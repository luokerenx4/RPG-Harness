import { expect, test } from "bun:test";
import type { MapDef, MapPlacementDef } from "./types";
import { collectMapConnections, mapLayerDisplayOrder, mapPlacementDisplayOrder, mapPlayerDisplayOrder } from "./maps";

test("collectMapConnections projects placement map events as ordinary exits", () => {
  const connections = collectMapConnections({
    id: "gate",
    name: "Gate",
    description: "",
    placements: [{
      id: "north-door",
      at: { x: 2, y: 0 },
      z: 0,
      footprint: { width: 1, height: 1 },
      collision: "trigger",
      visible: true,
      resource: { kind: "map", id: "inner" },
      events: [{
        id: "move",
        trigger: "player_touch",
        label: "北へ進む",
        order: 0,
      }],
    }],
  });
  expect(connections).toEqual([{ dir: "北へ進む", target: "inner" }]);
});

test("map display order respects authored layers before foot-Y sorting", () => {
  const map: MapDef = {
    id: "field",
    name: "Field",
    description: "",
    layout: {
      width: 12,
      height: 10,
      tileWidth: 32,
      tileHeight: 32,
      layers: [
        { id: "ground", kind: "tile", z: 0, visible: true },
        { id: "actors", kind: "object", z: 10, visible: true },
        { id: "canopy", kind: "object", z: 20, visible: true },
      ],
      regions: [],
    },
  };
  const actor: MapPlacementDef = {
    id: "actor",
    at: { x: 3, y: 6 },
    layer: "actors",
    z: 0,
    footprint: { width: 1, height: 1 },
    collision: "none",
    visible: true,
    events: [],
  };
  const lowerActor = { ...actor, id: "lower", at: { x: 3, y: 7 } };
  const canopy = { ...actor, id: "canopy", layer: "canopy", at: { x: 3, y: 0 } };
  expect(mapLayerDisplayOrder(10)).toBe(100_000);
  expect(mapPlacementDisplayOrder(map, lowerActor)).toBeGreaterThan(mapPlacementDisplayOrder(map, actor));
  expect(mapPlacementDisplayOrder(map, canopy)).toBeGreaterThan(mapPlacementDisplayOrder(map, lowerActor));
  expect(mapPlayerDisplayOrder(map, { x: 3, y: 6 })).toBe(mapPlacementDisplayOrder(map, actor));
});
