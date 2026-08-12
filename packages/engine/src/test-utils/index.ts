// Test fixtures + small builders. The goal: write engine tests that
// look like English ("a game with two characters; alice at affection 3;
// flip a flag; assert"). Keep these intentionally thin — no clever
// abstractions. Tests should be readable in one screen, not parameterized.

import { buildPresetContext } from "../engine";
import { createInitialState } from "../state";
import type {
  Action,
  Beat,
  CharacterDef,
  ComposedState,
  Game,
  Module,
  PresetContext,
  Script,
  StateDelta,
} from "../types";

export function makeCharacter(
  id: string,
  overrides: Partial<CharacterDef> = {},
): CharacterDef {
  return {
    id,
    name: id,
    ...overrides,
  };
}

export function makeScript(
  id: string,
  overrides: Partial<Script> = {},
): Script {
  return {
    id,
    title: id,
    beats: [],
    ...overrides,
  };
}

export function makeAction(
  id: string,
  overrides: Partial<Action> = {},
): Action {
  return {
    id,
    title: id,
    cost: 1,
    ...overrides,
  };
}

// Minimal valid Game. Defaults to no characters/scripts; pass overrides
// to populate. Most tests want at least one character + one script to
// exercise dispatch.
export function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    title: "test",
    characters: [],
    scripts: [],
    ...overrides,
  };
}

export interface MakeCtxOptions {
  state?: ComposedState;
  rng?: () => number;
}

// Build a PresetContext for primitive tests. `rng` defaults to a fixed
// deterministic sequence so combat tests don't flake. Override via
// opts.rng for tests that want to control rolls.
export function makeCtx(game: Game, opts: MakeCtxOptions = {}): PresetContext {
  const rng = opts.rng ?? deterministicRng();
  const state = opts.state ?? createInitialState(game);
  return buildPresetContext(game, state, rng);
}

// Deterministic RNG: cycles through a fixed seeded LCG. Predictable
// across runs, no real randomness — good for "did the handler use rng
// at all" checks.
export function deterministicRng(seed = 0x12345678): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Build a state object directly from a game's createInitialState. Most
// tests just want a fresh state to apply deltas against.
export function makeState(game: Game = makeGame()): ComposedState {
  return createInitialState(game);
}

// Build a state where alice has affection 0 and bob has affection 0,
// no flags, no scripts completed. Compact shorthand for the dominant
// case in applyDelta / condition tests.
export function twoCharGame(): Game {
  return makeGame({
    characters: [makeCharacter("alice"), makeCharacter("bob")],
  });
}

// Tracker module: records every hook call into a tape. Drop into a
// game's modules to assert hook ordering / arguments in primitive
// tests. Returns the module + a getter for the tape.
export function trackerModule(id = "tracker"): {
  module: Module;
  events: HookEvent[];
} {
  const events: HookEvent[] = [];
  const push = (e: HookEvent) => events.push(e);
  const module: Module = {
    id,
    onSessionStart: () => push({ hook: "onSessionStart" }),
    onScriptSelect: (_ctx, scriptId) => {
      push({ hook: "onScriptSelect", scriptId });
    },
    onScriptStart: (_ctx, scriptId) => {
      push({ hook: "onScriptStart", scriptId });
    },
    onScriptComplete: (_ctx, scriptId) => {
      push({ hook: "onScriptComplete", scriptId });
    },
    onActionDispatch: (_ctx, action) => {
      push({ hook: "onActionDispatch", actionId: action.id });
    },
    onActionComplete: (_ctx, action) => {
      push({ hook: "onActionComplete", actionId: action.id });
    },
    onStateMutated: (_ctx, delta, source) => {
      push({ hook: "onStateMutated", delta, source });
    },
    onBeatBefore: (_ctx, scriptId, beatIdx, beat) => {
      push({ hook: "onBeatBefore", scriptId, beatIdx, beatType: beat.type });
    },
    onBeatAfter: (_ctx, scriptId, beatIdx, beat) => {
      push({ hook: "onBeatAfter", scriptId, beatIdx, beatType: beat.type });
    },
    onChoiceResolved: (_ctx, scriptId, beatIdx, choiceIdx, resolution) => {
      push({ hook: "onChoiceResolved", scriptId, beatIdx, choiceIdx, resolution });
    },
    onLabelEnter: (_ctx, scriptId, labelName) => {
      push({ hook: "onLabelEnter", scriptId, labelName });
    },
    onNarrationDrain: (_ctx, text) => {
      push({ hook: "onNarrationDrain", text });
    },
    onEndConditionFire: (_ctx, ec) => {
      push({ hook: "onEndConditionFire", reason: ec.reason });
    },
  };
  return { module, events };
}

export type HookEvent =
  | { hook: "onSessionStart" }
  | { hook: "onScriptSelect"; scriptId: string }
  | { hook: "onScriptStart"; scriptId: string }
  | { hook: "onScriptComplete"; scriptId: string }
  | { hook: "onActionDispatch"; actionId: string }
  | { hook: "onActionComplete"; actionId: string }
  | { hook: "onStateMutated"; delta: StateDelta; source: string }
  | { hook: "onBeatBefore"; scriptId: string; beatIdx: number; beatType: string }
  | { hook: "onBeatAfter"; scriptId: string; beatIdx: number; beatType: string }
  | {
      hook: "onChoiceResolved";
      scriptId: string;
      beatIdx: number;
      choiceIdx: number;
      resolution: import("../types").ChoiceResolution;
    }
  | { hook: "onLabelEnter"; scriptId: string; labelName: string }
  | { hook: "onNarrationDrain"; text: string }
  | { hook: "onEndConditionFire"; reason: string };
