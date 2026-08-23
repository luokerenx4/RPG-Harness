import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MapLayoutDef, MapPlacementDef } from "@rpg-harness/engine";
import { handle } from "./handlers";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function previewProject() {
  const gameDir = await mkdtemp(path.join(os.tmpdir(), "autogal-map-preview-"));
  created.push(gameDir);
  await mkdir(path.join(gameDir, "maps"));
  await mkdir(path.join(gameDir, "scripts"));
  await writeFile(path.join(gameDir, "game.yaml"), "title: Preview fixture\n");
  const mapFile = path.join(gameDir, "maps", "town.yaml");
  await writeFile(mapFile, [
    "# authored source must remain byte-identical",
    "id: town",
    "name: Town",
    "description: Saved map",
    "layout:",
    "  width: 4",
    "  height: 3",
    "  tile_width: 32",
    "  tile_height: 32",
    "  player_start: [0, 0]",
    "  layers:",
    "    - { id: objects, kind: object, z: 0, visible: true }",
    "  regions: []",
    "",
  ].join("\n"));
  await writeFile(path.join(gameDir, "scripts", "hello.md"), [
    "---",
    "id: hello",
    "title: Hello",
    "---",
    "",
    "Guide: Hello.",
    "",
  ].join("\n"));
  return { gameDir, mapFile };
}

const layout: MapLayoutDef = {
  width: 4,
  height: 3,
  tileWidth: 32,
  tileHeight: 32,
  playerStart: { x: 0, y: 0 },
  layers: [{ id: "objects", kind: "object", z: 0, visible: true }],
  regions: [],
};

function placement({
  at = { x: 1, y: 0 },
  id = "guide",
  scriptId = "hello",
  label = "Talk to guide",
}: {
  at?: { x: number; y: number };
  id?: string;
  scriptId?: string;
  label?: string;
} = {}): MapPlacementDef {
  return {
    id,
    at,
    layer: "objects",
    z: 0,
    footprint: { width: 1, height: 1 },
    collision: "trigger",
    visible: true,
    events: [{
      id: "talk",
      trigger: "interact",
      label,
      run: { kind: "script", id: scriptId },
      order: 0,
    }],
  };
}

function previewRequest(gameDir: string, body: unknown) {
  return handle(new Request("http://studio.test/api/maps/town/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), { gameDir });
}

function authoringRequest(gameDir: string, body: unknown) {
  return handle(new Request("http://studio.test/api/maps/town/authoring", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), { gameDir });
}

describe("Studio map draft preview", () => {
  test("uses the saved source for a clean GET projection", async () => {
    const { gameDir } = await previewProject();
    const response = await handle(
      new Request("http://studio.test/api/maps/town/preview"),
      { gameDir },
    );
    expect(response.status).toBe(200);
    const preview = await response.json();
    expect(preview).toMatchObject({
      mapId: "town",
      source: "saved",
      readOnly: true,
    });
    expect(preview.hub).toEqual([]);
    expect(preview.headless).toEqual([]);
  });

  test("projects one legal in-memory draft across Hub, TUI, and Headless without writing", async () => {
    const { gameDir, mapFile } = await previewProject();
    const fixed = new Date("2001-02-03T04:05:06.000Z");
    await utimes(mapFile, fixed, fixed);
    const before = await readFile(mapFile);
    const beforeStat = await stat(mapFile, { bigint: true });
    const beforeEntries = (await readdir(path.dirname(mapFile))).sort();

    const response = await previewRequest(gameDir, { layout, placements: [placement()] });
    expect(response.status).toBe(200);
    const preview = await response.json();
    const eventKey = "map:town/placement:guide/event:talk";
    expect(preview).toMatchObject({
      mapId: "town",
      state: "deterministic-initial",
      source: "draft",
      readOnly: true,
    });
    expect(preview.hub.map((activity: { id: string }) => activity.id)).toContain(eventKey);
    expect(preview.tui.join("\n")).toContain("Talk to guide");
    expect(preview.headless.map((resource: { key: string }) => resource.key)).toEqual([
      "map:town/placement:guide",
      eventKey,
    ]);

    expect((await readFile(mapFile)).equals(before)).toBe(true);
    const afterStat = await stat(mapFile, { bigint: true });
    expect(afterStat.mtimeNs).toBe(beforeStat.mtimeNs);
    expect(afterStat.ino).toBe(beforeStat.ino);
    expect(afterStat.size).toBe(beforeStat.size);
    expect((await readdir(path.dirname(mapFile))).sort()).toEqual(beforeEntries);
    expect(beforeEntries.some((entry) => entry.endsWith(".studio.tmp"))).toBe(false);
  });

  test("returns validation errors for an invalid draft and leaves source untouched", async () => {
    const { gameDir, mapFile } = await previewProject();
    const fixed = new Date("2002-03-04T05:06:07.000Z");
    await utimes(mapFile, fixed, fixed);
    const before = await readFile(mapFile);
    const beforeStat = await stat(mapFile, { bigint: true });
    const beforeEntries = (await readdir(path.dirname(mapFile))).sort();

    const response = await previewRequest(gameDir, {
      layout,
      placements: [placement({ at: { x: 9, y: 0 } })],
    });
    expect(response.status).toBe(400);
    const error = await response.json();
    expect(error.code).toBe("invalid_map_draft");
    expect(error.error).toMatch(/guide|bounds|outside|width|coordinate/i);
    expect((await readFile(mapFile)).equals(before)).toBe(true);
    const afterStat = await stat(mapFile, { bigint: true });
    expect(afterStat.mtimeNs).toBe(beforeStat.mtimeNs);
    expect(afterStat.ino).toBe(beforeStat.ino);
    expect((await readdir(path.dirname(mapFile))).sort()).toEqual(beforeEntries);
    expect(beforeEntries.some((entry) => entry.endsWith(".studio.tmp"))).toBe(false);
  });

  test("runs full cross-resource validation for a missing draft command target", async () => {
    const { gameDir, mapFile } = await previewProject();
    const before = await readFile(mapFile);
    const response = await previewRequest(gameDir, {
      layout,
      placements: [placement({ scriptId: "missing_script" })],
    });
    expect(response.status).toBe(400);
    const error = await response.json();
    expect(error.code).toBe("invalid_map_draft");
    expect(error.error).toMatch(/missing_script|script/i);
    expect((await readFile(mapFile)).equals(before)).toBe(true);
  });

  test("keeps concurrent legal draft projections isolated", async () => {
    const { gameDir } = await previewProject();
    const [firstResponse, secondResponse] = await Promise.all([
      previewRequest(gameDir, {
        layout,
        placements: [placement({ id: "first", label: "First event" })],
      }),
      previewRequest(gameDir, {
        layout,
        placements: [placement({ id: "second", label: "Second event" })],
      }),
    ]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    const [first, second] = await Promise.all([firstResponse.json(), secondResponse.json()]);
    expect(first.tui.join("\n")).toContain("First event");
    expect(first.tui.join("\n")).not.toContain("Second event");
    expect(second.tui.join("\n")).toContain("Second event");
    expect(second.tui.join("\n")).not.toContain("First event");
    expect(first.headless.map((resource: { key: string }) => resource.key)).toEqual([
      "map:town/placement:first",
      "map:town/placement:first/event:talk",
    ]);
    expect(second.headless.map((resource: { key: string }) => resource.key)).toEqual([
      "map:town/placement:second",
      "map:town/placement:second/event:talk",
    ]);
  });

  test("previews and saves a property-only patch without rewriting spatial source", async () => {
    const { gameDir, mapFile } = await previewProject();
    const original = await readFile(mapFile, "utf-8");
    const spatialTail = original.slice(original.indexOf("layout:"));

    const previewResponse = await previewRequest(gameDir, {
      properties: { name: "New Town" },
    });
    expect(previewResponse.status).toBe(200);
    expect((await readFile(mapFile, "utf-8"))).toBe(original);

    const saveResponse = await authoringRequest(gameDir, {
      properties: { name: "New Town" },
    });
    expect(saveResponse.status).toBe(200);
    const project = await saveResponse.json();
    expect(project.maps.find((map: { id: string }) => map.id === "town")?.name).toBe("New Town");
    const saved = await readFile(mapFile, "utf-8");
    expect(saved).toContain("name: New Town");
    expect(saved.slice(saved.indexOf("layout:"))).toBe(spatialTail);
    expect(saved).not.toContain("difficulty:");
  });

  test("rejects malformed or unknown authoring fields without touching source", async () => {
    const { gameDir, mapFile } = await previewProject();
    const before = await readFile(mapFile);
    for (const body of [
      { properties: { name: "   " } },
      { properties: { unknown: true } },
      { surprise: true },
      { properties: { difficulty: "hard" } },
    ]) {
      const response = await authoringRequest(gameDir, body);
      expect(response.status).toBe(400);
      expect((await readFile(mapFile)).equals(before)).toBe(true);
    }
  });

  test("rejects encoded path traversal map ids without writing another project file", async () => {
    const { gameDir, mapFile } = await previewProject();
    const gameFile = path.join(gameDir, "game.yaml");
    await writeFile(mapFile, "id: ../game\nname: Traversal map\n");
    await writeFile(gameFile, "id: ../game\nname: Decoy map source\ntitle: Preview fixture\n");
    const mapBefore = await readFile(mapFile);
    const gameBefore = await readFile(gameFile);

    const response = await handle(new Request(
      "http://studio.test/api/maps/..%2Fgame/authoring",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ properties: { name: "Escaped write" } }),
      },
    ), { gameDir });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "map source file not found" });
    expect((await readFile(mapFile)).equals(mapBefore)).toBe(true);
    expect((await readFile(gameFile)).equals(gameBefore)).toBe(true);
  });
});
