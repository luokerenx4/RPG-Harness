import { describe, expect, test } from "bun:test";
import type { Game } from "@rpg-harness/engine";
import { parseMap } from "@rpg-harness/parser";
import { previewMapSpatialPatch, serializeSpatialMapPatch } from "./map-write";

describe("serializeSpatialMapPatch", () => {
  test("round-trips spatial fields while retaining unrelated authored YAML", () => {
    const original = [
      "# authored map",
      "id: town",
      "name: Town",
      "custom_weather: rain",
      "loot_table:",
      "  - { item: coin, min: 1, max: 1, weight: 100 }",
    ].join("\n") + "\n";
    const next = serializeSpatialMapPatch(original, {
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

  test("overlays exactly one target without mutating the input game", () => {
    const original = "id: town\nname: Town\ndescription: Saved\n";
    const map = parseMap(original, "maps/town.yaml");
    const game: Game = { title: "Preview", characters: [], scripts: [], maps: [map] };
    const before = structuredClone(game);
    const result = previewMapSpatialPatch(original, game, "town", {
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
    expect(() => previewMapSpatialPatch(original, {
      title: "Preview",
      characters: [],
      scripts: [],
      maps: [],
    }, "town", patch)).toThrow("map not found: town");
    expect(() => previewMapSpatialPatch(original, {
      title: "Preview",
      characters: [],
      scripts: [],
      maps: [town, structuredClone(town)],
    }, "town", patch)).toThrow("map id is not unique: town");
  });
});
