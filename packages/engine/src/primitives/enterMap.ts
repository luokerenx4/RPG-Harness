import type { ComposedState, Game, MapArrivalDef, MapDef, MapPoint } from "../types";
import { mapPositionLayoutKey } from "../maps";

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
// Takes (state, game, mapId, arrival?) rather than PresetContext so that
// ActionHandler bodies — which only receive ActionContext — can call it
// directly without re-plumbing the registries. All target and onEnter
// preflight happens before the first state mutation, so a rejected transfer
// cannot leave the player half-transitioned.
export function enterMap(
  state: ComposedState,
  game: Game,
  mapId: string,
  arrival?: MapArrivalDef,
): MapDef {
  const map = (game.maps ?? []).find((m) => m.id === mapId);
  if (!map) {
    throw new EnterMapError(
      `enterMap: undeclared map "${mapId}". Declared: ${
        (game.maps ?? []).map((m) => m.id).join(", ") || "(none)"
      }`,
    );
  }
  const arrivalPoint = resolveArrivalPoint(map, arrival);
  if (map.onEnter !== undefined) {
    const scriptExists = game.scripts.some((script) => script.id === map.onEnter);
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
  }
  state.baseline.currentMapId = mapId;
  state.runtime.mapPositionMapId = mapId;
  state.runtime.mapPosition = arrivalPoint;
  state.runtime.mapPositionLayoutKey = mapPositionLayoutKey(map);
  if (map.bg) {
    state.baseline.visuals.bg = map.bg;
  }
  if (map.onEnter !== undefined) {
    state.baseline.currentScriptId = map.onEnter;
    state.baseline.beatIndex = 0;
  }
  return map;
}

function resolveArrivalPoint(map: MapDef, arrival?: MapArrivalDef): MapPoint {
  if (arrival === undefined) {
    const start = map.layout?.playerStart ?? { x: 0, y: 0 };
    return { ...start };
  }
  const hasPlacement = arrival.placementId !== undefined;
  const hasPoint = arrival.at !== undefined;
  if (hasPlacement === hasPoint) {
    throw new EnterMapError(
      `enterMap: map "${map.id}" arrival must declare exactly one of placementId or at`,
    );
  }
  if (hasPlacement) {
    const placementId = arrival.placementId;
    if (typeof placementId !== "string" || placementId.length === 0) {
      throw new EnterMapError(
        `enterMap: map "${map.id}" arrival placementId must be a non-empty string`,
      );
    }
    const placement = (map.placements ?? []).find((candidate) => candidate.id === placementId);
    if (!placement) {
      throw new EnterMapError(
        `enterMap: map "${map.id}" has no arrival placement "${placementId}"`,
      );
    }
    return { ...placement.at };
  }
  const point = arrival.at;
  if (!point || !Number.isInteger(point.x) || !Number.isInteger(point.y) || point.x < 0 || point.y < 0) {
    throw new EnterMapError(
      `enterMap: map "${map.id}" arrival coordinates must be non-negative integers`,
    );
  }
  if (!map.layout) {
    throw new EnterMapError(
      `enterMap: map "${map.id}" coordinate arrival requires a spatial layout`,
    );
  }
  if (point.x >= map.layout.width || point.y >= map.layout.height) {
    throw new EnterMapError(
      `enterMap: map "${map.id}" arrival ${point.x},${point.y} must fit inside ${map.layout.width}x${map.layout.height} layout`,
    );
  }
  return { ...point };
}
