import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  adjacentResourceKeys,
  conditionEditorMode,
  collectMapEditorTiles,
  createMapPlacementDraft,
  duplicateMapPlacementDraft,
  createConditionDraft,
  eventTriggerMeta,
  EventPagesEditor,
  filterPlacementPaletteResources,
  fillMapLayerTiles,
  groupMapTreeResources,
  groupedStacks,
  hasMapDraftChanges,
  mapEventCommandSummary,
  mapEventArrivalSummary,
  mapPaletteResourceGraphicPath,
  mapPlacementEventSummary,
  mapPlacementGraphicPath,
  mapDraftHistoryReducer,
  mapPlacementResourceLabel,
  mapTreeChainKey,
  moveMapLayer,
  createMapDraftHistory,
  nextAvailableMapCell,
  nextStackPlacementId,
  nudgeMapPlayerStart,
  nextProjectTreeIndex,
  parseResourceScalarFields,
  patchResourceScalarFields,
  paintMapLayerTile,
  reconcileMapDraftAfterSave,
  replaceMapEventArrival,
  replaceMapEventRunTarget,
  replaceMapPlacementResourceTarget,
  resourceChoices,
  resolveProjectReference,
  resizeMapLayout,
  summarizeMapTreeResource,
  summarizeMapValidation,
  studioTileAtlasStyle,
} from "./pages/Project";
import type { MapDef, MapLayoutDef, MapPlacementDef, MapPlacementEventDef, ProjectResourceNode } from "@rpg-harness/engine";
import type { ProjectAssetPreview } from "./api";

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

  test("adds and removes the optional character map_sprite without touching prose", () => {
    const character = "---\nid: keeper\nname: Keeper\n---\n\nBiography.\n";
    const withSprite = patchResourceScalarFields(character, {
      map_sprite: "assets/sprites/keeper-field",
    });
    expect(withSprite).toBe("---\nid: keeper\nname: Keeper\nmap_sprite: assets/sprites/keeper-field\n---\n\nBiography.\n");
    expect(patchResourceScalarFields(withSprite, { map_sprite: "" })).toBe(character);
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

  test("inherits a character sprite while preserving placement graphic overrides", () => {
    const placement = {
      id: "keeper",
      resource: { kind: "character", id: "keeper" },
    } as MapPlacementDef;
    const resources = [{
      key: "character:keeper",
      kind: "character",
      id: "keeper",
      label: "Keeper",
      refs: ["asset:assets/sprites/keeper"],
    }] as ProjectResourceNode[];
    const assets = [{
      path: "assets/sprites/keeper",
      kind: "sprite",
      placeholder: "Keeper map sprite",
      renderings: {},
    }] as ProjectAssetPreview[];
    expect(mapPlacementGraphicPath(placement, resources, assets)).toBe("assets/sprites/keeper");
    expect(mapPlacementGraphicPath({ ...placement, asset: "assets/sprites/disguise" }, resources, assets))
      .toBe("assets/sprites/disguise");
  });

  test("prefers map sprites when the object palette can preview several asset references", () => {
    const resource = {
      key: "character:keeper",
      kind: "character",
      id: "keeper",
      label: "Keeper",
      refs: ["asset:assets/portraits/keeper", "asset:assets/sprites/keeper"],
    } as ProjectResourceNode;
    const assets = [
      { path: "assets/portraits/keeper", kind: "portrait", placeholder: "Portrait", renderings: {} },
      { path: "assets/sprites/keeper", kind: "sprite", placeholder: "Sprite", renderings: {} },
    ] as ProjectAssetPreview[];
    expect(mapPaletteResourceGraphicPath(resource, assets)).toBe("assets/sprites/keeper");
    expect(mapPaletteResourceGraphicPath({ ...resource, kind: "asset", id: "assets/portraits/keeper", refs: [] }, assets))
      .toBe("assets/portraits/keeper");
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
    expect(createMapPlacementDraft(script, [], { x: 3, y: 2 }, "actors").layer).toBe("actors");
  });

  test("duplicates a complete RPG event object beside its source with a stable identity", () => {
    const layout: MapLayoutDef = {
      width: 5,
      height: 4,
      tileWidth: 32,
      tileHeight: 32,
      layers: [],
      regions: [],
    };
    const source = {
      id: "gate",
      at: { x: 2, y: 1 },
      resource: { kind: "map", id: "courtyard" },
      z: 2,
      footprint: { width: 1, height: 2 },
      collision: "trigger",
      visible: true,
      requires: { switch: { name: "gate_open", eq: true } },
      events: [{ id: "enter", trigger: "interact", label: "Enter", order: 0 }],
    } as MapPlacementDef;
    const duplicate = duplicateMapPlacementDraft(layout, [source], source);
    expect(duplicate).toEqual({
      ...source,
      id: "gate_copy",
      at: { x: 1, y: 1 },
    });
    expect(duplicate.events).not.toBe(source.events);
    expect(duplicate.requires).not.toBe(source.requires);
    expect(duplicateMapPlacementDraft(layout, [source, duplicate], source).id).toBe("gate_copy_2");
    expect(duplicateMapPlacementDraft(undefined, [source], source)).toEqual({
      ...source,
      id: "gate_copy",
      at: { x: 0, y: 0 },
    });
  });

  test("cycles every object authored on one map cell", () => {
    const placements = ["event_a", "event_b", "event_c"].map((id) => ({
      id,
      at: { x: 4, y: 2 },
      z: 0,
      footprint: { width: 1, height: 1 },
      collision: "none" as const,
      visible: true,
      events: [],
    }));
    expect(groupedStacks([...placements, { ...placements[0]!, id: "elsewhere", at: { x: 1, y: 1 } }])).toEqual([{
      key: "4,2",
      x: 4,
      y: 2,
      ids: ["event_a", "event_b", "event_c"],
    }]);
    expect(nextStackPlacementId(["event_a", "event_b", "event_c"], null)).toBe("event_a");
    expect(nextStackPlacementId(["event_a", "event_b", "event_c"], "event_a")).toBe("event_b");
    expect(nextStackPlacementId(["event_a", "event_b", "event_c"], "event_c")).toBe("event_a");
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
    )).toBe("Transfer player → 三叉路 · placement resource · arrive at map start");
    expect(mapEventCommandSummary(
      { id: "leave", trigger: "player_touch", arrival: { placementId: "south_gate" }, order: 0 },
      placement,
      resources,
    )).toBe("Transfer player → 三叉路 · placement resource · arrive at placement:south_gate");
    expect(mapEventCommandSummary(
      { id: "leave", trigger: "player_touch", arrival: { at: { x: 4, y: 7 } }, order: 0 },
      placement,
      resources,
    )).toBe("Transfer player → 三叉路 · placement resource · arrive at 4,7");
    expect(mapEventCommandSummary(
      { id: "memory", trigger: "interact", run: { kind: "script", id: "memory" }, order: 0 },
      placement,
      resources,
    )).toBe("Run script → 失われた記憶");
    expect(mapEventArrivalSummary(undefined)).toBe("arrive at map start");
  });

  test("clears arrival only when the effective run target changes", () => {
    const inherited: MapPlacementEventDef = {
      id: "leave",
      trigger: "player_touch",
      arrival: { placementId: "south_gate" },
      order: 0,
    };
    const explicit: MapPlacementEventDef = {
      id: "memory",
      trigger: "interact",
      run: { kind: "script", id: "memory" },
      arrival: { at: { x: 1, y: 2 } },
      order: 1,
    };
    const placement: MapPlacementDef = {
      id: "gate",
      at: { x: 0, y: 0 },
      resource: { kind: "map", id: "crossroads" },
      z: 0,
      footprint: { width: 1, height: 1 },
      collision: "trigger",
      visible: true,
      events: [inherited, explicit],
    };

    expect(replaceMapEventRunTarget(inherited, undefined)).toBe(inherited);
    const moved = replaceMapEventRunTarget(inherited, { kind: "map", id: "harbour" });
    expect(moved.run).toEqual({ kind: "map", id: "harbour" });
    expect(moved).not.toHaveProperty("arrival");

    const changedPlacement = replaceMapPlacementResourceTarget(placement, {
      kind: "map",
      id: "harbour",
    });
    expect(changedPlacement.events[0]).not.toHaveProperty("arrival");
    expect(changedPlacement.events[1]).toEqual(explicit);
    expect(replaceMapPlacementResourceTarget(changedPlacement, changedPlacement.resource)).toBe(changedPlacement);

    expect(replaceMapEventArrival(inherited, undefined)).not.toHaveProperty("arrival");
    expect(replaceMapEventArrival(inherited, { at: { x: 2, y: 3 } }).arrival).toEqual({
      at: { x: 2, y: 3 },
    });
  });

  test("renders arrival authoring only for the selected page's effective map target", () => {
    const targetMap = {
      id: "crossroads",
      name: "Crossroads",
      description: "",
      layout: {
        width: 8,
        height: 6,
        tileWidth: 32,
        tileHeight: 32,
        playerStart: { x: 2, y: 3 },
        layers: [],
        regions: [],
      },
      placements: [{
        id: "south_gate",
        at: { x: 4, y: 5 },
        z: 0,
        footprint: { width: 1, height: 1 },
        collision: "trigger" as const,
        visible: true,
        events: [],
      }],
    } satisfies MapDef;
    const resources = [
      { key: "map:crossroads", kind: "map", id: "crossroads", label: "Crossroads", refs: [] },
      { key: "script:memory", kind: "script", id: "memory", label: "Memory", refs: [] },
    ] as ProjectResourceNode[];
    const routePlacement = {
      id: "gate",
      at: { x: 0, y: 0 },
      resource: { kind: "map", id: "crossroads" },
      z: 0,
      footprint: { width: 1, height: 1 },
      collision: "trigger",
      visible: true,
      events: [{
        id: "leave",
        trigger: "player_touch",
        arrival: { placementId: "south_gate" },
        order: 0,
      }],
    } satisfies MapPlacementDef;
    const common = {
      maps: [targetMap],
      resources,
      switches: [],
      variables: [],
      onChange: () => {},
    };

    const routeHtml = renderToStaticMarkup(React.createElement(EventPagesEditor, {
      ...common,
      placement: routePlacement,
    }));
    expect(routeHtml).toContain("Arrival point");
    expect(routeHtml).toContain("map:crossroads");
    expect(routeHtml).toContain("south_gate · 4,5 · trigger · event-only");

    const scriptHtml = renderToStaticMarkup(React.createElement(EventPagesEditor, {
      ...common,
      placement: {
        ...routePlacement,
        events: [{
          ...routePlacement.events[0]!,
          run: { kind: "script", id: "memory" },
        }],
      },
    }));
    expect(scriptHtml).not.toContain("Arrival point");
  });

  test("tracks authoritative map properties and spatial draft changes", () => {
    const saved = {
      id: "shrine",
      name: "Shrine",
      description: "saved copy",
      layout: undefined,
      placements: [],
    } as MapDef;
    expect(hasMapDraftChanges(saved, { ...saved, description: "project refresh" })).toBe(true);
    expect(hasMapDraftChanges(saved, { ...saved, bg: "assets/backgrounds/shrine" })).toBe(true);
    expect(hasMapDraftChanges(saved, { ...saved, isExtract: true })).toBe(true);
    expect(hasMapDraftChanges(saved, structuredClone(saved))).toBe(false);
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

  test("preserves edits made while an older save request is in flight", async () => {
    const submitted = {
      id: "shrine",
      name: "Renamed Shrine",
      description: "submitted copy",
      difficulty: 1,
      placements: [],
    } satisfies MapDef;
    let current = submitted;
    let resolveSave!: (map: MapDef) => void;
    const deferredSave = new Promise<MapDef>((resolve) => { resolveSave = resolve; });
    const reconciliation = deferredSave.then((authoritative) =>
      reconcileMapDraftAfterSave(submitted, current, authoritative)
    );

    current = { ...submitted, description: "typed while save was pending" };
    resolveSave(structuredClone(submitted));

    await expect(reconciliation).resolves.toEqual({
      draft: current,
      preserveCurrentDraft: true,
    });
    expect(reconcileMapDraftAfterSave(submitted, submitted, structuredClone(submitted))).toEqual({
      draft: submitted,
      preserveCurrentDraft: false,
    });
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

  test("groups World maps by authored chain while preserving resource order and identity", () => {
    const resources = [
      { key: "map:edo_castle", kind: "map", id: "edo_castle", label: "大名府", refs: [] },
      { key: "map:hell_gate_corridor", kind: "map", id: "hell_gate_corridor", label: "業の廊", refs: [] },
      { key: "map:hell_gate_mouth", kind: "map", id: "hell_gate_mouth", label: "門口", refs: [] },
      { key: "map:kuro_swamp_crossroads", kind: "map", id: "kuro_swamp_crossroads", label: "三叉路", refs: [] },
      { key: "script:intro", kind: "script", id: "intro", label: "Intro", refs: [] },
    ] as ProjectResourceNode[];
    const maps = [
      { id: "edo_castle", name: "大名府", description: "" },
      { id: "hell_gate_corridor", name: "業の廊", description: "", chain: "hell_gate" },
      { id: "hell_gate_mouth", name: "門口", description: "", chain: "hell_gate", isEntry: true },
      {
        id: "kuro_swamp_crossroads",
        name: "三叉路",
        description: "",
        chain: "kuro_swamp",
        layout: { width: 12, height: 10, tileWidth: 32, tileHeight: 32, layers: [], regions: [] },
      },
    ] as MapDef[];

    const groups = groupMapTreeResources(resources, maps);
    expect(groups.map(({ key, label, rows, spatialCount, entryCount }) => ({
      key,
      label,
      ids: rows.map((row) => row.id),
      spatialCount,
      entryCount,
    }))).toEqual([{
      key: "",
      label: "Standalone",
      ids: ["edo_castle"],
      spatialCount: 0,
      entryCount: 0,
    }, {
      key: "hell_gate",
      label: "hell_gate",
      ids: ["hell_gate_corridor", "hell_gate_mouth"],
      spatialCount: 0,
      entryCount: 1,
    }, {
      key: "kuro_swamp",
      label: "kuro_swamp",
      ids: ["kuro_swamp_crossroads"],
      spatialCount: 1,
      entryCount: 0,
    }]);
    expect(groups[1]?.rows[0]).toBe(resources[1]);
    expect(mapTreeChainKey({ chain: "  hell_gate  " })).toBe("  hell_gate  ");
    expect(mapTreeChainKey({ chain: "  " })).toBe("  ");
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
    expect(fillMapLayerTiles(resized, "ground", 4).layers[0]?.tiles).toEqual([[4, 4]]);
    expect(moveMapLayer(resized, 0, -1).layers.map((layer) => [layer.id, layer.z])).toEqual([
      ["ground", 1],
      ["walls", 0],
    ]);
    expect(moveMapLayer(resized, 1, -1)).toBe(resized);
    expect(studioTileAtlasStyle(6, {
      path: "assets/tilesets/shrine",
      tileGrid: { columns: 4, rows: 4, firstId: 1 },
      renderings: { sourceQuality: true, source: true, sourceCompressed: false, tuiTxt: false, tuiAns: false, web: false },
    })).toMatchObject({
      backgroundImage: 'url("/files/source/assets/tilesets/shrine")',
      backgroundPosition: `${1 / 3 * 100}% ${1 / 3 * 100}%`,
      backgroundSize: "400% 400%",
    });
  });

  test("undoes a drag-paint gesture as one map history step and supports redo", () => {
    const base = {
      id: "shrine",
      name: "Shrine",
      description: "",
      placements: [],
      layout: {
        width: 2,
        height: 1,
        tileWidth: 32,
        tileHeight: 32,
        layers: [{ id: "ground", kind: "tile", z: 0, visible: true, tiles: [[0, 0]] }],
        regions: [],
      },
    } as MapDef;
    let history = createMapDraftHistory(base);
    history = mapDraftHistoryReducer(history, {
      type: "change",
      group: "paint-1",
      update: (current) => ({ ...current, layout: paintMapLayerTile(current.layout!, "ground", 0, 0, 4) }),
    });
    history = mapDraftHistoryReducer(history, {
      type: "change",
      group: "paint-1",
      update: (current) => ({ ...current, layout: paintMapLayerTile(current.layout!, "ground", 1, 0, 4) }),
    });
    expect(history.past).toHaveLength(1);
    expect(history.present.layout?.layers[0]?.tiles).toEqual([[4, 4]]);

    history = mapDraftHistoryReducer(history, { type: "undo" });
    expect(history.present.layout?.layers[0]?.tiles).toEqual([[0, 0]]);
    history = mapDraftHistoryReducer(history, { type: "redo" });
    expect(history.present.layout?.layers[0]?.tiles).toEqual([[4, 4]]);
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
    expect(eventTriggerMeta("manual")).toEqual({
      icon: "◇",
      label: "Action / Explicit Call",
      description: "Runs when the player or another system explicitly dispatches this page.",
    });
    expect(eventTriggerMeta("quest:resolved")).toEqual({
      icon: "⌁",
      label: "quest · resolved",
      description: "Custom engine trigger: quest:resolved",
    });
    expect(mapPlacementEventSummary({
      id: "altar",
      at: { x: 1, y: 2 },
      z: 0,
      footprint: { width: 1, height: 1 },
      collision: "trigger",
      visible: false,
      events: [
        { id: "inspect", trigger: "interact", order: 0 },
        { id: "watch", trigger: "parallel", chance: 0.5, order: 1 },
      ],
    })).toEqual({
      count: 2,
      icons: "◎∞",
      gated: true,
      automatic: true,
      hidden: true,
      title: "2 event pages · Action Button · Parallel Process · 1 gated · hidden placement",
    });
  });
});
