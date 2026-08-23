import { expect, test } from "bun:test";
import type { MapDef, MapPlacementDef } from "./types";
import {
  collectMapArrivalBacklinks,
  collectMapConnections,
  collectMapImageLayers,
  collectMapRoutes,
  isMapPlacementLayerVisible,
  mapLayerDisplayOrder,
  mapPlacementDistance,
  mapPlacementDisplayOrder,
  mapPlayerDisplayOrder,
  mapPointBlocker,
  mapRouteActivityId,
  resolveMapPointBlocker,
  resolveMapRoute,
} from "./maps";

test("structured point blockers distinguish placement ids from collision layers", () => {
  const map: MapDef = {
    id: "field",
    name: "Field",
    description: "",
    layout: {
      width: 2,
      height: 1,
      tileWidth: 32,
      tileHeight: 32,
      layers: [{
        id: "wall",
        kind: "collision",
        z: 0,
        visible: false,
        tiles: [[1, 1]],
      }],
      regions: [],
    },
    placements: [{
      id: "layer:wall",
      at: { x: 0, y: 0 },
      z: 0,
      footprint: { width: 1, height: 1 },
      collision: "block",
      visible: true,
      events: [],
    }],
  };

  expect(resolveMapPointBlocker(map, { x: 0, y: 0 })).toEqual({
    kind: "placement",
    placementId: "layer:wall",
  });
  expect(resolveMapPointBlocker(map, { x: 1, y: 0 })).toEqual({
    kind: "collision-layer",
    layerId: "wall",
  });
  // Compatibility strings are intentionally ambiguous; authoring uses the
  // structured resolver above.
  expect(mapPointBlocker(map, { x: 0, y: 0 })).toBe("layer:wall");
  expect(mapPointBlocker(map, { x: 1, y: 0 })).toBe("layer:wall");
});

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

test("map placement distance uses the nearest footprint cell", () => {
  const placement: MapPlacementDef = {
    id: "wide-object",
    at: { x: 4, y: 5 },
    z: 0,
    footprint: { width: 3, height: 2 },
    collision: "none",
    visible: true,
    events: [],
  };
  expect(mapPlacementDistance({ x: 1, y: 2 }, placement)).toBe(6);
  expect(mapPlacementDistance({ x: 3, y: 5 }, placement)).toBe(1);
  expect(mapPlacementDistance({ x: 6, y: 6 }, placement)).toBe(0);
  expect(mapPlacementDistance({ x: 8, y: 7 }, placement)).toBe(3);
});

test("map arrival backlinks preserve every authored route source", () => {
  const target: MapDef = {
    id: "field",
    name: "Field",
    description: "",
    placements: [{
      id: "west-entry",
      at: { x: 0, y: 0 },
      z: 0,
      footprint: { width: 1, height: 1 },
      collision: "none",
      visible: true,
      events: [],
      resource: { kind: "custom", id: "marker" },
    }],
  };
  const otherTarget: MapDef = {
    ...target,
    id: "other-field",
    name: "Other field",
  };
  const source: MapDef = {
    id: "gatehouse",
    name: "Gatehouse",
    description: "",
    connections: [{
      dir: "Legacy gate",
      target: target.id,
      arrival: { placementId: "west-entry" },
    }],
    placements: [{
      id: "painted-door",
      at: { x: 2, y: 1 },
      z: 0,
      footprint: { width: 1, height: 1 },
      collision: "trigger",
      visible: true,
      resource: { kind: "map", id: target.id },
      events: [{
        id: "cross",
        trigger: "player_touch",
        label: "Painted door",
        arrival: { placementId: "west-entry" },
        order: 0,
      }],
    }, {
      id: "override-door",
      at: { x: 3, y: 1 },
      z: 0,
      footprint: { width: 1, height: 1 },
      collision: "trigger",
      visible: true,
      resource: { kind: "map", id: otherTarget.id },
      events: [{
        id: "cross",
        trigger: "interact",
        label: "Override door",
        run: { kind: "map", id: target.id },
        arrival: { placementId: "west-entry" },
        order: 0,
      }],
    }, {
      id: "other-door",
      at: { x: 4, y: 1 },
      z: 0,
      footprint: { width: 1, height: 1 },
      collision: "trigger",
      visible: true,
      resource: { kind: "map", id: otherTarget.id },
      events: [{
        id: "cross",
        trigger: "interact",
        label: "Other field door",
        arrival: { placementId: "west-entry" },
        order: 0,
      }],
    }],
  };

  expect(collectMapArrivalBacklinks([target, otherTarget, source], "field", "west-entry"))
    .toEqual([
      {
        targetKey: "map:field/placement:west-entry",
        targetMapId: "field",
        targetPlacementId: "west-entry",
        sourceKey: "map:gatehouse/legacy-connection:0",
        sourceMapId: "gatehouse",
        sourceMapName: "Gatehouse",
        source: "legacy-connection",
        label: "Legacy gate",
        sourceConnectionIndex: 0,
      },
      {
        targetKey: "map:field/placement:west-entry",
        targetMapId: "field",
        targetPlacementId: "west-entry",
        sourceKey: "map:gatehouse/placement:override-door/event:cross",
        sourceMapId: "gatehouse",
        sourceMapName: "Gatehouse",
        source: "placement-event",
        label: "Override door",
        sourcePlacementId: "override-door",
        sourceEventId: "cross",
        trigger: "interact",
      },
      {
        targetKey: "map:field/placement:west-entry",
        targetMapId: "field",
        targetPlacementId: "west-entry",
        sourceKey: "map:gatehouse/placement:painted-door/event:cross",
        sourceMapId: "gatehouse",
        sourceMapName: "Gatehouse",
        source: "placement-event",
        label: "Painted door",
        sourcePlacementId: "painted-door",
        sourceEventId: "cross",
        trigger: "player_touch",
      },
    ]);
  expect(collectMapArrivalBacklinks([target, otherTarget, source], "other-field", "west-entry"))
    .toEqual([
      expect.objectContaining({
        targetKey: "map:other-field/placement:west-entry",
        sourceKey: "map:gatehouse/placement:other-door/event:cross",
        sourcePlacementId: "other-door",
      }),
    ]);
  expect(collectMapArrivalBacklinks([target, otherTarget, source], "field", "missing"))
    .toEqual([]);
});
