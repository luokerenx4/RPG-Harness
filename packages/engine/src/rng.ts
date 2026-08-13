import type { ComposedState, RuntimeState } from "./types";

const STEP = 0x6d2b79f5;

// Backfill old saves deterministically. JSON property order is stable for a
// parsed checkpoint written by this engine, and both forks receive identical
// bytes/state. This cannot recover draws made before RNG persistence existed,
// but it makes every future draw from that legacy checkpoint reproducible.
export function ensurePersistedRng(state: ComposedState): void {
  state.runtime ??= {
    pendingNarrations: [],
    activeTriggers: [],
    firedTriggers: [],
    firedScriptStarts: [],
    lastHubActivities: [],
  };
  if (state.runtime.rng !== undefined) return;
  state.runtime.rng = {
    algorithm: "mulberry32",
    state: fnv1a32(JSON.stringify(state)),
  };
}

export function persistedRng(runtime: RuntimeState): () => number {
  if (runtime.rng === undefined) {
    throw new Error("persistedRng requires an initialized runtime RNG state");
  }
  return statefulRng(runtime.rng);
}

/** Create a Mulberry32 closure whose cursor remains externally persistable. */
export function statefulRng(
  cursor: NonNullable<RuntimeState["rng"]>,
): () => number {
  return () => {
    cursor.state = (cursor.state + STEP) >>> 0;
    let value = cursor.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
