import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Game, MapDef } from "@rpg-harness/engine";
import { parseMap } from "@rpg-harness/parser";
import {
  mapPlacementRenameRevision,
  planMapPlacementRename,
  updateMapPlacementRename,
} from "./map-placement-refactor";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("map placement refactor", () => {
  test("plans the target definition and every incoming arrival as one change", () => {
    const source = game();
    const before = structuredClone(source);
    const plan = planMapPlacementRename(source, {
      mapId: "target",
      placementId: "west-entry",
      newPlacementId: "west-gate",
    });

    expect(plan.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(plan.revision).toBe(mapPlacementRenameRevision(source, {
      mapId: "target",
      placementId: "west-entry",
      newPlacementId: "west-gate",
    }));
    expect(plan.targetKey).toBe("map:target/placement:west-entry");
    expect(plan.changedIds).toEqual(["event-source", "legacy-source", "target"]);
    expect(plan.backlinks.map((backlink) => ({
      sourceKey: backlink.sourceKey,
      sourceConnectionIndex: backlink.sourceConnectionIndex,
      sourcePlacementId: backlink.sourcePlacementId,
      sourceEventId: backlink.sourceEventId,
    }))).toEqual([
      {
        sourceKey: "map:event-source/placement:door/event:cross",
        sourceConnectionIndex: undefined,
        sourcePlacementId: "door",
        sourceEventId: "cross",
      },
      {
        sourceKey: "map:legacy-source/legacy-connection:0",
        sourceConnectionIndex: 0,
        sourcePlacementId: undefined,
        sourceEventId: undefined,
      },
    ]);
    expect(plan.game.maps?.find((map) => map.id === "target")?.placements?.[0]?.id)
      .toBe("west-gate");
    expect(plan.game.maps?.find((map) => map.id === "event-source")
      ?.placements?.[0]?.events[0]?.arrival).toEqual({ placementId: "west-gate" });
    expect(plan.game.maps?.find((map) => map.id === "legacy-source")
      ?.connections?.[0]?.arrival).toEqual({ placementId: "west-gate" });
    expect(source).toEqual(before);
  });

  test("rejects conflicts, missing targets, malformed ids, and stale previews", () => {
    const source = game();
    expect(() => planMapPlacementRename(source, {
      mapId: "target",
      placementId: "west-entry",
      newPlacementId: "occupied",
    })).toThrow("already has placement id");
    expect(() => planMapPlacementRename(source, {
      mapId: "target",
      placementId: "missing",
      newPlacementId: "new-entry",
    })).toThrow("has no placement");
    expect(() => planMapPlacementRename(source, {
      mapId: "target",
      placementId: "west-entry",
      newPlacementId: "not valid",
    })).toThrow("stable ASCII");
    expect(() => planMapPlacementRename(source, {
      mapId: "target",
      placementId: "west-entry",
      newPlacementId: "new-entry",
      expectedRevision: `sha256:${"0".repeat(64)}`,
    })).toThrow("changed since this refactor was previewed");
  });

  test("follows explicit event targets without touching the same placement id in another map", () => {
    const source = game();
    source.maps!.push({
      ...targetMap(),
      id: "other-target",
      name: "Other target",
    }, {
      id: "override-source",
      name: "Override source",
      description: "",
      placements: [{
        id: "door",
        at: { x: 0, y: 0 },
        z: 0,
        footprint: { width: 1, height: 1 },
        collision: "trigger",
        visible: true,
        resource: { kind: "map", id: "other-target" },
        events: [{
          id: "cross",
          trigger: "interact",
          run: { kind: "map", id: "target" },
          arrival: { placementId: "west-entry" },
          order: 0,
        }],
      }],
    }, {
      id: "other-source",
      name: "Other source",
      description: "",
      placements: [{
        id: "door",
        at: { x: 0, y: 0 },
        z: 0,
        footprint: { width: 1, height: 1 },
        collision: "trigger",
        visible: true,
        resource: { kind: "map", id: "other-target" },
        events: [{
          id: "cross",
          trigger: "interact",
          arrival: { placementId: "west-entry" },
          order: 0,
        }],
      }],
    });

    const plan = planMapPlacementRename(source, {
      mapId: "target",
      placementId: "west-entry",
      newPlacementId: "west-gate",
    });

    expect(plan.changedIds).toEqual([
      "event-source",
      "legacy-source",
      "override-source",
      "target",
    ]);
    expect(plan.backlinks.map((backlink) => backlink.sourceKey))
      .toContain("map:override-source/placement:door/event:cross");
    expect(plan.game.maps?.find((map) => map.id === "override-source")
      ?.placements?.[0]?.events[0]?.arrival).toEqual({ placementId: "west-gate" });
    expect(plan.game.maps?.find((map) => map.id === "other-target")
      ?.placements?.[0]?.id).toBe("west-entry");
    expect(plan.game.maps?.find((map) => map.id === "other-source")
      ?.placements?.[0]?.events[0]?.arrival).toEqual({ placementId: "west-entry" });
  });

  test("commits all source files together and preserves authored trivia", async () => {
    const fixture = await files();
    const initial = await fixture.reload();
    const preview = planMapPlacementRename(initial, {
      mapId: "target",
      placementId: "west-entry",
      newPlacementId: "true",
    });
    const result = await updateMapPlacementRename(fixture.sources, {
      mapId: "target",
      placementId: "west-entry",
      newPlacementId: "true",
      expectedRevision: preview.revision,
    }, fixture.reload);

    expect(result.changedIds).toEqual(["event-source", "legacy-source", "target"]);
    expect(result.game.maps?.find((map) => map.id === "target")?.placements?.[0]?.id)
      .toBe("true");
    expect(await readFile(fixture.paths.target, "utf-8"))
      .toContain("# target identity comment");
    expect(await readFile(fixture.paths.event, "utf-8"))
      .toContain("# event route comment");
    expect(await readFile(fixture.paths.legacy, "utf-8"))
      .toContain("# legacy route comment");
    expect((await readFile(fixture.paths.legacy, "utf-8")))
      .toContain("placement: 'true'");
  });

  test("renames a self-owned route definition and its arrival in the same source", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "autogal-placement-self-route-"));
    created.push(directory);
    const mapsDirectory = path.join(directory, "maps");
    await mkdir(mapsDirectory);
    const targetPath = path.join(mapsDirectory, "target.yaml");
    await writeFile(targetPath, [
      "id: target",
      "name: Target",
      "placements:",
      "  # keep self-route comment",
      "  - id: west-entry",
      "    at: [0, 0]",
      "    resource: { kind: map, id: target }",
      "    events:",
      "      - { id: loop, trigger: interact, arrival: { placement: west-entry } }",
    ].join("\n") + "\n");
    const sources = new Map([["target", targetPath]]);
    const reload = async (): Promise<Game> => ({
      title: "Self route",
      characters: [],
      scripts: [],
      maps: [parseMap(await readFile(targetPath, "utf-8"), targetPath)],
    });
    const preview = planMapPlacementRename(await reload(), {
      mapId: "target",
      placementId: "west-entry",
      newPlacementId: "west-gate",
    });

    expect(preview.changedIds).toEqual(["target"]);
    expect(preview.backlinks).toEqual([
      expect.objectContaining({
        sourceMapId: "target",
        sourcePlacementId: "west-entry",
        sourceEventId: "loop",
      }),
    ]);
    const result = await updateMapPlacementRename(sources, {
      mapId: "target",
      placementId: "west-entry",
      newPlacementId: "west-gate",
      expectedRevision: preview.revision,
    }, reload);

    const placement = result.game.maps?.[0]?.placements?.[0];
    expect(placement?.id).toBe("west-gate");
    expect(placement?.events[0]?.arrival).toEqual({ placementId: "west-gate" });
    const sourceText = await readFile(targetPath, "utf-8");
    expect(sourceText).toContain("# keep self-route comment");
    expect(sourceText).toContain("id: west-gate");
    expect(sourceText).toContain("placement: west-gate");
  });

  test("rolls every map back when authoritative projection fails", async () => {
    const fixture = await files();
    const originals = new Map(await Promise.all(
      Object.entries(fixture.paths).map(async ([key, file]) => [key, await readFile(file, "utf-8")] as const),
    ));
    const preview = planMapPlacementRename(await fixture.reload(), {
      mapId: "target",
      placementId: "west-entry",
      newPlacementId: "west-gate",
    });

    await expect(updateMapPlacementRename(fixture.sources, {
      mapId: "target",
      placementId: "west-entry",
      newPlacementId: "west-gate",
      expectedRevision: preview.revision,
    }, fixture.reload, async () => {
      throw new Error("projection failed");
    })).rejects.toThrow("projection failed");
    for (const [key, file] of Object.entries(fixture.paths)) {
      expect(await readFile(file, "utf-8")).toBe(originals.get(key)!);
    }
  });
});

function game(): Game {
  return {
    title: "Placement refactor",
    characters: [],
    scripts: [],
    maps: [
      targetMap(),
      {
        id: "event-source",
        name: "Event source",
        description: "",
        placements: [{
          id: "door",
          at: { x: 0, y: 0 },
          z: 0,
          footprint: { width: 1, height: 1 },
          collision: "trigger",
          visible: true,
          resource: { kind: "map", id: "target" },
          events: [{
            id: "cross",
            trigger: "interact",
            arrival: { placementId: "west-entry" },
            order: 0,
          }],
        }],
      },
      {
        id: "legacy-source",
        name: "Legacy source",
        description: "",
        connections: [{
          dir: "Old road",
          target: "target",
          arrival: { placementId: "west-entry" },
        }],
      },
    ],
  };
}

function targetMap(): MapDef {
  return {
    id: "target",
    name: "Target",
    description: "",
    placements: [{
      id: "west-entry",
      at: { x: 0, y: 0 },
      z: 0,
      footprint: { width: 1, height: 1 },
      collision: "none",
      visible: true,
      resource: { kind: "custom", id: "arrival-marker" },
      events: [],
    }, {
      id: "occupied",
      at: { x: 1, y: 0 },
      z: 0,
      footprint: { width: 1, height: 1 },
      collision: "none",
      visible: true,
      resource: { kind: "custom", id: "other-marker" },
      events: [],
    }],
  };
}

async function files() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "autogal-placement-refactor-"));
  created.push(directory);
  const mapsDirectory = path.join(directory, "maps");
  await mkdir(mapsDirectory);
  const paths = {
    target: path.join(mapsDirectory, "target.yaml"),
    event: path.join(mapsDirectory, "event-source.yaml"),
    legacy: path.join(mapsDirectory, "legacy-source.yaml"),
  };
  await writeFile(paths.target, [
    "id: target",
    "name: Target",
    "# target identity comment",
    "placements:",
    "  - { id: west-entry, at: [0, 0], resource: { kind: custom, id: arrival-marker } }",
    "  - { id: occupied, at: [1, 0], resource: { kind: custom, id: other-marker } }",
  ].join("\n") + "\n");
  await writeFile(paths.event, [
    "id: event-source",
    "name: Event source",
    "# event route comment",
    "placements:",
    "  - id: door",
    "    at: [0, 0]",
    "    resource: { kind: map, id: target }",
    "    events:",
    "      - { id: cross, trigger: interact, arrival: { placement: west-entry } }",
  ].join("\n") + "\n");
  await writeFile(paths.legacy, [
    "id: legacy-source",
    "name: Legacy source",
    "# legacy route comment",
    "connections:",
    "  - { dir: Old road, target: target, arrival: { placement: 'west-entry' } }",
  ].join("\n") + "\n");
  const sources = new Map([
    ["target", paths.target],
    ["event-source", paths.event],
    ["legacy-source", paths.legacy],
  ]);
  const reload = async (): Promise<Game> => ({
    title: "Placement refactor",
    characters: [],
    scripts: [],
    maps: await Promise.all([
      paths.target,
      paths.event,
      paths.legacy,
    ].map(async (file) => parseMap(await readFile(file, "utf-8"), file))),
  });
  return { directory, paths, sources, reload };
}
