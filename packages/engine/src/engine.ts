// Engine: state holder + ctx builder. The main run loop USED to live
// here (PR #1 / PR #2), but after C3 it lives in each preset's run.ts
// (presets/vn/run.ts, presets/training/run.ts, or a game-ejected
// preset/run.ts). Engine.run() now just resolves which preset to use
// and delegates.
//
// What still lives here:
//   - state initialization (via createInitialState in state.ts)
//   - PresetContext construction (script/action/character maps,
//     action handler registry from all modules' actionHandlers)
//   - getState / serialize / getAvailableScripts for callers (CLI
//     play screen uses these for session persistence)

import { evaluateCondition } from "./condition";
import { cloneState, createInitialState, resolveModules, resolveRunFn } from "./state";
import { ensurePersistedRng, persistedRng } from "./rng";
import type {
  ActionHandler,
  ComposedState,
  Game,
  Input,
  Output,
  PresetContext,
  RunFunction,
  ScriptInfo,
  Trigger,
} from "./types";

// Build a PresetContext from a Game + (optional pre-built) state.
// Same logic the Engine constructor uses; exported so tests can drive
// primitives (dispatchActivity, checkTriggers, applyActionResult, ...)
// without instantiating an Engine. Pass `rng` to override Math.random
// for deterministic combat / choice tests.
export function buildPresetContext(
  game: Game,
  state?: ComposedState,
  rng: () => number = Math.random,
): PresetContext {
  const composed = state ?? createInitialState(game);
  const scriptMap = new Map(game.scripts.map((s) => [s.id, s]));
  const actionMap = new Map((game.actions ?? []).map((a) => [a.id, a]));
  const itemMap = new Map((game.items ?? []).map((i) => [i.id, i]));
  const enemyMap = new Map((game.enemies ?? []).map((e) => [e.id, e]));
  const weaponMap = new Map((game.weapons ?? []).map((w) => [w.id, w]));
  const skillMap = new Map((game.skills ?? []).map((s) => [s.id, s]));
  const mapMap = new Map((game.maps ?? []).map((m) => [m.id, m]));
  const assetMap = new Map((game.assets ?? []).map((a) => [a.path, a]));
  const characterNameMap = new Map(
    game.characters.map((c) => [c.id, c.name]),
  );
  const modules = resolveModules(game);

  // Action handler registry. Indexed by both bare ("combat") and
  // qualified ("module-id:combat") keys. Qualified form is always
  // present; bare form is registered only when exactly one module
  // provides that kind. Multiple-providers case: bare form is omitted
  // — actions must reference the qualified form. Action dispatch
  // looks up `action.kind` verbatim, so authors can pick the form
  // that fits.
  const actionHandlerRegistry: Record<string, ActionHandler> = {};
  const providersByKind = new Map<string, string[]>();
  for (const mod of modules) {
    const handlerEntries = Object.entries(mod.actionHandlers ?? {});
    if (mod.provides) {
      const declared = new Set(mod.provides);
      const actual = new Set(handlerEntries.map(([k]) => k));
      const missing = mod.provides.filter((k) => !actual.has(k));
      const extra = handlerEntries
        .map(([k]) => k)
        .filter((k) => !declared.has(k));
      if (missing.length > 0 || extra.length > 0) {
        const parts: string[] = [];
        if (missing.length > 0) {
          parts.push(`declared but no handler: ${missing.join(", ")}`);
        }
        if (extra.length > 0) {
          parts.push(`handler but not declared: ${extra.join(", ")}`);
        }
        throw new Error(
          `Engine: module "${mod.id}" provides/actionHandlers mismatch — ${parts.join(
            "; ",
          )}`,
        );
      }
    }
    for (const [kind, handler] of handlerEntries) {
      const qualified = `${mod.id}:${kind}`;
      if (actionHandlerRegistry[qualified]) {
        throw new Error(
          `Engine: duplicate qualified action handler "${qualified}"`,
        );
      }
      actionHandlerRegistry[qualified] = handler;
      const existing = providersByKind.get(kind) ?? [];
      existing.push(mod.id);
      providersByKind.set(kind, existing);
    }
  }
  // Register bare keys only for kinds with a single provider; record
  // ambiguous kinds so dispatch can give an informative error.
  for (const [kind, providers] of providersByKind) {
    if (providers.length === 1) {
      const moduleId = providers[0]!;
      const handler = actionHandlerRegistry[`${moduleId}:${kind}`];
      if (handler) actionHandlerRegistry[kind] = handler;
    }
  }

  const triggerRegistry: Trigger[] = [];
  const seenTriggerIds = new Set<string>();
  for (const mod of modules) {
    for (const trig of mod.triggers ?? []) {
      if (seenTriggerIds.has(trig.id)) {
        throw new Error(
          `Engine: duplicate trigger id "${trig.id}" (module ${mod.id})`,
        );
      }
      seenTriggerIds.add(trig.id);
      triggerRegistry.push(trig);
    }
  }

  return {
    state: composed,
    game,
    modules,
    actionHandlerRegistry,
    triggerRegistry,
    scriptMap,
    actionMap,
    itemMap,
    enemyMap,
    weaponMap,
    skillMap,
    mapMap,
    assetMap,
    characterNameMap,
    rng,
  };
}

export class Engine {
  private state: ComposedState;
  private readonly ctx: PresetContext;
  private readonly runFn: RunFunction;

  constructor(
    private readonly game: Game,
    initialState?: ComposedState,
  ) {
    this.state = initialState ?? createInitialState(game);
    // Backfill runtime fields that older saved sessions may lack. New
    // fields added to RuntimeState are append-only; absent on load
    // means "default empty". Cheaper here than a versioned migration.
    const rt = this.state.runtime;
    if (rt) {
      if (rt.firedScriptStarts === undefined) rt.firedScriptStarts = [];
    }
    ensurePersistedRng(this.state);
    this.ctx = buildPresetContext(game, this.state, persistedRng(this.state.runtime));
    this.runFn = resolveRunFn(game);
  }

  getState(): ComposedState {
    return cloneState(this.state);
  }

  serialize(): string {
    return JSON.stringify(this.state);
  }

  getAvailableScripts(): ScriptInfo[] {
    return this.game.scripts
      .filter(
        (s) =>
          this.state.baseline.scripts[s.id]?.completed !== true &&
          (s.requires === undefined || evaluateCondition(s.requires, this.state).ok),
      )
      .map((s) => ({ id: s.id, title: s.title }));
  }

  // Delegate to the preset's run function. To customize the main loop
  // for a specific game, eject the preset and edit its run.ts directly
  // (see rpgh init --eject).
  async *run(): AsyncGenerator<Output, void, Input> {
    yield* this.runFn(this.ctx);
  }
}
