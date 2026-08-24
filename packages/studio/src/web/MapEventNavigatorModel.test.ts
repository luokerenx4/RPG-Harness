import { describe, expect, test } from "bun:test";
import type {
  MapDef,
  MapPlacementDef,
  MapPlacementEventDef,
  ProjectResourceNode,
} from "@rpg-harness/engine";
import {
  MAP_EVENT_NAVIGATOR_RESULT_LIMIT,
  buildMapEventNavigatorIndex,
  normalizeMapEventNavigatorText,
  resolveMapEventNavigatorTarget,
  searchMapEventNavigatorIndex,
} from "./MapEventNavigatorModel";

const resources = [
  {
    key: "map:keep",
    kind: "map",
    id: "keep",
    label: "ＭＯＯＮ 天守",
    refs: [],
  },
  {
    key: "script:memory",
    kind: "script",
    id: "memory",
    label: "失われた記憶",
    refs: [],
  },
] satisfies ProjectResourceNode[];

function event(
  id: string,
  extra: Partial<MapPlacementEventDef> = {},
): MapPlacementEventDef {
  return {
    id,
    trigger: "interact",
    order: 0,
    ...extra,
  };
}

function placement(
  id: string,
  extra: Partial<MapPlacementDef> = {},
): MapPlacementDef {
  return {
    id,
    at: { x: 0, y: 0 },
    z: 0,
    footprint: { width: 1, height: 1 },
    collision: "trigger",
    visible: true,
    events: [],
    ...extra,
  };
}

function navigatorMap(extra: Partial<MapDef> = {}): MapDef {
  return {
    id: "castle",
    name: "Castle",
    description: "Map Event Navigator fixture",
    ...extra,
  };
}

const authoredPlacements: MapPlacementDef[] = [
  placement("gate", {
    at: { x: 4, y: 2 },
    layer: "actors",
    facing: "south",
    resource: { kind: "map", id: "keep" },
    events: [
      event("open", {
        label: "開門",
        trigger: "player_touch",
        arrival: { placementId: "south_gate" },
        order: 20,
      }),
      event("memory", {
        trigger: "custom:moon_rite",
        run: { kind: "script", id: "memory" },
        order: 1,
      }),
    ],
  }),
  placement("marker", {
    at: { x: 9, y: 7 },
    visible: false,
    events: [event("inspect", { label: "Inspect marker" })],
  }),
];

describe("Studio Map Event Navigator model", () => {
  test("projects spatial and folded node maps from the same authored placement order", () => {
    const spatial = navigatorMap({
      layout: {
        width: 12,
        height: 8,
        tileWidth: 32,
        tileHeight: 32,
        layers: [{ id: "actors", kind: "object", z: 1, visible: true }],
        regions: [],
      },
      placements: authoredPlacements,
    });
    const node = navigatorMap({ placements: authoredPlacements });
    const before = structuredClone(spatial);
    const diagnostics = new Map([["gate", 2]]);

    const spatialIndex = buildMapEventNavigatorIndex(spatial, resources, diagnostics);
    const nodeIndex = buildMapEventNavigatorIndex(node, resources, diagnostics);

    expect(spatialIndex).toEqual(nodeIndex);
    expect(spatialIndex.placementCount).toBe(2);
    expect(spatialIndex.eventCount).toBe(3);
    expect(spatialIndex.rows.map((row) => row.key)).toEqual([
      "placement:0",
      "placement:0:event:0",
      "placement:0:event:1",
      "placement:1",
      "placement:1:event:0",
    ]);
    // Event array order is authoritative while a dirty draft is being edited;
    // numeric `order` must not silently reorder the search results.
    expect(spatialIndex.rows.slice(1, 3).map((row) => row.eventId)).toEqual([
      "open",
      "memory",
    ]);
    expect(spatialIndex.rows[0]).toMatchObject({
      kind: "placement",
      placementId: "gate",
      label: "ＭＯＯＮ 天守",
      placementLabel: "ＭＯＯＮ 天守",
      canonicalPath: "map:castle/placement:gate",
      at: { x: 4, y: 2 },
      layer: "actors",
      facing: "south",
      diagnosticCount: 2,
      destination: {
        mode: "exact",
        locator: { kind: "placement", placementId: "gate" },
      },
    });
    expect(spatialIndex.rows[1]).toMatchObject({
      kind: "event",
      eventId: "open",
      label: "開門",
      trigger: "player_touch",
      targetKey: "map:keep",
      targetLabel: "ＭＯＯＮ 天守",
      canonicalPath: "map:castle/placement:gate/event:open",
      destination: {
        mode: "exact",
        locator: { kind: "event", placementId: "gate", eventId: "open" },
      },
    });
    expect(spatialIndex.rows[2]).toMatchObject({
      eventId: "memory",
      label: "custom · moon rite",
      targetKey: "script:memory",
      targetLabel: "失われた記憶",
    });
    expect(spatial).toEqual(before);
  });

  test("normalizes NFKC and lower-case AND searches across placement and event context", () => {
    const index = buildMapEventNavigatorIndex(
      navigatorMap({ placements: authoredPlacements }),
      resources,
    );

    expect(normalizeMapEventNavigatorText("ＭＯＯＮ Player_Touch")).toBe("moon player_touch");
    expect(searchMapEventNavigatorIndex(index, " moon   天守  開門 ").rows.map((row) => row.key)).toEqual([
      "placement:0:event:0",
    ]);
    expect(searchMapEventNavigatorIndex(index, "GATE 失われた記憶").rows.map((row) => row.eventId)).toEqual([
      "memory",
    ]);
    expect(searchMapEventNavigatorIndex(index, "4,2 actors").rows.map((row) => row.key)).toEqual([
      "placement:0",
      "placement:0:event:0",
      "placement:0:event:1",
    ]);
    expect(searchMapEventNavigatorIndex(index, "facing south").rows.map((row) => row.key)).toEqual([
      "placement:0",
      "placement:0:event:0",
      "placement:0:event:1",
    ]);
    expect(searchMapEventNavigatorIndex(index, "south_gate player touch").rows.map((row) => row.eventId)).toEqual([
      "open",
    ]);
    expect(searchMapEventNavigatorIndex(index, "no such row")).toEqual({
      rows: [],
      total: 0,
      truncated: false,
    });
  });

  test("caps result materialization at one hundred rows", () => {
    const manyPlacements = Array.from(
      { length: MAP_EVENT_NAVIGATOR_RESULT_LIMIT + 37 },
      (_, index) => placement(`event_${index}`),
    );
    const index = buildMapEventNavigatorIndex(
      navigatorMap({ placements: manyPlacements }),
      [],
    );

    expect(searchMapEventNavigatorIndex(index, "", 1_000)).toMatchObject({
      total: 137,
      truncated: true,
    });
    expect(searchMapEventNavigatorIndex(index, "", 1_000).rows).toHaveLength(100);
    expect(searchMapEventNavigatorIndex(index, "", 12).rows).toHaveLength(12);
    expect(searchMapEventNavigatorIndex(index, "", 0)).toEqual({
      rows: [],
      total: 137,
      truncated: true,
    });
  });

  test("keeps invalid authored IDs visible without creating ambiguous exact destinations", () => {
    const invalid = navigatorMap({
      placements: [
        placement("", { events: [event("page")] }),
        placement("dup", { events: [event("first")] }),
        placement("dup", { events: [event("second")] }),
        placement("valid", {
          events: [
            event(""),
            event("same"),
            event("same"),
            event("ok"),
          ],
        }),
      ],
    });
    const index = buildMapEventNavigatorIndex(invalid, []);
    const byKey = new Map(index.rows.map((row) => [row.key, row]));

    expect(new Set(index.rows.map((row) => row.key)).size).toBe(index.rows.length);
    expect(byKey.get("placement:0")?.destination).toEqual({
      mode: "disabled",
      problem: "placement-id-empty",
    });
    expect(byKey.get("placement:0:event:0")?.destination).toEqual({
      mode: "disabled",
      problem: "placement-id-empty",
    });
    expect(byKey.get("placement:1")?.destination).toEqual({
      mode: "disabled",
      problem: "placement-id-duplicate",
    });
    expect(byKey.get("placement:2:event:0")?.destination).toEqual({
      mode: "disabled",
      problem: "placement-id-duplicate",
    });
    expect(byKey.get("placement:3:event:0")?.destination).toEqual({
      mode: "placement-only",
      locator: { kind: "placement", placementId: "valid" },
      problem: "event-id-empty",
    });
    expect(byKey.get("placement:3:event:1")?.destination).toEqual({
      mode: "placement-only",
      locator: { kind: "placement", placementId: "valid" },
      problem: "event-id-duplicate",
    });
    expect(byKey.get("placement:3:event:3")?.destination).toEqual({
      mode: "exact",
      locator: { kind: "event", placementId: "valid", eventId: "ok" },
    });
    expect(byKey.get("placement:3:event:3")?.canonicalPath).toBe(
      "map:castle/placement:valid/event:ok",
    );
    expect(byKey.get("placement:3:event:1")).not.toHaveProperty("canonicalPath");
    expect(byKey.get("placement:1")).not.toHaveProperty("canonicalPath");
  });

  test("re-resolves locators against the latest draft and fails closed after stale edits", () => {
    const base = navigatorMap({
      placements: [placement("gate", { events: [event("open")] })],
    });
    const before = structuredClone(base);

    const placementResolution = resolveMapEventNavigatorTarget(base, {
      kind: "placement",
      placementId: "gate",
    });
    expect(placementResolution).toMatchObject({
      ok: true,
      placement: { id: "gate" },
    });
    expect(resolveMapEventNavigatorTarget(base, {
      kind: "event",
      placementId: "gate",
      eventId: "open",
    })).toMatchObject({
      ok: true,
      placement: { id: "gate" },
      eventId: "open",
    });

    expect(resolveMapEventNavigatorTarget(
      navigatorMap({ placements: [] }),
      { kind: "placement", placementId: "gate" },
    )).toMatchObject({ ok: false, code: "placement-not-found" });
    expect(resolveMapEventNavigatorTarget(
      navigatorMap({ placements: [placement("gate"), placement("gate")] }),
      { kind: "placement", placementId: "gate" },
    )).toMatchObject({ ok: false, code: "placement-id-duplicate" });
    expect(resolveMapEventNavigatorTarget(
      navigatorMap({ placements: [placement("gate", { events: [] })] }),
      { kind: "event", placementId: "gate", eventId: "open" },
    )).toMatchObject({ ok: false, code: "event-not-found" });
    expect(resolveMapEventNavigatorTarget(
      navigatorMap({ placements: [placement("gate", { events: [event("open"), event("open")] })] }),
      { kind: "event", placementId: "gate", eventId: "open" },
    )).toMatchObject({ ok: false, code: "event-id-duplicate" });
    expect(resolveMapEventNavigatorTarget(base, {
      kind: "placement",
      placementId: " ",
    })).toMatchObject({ ok: false, code: "placement-id-empty" });
    expect(resolveMapEventNavigatorTarget(base, {
      kind: "event",
      placementId: "gate",
      eventId: " ",
    })).toMatchObject({ ok: false, code: "event-id-empty" });
    expect(base).toEqual(before);
  });
});
