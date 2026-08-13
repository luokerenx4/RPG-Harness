// Hub Output construction for training-mode games. Walks game.scripts
// + game.actions, filters by slot / availability / current-map scope,
// surfaces map-connection moves as activities, builds a HubSnapshot.

import { evaluateCondition } from "../../condition";
import type {
  ComposedState,
  Game,
  HubActivity,
  HubSnapshot,
  Output,
  StateDelta,
} from "../../types";

export function buildHubSnapshot(state: ComposedState, game: Game): Output {
  const cfg = game.training!;
  const t = state.training!;
  const slotName = cfg.slotNames[t.slot] ?? `slot ${t.slot}`;
  const isNight = t.slot === cfg.slotsPerDay - 1;

  const activities: HubActivity[] = [];
  const currentMapId = state.baseline.currentMapId;
  const currentMap =
    currentMapId !== null
      ? (game.maps ?? []).find((m) => m.id === currentMapId)
      : undefined;

  for (const s of game.scripts) {
    if (state.baseline.scripts[s.id]?.completed === true) continue;
    const r =
      s.requires === undefined ? { ok: true } : evaluateCondition(s.requires, state);
    if (!r.ok) continue;
    if (isExplicitlyEnding(game, s.id)) continue;
    activities.push({
      id: `script:${s.id}`,
      kind: "script",
      title: `📖 ${s.title}`,
      cost: 1,
      available: true,
    });
  }

  // Map connections — synthesize "move" activities pointing at neighbor
  // maps. Locked connections still appear so the player sees where they
  // could go. Movement costs 0 slots; advancing the calendar is a
  // separate concern.
  if (currentMap) {
    for (const conn of currentMap.connections ?? []) {
      const target = (game.maps ?? []).find((m) => m.id === conn.target);
      const title = target ? `→ ${target.name}（${conn.dir}）` : `→ ${conn.dir}`;
      const r =
        conn.requires === undefined
          ? { ok: true as const }
          : evaluateCondition(conn.requires, state);
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
    // Map-inline actions — same gating + slot rules as game.actions.
    for (const a of currentMap.actions ?? []) {
      if (a.slot === "day" && isNight) continue;
      if (a.slot === "night" && !isNight) continue;
      const r =
        a.requires === undefined ? { ok: true } : evaluateCondition(a.requires, state);
      activities.push({
        id: `action:${a.id}`,
        kind: "action",
        title: a.title,
        description: a.description,
        category: a.category,
        ...(a.aiTags ? { aiTags: [...a.aiTags] } : {}),
        cost: a.cost,
        effectsHint: formatEffectsHint(a.effects),
        available: r.ok,
        ...(r.ok ? {} : { lockedReason: r.reason }),
      });
    }
  }

  for (const a of game.actions ?? []) {
    if (a.slot === "day" && isNight) continue;
    if (a.slot === "night" && !isNight) continue;
    // Filter by current map. Omitted whenIn = ambient (visible everywhere).
    if (a.whenIn !== undefined) {
      if (currentMapId === null) continue;
      if (!a.whenIn.includes(currentMapId)) continue;
    }
    const r =
      a.requires === undefined ? { ok: true } : evaluateCondition(a.requires, state);
    activities.push({
      id: `action:${a.id}`,
      kind: "action",
      title: a.title,
      description: a.description,
      category: a.category,
      ...(a.aiTags ? { aiTags: [...a.aiTags] } : {}),
      cost: a.cost,
      effectsHint: formatEffectsHint(a.effects),
      available: r.ok,
      ...(r.ok ? {} : { lockedReason: r.reason }),
    });
  }

  // Apply hub markers. Modules populate state.runtime.hubMarkers with
  // per-activity-id title prefixes (e.g. "★") to signal "this option
  // has new content today". The marker is prepended to the activity's
  // title in-place — anything that resolves the activity (the player
  // picking it, dispatchActivity routing the input) still works because
  // the id is unchanged.
  const markers = state.runtime.hubMarkers;
  if (markers) {
    for (const a of activities) {
      const prefix = markers[a.id];
      if (prefix) a.title = `${prefix} ${a.title}`;
    }
  }

  const snapshot: HubSnapshot = {
    day: t.day,
    maxDay: cfg.maxDay,
    slot: t.slot,
    slotName,
    slotsPerDay: cfg.slotsPerDay,
    stats: cfg.stats.map((sd) => ({
      id: sd.id,
      name: sd.name,
      value: t.stats[sd.id] ?? 0,
      min: sd.min,
      max: t.statMax[sd.id] ?? sd.max,
      ...(sd.thresholds ? { thresholds: sd.thresholds } : {}),
    })),
    affections: game.characters.map((c) => ({
      id: c.id,
      name: c.name,
      value: state.baseline.characters[c.id]?.stats.affection ?? 0,
    })),
    activities,
  };

  return { type: "hubMenu", snapshot };
}

function isExplicitlyEnding(game: Game, scriptId: string): boolean {
  if (!game.training) return false;
  return game.training.endConditions.some((ec) => ec.goto === scriptId);
}

function formatEffectsHint(
  effects: StateDelta | undefined,
): string | undefined {
  if (!effects) return undefined;
  const parts: string[] = [];
  if (effects.characterStats) {
    for (const [charId, stats] of Object.entries(effects.characterStats)) {
      for (const [name, v] of Object.entries(stats)) {
        const suffix = name === "affection" ? "" : `.${name}`;
        parts.push(`${charId}${suffix}${v >= 0 ? "+" : ""}${v}`);
      }
    }
  }
  if (effects.stats) {
    for (const [k, v] of Object.entries(effects.stats)) {
      parts.push(`${k}${v >= 0 ? "+" : ""}${v}`);
    }
  }
  if (effects.switches) {
    for (const [k, v] of Object.entries(effects.switches)) {
      parts.push(`${k}=${v}`);
    }
  }
  if (effects.variables) {
    for (const [k, v] of Object.entries(effects.variables)) {
      parts.push(`${k}=${v}`);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}
