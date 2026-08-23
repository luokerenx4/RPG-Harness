import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mapPlacementEventKey } from "@rpg-harness/engine";
import type { HubActivity, MapDef, MapPlacementDef } from "@rpg-harness/engine";
import {
  collectSpatialContextOperations,
  collectSpatialLandmarks,
  collectSpatialPlacementActivityIds,
  collectSpatialStepTargets,
  collectSpatialTiles,
  describePlacementApproach,
  isSpatialInteractKey,
  mapMoveAvailability,
  mapPlacementDistance,
  resolveAcceptedSpatialActivityFeedback,
  resolveSpatialRegionAtPoint,
  resolveSpatialPlacementOperations,
  spatialMoveBlockedMessage,
  spatialOperationUnavailableReason,
  spatialTileAtlasStyle,
  SpatialMapSurface,
} from "../src/SpatialMapSurface";

const map: MapDef = {
  id: "shrine",
  name: "Shrine",
  description: "",
  difficulty: 1,
  layout: {
    width: 8,
    height: 6,
    tileWidth: 32,
    tileHeight: 32,
    layers: [],
    regions: [],
  },
  placements: [{
    id: "gate",
    at: { x: 3, y: 5 },
    z: 0,
    footprint: { width: 2, height: 1 },
    collision: "trigger",
    visible: true,
    resource: { kind: "map", id: "town" },
    events: [
      { id: "leave", trigger: "player_touch", label: "Leave", order: 0 },
      { id: "arrival", trigger: "map_enter", order: 1 },
    ],
  }],
};

const move: HubActivity = {
  id: "move:town",
  kind: "action",
  title: "Town",
  cost: 0,
  available: true,
};

describe("SpatialMapSurface", () => {
  test("measures player distance from a placement footprint", () => {
    const placement = map.placements![0]!;
    expect(mapPlacementDistance({ x: 1, y: 2 }, placement)).toBe(5);
    expect(mapPlacementDistance({ x: 3, y: 4 }, placement)).toBe(1);
    expect(mapPlacementDistance({ x: 4, y: 5 }, placement)).toBe(0);
  });

  test("maps a visual placement to the existing semantic activity", () => {
    const placement = map.placements![0]!;
    expect(resolveSpatialPlacementOperations(
      map,
      placement,
      new Map([[move.id, move]]),
    )).toEqual([{ event: placement.events[0], resource: placement.resource, activity: move }]);
  });

  test("describes bounded RPG field movement without changing semantic inputs", () => {
    expect(mapMoveAvailability(map, { x: 0, y: 5 })).toEqual({
      north: true,
      east: true,
      south: false,
      west: false,
    });
    expect(describePlacementApproach({ x: 3, y: 4 }, map.placements![0]!))
      .toBe("向南 1 格 · 接触后移动");
    expect(describePlacementApproach({ x: 3, y: 4 }, map.placements![0]!, 1, "manual"))
      .toBe("向南 1 格 · 可互动");
    expect(["Enter", "e", "E"].every(isSpatialInteractKey)).toBe(true);
    expect(isSpatialInteractKey(" ")).toBe(false);
    expect(collectSpatialStepTargets(map, { x: 0, y: 5 })).toEqual([
      { direction: "north", point: { x: 0, y: 4 }, available: true, label: "向北", arrow: "↑" },
      { direction: "east", point: { x: 1, y: 5 }, available: true, label: "向东", arrow: "→" },
    ]);
  });

  test("resolves authored regions with half-open rectangle bounds", () => {
    const regions = [{ id: "reed_bank", name: "葦原への浅瀬", x: 4, y: 7, width: 5, height: 3 }];

    expect(resolveSpatialRegionAtPoint(regions, { x: 4, y: 7 })?.id).toBe("reed_bank");
    expect(resolveSpatialRegionAtPoint(regions, { x: 8, y: 9 })?.id).toBe("reed_bank");
    expect(resolveSpatialRegionAtPoint(regions, { x: 9, y: 8 })).toBeUndefined();
    expect(resolveSpatialRegionAtPoint(regions, { x: 8, y: 10 })).toBeUndefined();
    expect(resolveSpatialRegionAtPoint(regions)).toBeUndefined();
  });

  test("marks and names only the region containing the confirmed player point", () => {
    const regionalMap: MapDef = {
      ...map,
      layout: {
        ...map.layout!,
        regions: [{ id: "reed_bank", name: "葦原への浅瀬", x: 4, y: 3, width: 3, height: 3 }],
      },
    };
    const current = renderToStaticMarkup(
      <SpatialMapSurface
        map={regionalMap}
        activities={[move]}
        playerPosition={{ x: 5, y: 4 }}
        moveFeedback={{ direction: "east", sequence: 1 }}
        onInput={() => {}}
      />,
    );
    const outside = renderToStaticMarkup(
      <SpatialMapSurface
        map={regionalMap}
        activities={[move]}
        playerPosition={{ x: 0, y: 0 }}
        onInput={() => {}}
      />,
    );

    expect(current).toContain('class="spatial-map-region current"');
    expect(current).toContain('aria-current="location"');
    expect(current).toContain("AREA · 葦原への浅瀬 · 座標 5, 4");
    expect(current).toContain("东侧无法通行");
    expect(outside).toContain('class="spatial-map-region"');
    expect(outside).not.toContain('class="spatial-map-region current"');
    expect(outside).not.toContain('aria-current="location"');
    expect(outside).toContain("AREA · — · 座標 0, 0");
  });

  test("replays directional blocked feedback for every sequence", () => {
    const first = renderToStaticMarkup(
      <SpatialMapSurface
        map={map}
        activities={[move]}
        playerPosition={{ x: 0, y: 5 }}
        moveFeedback={{ direction: "east", sequence: 1 }}
        onInput={() => {}}
      />,
    );
    const repeated = renderToStaticMarkup(
      <SpatialMapSurface
        map={map}
        activities={[move]}
        playerPosition={{ x: 0, y: 5 }}
        moveFeedback={{ direction: "east", sequence: 2 }}
        onInput={() => {}}
      />,
    );

    expect(spatialMoveBlockedMessage("east")).toBe("东侧无法通行");
    expect(first).toContain('class="spatial-map-player blocked-east" data-feedback-sequence="1"');
    expect(repeated).toContain('class="spatial-map-player blocked-east" data-feedback-sequence="2"');
    expect(first).toContain('aria-live="polite" aria-atomic="true"');
    expect(first).toContain('class="spatial-map-blocked-message">东侧无法通行</em>');
  });

  test("projects tile data and disables movement into canonical collision", () => {
    const tiledMap: MapDef = {
      ...map,
      layout: {
        ...map.layout!,
        layers: [{
          id: "ground",
          kind: "tile",
          z: 0,
          visible: true,
          tiles: Array.from({ length: 6 }, (_, y) =>
            Array.from({ length: 8 }, (_, x) => y === 4 && x === 1 ? 7 : 0)
          ),
        }, {
          id: "walls",
          kind: "collision",
          z: 1,
          visible: true,
          tiles: Array.from({ length: 6 }, (_, y) =>
            Array.from({ length: 8 }, (_, x) => y === 5 && x === 1 ? 1 : 0)
          ),
        }],
      },
    };
    expect(collectSpatialTiles(tiledMap)).toEqual([
      { layerId: "ground", kind: "tile", tile: 7, x: 1, y: 4, z: 0 },
      { layerId: "walls", kind: "collision", tile: 1, x: 1, y: 5, z: 1 },
    ]);
    expect(mapMoveAvailability(tiledMap, { x: 0, y: 5 })).toEqual({
      north: true,
      east: false,
      south: false,
      west: false,
    });
    const html = renderToStaticMarkup(
      <SpatialMapSurface map={tiledMap} activities={[move]} playerPosition={{ x: 0, y: 5 }} onInput={() => {}} />,
    );
    expect(html).toContain("spatial-map-tile kind-tile");
    expect(html).not.toContain("spatial-map-tile kind-collision");
    expect(html).toContain('aria-label="向东移动" aria-keyshortcuts="ArrowRight D" disabled=""');
    expect(html).toContain('aria-label="向东移动到 1,5" disabled=""');
    expect(spatialTileAtlasStyle(6, {
      tileGrid: { columns: 4, rows: 4, firstId: 1 },
    }, "/tiles.png")).toMatchObject({
      backgroundImage: 'url("/tiles.png")',
      backgroundPosition: `${1 / 3 * 100}% ${1 / 3 * 100}%`,
      backgroundSize: "400% 400%",
    });
  });

  test("renders positions and omits automatic events from player controls", () => {
    const mapWithHiddenPlacement: MapDef = {
      ...map,
      placements: [
        { ...map.placements![0]!, asset: "assets/sheets/gate" },
        {
          ...map.placements![0]!,
          id: "authoring-anchor",
          visible: false,
          resource: { kind: "asset", id: "private_backdrop_anchor" },
        },
      ],
    };
    const html = renderToStaticMarkup(
      <SpatialMapSurface
        map={mapWithHiddenPlacement}
        activities={[move]}
        playerPosition={{ x: 1, y: 2 }}
        resourceLabels={new Map([["map:town", "城下町"]])}
        playerGraphicUrl="/assets/player.webp"
        assetUrls={{ "assets/sheets/gate": "/assets/gate.webp" }}
        onInput={() => {}}
      />,
    );
    expect(html).toContain("Shrine 二维地图");
    expect(html).toContain("left:37.5%");
    expect(html).toContain("width:25%");
    expect(html).toContain("玩家位置 1,2");
    expect(html).toContain('<img src="/assets/player.webp" alt="" aria-hidden="true"/>');
    expect(html).not.toContain(">◆</span>");
    expect(html).toContain("POSITION 1,2");
    expect(html).toContain("城下町");
    expect(html).toContain("向南再向东 5 格");
    expect(html).toContain("placement-distant");
    expect(html).toContain("向南移动");
    expect(html).toContain('aria-keyshortcuts="ArrowDown S"');
    expect(html).toContain("resource-map");
    expect(html).toContain('class="spatial-placement-graphic" src="/assets/gate.webp"');
    expect(html).toContain("出口");
    expect(html).not.toContain("Town");
    expect(html).not.toContain("Private Backdrop Anchor");
    expect(html).not.toContain(">Leave</button>");
    expect(html).not.toContain("arrival");
  });

  test("renders authored layers before stable foot-Y depth", () => {
    const layeredMap: MapDef = {
      ...map,
      layout: {
        ...map.layout!,
        layers: [
          { id: "ground", kind: "tile", z: 0, visible: true },
          { id: "mist", kind: "image", z: 5, visible: true, asset: "assets/backgrounds/mist" },
          { id: "actors", kind: "object", z: 10, visible: true },
        ],
      },
      placements: [{ ...map.placements![0]!, layer: "actors" }],
    };
    const html = renderToStaticMarkup(
      <SpatialMapSurface map={layeredMap} activities={[move]} assetUrls={{ "assets/backgrounds/mist": "/assets/mist.webp" }} playerPosition={{ x: 3, y: 4 }} onInput={() => {}} />,
    );
    expect(html).toContain('class="spatial-map-image-layer" style="background-image:url(&quot;/assets/mist.webp&quot;);z-index:50000"');
    expect(html).toContain('class="spatial-map-player" aria-label="玩家位置 3,4" style="left:37.5%;top:66.66666666666666%;width:12.5%;height:16.666666666666668%;z-index:101004"');
    expect(html).toContain('class="spatial-placement resource-map collision-trigger placement-actionable placement-nearby" style="left:37.5%;top:83.33333333333334%;width:25%;height:16.666666666666664%;z-index:101005"');

    const hiddenLayerMap: MapDef = {
      ...layeredMap,
      layout: {
        ...layeredMap.layout!,
        layers: layeredMap.layout!.layers.map((layer) => layer.id === "actors" ? { ...layer, visible: false } : layer),
      },
    };
    const hiddenHtml = renderToStaticMarkup(
      <SpatialMapSurface map={hiddenLayerMap} activities={[move]} playerPosition={{ x: 3, y: 4 }} onInput={() => {}} />,
    );
    expect(hiddenHtml).toContain("0 LANDMARKS");
    expect(hiddenHtml).not.toContain('aria-label="出口 Town"');
    expect(collectSpatialPlacementActivityIds(hiddenLayerMap, new Map([[move.id, move]]))).toEqual(new Set([move.id]));
  });

  test("inherits a character map sprite unless the placement owns a graphic", () => {
    const characterMap: MapDef = {
      ...map,
      placements: [{
        ...map.placements![0]!,
        id: "keeper",
        resource: { kind: "character", id: "keeper" },
        asset: undefined,
      }],
    };
    const html = renderToStaticMarkup(
      <SpatialMapSurface
        map={characterMap}
        activities={[]}
        assetUrls={{ "assets/sprites/keeper": "/assets/keeper.webp" }}
        resourceGraphics={new Map([["character:keeper", "assets/sprites/keeper"]])}
        onInput={() => {}}
      />,
    );
    expect(html).toContain('class="spatial-placement-graphic" src="/assets/keeper.webp"');
    const override = renderToStaticMarkup(
      <SpatialMapSurface
        map={{ ...characterMap, placements: [{ ...characterMap.placements![0]!, asset: "assets/sprites/disguise" }] }}
        activities={[]}
        assetUrls={{
          "assets/sprites/keeper": "/assets/keeper.webp",
          "assets/sprites/disguise": "/assets/disguise.webp",
        }}
        resourceGraphics={new Map([["character:keeper", "assets/sprites/keeper"]])}
        onInput={() => {}}
      />,
    );
    expect(override).toContain('src="/assets/disguise.webp"');
    expect(override).not.toContain('src="/assets/keeper.webp"');
  });

  test("moves manual placement commands into one nearby action prompt", () => {
    const inspectMap: MapDef = {
      ...map,
      layout: { ...map.layout!, regions: [{ id: "market", name: "市集", x: 1, y: 1, width: 3, height: 2 }] },
      placements: [{
        ...map.placements![0]!,
        resource: { kind: "item", id: "old_key" },
        events: [{ id: "inspect", trigger: "interact", label: "调查门扉", order: 0 }],
      }],
    };
    const inspectActivity: HubActivity = { ...move, id: "map:shrine/placement:gate/event:inspect", title: "Inspect" };
    const html = renderToStaticMarkup(
      <SpatialMapSurface
        map={inspectMap}
        activities={[inspectActivity]}
        playerPosition={{ x: 3, y: 4 }}
        onInput={() => {}}
      />,
    );
    expect(html).toContain("区域 市集");
    expect(html).toContain("spatial-map-interact");
    expect(html).toContain("调查门扉");
    expect(html).toContain("<kbd>E</kbd>ACTION");
    expect(html).toContain('class="spatial-placement-interact-cue"');
    expect(html).toContain("<kbd>E</kbd> 调查门扉");
    expect(html).toContain('aria-keyshortcuts="E Enter Digit1"');
    expect(html).toContain('aria-label="附近地标雷达"');
    expect(html).not.toContain('class="spatial-map-interact" type="button" disabled');
    expect(html).toContain('aria-label="展开地图"');
    expect(html.match(/<button/g)).toHaveLength(10);
    expect([...collectSpatialPlacementActivityIds(
      inspectMap,
      new Map([[inspectActivity.id, inspectActivity]]),
    )]).toEqual([inspectActivity.id]);
    expect(resolveAcceptedSpatialActivityFeedback(
      inspectMap,
      [inspectActivity],
      { type: "doActivity", id: inspectActivity.id },
      { accepted: true, code: "accepted", message: "Input accepted.", expected: [] },
    )).toEqual({ activityId: inspectActivity.id, title: "调查门扉" });
    expect(resolveAcceptedSpatialActivityFeedback(
      inspectMap,
      [inspectActivity],
      { type: "doActivity", id: inspectActivity.id },
      { accepted: false, code: "activity-locked", message: "locked", expected: [] },
    )).toBeUndefined();
  });

  test("shows nearby locked reasons without making the event keyboard-actionable", () => {
    const lockedMap: MapDef = {
      ...map,
      placements: [{
        ...map.placements![0]!,
        resource: { kind: "item", id: "sealed_chest" },
        events: [{ id: "open", trigger: "interact", label: "打开宝箱", order: 0 }],
      }],
    };
    const activityId = mapPlacementEventKey(lockedMap.id, "gate", "open");
    const lockedActivity: HubActivity = {
      ...move,
      id: activityId,
      title: "打开宝箱",
      available: false,
      lockedReason: "需要古旧钥匙",
    };
    const operation = resolveSpatialPlacementOperations(
      lockedMap,
      lockedMap.placements![0]!,
      new Map([[activityId, lockedActivity]]),
    )[0]!;
    const html = renderToStaticMarkup(
      <SpatialMapSurface
        map={lockedMap}
        activities={[lockedActivity]}
        playerPosition={{ x: 3, y: 4 }}
        onInput={() => {}}
      />,
    );

    expect(spatialOperationUnavailableReason(operation)).toBe("需要古旧钥匙");
    expect(html).toContain('class="spatial-map-interact locked"');
    expect(html).toContain('aria-label="打开宝箱 · 锁定：需要古旧钥匙"');
    const lockedButton = html.match(/<button class="spatial-map-interact locked"[\s\S]*?<\/button>/)?.[0];
    expect(lockedButton).toContain("<kbd>—</kbd>LOCKED");
    expect(lockedButton).not.toContain("aria-keyshortcuts");
    expect(html).toContain('class="spatial-map-interact-reason"');
    expect(html).toContain("需要古旧钥匙");
    expect(html).toContain("道具 · 暂不可用");
    expect(html).not.toContain('class="spatial-placement-interact-cue"');
    expect(resolveAcceptedSpatialActivityFeedback(
      lockedMap,
      [lockedActivity],
      { type: "doActivity", id: activityId },
      { accepted: true, code: "accepted", message: "Input accepted.", expected: [] },
    )).toBeUndefined();
  });

  test("keeps stacked resources visible and prioritizes an actionable landmark at equal distance", () => {
    const decorative: MapPlacementDef = {
      ...map.placements![0]!,
      id: "decor",
      at: { x: 3, y: 4 },
      resource: { kind: "asset", id: "wall" },
      events: [],
    };
    const actionable: MapPlacementDef = {
      ...decorative,
      id: "altar",
      resource: { kind: "action", id: "pray" },
      events: [{ id: "inspect", trigger: "interact", label: "祈る", order: 0 }],
    };
    const stackedMap: MapDef = { ...map, placements: [decorative, actionable] };
    const eventId = mapPlacementEventKey(stackedMap.id, actionable.id, "inspect");
    const landmarks = collectSpatialLandmarks(
      stackedMap,
      new Map([[eventId, { ...move, id: eventId }]]),
      { x: 3, y: 4 },
    );

    expect(landmarks.map(({ placement }) => placement.id)).toEqual(["altar", "decor"]);
    expect(landmarks.map(({ distance }) => distance)).toEqual([0, 0]);
  });

  test("aggregates nearby manual events without turning touch or distant events into buttons", () => {
    const projected = (
      id: string,
      x: number,
      trigger: MapPlacementDef["events"][number]["trigger"],
    ): MapPlacementDef => ({
      ...map.placements![0]!,
      id,
      at: { x, y: 4 },
      resource: { kind: "action", id },
      events: [{ id: "run", trigger, label: id, order: 0 }],
    });
    const placements = [
      projected("locked", 3, "manual"),
      projected("open", 4, "interact"),
      projected("touch", 3, "player_touch"),
      projected("far", 7, "interact"),
    ];
    const projectedMap: MapDef = { ...map, placements };
    const activities = new Map(placements.map((placement) => {
      const id = mapPlacementEventKey(projectedMap.id, placement.id, "run");
      return [id, { ...move, id, available: placement.id !== "locked" }] as const;
    }));
    const context = collectSpatialContextOperations(
      collectSpatialLandmarks(projectedMap, activities, { x: 3, y: 4 }),
    );

    expect(context.map(({ placement }) => placement.id)).toEqual(["open", "locked"]);
    expect(context.map(({ distance }) => distance)).toEqual([1, 0]);
  });
});
