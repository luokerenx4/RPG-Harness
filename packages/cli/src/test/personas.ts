import type { ComposedState, Input, Output } from "@rpg-harness/engine";

export type Persona = (
  output: Output,
  state: ComposedState,
  step: number,
) => Promise<Input | null>;

function pickFirstAvailableChoice(output: Output): Input | null {
  if (output.type !== "choice") return null;
  const i = output.options.findIndex((o) => o.available);
  return i >= 0 ? { type: "choose", index: i } : { type: "quit" };
}

function pickHighestPriorityChoice(output: Output): Input | null {
  if (output.type !== "choice") return null;
  let bestIndex = -1;
  let bestPriority = Number.NEGATIVE_INFINITY;
  for (const [index, option] of output.options.entries()) {
    if (!option.available) continue;
    const priority = option.aiPriority ?? 0;
    if (bestIndex < 0 || priority > bestPriority) {
      bestIndex = index;
      bestPriority = priority;
    }
  }
  return bestIndex >= 0
    ? { type: "choose", index: bestIndex }
    : { type: "quit" };
}

function pickLastAvailableChoice(output: Output): Input | null {
  if (output.type !== "choice") return null;
  const found = [...output.options]
    .map((o, i) => ({ o, i }))
    .reverse()
    .find(({ o }) => o.available);
  return found ? { type: "choose", index: found.i } : { type: "quit" };
}

function pickActivity(
  output: Output,
  picker: (available: { id: string; idx: number }[]) => number,
): Input | null {
  if (output.type !== "hubMenu") return null;
  const acts = output.snapshot.activities
    .map((a, idx) => ({ a, idx }))
    .filter(({ a }) => a.available)
    .map(({ a, idx }) => ({ id: a.id, idx }));
  if (acts.length === 0) return { type: "quit" };
  const pickIdx = picker(acts);
  const chosen = output.snapshot.activities[pickIdx];
  if (!chosen) return { type: "quit" };
  return { type: "doActivity", id: chosen.id };
}

// Sum all signed integers in an effectsHint string (e.g. "engineering+5
// stamina-1 alice+1" → 5). Hub activities without a hint score 0;
// module-dispatched actions (kind: dive etc.) and effects-less actions
// fall into this bucket and lose ties to anything with a positive hint.
// This is intentionally crude — it treats affection deltas and stat
// deltas as equally valuable. Good enough for "fuzz the game with a
// not-totally-dumb agent" which is all greedy is for.
function activityScore(hint: string | undefined): number {
  if (!hint) return 0;
  let total = 0;
  for (const m of hint.matchAll(/[+-]\d+/g)) {
    total += parseInt(m[0]!, 10);
  }
  return total;
}

function pickObjectiveActivity(output: Extract<Output, { type: "hubMenu" }>): Input | null {
  const availableById = new Map(
    output.snapshot.activities
      .filter((activity) => activity.available)
      .map((activity) => [activity.id, activity]),
  );
  for (const objective of output.snapshot.objectives ?? []) {
    if (objective.status !== "active") continue;
    for (const id of objective.relatedActivityIds ?? []) {
      const activity = availableById.get(id);
      if (activity) return { type: "doActivity", id: activity.id };
    }
  }
  return null;
}

export const personas: Record<string, Persona> = {
  // Renderer-neutral AI: follow only the public objective contract. It does
  // not inspect module-specific state or hard-code story thresholds.
  objective: async (output) => {
    if (output.type === "choice") return pickHighestPriorityChoice(output);
    if (output.type === "scriptComplete") {
      const first = output.nextAvailable[0];
      return first ? { type: "select", scriptId: first.id } : null;
    }
    if (output.type === "hubMenu") {
      return pickObjectiveActivity(output) ?? { type: "quit" };
    }
    if (output.type === "gameEnd") return null;
    return { type: "next" };
  },

  greedy: async (output) => {
    if (output.type === "choice") return pickFirstAvailableChoice(output);
    if (output.type === "scriptComplete") {
      const first = output.nextAvailable[0];
      return first ? { type: "select", scriptId: first.id } : null;
    }
    if (output.type === "hubMenu") {
      const available = output.snapshot.activities.filter((a) => a.available);
      if (available.length === 0) return { type: "quit" };
      // Pick highest-scoring activity; first-wins on ties (hub order).
      let best = available[0]!;
      let bestScore = activityScore(best.effectsHint);
      for (let i = 1; i < available.length; i++) {
        const s = activityScore(available[i]!.effectsHint);
        if (s > bestScore) {
          best = available[i]!;
          bestScore = s;
        }
      }
      // Preserve greed as the primary policy, but let the public objective
      // break score ties. This avoids reversible zero-value toggles winning
      // forever merely because they appear earlier in the Hub.
      const objectiveInput = pickObjectiveActivity(output);
      if (objectiveInput?.type === "doActivity") {
        const objectiveActivity = available.find(
          (activity) => activity.id === objectiveInput.id,
        );
        if (
          objectiveActivity &&
          activityScore(objectiveActivity.effectsHint) === bestScore
        ) return objectiveInput;
      }
      return { type: "doActivity", id: best.id };
    }
    if (output.type === "gameEnd") return null;
    return { type: "next" };
  },

  charmer: async (output) => {
    if (output.type === "choice") return pickLastAvailableChoice(output);
    if (output.type === "scriptComplete") {
      const first = output.nextAvailable[0];
      return first ? { type: "select", scriptId: first.id } : null;
    }
    if (output.type === "hubMenu") {
      return pickActivity(output, (acts) => acts[acts.length - 1]!.idx);
    }
    if (output.type === "gameEnd") return null;
    return { type: "next" };
  },

  rude: async (output) => {
    if (output.type === "choice") {
      const second = output.options[1];
      if (second?.available) return { type: "choose", index: 1 };
      return pickFirstAvailableChoice(output);
    }
    if (output.type === "scriptComplete") {
      const first = output.nextAvailable[0];
      return first ? { type: "select", scriptId: first.id } : null;
    }
    if (output.type === "hubMenu") {
      return pickActivity(output, (acts) => {
        if (acts.length >= 2) return acts[1]!.idx;
        return acts[0]!.idx;
      });
    }
    if (output.type === "gameEnd") return null;
    return { type: "next" };
  },

  random: async (output) => {
    if (output.type === "choice") {
      const available = output.options
        .map((o, i) => ({ o, i }))
        .filter(({ o }) => o.available);
      if (available.length === 0) return { type: "quit" };
      const pick = available[Math.floor(Math.random() * available.length)]!;
      return { type: "choose", index: pick.i };
    }
    if (output.type === "scriptComplete") {
      if (output.nextAvailable.length === 0) return null;
      const pick =
        output.nextAvailable[
          Math.floor(Math.random() * output.nextAvailable.length)
        ]!;
      return { type: "select", scriptId: pick.id };
    }
    if (output.type === "hubMenu") {
      return pickActivity(output, (acts) => {
        return acts[Math.floor(Math.random() * acts.length)]!.idx;
      });
    }
    if (output.type === "gameEnd") return null;
    return { type: "next" };
  },

  // sengoku-raid: cautious extraction-shooter player. In raid mode:
  // extract whenever possible (cash in what you have), flee from any
  // encounter rather than fight. In hub mode: sell loot, rest, upgrade
  // when affordable, then redeploy. Will never engage a fight.
  extractor: async (output) => {
    if (output.type === "hubMenu") {
      const acts = output.snapshot.activities.filter((a) => a.available);
      const find = (pred: (id: string) => boolean) =>
        acts.find((a) => pred(a.id));
      // Pulse imbue forces a choice — extractor picks 浄 (rebate / safest).
      const imbue = find((id) => id.startsWith("imbue:"));
      if (imbue) return { type: "doActivity", id: imbue.id };
      // Negotiate options (HP<30%) — extractor releases.
      const release = find((id) => id === "negotiate_release");
      if (release) return { type: "doActivity", id: release.id };
      // Raid-side priorities
      const ext = find((id) => id === "extract");
      if (ext) return { type: "doActivity", id: ext.id };
      const flee = find((id) => id === "flee");
      if (flee) return { type: "doActivity", id: flee.id };
      const search = find((id) => id === "search");
      if (search) return { type: "doActivity", id: search.id };
      const move = acts.find((a) => a.id.startsWith("move:"));
      if (move) return { type: "doActivity", id: move.id };
      // Hub-side priorities (post-R2 unprefixed ids)
      const sell = find((id) => id === "sell_all_loot");
      if (sell) return { type: "doActivity", id: sell.id };
      // Read pending intel briefing first
      const intelRead = find((id) => id === "script:intel_briefing");
      if (intelRead) return { type: "doActivity", id: intelRead.id };
      const upgrade = find((id) => id === "upgrade_mundane");
      if (upgrade) return { type: "doActivity", id: upgrade.id };
      const rest = find((id) => id === "rest");
      if (rest) return { type: "doActivity", id: rest.id };
      const depart = acts.find((a) => a.id.startsWith("depart:"));
      if (depart) return { type: "doActivity", id: depart.id };
      const first = acts[0];
      return first ? { type: "doActivity", id: first.id } : { type: "quit" };
    }
    if (output.type === "choice") return pickFirstAvailableChoice(output);
    if (output.type === "scriptComplete") {
      const first = output.nextAvailable[0];
      return first ? { type: "select", scriptId: first.id } : null;
    }
    if (output.type === "gameEnd") return null;
    return { type: "next" };
  },

  // sengoku-raid: aggressive opposite of extractor. Always fights,
  // pushes into unvisited zones, only extracts when fully explored.
  // Useful for proving combat / death / boss paths are reachable.
  // Knows about module state (state["sengoku-raid"].raid.zones) to
  // make smart movement choices — without that, the persona oscillates
  // between visited zones forever.
  delver: async (output, state) => {
    if (output.type === "hubMenu") {
      const acts = output.snapshot.activities.filter((a) => a.available);
      const find = (pred: (id: string) => boolean) =>
        acts.find((a) => pred(a.id));
      // Pulse imbue forces a choice after each victory. Delver picks 鬼.
      const imbueOni = find((id) => id === "imbue:oni");
      if (imbueOni) return { type: "doActivity", id: imbueOni.id };
      const imbueAny = find((id) => id.startsWith("imbue:"));
      if (imbueAny) return { type: "doActivity", id: imbueAny.id };
      // Negotiate options (HP<30%): delver finishes with the voice
      // when possible, otherwise just keeps attacking.
      const voice = find((id) => id === "yaodao_voice");
      if (voice) return { type: "doActivity", id: voice.id };
      // 1. Always fight when there's something to fight
      const atk = find((id) => id === "attack");
      if (atk) return { type: "doActivity", id: atk.id };
      const sneak = find((id) => id === "sneak_strike");
      if (sneak) return { type: "doActivity", id: sneak.id };
      // 2. Grab loot at current zone
      const search = find((id) => id === "search");
      if (search) return { type: "doActivity", id: search.id };
      // 3. Prefer moving to an UNVISITED zone (read module state to know).
      const raid = (state as Record<string, unknown>)["sengoku-raid"] as
        | { raid?: { zones?: Record<string, { visited?: boolean }> } }
        | undefined;
      const zones = raid?.raid?.zones;
      const moveActs = acts.filter((a) => a.id.startsWith("move:"));
      if (moveActs.length > 0 && zones) {
        const toUnvisited = moveActs.find((a) => {
          const target = a.id.slice("move:".length);
          return zones[target] && !zones[target]!.visited;
        });
        if (toUnvisited) return { type: "doActivity", id: toUnvisited.id };
      }
      // 4. Extract ONLY if every zone in the map has been visited.
      const allVisited =
        zones !== undefined &&
        Object.values(zones).every((z) => z?.visited === true);
      const extract = find((id) => id === "extract");
      if (allVisited && extract) return { type: "doActivity", id: extract.id };
      // 5. Some zones still unvisited but no unvisited neighbor — take
      //    the first move; eventually BFS-like wander finds the path.
      if (moveActs.length > 0) return { type: "doActivity", id: moveActs[0]!.id };
      // 6. Cornered: extract (if we can) or quit.
      if (extract) return { type: "doActivity", id: extract.id };
      // 6. Hub-side: rest if hurt, then depart on hardest map
      const rest = find((id) => id === "rest");
      if (rest) return { type: "doActivity", id: rest.id };
      const departs = acts.filter((a) => a.id.startsWith("depart:"));
      if (departs.length > 0) {
        return { type: "doActivity", id: departs[departs.length - 1]!.id };
      }
      const first = acts[0];
      return first ? { type: "doActivity", id: first.id } : { type: "quit" };
    }
    if (output.type === "choice") return pickFirstAvailableChoice(output);
    if (output.type === "scriptComplete") {
      const first = output.nextAvailable[0];
      return first ? { type: "select", scriptId: first.id } : null;
    }
    if (output.type === "gameEnd") return null;
    return { type: "next" };
  },

  hunter: async (output) => {
    if (output.type === "hubMenu") {
      const activities = output.snapshot.activities;
      const hunt = activities.findIndex(
        (a) => a.id === "action:hunt" && a.available,
      );
      if (hunt >= 0) return { type: "doActivity", id: activities[hunt]!.id };
      const sleep = activities.findIndex(
        (a) => a.id === "action:sleep" && a.available,
      );
      if (sleep >= 0) return { type: "doActivity", id: activities[sleep]!.id };
      const shrine = activities.findIndex(
        (a) => a.id === "action:shrine_pray" && a.available,
      );
      if (shrine >= 0) return { type: "doActivity", id: activities[shrine]!.id };
      // Game-specific training modes do not necessarily use the generic
      // action:hunt/action:sleep ids. Follow their public objective links
      // before falling back to hub order, which may contain reversible
      // toggles such as invite/uninvite ahead of the actual expedition.
      const objective = pickObjectiveActivity(output);
      if (objective) return objective;
      const depart = activities.find(
        (activity) => activity.available && activity.id.startsWith("depart:"),
      );
      if (depart) return { type: "doActivity", id: depart.id };
      const firstAvail = activities.findIndex((a) => a.available);
      if (firstAvail >= 0)
        return { type: "doActivity", id: activities[firstAvail]!.id };
      return { type: "quit" };
    }
    if (output.type === "choice") return pickFirstAvailableChoice(output);
    if (output.type === "scriptComplete") {
      const first = output.nextAvailable[0];
      return first ? { type: "select", scriptId: first.id } : null;
    }
    if (output.type === "gameEnd") return null;
    return { type: "next" };
  },
};

export const personaDescriptions: Record<string, string> = {
  objective: "只依赖 HubSnapshot.objectives 的可执行链接推进，不读取游戏模块私有状态",
  greedy: "选 effectsHint 数值之和最高的可用项 — 平均下来是温柔系玩家",
  charmer: "总选最后一个可选项 — 倾向更主动的回答",
  rude: "总选第二个 — 偏向冷漠/拒绝路线",
  random: "随机选 — 用来 stress-test 路径",
  hunter: "训练模式专用：优先讨伐妖怪，没怪打就睡，平衡灵体化",
  extractor: "extraction-shooter 专用：能撤就撤，能逃就逃，从不打硬仗",
  delver: "extraction-shooter 专用：永远进攻，永远往深处推，从不回避",
};
