import { describe, expect, test } from "bun:test";
import { serializeSpatialMapPatch } from "./map-write";

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
    });
  });
});
