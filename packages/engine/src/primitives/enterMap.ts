import type { ComposedState, Game, MapDef } from "../types";

export class EnterMapError extends Error {}

// Transition the player into a map. The single engine entrypoint for
// "where am I now":
//   1. Validates the target map exists in game.maps.
//   2. Updates state.baseline.currentMapId.
//   3. Syncs state.baseline.visuals.bg to map.bg (when set), so the next
//      Output's visualState reflects the new location without each game
//      having to re-issue a :setBg directive.
//   4. If the map declares onEnter (a script id), queues it into
//      baseline.currentScriptId so the run loop runs it next iteration.
//      Refuses to queue if a script is already mid-flight — the caller
//      is responsible for sequencing transitions around active scripts.
//
// Character spawn rolls are NOT performed here. They are module-owned
// (different games roll differently — flat 1 in 5, deterministic on
// first entry, etc.). The MapDef carries the rule list; how to read it
// is the module's choice.
//
// Takes (state, game, mapId) rather than PresetContext so that
// ActionHandler bodies — which only receive ActionContext — can call it
// directly without re-plumbing the registries.
export function enterMap(
  state: ComposedState,
  game: Game,
  mapId: string,
): MapDef {
  const map = (game.maps ?? []).find((m) => m.id === mapId);
  if (!map) {
    throw new EnterMapError(
      `enterMap: undeclared map "${mapId}". Declared: ${
        (game.maps ?? []).map((m) => m.id).join(", ") || "(none)"
      }`,
    );
  }
  state.baseline.currentMapId = mapId;
  state.runtime.mapPositionMapId = mapId;
  state.runtime.mapPosition = map.layout?.playerStart ?? { x: 0, y: 0 };
  if (map.bg) {
    state.baseline.visuals.bg = map.bg;
  }
  if (map.onEnter !== undefined) {
    const scriptExists = game.scripts.some((s) => s.id === map.onEnter);
    if (!scriptExists) {
      throw new EnterMapError(
        `enterMap: map "${mapId}".onEnter references undeclared script "${map.onEnter}"`,
      );
    }
    if (state.baseline.currentScriptId !== null) {
      throw new EnterMapError(
        `enterMap: cannot run map "${mapId}".onEnter — a script is already active ` +
          `(currentScriptId="${state.baseline.currentScriptId}"). Finish or ` +
          `clear it before transitioning.`,
      );
    }
    state.baseline.currentScriptId = map.onEnter;
    state.baseline.beatIndex = 0;
  }
  return map;
}
