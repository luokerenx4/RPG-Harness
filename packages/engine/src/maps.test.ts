import { expect, test } from "bun:test";
import type { MapDef, MapPlacementDef } from "./types";
import { collectMapConnections, collectMapImageLayers, collectMapRoutes, isMapPlacementLayerVisible, mapLayerDisplayOrder, mapPlacementDisplayOrder, mapPlayerDisplayOrder, mapRouteActivityId, resolveMapRoute } from "./maps";

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
        arrival: { placementId: "south-gate" },
        order: 0,
      }],
    }],
  });
  expect(connections).toEqual([{
    dir: "北へ進む",
    target: "inner",
    arrival: { placementId: "south-gate" },
  }]);
});

test("map routes retain event-page identity across duplicate targets", () => {
  const map: MapDef = {
    id: "gate",
    name: "Gate",
    description: "",
    connections: [{
      dir: "Old tunnel",
      target: "inner",
      arrival: { at: { x: 3, y: 1 } },
    }],
    placements: [
      {
        id: "locked-door",
        at: { x: 1, y: 0 },
        z: 0,
        footprint: { width: 1, height: 1 },
        collision: "trigger",
        visible: true,
        resource: { kind: "map", id: "inner" },
        events: [{
          id: "enter",
          trigger: "interact",
          label: "Sealed door",
          requires: { switch: { name: "sealed", eq: false } },
          order: 0,
        }],
      },
      {
        id: "open-door",
        at: { x: 2, y: 0 },
        z: 0,
        footprint: { width: 1, height: 1 },
        collision: "trigger",
        visible: true,
        resource: { kind: "map", id: "inner" },
        events: [{
          id: "enter",
          trigger: "interact",
          label: "Open door",
          arrival: { placementId: "west-door" },
          order: 0,
        }],
      },
    ],
  };
  const routes = collectMapRoutes(map);
  expect(routes.map(({ key, source }) => [key, source])).toEqual([
    ["map:gate/legacy-connection:0", "legacy-connection"],
    ["map:gate/placement:locked-door/event:enter", "placement-event"],
    ["map:gate/placement:open-door/event:enter", "placement-event"],
  ]);
  expect(new Set(routes.map((route) => mapRouteActivityId(routes, route))).size).toBe(3);
  expect(resolveMapRoute(map, "inner")).toBeUndefined();
  expect(routes[0]?.arrival).toEqual({ at: { x: 3, y: 1 } });
  expect(routes[2]?.arrival).toEqual({ placementId: "west-door" });
  expect(resolveMapRoute(map, "inner", routes[2]!.key)?.dir).toBe("Open door");
  expect(resolveMapRoute(map, "wrong", routes[2]!.key)).toBeUndefined();
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
  expect(isMapPlacementLayerVisible(map, actor)).toBe(true);
  expect(isMapPlacementLayerVisible({
    ...map,
    layout: { ...map.layout!, layers: map.layout!.layers.map((layer) => layer.id === "actors" ? { ...layer, visible: false } : layer) },
  }, actor)).toBe(false);
  expect(collectMapImageLayers({
    ...map,
    layout: {
      ...map.layout!,
      layers: [
        ...map.layout!.layers,
        { id: "mist", kind: "image", z: 5, visible: true, asset: "assets/backgrounds/mist" },
        { id: "hidden", kind: "image", z: 6, visible: false, asset: "assets/backgrounds/hidden" },
      ],
    },
  }).map((layer) => layer.id)).toEqual(["mist"]);
});
