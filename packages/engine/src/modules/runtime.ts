import type {
  Game,
  Module,
  ModuleInitializationContext,
  RuntimeState,
} from "../types";

export const RUNTIME_NAMESPACE = "runtime";

// Initial transient run-loop state. Holds the cross-step narration
// queue + the reactive-trigger bookkeeping (active edge tracking +
// once-fired set).
export function createRuntimeState(
  seed = Math.floor(Math.random() * 0x1_0000_0000),
): RuntimeState {
  return {
    rng: {
      algorithm: "mulberry32",
      state: seed >>> 0,
    },
    pendingNarrations: [],
    activeTriggers: [],
    firedTriggers: [],
    firedScriptStarts: [],
    lastHubActivities: [],
  };
}

export const runtimeModule: Module = {
  id: RUNTIME_NAMESPACE,
  version: "0.1",
  initialize(_game: Game, context: ModuleInitializationContext): RuntimeState {
    return createRuntimeState(context.seed);
  },
};
