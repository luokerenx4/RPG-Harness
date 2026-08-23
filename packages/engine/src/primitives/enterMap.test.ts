import { describe, expect, test } from "bun:test";
import { enterMap, EnterMapError } from "./enterMap";
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
    expect(() => enterMap(state, game, "nowhere")).toThrow(EnterMapError);
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
    expect(() => enterMap(state, game, "broken")).toThrow(
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
    expect(() => enterMap(state, game, "scene_b")).toThrow(
      /script is already active/,
    );
  });
});
