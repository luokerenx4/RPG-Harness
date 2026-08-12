import type { Beat, Script } from "./types";

const revisionCache = new WeakMap<Script, string>();

/** Fingerprint authored data that can change how a script is reached or played. */
export function scriptRevision(script: Script): string {
  const cached = revisionCache.get(script);
  if (cached !== undefined) return cached;
  const source = JSON.stringify({
    requires: script.requires ?? null,
    ai: script.ai ?? null,
    cost: script.cost ?? null,
    beats: script.beats.map(canonicalBeat),
  });
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const revision = (hash >>> 0).toString(36);
  revisionCache.set(script, revision);
  return revision;
}

function canonicalBeat(beat: Beat): Beat {
  if (beat.type !== "choice" || beat.options.some((option) => option.id === undefined)) {
    return beat;
  }
  return {
    ...beat,
    // Stable choice identities make presentation order non-semantic for
    // evidence. An old selection still exercises the same authored branch
    // after buttons move; copy, gates, effects and targets remain hashed.
    options: [...beat.options].sort((left, right) => left.id!.localeCompare(right.id!)),
  };
}
