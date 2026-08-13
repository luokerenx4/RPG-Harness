import type {
  CharacterDef,
  ComposedState,
  Game,
  ModuleInitializationContext,
  Module,
  RunFunction,
  StateDelta,
} from "./types";
import { makeScriptState } from "./types";
import { baselineModule } from "./modules/baseline";
import { runtimeModule } from "./modules/runtime";
import { trainingPreset, trainingRun } from "./presets/training";
import { vnRun } from "./presets/vn/run";
import { statefulRng } from "./rng";

export interface InitialStateOptions {
  /** Deterministically seeds built-in and author-owned module initialization. */
  seed?: number;
}

/** Author-owned world initialization failed before a playable save existed. */
export class ModuleInitializationError extends Error {
  readonly moduleId: string;
  readonly seed: number;
  readonly partialState: ComposedState;

  constructor(
    moduleId: string,
    seed: number,
    partialState: ComposedState,
    cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Module ${moduleId} initialization failed: ${reason}`, { cause });
    this.name = "ModuleInitializationError";
    this.moduleId = moduleId;
    this.seed = seed;
    this.partialState = structuredClone(partialState);
    if (cause instanceof Error && cause.stack) this.stack = cause.stack;
  }
}

export function defaultModules(): Module[] {
  return [baselineModule, runtimeModule];
}

// Resolve the full module list for a game. Always includes baseline +
// runtime (transient narration queue, etc.). Auto-includes the
// training preset when game.training is configured. Then layers
// user-provided modules on top. User modules cannot replace built-in
// modules (matched by id).
export function resolveModules(game: Game): Module[] {
  const builtin: Module[] = [baselineModule, runtimeModule];
  if (game.training) builtin.push(trainingPreset);
  const seen = new Set(builtin.map((m) => m.id));
  const game_modules = (game.modules ?? []).filter((m) => !seen.has(m.id));
  return [...builtin, ...game_modules];
}

export function createInitialState(game: Game, options?: InitialStateOptions): ComposedState;
export function createInitialState(
  characters: CharacterDef[],
  options?: InitialStateOptions,
): ComposedState;
export function createInitialState(
  arg: Game | CharacterDef[],
  options: InitialStateOptions = {},
): ComposedState {
  const game: Game = Array.isArray(arg)
    ? { title: "", characters: arg, scripts: [] }
    : arg;
  const modules = resolveModules(game);
  const seed = options.seed ?? Math.floor(Math.random() * 0x1_0000_0000);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error("Initial state seed must be a uint32 integer");
  }
  const rngCursor = {
    algorithm: "mulberry32" as const,
    state: seed >>> 0,
  };
  const context: ModuleInitializationContext = {
    seed,
    rng: statefulRng(rngCursor),
  };
  const composed: ComposedState = {
    baseline: undefined as never,
    runtime: undefined as never,
  };
  for (const mod of modules) {
    if (!mod.initialize) continue;
    let slice: unknown;
    try {
      slice = mod.initialize(game, context);
    } catch (error) {
      // Built-ins establish the minimum ComposedState contract. Once those
      // slices exist, preserve them for diagnostics but never persist them as
      // a playable save: verification must re-run this initializer from seed.
      if (composed.baseline && composed.runtime) {
        throw new ModuleInitializationError(mod.id, seed, composed, error);
      }
      throw error;
    }
    if (slice !== undefined) composed[mod.id] = slice;
  }
  // Author module initialization may consume the shared stream after the
  // runtime slice was created. Persist the final cursor so gameplay resumes
  // exactly after those world-generation draws.
  composed.runtime.rng = rngCursor;
  return composed;
}

// Apply a StateDelta to the state. When `game` is provided, characterStats
// changes clamp against the declared CharacterStatDef.min/max for each
// stat (RPGMaker-style bounded stats — hp can't exceed hpMax, can't drop
// below 0). When `game` is omitted (e.g. fixture-loader state restore),
// no clamping happens. Most callers go through `mutateState` which passes
// ctx.game in automatically.
export function applyDelta(
  state: ComposedState,
  delta: StateDelta,
  game?: Game,
): void {
  if (delta.characterStats) {
    for (const [charId, statDeltas] of Object.entries(delta.characterStats)) {
      const c = state.baseline.characters[charId];
      if (!c) continue;
      const def = game?.characters.find((cd) => cd.id === charId);
      for (const [name, change] of Object.entries(statDeltas)) {
        const next = (c.stats[name] ?? 0) + change;
        const statDef = def?.stats?.[name];
        const min = statDef?.min ?? Number.NEGATIVE_INFINITY;
        const max = statDef?.max ?? Number.POSITIVE_INFINITY;
        c.stats[name] = Math.max(min, Math.min(max, next));
      }
    }
  }
  if (delta.switches) {
    for (const [name, value] of Object.entries(delta.switches)) {
      state.baseline.switches[name] = value;
    }
  }
  if (delta.variables) {
    for (const [name, value] of Object.entries(delta.variables)) {
      const current = state.baseline.variables[name];
      if (typeof current === "number" && typeof value === "number") {
        state.baseline.variables[name] = current + value;
      } else {
        state.baseline.variables[name] = value;
      }
    }
  }
  if (delta.stats && state.training) {
    for (const [name, change] of Object.entries(delta.stats)) {
      const current = state.training.stats[name] ?? 0;
      const max = state.training.statMax[name] ?? Number.MAX_SAFE_INTEGER;
      state.training.stats[name] = clamp(current + change, 0, max);
    }
  }
  if (delta.statMax && state.training) {
    for (const [name, change] of Object.entries(delta.statMax)) {
      const current = state.training.statMax[name] ?? 0;
      state.training.statMax[name] = current + change;
    }
  }
  if (delta.inventory) {
    for (const [itemId, change] of Object.entries(delta.inventory)) {
      const current = state.baseline.inventory[itemId] ?? 0;
      const next = current + change;
      if (next <= 0) {
        // Preserve the invariant: present key ⇔ count >= 1.
        delete state.baseline.inventory[itemId];
      } else {
        state.baseline.inventory[itemId] = next;
      }
    }
  }
  if (delta.weapons) {
    for (const [weaponId, fields] of Object.entries(delta.weapons)) {
      // Weapons exist only if declared in game.weapons (baseline init
      // pre-creates each). Skip unknown weapon ids — game data
      // mismatch, not a runtime error.
      const w = state.baseline.weapons[weaponId];
      if (!w) continue;
      if (typeof fields.power === "number") {
        w.power = Math.max(0, w.power + fields.power);
      }
    }
  }
  if (delta.skills) {
    if (delta.skills.learn) {
      for (const id of delta.skills.learn) {
        if (!state.baseline.knownSkills.includes(id)) {
          state.baseline.knownSkills.push(id);
        }
      }
    }
    if (delta.skills.forget) {
      const drop = new Set(delta.skills.forget);
      state.baseline.knownSkills = state.baseline.knownSkills.filter(
        (id) => !drop.has(id),
      );
    }
  }
  if (delta.selfSwitches) {
    for (const [scriptId, flips] of Object.entries(delta.selfSwitches)) {
      let entry = state.baseline.scripts[scriptId];
      if (!entry) {
        entry = makeScriptState();
        state.baseline.scripts[scriptId] = entry;
      }
      for (const [name, value] of Object.entries(flips)) {
        if (
          (name === "A" || name === "B" || name === "C" || name === "D") &&
          typeof value === "boolean"
        ) {
          entry.selfSwitches[name] = value;
        }
      }
    }
  }
}

// Engine-internal helper: mark a script as completed in baseline.scripts
// AND append to completionOrder. Called by preset run loops at script
// end. Lazy-creates ScriptState if missing.
export function markScriptCompleted(
  state: ComposedState,
  scriptId: string,
  completedRevision?: string,
): void {
  let entry = state.baseline.scripts[scriptId];
  if (!entry) {
    entry = makeScriptState();
    state.baseline.scripts[scriptId] = entry;
  }
  const wasCompleted = entry.completed;
  entry.completed = true;
  if (completedRevision !== undefined) entry.completedRevision = completedRevision;
  if (!wasCompleted) {
    state.baseline.completionOrder.push(scriptId);
  }
}

// True if the script was previously completed. Equivalent to
// state.baseline.scripts[id]?.completed === true but reads more like
// English at call sites.
export function isScriptCompleted(
  state: ComposedState,
  scriptId: string,
): boolean {
  return state.baseline.scripts[scriptId]?.completed === true;
}

export function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export function cloneState(state: ComposedState): ComposedState {
  return structuredClone(state);
}

export function hydrateState(serialized: string): ComposedState {
  return JSON.parse(serialized) as ComposedState;
}

// Pick the main-loop generator for a game. Priority:
//   1. game.runFn (set by the CLI loader after a path-based preset
//      was dynamically imported)
//   2. game.preset string → built-in preset by name
//   3. auto-detect: training when game.training is set, else vn
export function resolveRunFn(game: Game): RunFunction {
  if (game.runFn) return game.runFn;
  if (game.preset === "training") return trainingRun;
  if (game.preset === "vn") return vnRun;
  if (game.preset !== undefined) {
    throw new Error(
      `state.resolveRunFn: unknown preset "${game.preset}". ` +
        `Built-in: "vn" / "training". Relative paths must be resolved ` +
        `by the CLI loader into game.runFn.`,
    );
  }
  return game.training ? trainingRun : vnRun;
}
