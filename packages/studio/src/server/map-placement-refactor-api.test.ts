import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadGame } from "@rpg-harness/cli/loader";
import { handle } from "./handlers";
import { planMapPlacementRename } from "./map-placement-refactor";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("Studio map placement refactor API", () => {
  test("previews without writing, then atomically renames the anchor and backlinks", async () => {
    const fixture = await apiFixture();
    const before = new Map(await Promise.all(
      Object.entries(fixture.files).map(async ([key, file]) => [key, await readFile(file, "utf-8")] as const),
    ));
    const body = renameBody();

    const preview = await request(fixture.gameDir, "POST", body, true);
    expect(preview.status).toBe(200);
    const plan = await preview.json();
    expect(plan.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(plan.targetKey).toBe("map:target/placement:west-entry");
    expect(plan.changedIds).toEqual(["event-source", "legacy-source", "target"]);
    expect(plan.backlinks).toHaveLength(2);
    for (const [key, file] of Object.entries(fixture.files)) {
      expect(await readFile(file, "utf-8")).toBe(before.get(key)!);
    }

    body.expectedRevision = plan.revision;
    const committed = await request(fixture.gameDir, "PATCH", body);
    expect(committed.status).toBe(200);
    const result = await committed.json();
    expect(result.changedIds).toEqual(["event-source", "legacy-source", "target"]);
    expect(result.newPlacementId).toBe("west-gate");
    expect(result.project.maps.find((map: { id: string }) => map.id === "target")
      .placements[0].id).toBe("west-gate");
    expect(result.project.maps.find((map: { id: string }) => map.id === "event-source")
      .placements[0].events[0].arrival).toEqual({ placementId: "west-gate" });
    expect(await readFile(fixture.files.target, "utf-8")).toContain("id: west-gate");
    expect(await readFile(fixture.files.event, "utf-8")).toContain("placement: west-gate");
    expect(await readFile(fixture.files.legacy, "utf-8")).toContain("placement: west-gate");
  });

  test("requires preview revision and rejects malformed request fields", async () => {
    const fixture = await apiFixture();
    const missingPreview = await request(fixture.gameDir, "PATCH", renameBody());
    expect(missingPreview.status).toBe(409);
    expect(await missingPreview.json()).toMatchObject({
      code: "map_placement_preview_required",
    });

    const unknown = await request(fixture.gameDir, "POST", {
      ...renameBody(),
      rewriteEverything: true,
    }, true);
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toContain("unknown map placement refactor field");

    const malformedRevision = await request(fixture.gameDir, "POST", {
      ...renameBody(),
      expectedRevision: "old",
    }, true);
    expect(malformedRevision.status).toBe(400);
    expect((await malformedRevision.json()).error).toContain("sha256 placement revision");
  });

  test("rejects a commit after an arrival source changes since preview", async () => {
    const fixture = await apiFixture();
    const body = renameBody();
    const preview = await request(fixture.gameDir, "POST", body, true);
    body.expectedRevision = (await preview.json()).revision;
    const eventSource = await readFile(fixture.files.event, "utf-8");
    await writeFile(
      fixture.files.event,
      eventSource.replace(", arrival: { placement: west-entry }", ""),
    );

    const committed = await request(fixture.gameDir, "PATCH", body);
    expect(committed.status).toBe(409);
    expect(await committed.json()).toMatchObject({ code: "stale_map_placement_refs" });
    expect(await readFile(fixture.files.target, "utf-8")).toContain("id: west-entry");
  });

  test("binds the preview revision to the exact placement rename intent", async () => {
    const fixture = await apiFixture();
    const previewIntent = renameBody();
    const preview = await request(fixture.gameDir, "POST", previewIntent, true);
    const revision = (await preview.json()).revision as string;

    const committed = await request(fixture.gameDir, "PATCH", {
      ...previewIntent,
      newPlacementId: "different-gate",
      expectedRevision: revision,
    });
    expect(committed.status).toBe(409);
    expect(await committed.json()).toMatchObject({ code: "stale_map_placement_refs" });
    expect(await readFile(fixture.files.target, "utf-8")).toContain("id: west-entry");
  });

  test("rejects alias and block-scalar sources equally during preview and commit", async () => {
    for (const shape of ["alias", "block"] as const) {
      const fixture = await unsafeApiFixture(shape);
      const intent = renameBody();
      const preview = await request(fixture.gameDir, "POST", intent, true);
      expect(preview.status).toBe(422);
      expect(await preview.json()).toMatchObject({ code: "invalid_map_placement_refactor" });

      const plan = planMapPlacementRename(await loadGame(fixture.gameDir), intent);
      const committed = await request(fixture.gameDir, "PATCH", {
        ...intent,
        expectedRevision: plan.revision,
      });
      expect(committed.status).toBe(422);
      expect(await committed.json()).toMatchObject({ code: "invalid_map_placement_refactor" });
    }
  });
});

function request(
  gameDir: string,
  method: "POST" | "PATCH",
  body: unknown,
  preview = false,
) {
  return handle(new Request(
    `http://studio.test/api/map-placements/rename${preview ? "/preview" : ""}`,
    {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  ), { gameDir });
}

function renameBody() {
  return {
    mapId: "target",
    placementId: "west-entry",
    newPlacementId: "west-gate",
    expectedRevision: undefined as string | undefined,
  };
}

async function apiFixture() {
  const gameDir = await mkdtemp(path.join(os.tmpdir(), "autogal-placement-refactor-api-"));
  created.push(gameDir);
  const mapsDir = path.join(gameDir, "maps");
  await mkdir(mapsDir);
  await writeFile(path.join(gameDir, "game.yaml"), "title: Placement refactor API fixture\n");
  const files = {
    target: path.join(mapsDir, "target.yaml"),
    event: path.join(mapsDir, "event-source.yaml"),
    legacy: path.join(mapsDir, "legacy-source.yaml"),
  };
  await writeFile(files.target, [
    "id: target",
    "name: Target",
    "placements:",
    "  - { id: west-entry, at: [0, 0], resource: { kind: custom, id: arrival-marker } }",
  ].join("\n") + "\n");
  await writeFile(files.event, [
    "id: event-source",
    "name: Event source",
    "placements:",
    "  - id: door",
    "    at: [0, 0]",
    "    resource: { kind: map, id: target }",
    "    events:",
    "      - { id: cross, trigger: interact, arrival: { placement: west-entry } }",
  ].join("\n") + "\n");
  await writeFile(files.legacy, [
    "id: legacy-source",
    "name: Legacy source",
    "connections:",
    "  - { dir: Old road, target: target, arrival: { placement: west-entry } }",
  ].join("\n") + "\n");
  return { gameDir, files };
}

async function unsafeApiFixture(shape: "alias" | "block") {
  const gameDir = await mkdtemp(path.join(os.tmpdir(), `autogal-placement-${shape}-api-`));
  created.push(gameDir);
  const mapsDir = path.join(gameDir, "maps");
  await mkdir(mapsDir);
  await writeFile(path.join(gameDir, "game.yaml"), "title: Unsafe placement source fixture\n");
  const target = path.join(mapsDir, "target.yaml");
  await writeFile(target, shape === "alias"
    ? [
      "id: target",
      "name: Target",
      "placements:",
      "  - { id: &entry west-entry, at: [0, 0], resource: { kind: custom, id: marker } }",
      "connections:",
      "  - { dir: Loop, target: target, arrival: { placement: *entry } }",
    ].join("\n") + "\n"
    : [
      "id: target",
      "name: Target",
      "placements:",
      "  - id: |-",
      "      west-entry",
      "    at: [0, 0]",
      "    resource: { kind: custom, id: marker }",
    ].join("\n") + "\n");
  return { gameDir, target };
}
