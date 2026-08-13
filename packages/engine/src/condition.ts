import type {
  ComposedState,
  Condition,
  Game,
  VariableValue,
} from "./types";

// Result of evaluating a Condition. `reason` is populated only when
// ok=false, with a short structured string describing which atomic
// predicate failed (and, where meaningful, the current value vs the
// threshold). UI/game layers can show it verbatim or re-render in a
// preferred locale — the engine keeps it terse and machine-greppable
// ("affection.kagari ≥ 4 (現在 2)" rather than a full sentence).
export interface ConditionResult {
  ok: boolean;
  reason?: string;
}

/**
 * Convert the same condition DSL consumed by AI/search into a player-facing
 * explanation. Stable ids remain in `requires` and diagnostic `reason`; this
 * projection resolves author-owned labels instead of asking renderers to
 * reverse-engineer implementation names.
 */
export function explainCondition(
  condition: Condition,
  state: ComposedState,
  game: Game,
): string {
  if ("all" in condition) {
    return condition.all
      .filter((child) => !evaluateCondition(child, state).ok)
      .map((child) => explainCondition(child, state, game))
      .join("、");
  }
  if ("any" in condition) {
    return `次のいずれか：${condition.any
      .map((child) => explainCondition(child, state, game))
      .join("／")}`;
  }
  if ("not" in condition) {
    return `${explainCondition(condition.not, state, game)}を満たさない`;
  }
  if ("scriptCompleted" in condition) {
    return `先に「${scriptLabel(game, condition.scriptCompleted)}」を完了`;
  }
  if ("selfSwitch" in condition) {
    return `「${scriptLabel(game, condition.selfSwitch.scriptId)}」の条件を進める`;
  }
  if ("affection" in condition) {
    return rangeExplanation(
      characterStatLabel(game, condition.affection.character, "affection"),
      state.baseline.characters[condition.affection.character]?.stats.affection ?? 0,
      condition.affection,
    );
  }
  if ("characterStat" in condition) {
    return rangeExplanation(
      characterStatLabel(
        game,
        condition.characterStat.character,
        condition.characterStat.name,
      ),
      state.baseline.characters[condition.characterStat.character]?.stats[
        condition.characterStat.name
      ] ?? 0,
      condition.characterStat,
    );
  }
  if ("switch" in condition) {
    const label = switchLabel(game, condition.switch.name);
    return condition.switch.eq === false ? `${label}を満たさない` : label;
  }
  if ("variable" in condition) {
    const def = game.variables?.find((item) => item.id === condition.variable.name);
    return valueExplanation(
      def?.label ?? def?.description ?? humanizeId(condition.variable.name),
      state.baseline.variables[condition.variable.name],
      condition.variable,
    );
  }
  if ("stat" in condition) {
    const def = game.training?.stats.find((item) => item.id === condition.stat.name);
    return rangeExplanation(
      def?.name ?? humanizeId(condition.stat.name),
      state.training?.stats[condition.stat.name] ?? 0,
      condition.stat,
    );
  }
  if ("inventory" in condition) {
    const item = game.items?.find((entry) => entry.id === condition.inventory.itemId);
    return rangeExplanation(
      item?.name ?? humanizeId(condition.inventory.itemId),
      state.baseline.inventory[condition.inventory.itemId] ?? 0,
      condition.inventory,
    );
  }
  if ("weaponPower" in condition) {
    const weapon = game.weapons?.find((entry) => entry.id === condition.weaponPower.weaponId);
    return rangeExplanation(
      `${weapon?.name ?? humanizeId(condition.weaponPower.weaponId)}の威力`,
      state.baseline.weapons[condition.weaponPower.weaponId]?.power ?? 0,
      condition.weaponPower,
    );
  }
  if ("knowsSkill" in condition) {
    const skill = game.skills?.find((entry) => entry.id === condition.knowsSkill);
    return `「${skill?.name ?? humanizeId(condition.knowsSkill)}」を習得`;
  }
  if ("day" in condition) {
    return rangeExplanation("日数", state.training?.day ?? 0, condition.day);
  }
  if ("slot" in condition) {
    return rangeExplanation("時間帯", state.training?.slot ?? 0, condition.slot);
  }
  return "解放条件を満たす";
}

function characterStatLabel(game: Game, characterId: string, statId: string): string {
  const character = game.characters.find((entry) => entry.id === characterId);
  const characterName = character?.name ?? humanizeId(characterId);
  const stat = character?.stats?.[statId];
  const statName = stat?.label ?? stat?.description ??
    (statId === "affection" ? "親密度" : humanizeId(statId));
  return `${characterName}の${statName}`;
}

function scriptLabel(game: Game, scriptId: string): string {
  return game.scripts.find((entry) => entry.id === scriptId)?.title ?? humanizeId(scriptId);
}

function switchLabel(game: Game, switchId: string): string {
  const entry = game.switches?.find((item) => item.id === switchId);
  return entry?.label ?? entry?.description ?? humanizeId(switchId);
}

function rangeExplanation(
  label: string,
  current: number,
  query: { min?: number; max?: number; eq?: number },
): string {
  if (query.eq !== undefined) return `${label} ${query.eq}（現在 ${current}）`;
  if (query.min !== undefined) return `${label} ${query.min} 以上（現在 ${current}）`;
  if (query.max !== undefined) return `${label} ${query.max} 以下（現在 ${current}）`;
  return label;
}

function valueExplanation(
  label: string,
  current: VariableValue | undefined,
  query: { eq?: VariableValue; min?: number; max?: number },
): string {
  if (query.eq !== undefined) {
    return `${label}「${String(query.eq)}」（現在「${String(current ?? "")}」）`;
  }
  return rangeExplanation(
    label,
    typeof current === "number" ? current : 0,
    { min: query.min, max: query.max },
  );
}

function humanizeId(id: string): string {
  return id.replace(/[._:/-]+/gu, " ").replace(/\s+/gu, " ").trim();
}

export function evaluateCondition(
  cond: Condition,
  state: ComposedState,
): ConditionResult {
  if ("all" in cond) {
    const failed: string[] = [];
    for (const c of cond.all) {
      const r = evaluateCondition(c, state);
      if (!r.ok) failed.push(r.reason ?? "(reason missing)");
    }
    if (failed.length === 0) return { ok: true };
    return { ok: false, reason: failed.join("、") };
  }
  if ("any" in cond) {
    const reasons: string[] = [];
    for (const c of cond.any) {
      const r = evaluateCondition(c, state);
      if (r.ok) return { ok: true };
      reasons.push(r.reason ?? "(reason missing)");
    }
    return { ok: false, reason: `次の何れか：${reasons.join(" / ")}` };
  }
  if ("not" in cond) {
    const r = evaluateCondition(cond.not, state);
    if (!r.ok) return { ok: true };
    return { ok: false, reason: `否定条件が成立：${r.reason ?? ""}`.trimEnd() };
  }
  if ("scriptCompleted" in cond) {
    const ok = state.baseline.scripts[cond.scriptCompleted]?.completed === true;
    return ok
      ? { ok: true }
      : { ok: false, reason: `前提：${cond.scriptCompleted} 未完了` };
  }
  if ("selfSwitch" in cond) {
    const entry = state.baseline.scripts[cond.selfSwitch.scriptId];
    const value = entry?.selfSwitches[cond.selfSwitch.name] ?? false;
    const eq = cond.selfSwitch.eq ?? true;
    if (value === eq) return { ok: true };
    return {
      ok: false,
      reason: `selfSwitch.${cond.selfSwitch.scriptId}.${cond.selfSwitch.name} = ${eq} が要る (現在 ${value})`,
    };
  }
  if ("affection" in cond) {
    const c = state.baseline.characters[cond.affection.character];
    if (!c) {
      return {
        ok: false,
        reason: `character ${cond.affection.character} unknown`,
      };
    }
    const value = c.stats.affection ?? 0;
    return rangeReason(
      value,
      cond.affection,
      `affection.${cond.affection.character}`,
    );
  }
  if ("characterStat" in cond) {
    const c = state.baseline.characters[cond.characterStat.character];
    if (!c) {
      return {
        ok: false,
        reason: `character ${cond.characterStat.character} unknown`,
      };
    }
    const value = c.stats[cond.characterStat.name] ?? 0;
    return rangeReason(
      value,
      cond.characterStat,
      `${cond.characterStat.character}.${cond.characterStat.name}`,
    );
  }
  if ("switch" in cond) {
    const v = state.baseline.switches[cond.switch.name];
    const { eq } = cond.switch;
    const target = eq ?? true;
    if (v === target) return { ok: true };
    if (eq === undefined) {
      return { ok: false, reason: `switch.${cond.switch.name} が要る` };
    }
    return {
      ok: false,
      reason: `switch.${cond.switch.name} = ${eq} が要る (現在 ${v ?? false})`,
    };
  }
  if ("variable" in cond) {
    const v = state.baseline.variables[cond.variable.name];
    const { eq, min, max } = cond.variable;
    if (eq !== undefined) {
      if (v === eq) return { ok: true };
      return {
        ok: false,
        reason: `${cond.variable.name} = ${String(eq)} が要る (現在 ${String(v)})`,
      };
    }
    if (typeof v !== "number") {
      return {
        ok: false,
        reason: `${cond.variable.name} が数値でない (現在 ${String(v)})`,
      };
    }
    return rangeReason(v, { min, max }, cond.variable.name);
  }
  if ("stat" in cond) {
    if (!state.training) {
      return { ok: false, reason: `stat ${cond.stat.name}: training preset 未使用` };
    }
    const v = state.training.stats[cond.stat.name];
    if (v === undefined) {
      return { ok: false, reason: `stat ${cond.stat.name} 未定義` };
    }
    return rangeReason(v, cond.stat, `stat.${cond.stat.name}`);
  }
  if ("inventory" in cond) {
    const count = state.baseline.inventory[cond.inventory.itemId] ?? 0;
    return rangeReason(
      count,
      cond.inventory,
      `inventory.${cond.inventory.itemId}`,
    );
  }
  if ("weaponPower" in cond) {
    const w = state.baseline.weapons[cond.weaponPower.weaponId];
    if (!w) {
      return {
        ok: false,
        reason: `weapon ${cond.weaponPower.weaponId} 未所持`,
      };
    }
    return rangeReason(
      w.power,
      cond.weaponPower,
      `weapon.${cond.weaponPower.weaponId}.power`,
    );
  }
  if ("knowsSkill" in cond) {
    if (state.baseline.knownSkills.includes(cond.knowsSkill)) {
      return { ok: true };
    }
    return { ok: false, reason: `スキル ${cond.knowsSkill} を覚えていない` };
  }
  if ("day" in cond) {
    if (!state.training) {
      return { ok: false, reason: `day: training preset 未使用` };
    }
    return rangeReason(state.training.day, cond.day, "day");
  }
  if ("slot" in cond) {
    if (!state.training) {
      return { ok: false, reason: `slot: training preset 未使用` };
    }
    return rangeReason(state.training.slot, cond.slot, "slot");
  }
  return { ok: false, reason: "unknown condition" };
}

interface RangeQuery {
  min?: number;
  max?: number;
  eq?: number;
}

function rangeReason(
  value: number,
  q: RangeQuery,
  label: string,
): ConditionResult {
  if (q.eq !== undefined && value !== q.eq) {
    return { ok: false, reason: `${label} = ${q.eq} が要る (現在 ${value})` };
  }
  if (q.min !== undefined && value < q.min) {
    return { ok: false, reason: `${label} ≥ ${q.min} が要る (現在 ${value})` };
  }
  if (q.max !== undefined && value > q.max) {
    return { ok: false, reason: `${label} ≤ ${q.max} が要る (現在 ${value})` };
  }
  return { ok: true };
}
