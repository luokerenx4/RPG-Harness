import { evaluateCondition } from "../condition";
import type {
  Action,
  HubActivity,
  HubSnapshot,
  Output,
  PresetContext,
  StatSnapshot,
} from "../types";

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
  const activities: HubActivity[] = [];
  const currentMapId = ctx.state.baseline.currentMapId;
  const currentMap =
    currentMapId !== null ? ctx.mapMap.get(currentMapId) : undefined;

  if (currentMap) {
    for (const conn of currentMap.connections ?? []) {
      const target = ctx.mapMap.get(conn.target);
      const title = target ? `→ ${target.name}（${conn.dir}）` : `→ ${conn.dir}`;
      const r =
        conn.requires === undefined
          ? { ok: true as const }
          : evaluateCondition(conn.requires, ctx.state);
      activities.push({
        id: `move:${conn.target}`,
        kind: "action",
        actionKind: "moveToMap",
        payload: { to: conn.target },
        title,
        category: "move",
        cost: 0,
        available: r.ok,
        ...(r.ok ? {} : { lockedReason: conn.lockedHint ?? r.reason }),
      });
    }
    for (const a of currentMap.actions ?? []) {
      pushAction(activities, ctx, a);
    }
  }

  for (const a of ctx.game.actions ?? []) {
    if (a.whenIn !== undefined) {
      if (currentMapId === null) continue;
      if (!a.whenIn.includes(currentMapId)) continue;
    }
    pushAction(activities, ctx, a);
  }

  return activities;
}

function pushAction(
  activities: HubActivity[],
  ctx: PresetContext,
  a: Action,
): void {
  const r =
    a.requires === undefined
      ? { ok: true as const }
      : evaluateCondition(a.requires, ctx.state);
  activities.push({
    id: `action:${a.id}`,
    kind: "action",
    title: a.title,
    description: a.description,
    category: a.category,
    ...(a.aiTags ? { aiTags: [...a.aiTags] } : {}),
    cost: a.cost,
    available: r.ok,
    ...(r.ok ? {} : { lockedReason: r.reason }),
  });
}
