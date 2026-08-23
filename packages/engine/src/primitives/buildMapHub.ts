import type {
  HubActivity,
  HubSnapshot,
  Output,
  PresetContext,
  StatSnapshot,
} from "../types";
import { collectMapAvailableResources } from "./collectMapResources";
import { isMapEventPlayerAction } from "../maps";

// Build a hub Output scoped to the current map. Activity list contents:
//   1. Connections of the current map → synthesized "move" activities
//      that dispatch through the built-in `moveToMap` handler with
//      `payload.to = target`. Each connection's `requires` becomes the
//      activity's lockedReason source; locked connections still appear
//      so the player sees where they could go.
//   2. The current map's own `actions[]`, filtered through their
//      `requires`. Locked actions surface with a `lockedReason`.
//   3. Global `game.actions[]` that either omit `whenIn` (visible
//      everywhere) or list the current map id. Same `requires` gating.
//
// When `state.baseline.currentMapId` is null, only the global-action
// pass runs — games that don't use maps yet still get a sensible hub.
//
// Intentionally minimal:
//   - No script-as-activity surfacing. The vn/training presets already
//     decide their own script-picker semantics; map-hub stays focused
//     on map-scoped actions.
//   - No `stats` / `affections` aggregation. The HubSnapshot fields are
//     filled with the engine's defaults — modules that want richer
//     telemetry should compose their own hub Output and call into
//     `collectMapActivities` (exported) for just the activity list.
export function buildMapHubSnapshot(ctx: PresetContext): Output {
  const activities = collectMapActivities(ctx);
  const snapshot: HubSnapshot = {
    day: 0,
    maxDay: 0,
    slot: 0,
    slotName: "",
    slotsPerDay: 0,
    stats: [] as StatSnapshot[],
    affections: ctx.game.characters.map((c) => ({
      id: c.id,
      name: c.name,
      value: ctx.state.baseline.characters[c.id]?.stats.affection ?? 0,
    })),
    activities,
  };
  return { type: "hubMenu", snapshot, visualState: ctx.state.baseline.visuals };
}

// Collect the map-scoped activity list without wrapping it in a hub
// Output. Useful for game modules that already build their own hub
// (sengoku-raid's mode-dependent menu) but want to delegate the
// map-action / connection enumeration to the engine.
export function collectMapActivities(ctx: PresetContext): HubActivity[] {
  return collectMapAvailableResources(ctx).flatMap((resource) =>
    resource.activity &&
        (resource.trigger === undefined || isMapEventPlayerAction(resource.trigger))
      ? [resource.activity]
      : []
  );
}
