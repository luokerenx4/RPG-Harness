import { describe, expect, test } from "bun:test";
import {
  adjacentResourceKeys,
  conditionEditorMode,
  collectMapEditorTiles,
  createMapPlacementDraft,
  createConditionDraft,
  eventTriggerMeta,
  filterPlacementPaletteResources,
  hasMapDraftChanges,
  mapEventCommandSummary,
  mapPlacementResourceLabel,
  nextAvailableMapCell,
  nudgeMapPlayerStart,
  nextProjectTreeIndex,
  parseResourceScalarFields,
  patchResourceScalarFields,
  paintMapLayerTile,
  resourceChoices,
  resolveProjectReference,
  resizeMapLayout,
  summarizeMapTreeResource,
  summarizeMapValidation,
} from "./pages/Project";
import type { MapDef, MapLayoutDef, MapPlacementDef, ProjectResourceNode } from "@rpg-harness/engine";

describe("Studio database record fields", () => {
  const source = [
    "---",
    "id: soul_shard",
    "name: 魂石の欠片",
    "sell_value: 30 # economy note",
    "stack: true",
    "stats:",
    "  affection: { initial: 0 }",
    "characters: [kagari]",
    "---",
    "",
    "Body remains untouched.",
    "",
  ].join("\n");

  test("projects safe top-level scalars as editable database fields", () => {
    expect(parseResourceScalarFields(source)).toEqual([
      { key: "id", kind: "text", value: "soul_shard", displayValue: "soul_shard", editable: false },
      { key: "name", kind: "text", value: "魂石の欠片", displayValue: "魂石の欠片", editable: true },
      { key: "sell_value", kind: "number", value: "30", displayValue: "30", editable: true },
      { key: "stack", kind: "boolean", value: true, displayValue: "true", editable: true },
      { key: "stats", kind: "complex", value: "", displayValue: "{…}", editable: false },
      { key: "characters", kind: "complex", value: "[kagari]", displayValue: "[kagari]", editable: false },
    ]);
  });

  test("patches only selected metadata scalars and preserves comments and body", () => {
    expect(patchResourceScalarFields(source, {
      name: "封じた欠片 # 試作",
      sell_value: "45",
      stack: false,
      id: "must_not_change",
    })).toBe([
      "---",
      "id: soul_shard",
      'name: "封じた欠片 # 試作"',
      "sell_value: 45 # economy note",
      "stack: false",
      "stats:",
      "  affection: { initial: 0 }",
      "characters: [kagari]",
      "---",
      "",
      "Body remains untouched.",
      "",
    ].join("\n"));
  });
});

describe("Studio map event resource picker", () => {
  test("moves between records of the same database kind without crossing groups", () => {
    const resources = [
      { key: "character:kagari", kind: "character", id: "kagari", label: "Kagari", refs: [] },
      { key: "map:swamp", kind: "map", id: "swamp", label: "Swamp", refs: [] },
      { key: "character:kasumi", kind: "character", id: "kasumi", label: "Kasumi", refs: [] },
      { key: "character:mio", kind: "character", id: "mio", label: "Mio", refs: [] },
    ] as ProjectResourceNode[];
    expect(adjacentResourceKeys(resources, "character:kasumi")).toEqual({
      previous: resources[0]!,
      next: resources[3]!,
      position: 1,
      total: 3,
    });
    expect(adjacentResourceKeys(resources, "map:swamp")).toEqual({
      previous: null,
      next: null,
      position: 0,
      total: 1,
    });
  });

  test("resolves inspector relationships against the authoritative project registry", () => {
    const resources = [
      { key: "asset:portraits/kagari", kind: "asset", id: "portraits/kagari", label: "篝 portrait", refs: [] },
    ] as ProjectResourceNode[];
    expect(resolveProjectReference(resources, "asset:portraits/kagari")).toBe(resources[0]!);
    expect(resolveProjectReference(resources, "asset:missing")).toBeNull();
  });

  test("wraps RPG-style keyboard navigation across long project trees", () => {
    expect(nextProjectTreeIndex(0, 5, -1)).toBe(4);
    expect(nextProjectTreeIndex(4, 5, 1)).toBe(0);
    expect(nextProjectTreeIndex(-1, 5, 1)).toBe(0);
    expect(nextProjectTreeIndex(-1, 5, -1)).toBe(4);
    expect(nextProjectTreeIndex(0, 0, 1)).toBe(-1);
  });

  test("filters and alphabetizes records for the selected resource kind", () => {
    const resources = [
      { key: "script:z", kind: "script", id: "z", label: "Zulu", refs: [] },
      { key: "map:a", kind: "map", id: "a", label: "Alpha map", refs: [] },
      { key: "script:a", kind: "script", id: "a", label: "Alpha", refs: [] },
    ] as ProjectResourceNode[];
    expect(resourceChoices(resources, "script").map((resource) => resource.id)).toEqual(["a", "z"]);
    expect(resourceChoices(resources, undefined)).toEqual([]);
  });

  test("searches the map object palette by label, stable id, and database kind", () => {
    const resources = [
      { key: "script:memory", kind: "script", id: "memory", label: "失われた記憶", refs: [] },
      { key: "character:kagari", kind: "character", id: "kagari", label: "篝", refs: [] },
      { key: "test:kagari", kind: "test", id: "kagari", label: "Kagari QA", refs: [] },
    ] as ProjectResourceNode[];
    expect(filterPlacementPaletteResources(resources, "篝").map((row) => row.key)).toEqual(["character:kagari"]);
    expect(filterPlacementPaletteResources(resources, "kagari").map((row) => row.key)).toEqual(["character:kagari"]);
    expect(filterPlacementPaletteResources(resources, "scripts").map((row) => row.key)).toEqual(["script:memory"]);
    expect(filterPlacementPaletteResources(resources, "").map((row) => row.key).sort()).toEqual([
      "character:kagari",
      "script:memory",
    ]);
  });

  test("uses database labels for placed map resources without replacing stable instance ids", () => {
    const placement = {
      id: "altar_shard",
      at: { x: 5, y: 2 },
      z: 0,
      footprint: { width: 1, height: 1 },
      collision: "block",
      visible: true,
      resource: { kind: "item", id: "soul_shard" },
      events: [],
    } as MapPlacementDef;
    const resources = [
      { key: "item:soul_shard", kind: "item", id: "soul_shard", label: "魂石の欠片", refs: [] },
    ] as ProjectResourceNode[];
    expect(mapPlacementResourceLabel(placement, resources)).toBe("魂石の欠片");
    expect(placement.id).toBe("altar_shard");
  });

  test("creates accessible object-palette placements with RPG Maker event defaults", () => {
    const script = {
      key: "script:memory",
      kind: "script",
      id: "memory",
      label: "失われた記憶",
      refs: [],
    } as ProjectResourceNode;
    expect(createMapPlacementDraft(script, [], { x: 3, y: 2 })).toEqual({
      id: "memory",
      at: { x: 3, y: 2 },
      resource: { kind: "script", id: "memory" },
      z: 0,
      footprint: { width: 1, height: 1 },
      collision: "none",
      visible: true,
      events: [{ id: "activate", trigger: "interact", label: "失われた記憶", order: 0 }],
    });
    expect(createMapPlacementDraft(undefined, [{
      id: "event",
      at: { x: 0, y: 0 },
      z: 0,
      footprint: { width: 1, height: 1 },
      collision: "trigger",
      visible: true,
      events: [],
    }], { x: 1, y: 0 })).toMatchObject({
      id: "event_2",
      at: { x: 1, y: 0 },
      collision: "trigger",
      events: [{ id: "page_1", trigger: "interact", label: "Event", order: 0 }],
    });
  });

  test("places palette objects on the first cell outside existing footprints", () => {
    expect(nextAvailableMapCell({
      width: 3,
      height: 2,
      tileWidth: 32,
      tileHeight: 32,
      playerStart: { x: 0, y: 0 },
      layers: [],
      regions: [],
    }, [{
      id: "counter",
      at: { x: 0, y: 0 },
      z: 0,
      footprint: { width: 2, height: 1 },
      collision: "block",
      visible: true,
      events: [],
    }])).toEqual({ x: 2, y: 0 });
  });

  test("nudges the player start on the grid while clamping every edge", () => {
    const layout: MapLayoutDef = {
      width: 3,
      height: 2,
      tileWidth: 32,
      tileHeight: 32,
      layers: [],
      regions: [],
    };
    expect(nudgeMapPlayerStart(layout, { x: 1, y: 1 }, "ArrowRight")).toEqual({ x: 2, y: 1 });
    expect(nudgeMapPlayerStart(layout, { x: 2, y: 1 }, "ArrowRight")).toEqual({ x: 2, y: 1 });
    expect(nudgeMapPlayerStart(layout, { x: 0, y: 0 }, "ArrowUp")).toEqual({ x: 0, y: 0 });
  });

  test("summarizes event-page commands as player-facing RPG operations", () => {
    const resources = [
      { key: "map:crossroads", kind: "map", id: "crossroads", label: "三叉路", refs: [] },
      { key: "script:memory", kind: "script", id: "memory", label: "失われた記憶", refs: [] },
    ] as ProjectResourceNode[];
    const placement = {
      id: "gate",
      resource: { kind: "map", id: "crossroads" },
    } as MapPlacementDef;
    expect(mapEventCommandSummary(
      { id: "leave", trigger: "player_touch", order: 0 },
      placement,
      resources,
    )).toBe("Transfer player → 三叉路 · placement resource");
    expect(mapEventCommandSummary(
      { id: "memory", trigger: "interact", run: { kind: "script", id: "memory" }, order: 0 },
      placement,
      resources,
    )).toBe("Run script → 失われた記憶");
  });

  test("tracks only authoritative spatial map draft changes", () => {
    const saved = {
      id: "shrine",
      name: "Shrine",
      description: "saved copy",
      layout: undefined,
      placements: [],
    } as MapDef;
    expect(hasMapDraftChanges(saved, { ...saved, description: "project refresh" })).toBe(false);
    expect(hasMapDraftChanges(saved, {
      ...saved,
      placements: [{
        id: "gate",
        at: { x: 0, y: 0 },
        z: 0,
        footprint: { width: 1, height: 1 },
        collision: "trigger",
        visible: true,
        events: [],
      }],
    })).toBe(true);
  });

  test("summarizes the validated map surface for a save receipt", () => {
    expect(summarizeMapValidation({
      layout: {
        width: 12,
        height: 8,
        tileWidth: 32,
        tileHeight: 32,
        layers: [],
        regions: [],
      },
      placements: [{
        id: "gate",
        at: { x: 0, y: 0 },
        z: 0,
        footprint: { width: 1, height: 1 },
        collision: "trigger",
        visible: true,
        events: [{ id: "leave", trigger: "player_touch", order: 0 }],
      }],
    })).toBe("12 × 8 grid · 1 placement · 1 event page");
    expect(summarizeMapValidation({ placements: [] })).toBe(
      "semantic node map · 0 placements · 0 event pages",
    );
  });

  test("distinguishes spatial maps from semantic nodes in the World tree", () => {
    expect(summarizeMapTreeResource({
      layout: {
        width: 14,
        height: 10,
        tileWidth: 32,
        tileHeight: 32,
        layers: [],
        regions: [{ id: "bank", name: "River bank", x: 0, y: 0, width: 4, height: 2 }],
      },
      placements: [{ id: "gate" }, { id: "altar" }],
    } as unknown as MapDef)).toEqual({
      spatial: true,
      label: "14×10 GRID · 2 OBJECTS · 1 REGION",
    });
    expect(summarizeMapTreeResource({ placements: [{ id: "gate" }] } as unknown as MapDef)).toEqual({
      spatial: false,
      label: "NODE MAP · 1 RESOURCE",
    });
    expect(summarizeMapTreeResource(undefined)).toBeNull();
  });

  test("paints and resizes canonical tile-layer matrices without losing authored cells", () => {
    const layout: MapLayoutDef = {
      width: 3,
      height: 2,
      tileWidth: 32,
      tileHeight: 32,
      playerStart: { x: 2, y: 1 },
      layers: [{ id: "ground", kind: "tile", z: 0, visible: true }, {
        id: "walls",
        kind: "collision",
        z: 1,
        visible: true,
        tiles: [[0, 1, 0], [0, 0, 0]],
      }],
      regions: [],
    };
    const painted = paintMapLayerTile(layout, "ground", 2, 1, 7);
    expect(painted.layers[0]?.tiles).toEqual([[0, 0, 0], [0, 0, 7]]);
    expect(collectMapEditorTiles(painted)).toEqual([
      { layerId: "ground", kind: "tile", tile: 7, x: 2, y: 1, z: 0 },
      { layerId: "walls", kind: "collision", tile: 1, x: 1, y: 0, z: 1 },
    ]);
    const resized = resizeMapLayout(painted, { width: 2, height: 1 });
    expect(resized.playerStart).toEqual({ x: 1, y: 0 });
    expect(resized.layers[0]?.tiles).toEqual([[0, 0]]);
    expect(resized.layers[1]?.tiles).toEqual([[0, 1]]);
  });

  test("creates resource-backed RPG Maker style condition drafts", () => {
    const resources = [
      { key: "character:kagari", kind: "character", id: "kagari", label: "Kagari", refs: [] },
      { key: "item:shard", kind: "item", id: "shard", label: "Shard", refs: [] },
      { key: "script:intro", kind: "script", id: "intro", label: "Intro", refs: [] },
      { key: "skill:dash", kind: "skill", id: "dash", label: "Dash", refs: [] },
    ] as ProjectResourceNode[];
    expect(createConditionDraft("affection", resources)).toEqual({ affection: { character: "kagari", min: 1 } });
    expect(createConditionDraft("scriptCompleted", resources)).toEqual({ scriptCompleted: "intro" });
    expect(createConditionDraft("inventory", resources)).toEqual({ inventory: { itemId: "shard", min: 1 } });
    expect(createConditionDraft("switch", resources, [
      { id: "chapter_open", initial: false, label: "Chapter open" },
    ])).toEqual({ switch: { name: "chapter_open", eq: true } });
    expect(createConditionDraft("variable", resources, [], [
      { id: "route", type: "string", initial: "north", label: "Route" },
    ])).toEqual({ variable: { name: "route", eq: "north" } });
    expect(conditionEditorMode({ all: [] })).toBe("advanced");
    expect(conditionEditorMode({ knowsSkill: "dash" })).toBe("knowsSkill");
    expect(conditionEditorMode(undefined)).toBe("none");
  });

  test("presents engine trigger ids as readable event-page controls", () => {
    expect(eventTriggerMeta("interact")).toEqual({
      icon: "◎",
      label: "Action Button",
      description: "Runs when the player deliberately interacts with this object.",
    });
    expect(eventTriggerMeta("quest:resolved")).toEqual({
      icon: "⌁",
      label: "quest · resolved",
      description: "Custom engine trigger: quest:resolved",
    });
  });
});
