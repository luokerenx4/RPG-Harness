// Hub Output construction for training-mode games. Walks game.scripts
// + game.actions, filters by slot/availability, builds a HubSnapshot.

import { evaluateCondition } from "@rpg-harness/engine";
import type {
  ComposedState,
  Game,
  HubActivity,
  HubSnapshot,
  Output,
  StateDelta,
} from "@rpg-harness/engine";

export function buildHubSnapshot(state: ComposedState, game: Game): Output {
  const cfg = game.training!;
  const t = state.training!;
  const slotName = cfg.slotNames[t.slot] ?? `slot ${t.slot}`;
  const isNight = t.slot === cfg.slotsPerDay - 1;

  const activities: HubActivity[] = [];

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

  for (const a of game.actions ?? []) {
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
      value: state.baseline.characters[c.id]?.affection ?? 0,
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
  if (effects.affection) {
    for (const [k, v] of Object.entries(effects.affection)) {
      parts.push(`${k}${v >= 0 ? "+" : ""}${v}`);
    }
  }
  if (effects.stats) {
    for (const [k, v] of Object.entries(effects.stats)) {
      parts.push(`${k}${v >= 0 ? "+" : ""}${v}`);
    }
  }
  if (effects.flags) {
    for (const [k, v] of Object.entries(effects.flags)) {
      parts.push(`${k}=${v}`);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}
