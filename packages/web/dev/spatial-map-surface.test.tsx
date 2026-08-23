import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HubActivity, MapDef } from "@rpg-harness/engine";
import {
  describePlacementApproach,
  mapMoveAvailability,
  mapPlacementDistance,
  resolveSpatialPlacementOperations,
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
    expect(mapMoveAvailability(map.layout, { x: 0, y: 5 })).toEqual({
      north: true,
      east: true,
      south: false,
      west: false,
    });
    expect(describePlacementApproach({ x: 3, y: 4 }, map.placements![0]!))
      .toBe("向南 1 格 · 接触后移动");
  });

  test("renders positions and omits automatic events from player controls", () => {
    const mapWithHiddenPlacement: MapDef = {
      ...map,
      placements: [
        ...map.placements!,
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
        onInput={() => {}}
      />,
    );
    expect(html).toContain("Shrine 二维地图");
    expect(html).toContain("left:37.5%");
    expect(html).toContain("width:25%");
    expect(html).toContain("玩家位置 1,2");
    expect(html).toContain("POSITION 1,2");
    expect(html).toContain("城下町");
    expect(html).toContain("向南再向东 5 格");
    expect(html).toContain("placement-distant");
    expect(html).toContain("向南移动");
    expect(html).toContain("resource-map");
    expect(html).toContain("出口");
    expect(html).not.toContain("Town");
    expect(html).not.toContain("Private Backdrop Anchor");
    expect(html).not.toContain(">Leave</button>");
    expect(html).not.toContain("arrival");
  });
});
