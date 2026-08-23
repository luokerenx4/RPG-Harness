import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Game } from "@rpg-harness/engine";
import { parseMap } from "@rpg-harness/parser";
import {
  previewMapAuthoringPatch,
  serializeMapAuthoringPatch,
  serializeMapPlacementRefactor,
  updateMapAuthoring,
} from "./map-write";

describe("serializeMapAuthoringPatch", () => {
  test("round-trips spatial fields while retaining unrelated authored YAML", () => {
    const original = [
      "# authored map",
      "id: town",
      "name: Town",
      "custom_weather: rain",
      "loot_table:",
      "  - { item: coin, min: 1, max: 1, weight: 100 }",
    ].join("\n") + "\n";
    const next = serializeMapAuthoringPatch(original, {
      layout: {
        width: 10,
        height: 8,
        tileWidth: 16,
        tileHeight: 16,
        playerStart: { x: 2, y: 6 },
        layers: [{ id: "actors", kind: "object", z: 2, visible: true }],
        regions: [],
      },
      placements: [{
        id: "guide",
        at: { x: 4, y: 3 },
        resource: { kind: "character", id: "guide" },
        asset: "assets/sheets/guide-map",
        layer: "actors",
        z: 0,
        facing: "south",
        footprint: { width: 1, height: 1 },
        collision: "block",
        visible: true,
        events: [{
          id: "talk",
          trigger: "interact",
          run: { kind: "script", id: "meet_guide" },
          order: 0,
        }],
      }],
    });

    expect(next.content).toContain("# authored map");
    expect(next.content).toContain("custom_weather: rain");
    expect(next.content).toContain("loot_table:");
    expect(next.map.layout).toMatchObject({
      width: 10,
      height: 8,
      tileWidth: 16,
      playerStart: { x: 2, y: 6 },
    });
    expect(next.map.placements?.[0]).toMatchObject({
      id: "guide",
      at: { x: 4, y: 3 },
      resource: { kind: "character", id: "guide" },
      asset: "assets/sheets/guide-map",
    });
  });

  test("round-trips both destination arrival anchors when rewriting event pages", () => {
    const next = serializeMapAuthoringPatch("id: gate\nname: Gate\n", {
      placements: [{
        id: "doors",
        at: { x: 0, y: 0 },
        resource: { kind: "map", id: "inner" },
        z: 0,
        footprint: { width: 1, height: 1 },
        collision: "trigger",
        visible: true,
        events: [{
          id: "west",
          trigger: "interact",
          arrival: { placementId: "west_entry" },
          order: 0,
        }, {
          id: "east",
          trigger: "interact",
          arrival: { at: { x: 6, y: 2 } },
          order: 1,
        }],
      }],
    });

    expect(next.map.placements?.[0]?.events.map((event) => event.arrival)).toEqual([
      { placementId: "west_entry" },
      { at: { x: 6, y: 2 } },
    ]);
    expect(next.content).toContain("placement: west_entry");
    expect(next.content).toContain("at:");
  });

  test("refactors placement definitions and contextual arrivals without rewriting source trivia", () => {
    const original = [
      "# keep authored map trivia",
      "id: field",
      "name: Field",
      "connections:",
      "  - { dir: Loop, target: field, arrival: { placement: old-entry } } # legacy stays flow",
      "placements:",
      "  - { id: old-entry, at: [0, 0], resource: { kind: custom, id: marker } }",
      "  - id: door",
      "    at: [1, 0]",
      "    resource: { kind: map, id: field }",
      "    events:",
      "      - { id: cross, trigger: interact, arrival: { placement: 'old-entry' } }",
      "  - id: override-door",
      "    at: [2, 0]",
      "    resource: { kind: map, id: elsewhere }",
      "    events:",
      "      - { id: cross, trigger: interact, run: { kind: map, id: field }, arrival: { placement: old-entry } }",
      "  - id: other-door",
      "    at: [3, 0]",
      "    resource: { kind: map, id: field }",
      "    events:",
      "      - { id: cross, trigger: interact, run: { kind: map, id: elsewhere }, arrival: { placement: old-entry } }",
    ].join("\n") + "\n";
    const next = serializeMapPlacementRefactor(original, {
      sourceMapId: "field",
      targetMapId: "field",
      placementId: "old-entry",
      newPlacementId: "true",
    });

    expect(next.content).toContain("# keep authored map trivia");
    expect(next.content).toContain("# legacy stays flow");
    expect(next.content).toContain("placement: 'true'");
    expect(next.map.placements?.map((placement) => placement.id)).toEqual([
      "true",
      "door",
      "override-door",
      "other-door",
    ]);
    expect(next.map.connections?.[0]?.arrival).toEqual({ placementId: "true" });
    expect(next.map.placements?.[1]?.events[0]?.arrival).toEqual({ placementId: "true" });
    expect(next.map.placements?.[2]?.events[0]?.arrival).toEqual({ placementId: "true" });
    expect(next.map.placements?.[3]?.events[0]?.arrival).toEqual({ placementId: "old-entry" });
  });

  test("overlays exactly one target without mutating the input game", () => {
    const original = "id: town\nname: Town\ndescription: Saved\n";
    const map = parseMap(original, "maps/town.yaml");
    const game: Game = { title: "Preview", characters: [], scripts: [], maps: [map] };
    const before = structuredClone(game);
    const result = previewMapAuthoringPatch(original, game, "town", {
      layout: {
        width: 2,
        height: 2,
        tileWidth: 32,
        tileHeight: 32,
        layers: [],
        regions: [],
      },
      placements: [],
    });

    expect(game).toEqual(before);
    expect(result.game).not.toBe(game);
    expect(result.game.maps?.[0]).toBe(result.map);
    expect(result.map.layout).toMatchObject({ width: 2, height: 2 });
  });

  test("rejects a missing or ambiguous target before returning a detached map", () => {
    const original = "id: town\nname: Town\ndescription: Saved\n";
    const town = parseMap(original, "maps/town.yaml");
    const patch = { layout: null, placements: [] };
    expect(() => previewMapAuthoringPatch(original, {
      title: "Preview",
      characters: [],
      scripts: [],
      maps: [],
    }, "town", patch)).toThrow("map not found: town");
    expect(() => previewMapAuthoringPatch(original, {
      title: "Preview",
      characters: [],
      scripts: [],
      maps: [town, structuredClone(town)],
    }, "town", patch)).toThrow("map id is not unique: town");
  });

  test("changes only requested scalar nodes without rewriting authored spatial YAML", () => {
    const original = [
      "# authored map",
      "id: town",
      "name: Old Town",
      "layout:",
      "  # keep this comment and flow style byte-for-byte",
      "  width: 2",
      "  height: 2",
      "  layers: []",
      "  regions: []",
      "placements:",
      "  - { id: bell, at: [1, 1], resource: { kind: map, id: town }, collision: trigger }",
    ].join("\n") + "\n";
    const next = serializeMapAuthoringPatch(original, {
      properties: { name: "New Town" },
    });

    expect(next.content.slice(next.content.indexOf("layout:"))).toBe(
      original.slice(original.indexOf("layout:")),
    );
    expect(next.content).toContain("name: New Town");
    expect(next.content).not.toContain("difficulty:");
  });

  test("patches block scalar values in place while preserving comments and later bytes", () => {
    const original = [
      "id: town",
      "name: Town # identity note",
      "description: |",
      "  Old first line.",
      "  Old second line.",
      "layout: { width: 2, height: 2, layers: [], regions: [] }",
    ].join("\n") + "\n";
    const next = serializeMapAuthoringPatch(original, {
      properties: { name: "New Town", description: "New first line.\nNew second line." },
    });

    expect(next.content).toContain("name: New Town # identity note");
    expect(next.content.slice(next.content.indexOf("layout:"))).toBe(
      original.slice(original.indexOf("layout:")),
    );
    expect(next.map.description).toBe("New first line.\nNew second line.");
  });

  test("adds YAML separators when replacing an empty scalar", () => {
    const original = [
      "id: town",
      "name: Town",
      "description: # preserve this inline note",
      "layout: { width: 2, height: 2, layers: [], regions: [] }",
    ].join("\n") + "\n";
    const next = serializeMapAuthoringPatch(original, {
      properties: { description: "Now authored" },
    });

    expect(next.content).toContain("description: Now authored # preserve this inline note");
    expect(next.map.description).toBe("Now authored");
  });

  test("inserts new scalar keys before explicit document endings and trailing comments", () => {
    const original = "---\nid: town\nname: Town\n# authored tail\n...\n";
    const next = serializeMapAuthoringPatch(original, {
      properties: { difficulty: 2, isExtract: true },
    });
    expect(next.content).toBe(
      "---\nid: town\nname: Town\ndifficulty: 2\nis_extract: true\n# authored tail\n...\n",
    );
    expect(next.map).toMatchObject({ difficulty: 2, isExtract: true });
  });

  test("deletes cleared scalar keys and validates background assets through preview and save path", () => {
    const original = [
      "id: town",
      "name: Town",
      "description: Old description",
      "bg: assets/backgrounds/old",
      "is_extract: true",
    ].join("\n") + "\n";
    const map = parseMap(original, "maps/town.yaml");
    const game: Game = {
      title: "Preview",
      characters: [],
      scripts: [],
      maps: [map],
      assets: [{
        path: "assets/backgrounds/new",
        kind: "bg",
        description: "",
        prompt: "",
        placeholder: "New background",
        renderings: {},
      }],
    };
    const cleared = previewMapAuthoringPatch(original, game, "town", {
      properties: { description: null, bg: null, isExtract: false },
    });
    expect(cleared.content).not.toContain("description:");
    expect(cleared.content).not.toContain("bg:");
    expect(cleared.content).not.toContain("is_extract:");
    expect(cleared.map).toMatchObject({ description: "" });
    expect(cleared.map.bg).toBeUndefined();
    expect(cleared.map.isExtract).toBeUndefined();

    expect(() => previewMapAuthoringPatch(original, game, "town", {
      properties: { bg: "assets/backgrounds/missing" },
    })).toThrow("map background asset not found");
    expect(() => previewMapAuthoringPatch(original, {
      ...game,
      assets: [{ ...game.assets![0]!, kind: "cg" }],
    }, "town", {
      properties: { bg: "assets/backgrounds/new" },
    })).toThrow("map background must reference a bg asset");
  });

  test("preserves standalone comments when clearing empty or false scalar keys", () => {
    const emptyScalar = [
      "id: town",
      "name: Town",
      "description:",
      "# author note for layout",
      "layout: { width: 2, height: 2, layers: [], regions: [] }",
    ].join("\n") + "\n";
    expect(serializeMapAuthoringPatch(emptyScalar, {
      properties: { description: null },
    }).content).toBe([
      "id: town",
      "name: Town",
      "# author note for layout",
      "layout: { width: 2, height: 2, layers: [], regions: [] }",
    ].join("\n") + "\n");

    const falseScalar = [
      "id: town",
      "name: Town",
      "is_extract: false",
      "# author note for layout",
      "layout: { width: 2, height: 2, layers: [], regions: [] }",
    ].join("\n") + "\n";
    expect(serializeMapAuthoringPatch(falseScalar, {
      properties: { isExtract: false },
    }).content).toBe([
      "id: town",
      "name: Town",
      "# author note for layout",
      "layout: { width: 2, height: 2, layers: [], regions: [] }",
    ].join("\n") + "\n");
  });

  test("rejects invalid Studio property values before serialization", () => {
    const original = "id: town\nname: Town\n";
    const map = parseMap(original, "maps/town.yaml");
    const game: Game = { title: "Preview", characters: [], scripts: [], maps: [map] };
    expect(() => previewMapAuthoringPatch(original, game, "town", {
      properties: { name: "   " },
    })).toThrow("map name must not be blank");
    expect(() => previewMapAuthoringPatch(original, game, "town", {
      properties: { name: "x".repeat(161) },
    })).toThrow("map name must be at most 160 characters");
    expect(() => previewMapAuthoringPatch(original, game, "town", {
      properties: { difficulty: Number.NaN },
    })).toThrow("map difficulty must be a finite number");
  });

  test("restores the original file if authoritative reload fails after replacement", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "autogal-map-write-"));
    const file = path.join(directory, "town.yaml");
    const original = "id: town\nname: Town\nlayout: { width: 2, height: 2, layers: [], regions: [] }\n";
    await writeFile(file, original);
    const map = parseMap(original, file);
    const game: Game = { title: "Preview", characters: [], scripts: [], maps: [map] };
    try {
      await expect(updateMapAuthoring(
        file,
        game,
        "town",
        { properties: { name: "Broken reload" } },
        async () => { throw new Error("reload failed"); },
      )).rejects.toThrow("reload failed");
      expect(await readFile(file, "utf-8")).toBe(original);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  test("serializes concurrent saves so a failed rollback cannot erase a later success", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "autogal-map-write-race-"));
    const file = path.join(directory, "town.yaml");
    const original = "id: town\nname: Town\nlayout: { width: 2, height: 2, layers: [], regions: [] }\n";
    await writeFile(file, original);
    const map = parseMap(original, file);
    const game: Game = { title: "Preview", characters: [], scripts: [], maps: [map] };
    let signalFirstReload!: () => void;
    const firstReloadStarted = new Promise<void>((resolve) => {
      signalFirstReload = resolve;
    });
    let releaseFirstReload!: () => void;
    const firstReloadGate = new Promise<void>((resolve) => {
      releaseFirstReload = resolve;
    });

    try {
      const first = updateMapAuthoring(
        file,
        game,
        "town",
        { properties: { name: "First request" } },
        async () => {
          signalFirstReload();
          await firstReloadGate;
          throw new Error("first reload failed");
        },
      );
      const firstOutcome = first.then(
        () => new Error("first save unexpectedly succeeded"),
        (error: unknown) => error,
      );
      await firstReloadStarted;

      const second = updateMapAuthoring(
        file,
        game,
        "town",
        { properties: { isExtract: true } },
        async () => {
          const current = parseMap(await readFile(file, "utf-8"), file);
          return { ...game, maps: [current] };
        },
      );
      releaseFirstReload();

      expect(await firstOutcome).toMatchObject({ message: "first reload failed" });
      await expect(second).resolves.toMatchObject({
        map: { id: "town", name: "Town", isExtract: true },
      });
      const finalMap = parseMap(await readFile(file, "utf-8"), file);
      expect(finalMap).toMatchObject({ id: "town", name: "Town", isExtract: true });
      expect(await readdir(directory)).toEqual(["town.yaml"]);
    } finally {
      releaseFirstReload();
      await rm(directory, { recursive: true });
    }
  });

  test("does not roll back over a source changed outside the in-flight save", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "autogal-map-write-cas-"));
    const file = path.join(directory, "town.yaml");
    const original = "id: town\nname: Town\n";
    const external = "id: town\nname: External edit\n";
    await writeFile(file, original);
    const map = parseMap(original, file);
    const game: Game = { title: "Preview", characters: [], scripts: [], maps: [map] };
    try {
      await expect(updateMapAuthoring(
        file,
        game,
        "town",
        { properties: { name: "Studio edit" } },
        async () => {
          await writeFile(file, external);
          throw new Error("reload observed an external edit");
        },
      )).rejects.toThrow("Rollback skipped because the map source changed");
      expect(await readFile(file, "utf-8")).toBe(external);
      expect(await readdir(directory)).toEqual(["town.yaml"]);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  test("revalidates property references against the authoritative reload", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "autogal-map-write-reload-"));
    const file = path.join(directory, "town.yaml");
    const original = "id: town\nname: Town\n";
    await writeFile(file, original);
    const map = parseMap(original, file);
    const background = {
      path: "assets/backgrounds/town",
      kind: "bg" as const,
      description: "",
      prompt: "",
      placeholder: "Town",
      renderings: {},
    };
    const game: Game = {
      title: "Preview",
      characters: [],
      scripts: [],
      maps: [map],
      assets: [background],
    };
    try {
      await expect(updateMapAuthoring(
        file,
        game,
        "town",
        { properties: { bg: background.path } },
        async () => ({
          ...game,
          maps: [parseMap(await readFile(file, "utf-8"), file)],
          assets: [],
        }),
      )).rejects.toThrow("map background asset not found");
      expect(await readFile(file, "utf-8")).toBe(original);
      expect(await readdir(directory)).toEqual(["town.yaml"]);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  test("rolls back when reload returns a stale target map", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "autogal-map-write-stale-"));
    const file = path.join(directory, "town.yaml");
    const original = "id: town\nname: Town\n";
    await writeFile(file, original);
    const map = parseMap(original, file);
    const game: Game = { title: "Preview", characters: [], scripts: [], maps: [map] };
    try {
      await expect(updateMapAuthoring(
        file,
        game,
        "town",
        { properties: { name: "Studio edit" } },
        async () => game,
      )).rejects.toThrow("reloaded map does not match the authored source");
      expect(await readFile(file, "utf-8")).toBe(original);
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
