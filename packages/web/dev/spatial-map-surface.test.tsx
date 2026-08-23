import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HubActivity, MapDef } from "@rpg-harness/engine";
import {
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
  test("maps a visual placement to the existing semantic activity", () => {
    const placement = map.placements![0]!;
    expect(resolveSpatialPlacementOperations(
      map,
      placement,
      new Map([[move.id, move]]),
    )).toEqual([{ event: placement.events[0], resource: placement.resource, activity: move }]);
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
        onInput={() => {}}
      />,
    );
    expect(html).toContain("Shrine 二维地图");
    expect(html).toContain("left:37.5%");
    expect(html).toContain("width:25%");
    expect(html).toContain("玩家位置 1,2");
    expect(html).toContain("向南移动");
    expect(html).toContain("resource-map");
    expect(html).toContain("出口");
    expect(html).toContain("Town");
    expect(html).not.toContain("Private Backdrop Anchor");
    expect(html).not.toContain(">Leave</button>");
    expect(html).not.toContain("arrival");
  });
});
