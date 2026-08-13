import { describe, expect, test } from "bun:test";
import { applyDelta, createInitialState } from "./state";
import {
  makeAction,
  makeCharacter,
  makeGame,
  makeState,
  twoCharGame,
} from "./test-utils";
import type { WeaponDef } from "./types";

describe("applyDelta — characterStats", () => {
  test("adds to character affection (default stat)", () => {
    const game = twoCharGame();
    const state = createInitialState(game);
    applyDelta(state, { characterStats: { alice: { affection: 2 } } });
    expect(state.baseline.characters.alice!.stats.affection).toBe(2);
  });

  test("subtraction supported", () => {
    const game = makeGame({
      characters: [
        makeCharacter("alice", {
          stats: { affection: { initial: 3 } },
        }),
      ],
    });
    const state = createInitialState(game);
    applyDelta(state, { characterStats: { alice: { affection: -2 } } });
    expect(state.baseline.characters.alice!.stats.affection).toBe(1);
  });

  test("unknown character is silently ignored", () => {
    const state = createInitialState(twoCharGame());
    expect(() =>
      applyDelta(state, { characterStats: { ghost: { affection: 1 } } }),
    ).not.toThrow();
    expect(state.baseline.characters.ghost).toBeUndefined();
  });

  test("multiple characters in one delta", () => {
    const state = createInitialState(twoCharGame());
    applyDelta(state, {
      characterStats: { alice: { affection: 2 }, bob: { affection: -1 } },
    });
    expect(state.baseline.characters.alice!.stats.affection).toBe(2);
    expect(state.baseline.characters.bob!.stats.affection).toBe(-1);
  });

  test("non-affection stats supported", () => {
    const game = makeGame({
      characters: [
        makeCharacter("alice", {
          stats: { trust: { initial: 0 }, anger: { initial: 0 } },
        }),
      ],
    });
    const state = createInitialState(game);
    applyDelta(state, {
      characterStats: { alice: { trust: 3, anger: -1 } },
    });
    expect(state.baseline.characters.alice!.stats.trust).toBe(3);
    expect(state.baseline.characters.alice!.stats.anger).toBe(-1);
    expect(state.baseline.characters.alice!.stats.affection).toBe(0);
  });
});

describe("applyDelta — characterStats clamping (with game ref)", () => {
  function boundedGame() {
    return makeGame({
      characters: [
        makeCharacter("alice", {
          stats: {
            hp: { initial: 30, min: 0, max: 30 },
            spectral: { initial: 5, min: 0, max: 100 },
            unbounded: { initial: 0 },
          },
        }),
      ],
    });
  }

  test("clamps at declared max", () => {
    const game = boundedGame();
    const state = createInitialState(game);
    applyDelta(state, { characterStats: { alice: { hp: 100 } } }, game);
    expect(state.baseline.characters.alice!.stats.hp).toBe(30);
  });

  test("clamps at declared min", () => {
    const game = boundedGame();
    const state = createInitialState(game);
    applyDelta(state, { characterStats: { alice: { hp: -100 } } }, game);
    expect(state.baseline.characters.alice!.stats.hp).toBe(0);
  });

  test("unbounded stat (no min/max declared) is not clamped", () => {
    const game = boundedGame();
    const state = createInitialState(game);
    applyDelta(state, { characterStats: { alice: { unbounded: 9999 } } }, game);
    expect(state.baseline.characters.alice!.stats.unbounded).toBe(9999);
  });

  test("without game ref, no clamping (back-compat — fixture restore)", () => {
    const game = boundedGame();
    const state = createInitialState(game);
    applyDelta(state, { characterStats: { alice: { hp: 100 } } });
    expect(state.baseline.characters.alice!.stats.hp).toBe(130);
  });

  test("mutateState uses game ref so clamping kicks in", () => {
    const game = boundedGame();
    const ctx = (require("./engine") as typeof import("./engine"))
      .buildPresetContext(game);
    const { mutateState } = require("./primitives/mutateState") as typeof import(
      "./primitives/mutateState"
    );
    mutateState(ctx, { characterStats: { alice: { hp: 100 } } }, "action");
    expect(ctx.state.baseline.characters.alice!.stats.hp).toBe(30);
  });
});

describe("applyDelta — variables", () => {
  test("numeric variables are summed additively", () => {
    const state = makeState();
    applyDelta(state, { variables: { gold: 10 } });
    applyDelta(state, { variables: { gold: 5 } });
    expect(state.baseline.variables.gold).toBe(15);
  });

  test("string variables are last-write-wins", () => {
    const state = makeState();
    applyDelta(state, { variables: { route: "alice" } });
    applyDelta(state, { variables: { route: "bea" } });
    expect(state.baseline.variables.route).toBe("bea");
  });

  test("setting a numeric variable with a string replaces", () => {
    const state = makeState();
    applyDelta(state, { variables: { x: 5 } });
    applyDelta(state, { variables: { x: "five" } });
    expect(state.baseline.variables.x).toBe("five");
  });
});

describe("applyDelta — switches", () => {
  test("switches are last-write-wins booleans", () => {
    const state = makeState();
    applyDelta(state, { switches: { unlocked: false } });
    applyDelta(state, { switches: { unlocked: true } });
    expect(state.baseline.switches.unlocked).toBe(true);
  });
});

describe("applyDelta — inventory", () => {
  test("positive delta adds count", () => {
    const state = makeState();
    applyDelta(state, { inventory: { potion: 3 } });
    expect(state.baseline.inventory.potion).toBe(3);
  });

  test("counts sum across deltas", () => {
    const state = makeState();
    applyDelta(state, { inventory: { potion: 2 } });
    applyDelta(state, { inventory: { potion: 3 } });
    expect(state.baseline.inventory.potion).toBe(5);
  });

  test("negative delta drains stock and prunes at 0", () => {
    const state = makeState();
    applyDelta(state, { inventory: { potion: 3 } });
    applyDelta(state, { inventory: { potion: -3 } });
    expect(state.baseline.inventory.potion).toBeUndefined();
  });

  test("over-drain clamps to removal (no negative count)", () => {
    const state = makeState();
    applyDelta(state, { inventory: { potion: 1 } });
    applyDelta(state, { inventory: { potion: -5 } });
    expect(state.baseline.inventory.potion).toBeUndefined();
  });
});

describe("applyDelta — weapons", () => {
  const yaodao: WeaponDef = {
    id: "yaodao",
    name: "妖刀",
    description: "",
    basePower: 3,
  };

  test("power adds to weapon", () => {
    const game = makeGame({
      characters: [makeCharacter("alice")],
      weapons: [yaodao],
    });
    const state = createInitialState(game);
    expect(state.baseline.weapons.yaodao!.power).toBe(3);
    applyDelta(state, { weapons: { yaodao: { power: 4 } } });
    expect(state.baseline.weapons.yaodao!.power).toBe(7);
  });

  test("power clamps at 0 (no negative power)", () => {
    const game = makeGame({ weapons: [yaodao] });
    const state = createInitialState(game);
    applyDelta(state, { weapons: { yaodao: { power: -10 } } });
    expect(state.baseline.weapons.yaodao!.power).toBe(0);
  });

  test("unknown weapon id is silently ignored", () => {
    const state = createInitialState(makeGame({ weapons: [yaodao] }));
    expect(() =>
      applyDelta(state, { weapons: { phantom: { power: 1 } } }),
    ).not.toThrow();
    expect(state.baseline.weapons.phantom).toBeUndefined();
  });

  test("auto-equips a single declared weapon", () => {
    const state = createInitialState(makeGame({ weapons: [yaodao] }));
    expect(state.baseline.equippedWeaponId).toBe("yaodao");
  });

  test("does not auto-equip when multiple weapons declared", () => {
    const state = createInitialState(
      makeGame({
        weapons: [
          yaodao,
          { id: "katana", name: "刀", description: "", basePower: 2 },
        ],
      }),
    );
    expect(state.baseline.equippedWeaponId).toBeNull();
  });
});

describe("applyDelta — skills", () => {
  test("learn adds to knownSkills", () => {
    const state = makeState();
    applyDelta(state, { skills: { learn: ["purify"] } });
    expect(state.baseline.knownSkills).toEqual(["purify"]);
  });

  test("learn is set-semantics (no duplicates)", () => {
    const state = makeState();
    applyDelta(state, { skills: { learn: ["purify"] } });
    applyDelta(state, { skills: { learn: ["purify"] } });
    expect(state.baseline.knownSkills).toEqual(["purify"]);
  });

  test("forget removes from knownSkills", () => {
    const state = makeState();
    applyDelta(state, { skills: { learn: ["purify", "warding"] } });
    applyDelta(state, { skills: { forget: ["purify"] } });
    expect(state.baseline.knownSkills).toEqual(["warding"]);
  });

  test("forgetting an unknown skill is a no-op", () => {
    const state = makeState();
    applyDelta(state, { skills: { forget: ["nonexistent"] } });
    expect(state.baseline.knownSkills).toEqual([]);
  });

  test("learn-then-forget within one delta applies in order", () => {
    const state = makeState();
    applyDelta(state, {
      skills: { learn: ["purify"], forget: ["purify"] },
    });
    expect(state.baseline.knownSkills).toEqual([]);
  });
});

describe("applyDelta — stats", () => {
  // stats only apply when training state exists; test the training
  // preset's clamping rule here via a minimal training-mode game.
  function makeTrainingGame() {
    return makeGame({
      characters: [makeCharacter("alice")],
      training: {
        slotsPerDay: 3,
        slotNames: ["上午", "下午", "晚上"],
        startDay: 1,
        maxDay: 14,
        decayPerDay: 0,
        decayStatId: "spectral",
        sleepActionId: "sleep",
        huntActionId: "hunt",
        stats: [
          { id: "spectral", name: "灵体化", min: 0, max: 100, start: 5 },
          { id: "physical", name: "体力", min: 0, max: 20, start: 10 },
        ],
        endConditions: [],
      },
    });
  }

  test("stat delta adds to current value", () => {
    const state = createInitialState(makeTrainingGame());
    applyDelta(state, { stats: { spectral: 3 } });
    expect(state.training!.stats.spectral).toBe(8);
  });

  test("stat delta clamps at statMax", () => {
    const state = createInitialState(makeTrainingGame());
    applyDelta(state, { stats: { physical: 100 } });
    expect(state.training!.stats.physical).toBe(20);
  });

  test("stat delta clamps at 0", () => {
    const state = createInitialState(makeTrainingGame());
    applyDelta(state, { stats: { physical: -100 } });
    expect(state.training!.stats.physical).toBe(0);
  });

  test("statMax delta raises the cap", () => {
    const state = createInitialState(makeTrainingGame());
    applyDelta(state, { statMax: { physical: 5 } });
    expect(state.training!.statMax.physical).toBe(25);
    applyDelta(state, { stats: { physical: 100 } });
    expect(state.training!.stats.physical).toBe(25);
  });

  test("stats delta is a no-op without training state", () => {
    const state = makeState();
    expect(() =>
      applyDelta(state, { stats: { spectral: 5 } }),
    ).not.toThrow();
    expect(state.training).toBeUndefined();
  });
});

describe("createInitialState", () => {
  test("seeds character affection from declared stats", () => {
    const game = makeGame({
      characters: [
        makeCharacter("alice", { stats: { affection: { initial: 2 } } }),
        makeCharacter("bob"),
      ],
    });
    const state = createInitialState(game);
    expect(state.baseline.characters.alice!.stats.affection).toBe(2);
    expect(state.baseline.characters.bob!.stats.affection).toBe(0);
  });

  test("creates fresh runtime + baseline slices", () => {
    const state = makeState();
    expect(state.baseline).toBeDefined();
    expect(state.baseline.switches).toEqual({});
    expect(state.baseline.variables).toEqual({});
    expect(state.baseline.scripts).toEqual({});
    expect(state.baseline.completionOrder).toEqual([]);
    expect(state.baseline.inventory).toEqual({});
    expect(state.runtime.pendingNarrations).toEqual([]);
    expect(state.runtime.activeTriggers).toEqual([]);
    expect(state.runtime.firedTriggers).toEqual([]);
  });

  test("accepts a bare character array (legacy overload)", () => {
    const state = createInitialState([makeCharacter("alice")]);
    expect(state.baseline.characters.alice).toBeDefined();
  });

  test("seeds author module initialization and persists its advanced cursor", () => {
    const randomWorld = {
      id: "random-world",
      initialize: (_game: unknown, context: { rng: () => number }) => ({
        landmarks: [context.rng(), context.rng()],
      }),
    };
    const game = makeGame({ modules: [randomWorld] });

    const first = createInitialState(game, { seed: 17 });
    const replay = createInitialState(game, { seed: 17 });
    const other = createInitialState(game, { seed: 18 });

    expect(first["random-world"]).toEqual(replay["random-world"]);
    expect(first.runtime.rng).toEqual(replay.runtime.rng);
    expect(first["random-world"]).not.toEqual(other["random-world"]);
    expect(first.runtime.rng?.state).not.toBe(17);
  });

  test("rejects initial-world seeds outside uint32", () => {
    expect(() => createInitialState(twoCharGame(), { seed: -1 }))
      .toThrow("uint32");
    expect(() => createInitialState(twoCharGame(), { seed: 0x1_0000_0000 }))
      .toThrow("uint32");
  });
});

describe("applyDelta — selfSwitches", () => {
  test("flips A on an existing scripts entry", () => {
    const state = makeState();
    state.baseline.scripts.q1 = {
      completed: false,
      selfSwitches: { A: false, B: false, C: false, D: false },
    };
    applyDelta(state, { selfSwitches: { q1: { A: true } } });
    expect(state.baseline.scripts.q1.selfSwitches.A).toBe(true);
  });

  test("auto-creates ScriptState when scripts entry missing", () => {
    const state = makeState();
    applyDelta(state, { selfSwitches: { fresh_quest: { B: true } } });
    expect(state.baseline.scripts.fresh_quest).toEqual({
      completed: false,
      selfSwitches: { A: false, B: true, C: false, D: false },
    });
  });

  test("multiple switches in one delta", () => {
    const state = makeState();
    applyDelta(state, {
      selfSwitches: { q: { A: true, C: true } },
    });
    expect(state.baseline.scripts.q?.selfSwitches).toEqual({
      A: true,
      B: false,
      C: true,
      D: false,
    });
  });

  test("invalid switch names silently ignored", () => {
    const state = makeState();
    applyDelta(state, {
      selfSwitches: { q: { Z: true } as never },
    });
    expect(state.baseline.scripts.q?.selfSwitches.A).toBe(false);
  });
});

describe("markScriptCompleted", () => {
  test("flips completed + appends to completionOrder", () => {
    const state = makeState();
    const { markScriptCompleted } = require("./state");
    markScriptCompleted(state, "001");
    expect(state.baseline.scripts["001"]?.completed).toBe(true);
    expect(state.baseline.completionOrder).toEqual(["001"]);
  });

  test("idempotent: completing twice doesn't double-add to order", () => {
    const state = makeState();
    const { markScriptCompleted } = require("./state");
    markScriptCompleted(state, "001");
    markScriptCompleted(state, "001");
    expect(state.baseline.completionOrder).toEqual(["001"]);
  });
});

// Sanity check that test-utils don't import anything that breaks the
// engine package. If this import chain ever cycles, this test will
// surface it before the others run.
test("test-utils make a usable game", () => {
  const game = makeGame({
    characters: [makeCharacter("alice")],
    actions: [makeAction("rest")],
  });
  expect(game.title).toBe("test");
  expect(game.actions).toHaveLength(1);
});
