import { describe, expect, test } from "bun:test";
import { makeCtx } from "../test-utils";
import type { Game, MapDef } from "../types";
import { moveMapPlayer } from "./moveMapPlayer";

const shrine: MapDef = {
  id: "shrine",
  name: "Shrine",
  description: "",
  layout: {
    width: 5,
    height: 4,
    tileWidth: 32,
    tileHeight: 32,
    playerStart: { x: 2, y: 2 },
    layers: [],
    regions: [],
  },
  placements: [{
    id: "wall",
    at: { x: 3, y: 2 },
    z: 0,
    footprint: { width: 1, height: 1 },
    collision: "block",
    visible: true,
    events: [],
    resource: { kind: "item", id: "stone" },
  }, {
    id: "exit",
    at: { x: 2, y: 3 },
    z: 0,
    footprint: { width: 1, height: 1 },
    collision: "trigger",
    visible: true,
    events: [{ id: "leave", trigger: "player_touch", order: 0 }],
    resource: { kind: "map", id: "town" },
  }],
};

const game: Game = {
  title: "move",
  characters: [],
  scripts: [],
  items: [{ id: "stone", name: "Stone", description: "", kind: "key" }],
  maps: [shrine, { id: "town", name: "Town", description: "" }],
};

describe("moveMapPlayer", () => {
  test("persists position and enforces map bounds and blocking footprints", () => {
    const ctx = makeCtx(game);
    ctx.state.baseline.currentMapId = "shrine";
    expect(moveMapPlayer(ctx, "east")).toMatchObject({ moved: false, blockedBy: "wall" });
    expect(moveMapPlayer(ctx, "north")).toMatchObject({ moved: true, position: { x: 2, y: 1 } });
    expect(ctx.state.runtime.mapPosition).toEqual({ x: 2, y: 1 });
  });

  test("maps player-touch to the published semantic activity", () => {
    const ctx = makeCtx(game);
    ctx.state.baseline.currentMapId = "shrine";
    ctx.state.runtime.lastHubActivities = [{
      id: "move:town",
      kind: "action",
      actionKind: "moveToMap",
      payload: { to: "town" },
      title: "Town",
      cost: 0,
      available: true,
    }];
    expect(moveMapPlayer(ctx, "south")).toMatchObject({
      moved: true,
      position: { x: 2, y: 3 },
      activityId: "move:town",
    });
  });
});
