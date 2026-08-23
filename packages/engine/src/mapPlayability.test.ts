import { describe, expect, test } from "bun:test";
import { analyzeMapPlayability } from "./mapPlayability";
import { makeGame } from "./test-utils";
import type {
  MapDef,
  MapEventTrigger,
  MapPlacementDef,
} from "./types";

describe("analyzeMapPlayability", () => {
  test("uses every arrival form as an ingress and walks out of blocked landings", () => {
    const target: MapDef = {
      id: "target",
      name: "Target",
      description: "",
      layout: {
        width: 5,
        height: 1,
        tileWidth: 32,
        tileHeight: 32,
        playerStart: { x: 0, y: 0 },
        layers: [{
          id: "collision",
          kind: "collision",
          z: 0,
          visible: false,
          tiles: [[1, 0, 1, 0, 1]],
        }],
        regions: [],
      },
      placements: [
        placement("landing", 4, 0),
        placement("console", 3, 0, "manual"),
      ],
    };
    const placementSource: MapDef = {
      id: "placement-source",
      name: "Placement source",
      description: "",
      placements: [{
        ...placement("gate", 0, 0, "manual", {
          visible: false,
          resource: { kind: "map", id: target.id },
        }),
        events: [{
          id: "run",
          trigger: "manual",
          arrival: { placementId: "landing" },
          requires: { switch: { name: "route_open", eq: true } },
          order: 0,
        }],
      }],
    };
    const coordinateSource: MapDef = {
      id: "coordinate-source",
      name: "Coordinate source",
      description: "",
      connections: [{
        dir: "Coordinate",
        target: target.id,
        arrival: { at: { x: 4, y: 0 } },
      }],
    };
    const defaultSource: MapDef = {
      id: "default-source",
      name: "Default source",
      description: "",
      connections: [{ dir: "Default", target: target.id }],
    };
    const maps = [placementSource, coordinateSource, defaultSource, target];

    const diagnostics = analyzeMapPlayability(maps);

    expect(diagnostics.filter(({ code }) => code === "blocked-player-start")).toHaveLength(1);
    expect(diagnostics.filter(({ code }) => code === "blocked-route-arrival")).toHaveLength(2);
    expect(diagnostics.some(({ code }) => code === "interaction-unreachable")).toBe(false);
    expect(diagnostics.some(({ mapId }) => mapId === placementSource.id)).toBe(false);
    expect(diagnostics.find(({ sourceKey }) =>
      sourceKey === "map:placement-source/placement:gate/event:run"
    )).toMatchObject({
      mapId: target.id,
      path: "map placement-source.placements[gate].events[run].arrival",
      code: "blocked-route-arrival",
      severity: "warning",
      placementId: "gate",
      eventId: "run",
      sourceMapId: "placement-source",
    });
    expect(diagnostics.find(({ sourceKey }) =>
      sourceKey === "map:coordinate-source/legacy-connection:0"
    )?.path).toBe("map coordinate-source.connections[0].arrival");
    expect(analyzeMapPlayability(makeGame({ maps }))).toEqual(diagnostics);
  });

  test("reports only player-operable spatial event failures", () => {
    const map: MapDef = {
      id: "field",
      name: "Field",
      description: "",
      layout: {
        width: 7,
        height: 5,
        tileWidth: 32,
        tileHeight: 32,
        playerStart: { x: 0, y: 2 },
        layers: [
          { id: "objects", kind: "object", z: 10, visible: true },
          { id: "hidden", kind: "object", z: 20, visible: false },
          {
            id: "collision",
            kind: "collision",
            z: 0,
            visible: false,
            tiles: Array.from({ length: 5 }, () => [0, 0, 0, 1, 0, 0, 0]),
          },
        ],
        regions: [],
      },
      placements: [
        placement("sealed-touch", 1, 0, "player_touch", { collision: "block" }),
        placement("far-touch", 5, 1, "player_touch", { collision: "trigger" }),
        placement("hidden-manual", 1, 3, "manual", { visible: false }),
        placement("hidden-layer", 2, 3, "interact", { layer: "hidden" }),
        placement("far-manual", 5, 3, "manual"),
        placement("event-touch", 1, 1, "event_touch"),
        placement("parallel", 2, 1, "parallel"),
        placement("automatic", 5, 0, "autorun", { visible: false }),
        placement("on-enter", 5, 2, "map_enter", { visible: false }),
        placement("module-owned", 5, 4, "plugin:touch", { visible: false }),
        {
          ...placement("disabled-touch", 6, 4, "player_touch", { collision: "block" }),
          events: [{ id: "run", trigger: "player_touch", chance: 0, order: 0 }],
        },
      ],
    };

    const diagnostics = analyzeMapPlayability([map]);

    expect(diagnostics.map(({ placementId, code }) => [placementId, code])).toEqual([
      ["sealed-touch", "player-touch-no-walkable-entry"],
      ["far-touch", "player-touch-unreachable"],
      ["hidden-manual", "interaction-hidden"],
      ["hidden-layer", "interaction-hidden"],
      ["far-manual", "interaction-unreachable"],
      ["event-touch", "unscheduled-spatial-trigger"],
      ["parallel", "unscheduled-spatial-trigger"],
    ]);
    expect(diagnostics.every(({ severity }) => severity === "warning")).toBe(true);
    expect(diagnostics.find(({ placementId }) => placementId === "hidden-manual")?.path)
      .toBe("map field.placements[hidden-manual].visible");
    expect(diagnostics.find(({ placementId }) => placementId === "hidden-layer")?.path)
      .toBe("map field.placements[hidden-layer].layer");
    expect(diagnostics.find(({ placementId }) => placementId === "far-touch"))
      .toMatchObject({
        eventId: "run",
        sourceKey: "map:field/placement:far-touch/event:run",
      });
  });

  test("requires a movement edge into a player-touch tile", () => {
    const trapped: MapDef = {
      id: "trapped",
      name: "Trapped",
      description: "",
      layout: {
        width: 1,
        height: 1,
        tileWidth: 32,
        tileHeight: 32,
        playerStart: { x: 0, y: 0 },
        layers: [],
        regions: [],
      },
      placements: [placement("arrival-trigger", 0, 0, "player_touch", {
        collision: "trigger",
      })],
    };

    expect(analyzeMapPlayability([trapped])).toContainEqual(expect.objectContaining({
      mapId: "trapped",
      placementId: "arrival-trigger",
      code: "player-touch-unreachable",
    }));
  });

  test("does not let spatially unscheduled routes seed isolated target islands", () => {
    const target: MapDef = {
      id: "island",
      name: "Island",
      description: "",
      layout: {
        width: 3,
        height: 1,
        tileWidth: 32,
        tileHeight: 32,
        playerStart: { x: 0, y: 0 },
        layers: [{
          id: "wall",
          kind: "collision",
          z: 0,
          visible: false,
          tiles: [[0, 1, 0]],
        }],
        regions: [],
      },
      placements: [placement("isolated-console", 2, 0, "manual")],
    };
    const sourceFor = (trigger: MapEventTrigger, spatial: boolean): MapDef => ({
      id: `source-${trigger}-${spatial ? "field" : "node"}`,
      name: "Source",
      description: "",
      ...(spatial ? {
        layout: {
          width: 1,
          height: 1,
          tileWidth: 32,
          tileHeight: 32,
          layers: [],
          regions: [],
        },
      } : {}),
      placements: [{
        ...placement("dead-route", 0, 0, trigger, {
          resource: { kind: "map", id: target.id },
        }),
        events: [{
          id: "run",
          trigger,
          arrival: { at: { x: 2, y: 0 } },
          order: 0,
        }],
      }],
    });

    for (const source of [
      sourceFor("parallel", false),
      sourceFor("parallel", true),
      sourceFor("event_touch", true),
    ]) {
      expect(analyzeMapPlayability([source, target])).toContainEqual(expect.objectContaining({
        mapId: target.id,
        placementId: "isolated-console",
        code: "interaction-unreachable",
      }));
    }

    expect(analyzeMapPlayability([sourceFor("event_touch", false), target]))
      .not.toContainEqual(expect.objectContaining({
        mapId: target.id,
        placementId: "isolated-console",
        code: "interaction-unreachable",
      }));
  });

  test("ignores event scheduling and visibility on node maps", () => {
    const nodeMap: MapDef = {
      id: "node",
      name: "Node",
      description: "",
      placements: [
        placement("manual", 0, 0, "manual", { visible: false }),
        placement("touch", 0, 0, "player_touch", { collision: "block" }),
        placement("event-touch", 0, 0, "event_touch"),
        placement("parallel", 0, 0, "parallel"),
      ],
    };

    expect(analyzeMapPlayability([nodeMap])).toEqual([]);
  });
});

function placement(
  id: string,
  x: number,
  y: number,
  trigger?: MapEventTrigger,
  overrides: Partial<Omit<MapPlacementDef, "id" | "at" | "events">> = {},
): MapPlacementDef {
  return {
    id,
    at: { x, y },
    z: 0,
    footprint: { width: 1, height: 1 },
    collision: "none",
    visible: true,
    ...overrides,
    events: trigger === undefined
      ? []
      : [{ id: "run", trigger, order: 0 }],
  };
}
