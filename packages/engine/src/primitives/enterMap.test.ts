import { describe, expect, test } from "bun:test";
import { enterMap } from "./enterMap";
import { createInitialState } from "../state";
import { makeCharacter, makeGame, makeScript } from "../test-utils";
import type { Game, MapDef } from "../types";

function gameWithMaps(maps: MapDef[], extra: Partial<Game> = {}): Game {
  return makeGame({
    characters: [makeCharacter("alice")],
    maps,
    ...extra,
  });
}

function expectRejectedTransferToPreserveState(
  state: ReturnType<typeof createInitialState>,
  transfer: () => unknown,
  message: RegExp,
): void {
  const before = structuredClone(state);
  expect(transfer).toThrow(message);
  expect(state).toEqual(before);
}

describe("enterMap", () => {
  test("sets currentMapId on a valid map", () => {
    const game = gameWithMaps([
      { id: "atrium", name: "玄関", description: "" },
    ]);
    const state = createInitialState(game);
    enterMap(state, game, "atrium");
    expect(state.baseline.currentMapId).toBe("atrium");
  });

  test("records the spatial layout contract beside the entry position", () => {
    const game = gameWithMaps([{
      id: "field",
      name: "Field",
      description: "",
      layout: {
        width: 7,
        height: 6,
        tileWidth: 32,
        tileHeight: 32,
        playerStart: { x: 3, y: 4 },
        layers: [],
        regions: [],
      },
    }]);
    const state = createInitialState(game);
    enterMap(state, game, "field");
    expect(state.runtime.mapPosition).toEqual({ x: 3, y: 4 });
    expect(state.runtime.mapPositionLayoutKey).toBe("7x6@3,4");
  });

  test("resolves coordinate and stable-placement arrivals without changing the map contract", () => {
    const game = gameWithMaps([{
      id: "field",
      name: "Field",
      description: "",
      layout: {
        width: 7,
        height: 6,
        tileWidth: 32,
        tileHeight: 32,
        playerStart: { x: 3, y: 4 },
        layers: [],
        regions: [],
      },
      placements: [{
        id: "west-gate",
        at: { x: 1, y: 2 },
        z: 0,
        footprint: { width: 1, height: 1 },
        collision: "trigger",
        visible: true,
        events: [{ id: "return", trigger: "interact", order: 0 }],
      }],
    }]);
    const state = createInitialState(game);

    enterMap(state, game, "field", { at: { x: 5, y: 1 } });
    expect(state.runtime.mapPosition).toEqual({ x: 5, y: 1 });
    expect(state.runtime.mapPositionLayoutKey).toBe("7x6@3,4");

    enterMap(state, game, "field", { placementId: "west-gate" });
    expect(state.runtime.mapPosition).toEqual({ x: 1, y: 2 });
    expect(state.runtime.mapPositionLayoutKey).toBe("7x6@3,4");
  });

  test("rejects malformed, missing, and out-of-bounds arrivals at the runtime boundary", () => {
    const game = gameWithMaps([{
      id: "field",
      name: "Field",
      description: "",
      layout: {
        width: 2,
        height: 2,
        tileWidth: 32,
        tileHeight: 32,
        layers: [],
        regions: [],
      },
    }, { id: "node", name: "Node", description: "" }]);
    const state = createInitialState(game);

    state.baseline.currentMapId = "before";
    state.runtime.mapPositionMapId = "before";
    state.runtime.mapPosition = { x: 9, y: 8 };
    state.runtime.mapPositionLayoutKey = "before-layout";
    state.baseline.visuals.bg = "assets/backgrounds/before";

    expectRejectedTransferToPreserveState(
      state,
      () => enterMap(state, game, "field", {}),
      /exactly one/,
    );
    expectRejectedTransferToPreserveState(
      state,
      () => enterMap(state, game, "field", {
        placementId: "",
        at: { x: 0, y: 0 },
      }),
      /exactly one/,
    );
    expectRejectedTransferToPreserveState(
      state,
      () => enterMap(state, game, "field", { placementId: "" }),
      /non-empty string/,
    );
    expectRejectedTransferToPreserveState(
      state,
      () => enterMap(state, game, "field", { placementId: "missing" }),
      /no arrival placement/,
    );
    expectRejectedTransferToPreserveState(
      state,
      () => enterMap(state, game, "field", { at: { x: 2, y: 0 } }),
      /must fit inside 2x2/,
    );
    expectRejectedTransferToPreserveState(
      state,
      () => enterMap(state, game, "node", { at: { x: 0, y: 0 } }),
      /requires a spatial layout/,
    );
  });

  test("syncs visuals.bg when map declares bg", () => {
    const game = gameWithMaps([
      {
        id: "swamp",
        name: "沼",
        description: "",
        bg: "assets/backgrounds/swamp",
      },
    ]);
    const state = createInitialState(game);
    enterMap(state, game, "swamp");
    expect(state.baseline.visuals.bg).toBe("assets/backgrounds/swamp");
  });

  test("leaves visuals.bg unchanged when map has no bg", () => {
    const game = gameWithMaps([
      { id: "void", name: "虚", description: "" },
    ]);
    const state = createInitialState(game);
    state.baseline.visuals.bg = "assets/backgrounds/prior";
    enterMap(state, game, "void");
    expect(state.baseline.visuals.bg).toBe("assets/backgrounds/prior");
  });

  test("queues onEnter script into baseline.currentScriptId", () => {
    const game = gameWithMaps(
      [
        {
          id: "shrine",
          name: "社",
          description: "",
          onEnter: "intro",
        },
      ],
      {
        scripts: [makeScript("intro")],
      },
    );
    const state = createInitialState(game);
    enterMap(state, game, "shrine");
    expect(state.baseline.currentScriptId).toBe("intro");
    expect(state.baseline.beatIndex).toBe(0);
  });

  test("rejects unknown map id", () => {
    const game = gameWithMaps([
      { id: "atrium", name: "玄関", description: "" },
    ]);
    const state = createInitialState(game);
    expectRejectedTransferToPreserveState(
      state,
      () => enterMap(state, game, "nowhere"),
      /undeclared map/,
    );
  });

  test("rejects onEnter that references missing script", () => {
    const game = gameWithMaps([
      {
        id: "broken",
        name: "broken",
        description: "",
        onEnter: "ghost_script",
      },
    ]);
    const state = createInitialState(game);
    state.baseline.currentMapId = "before";
    state.runtime.mapPosition = { x: 7, y: 3 };
    state.baseline.visuals.bg = "assets/backgrounds/before";
    expectRejectedTransferToPreserveState(
      state,
      () => enterMap(state, game, "broken"),
      /undeclared script "ghost_script"/,
    );
  });

  test("refuses to queue onEnter while a script is active", () => {
    const game = gameWithMaps(
      [
        {
          id: "scene_b",
          name: "B",
          description: "",
          onEnter: "intro_b",
        },
      ],
      {
        scripts: [makeScript("intro_b"), makeScript("active")],
      },
    );
    const state = createInitialState(game);
    state.baseline.currentScriptId = "active";
    state.baseline.currentMapId = "before";
    state.runtime.mapPosition = { x: 7, y: 3 };
    state.baseline.visuals.bg = "assets/backgrounds/before";
    expectRejectedTransferToPreserveState(
      state,
      () => enterMap(state, game, "scene_b"),
      /script is already active/,
    );
  });
});
