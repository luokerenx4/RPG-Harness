import type {
  AiPersonaDecider,
  AiPersonaDefinition,
  Game,
  Input,
  Output,
} from "@rpg-harness/engine";

export type Persona = AiPersonaDecider;

export type DeterministicChoicePersona =
  | "objective"
  | "greedy"
  | "charmer"
  | "rude"
  | "hunter";

export interface PersonaChoiceDecision {
  input: Input;
  optionIndex: number | null;
  optionId: string | null;
  reason:
    | {
        kind: "semantic-tags";
        preferredTags: string[];
        matchedTags: string[];
        score: number;
      }
    | {
        kind: "ai-priority";
        priority: number;
        explicit: boolean;
        tiedAvailableOptions: number;
        tieBreak: "first" | null;
      }
    | {
        kind: "positional-fallback";
        position: "first" | "second" | "last";
      }
    | {
        kind: "registered-persona";
        source: "builtin" | `module:${string}`;
        description: string;
      }
    | { kind: "no-available-option" };
}

function chooseOption(
  output: Extract<Output, { type: "choice" }>,
  index: number,
): Input {
  const option = output.options[index];
  return output.choiceId !== undefined && option?.id !== undefined
    ? { type: "choose", choiceId: output.choiceId, optionId: option.id }
    : { type: "choose", index };
}

function pickTaggedChoice(
  output: Extract<Output, { type: "choice" }>,
  preferredTags: readonly string[],
): { index: number; matchedTags: string[]; score: number } | null {
  const weights = new Map(
    preferredTags.map((tag, index) => [tag, preferredTags.length - index]),
  );
  let bestIndex = -1;
  let bestScore = 0;
  for (const [index, option] of output.options.entries()) {
    if (!option.available) continue;
    const score = (option.aiTags ?? []).reduce(
      (sum, tag) => sum + (weights.get(tag) ?? 0),
      0,
    );
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }
  if (bestIndex < 0) return null;
  const matchedTags = (output.options[bestIndex]?.aiTags ?? []).filter((tag) =>
    weights.has(tag),
  );
  return { index: bestIndex, matchedTags, score: bestScore };
}

function choiceDecision(
  output: Extract<Output, { type: "choice" }>,
  index: number,
  reason: PersonaChoiceDecision["reason"],
): PersonaChoiceDecision {
  return {
    input: chooseOption(output, index),
    optionIndex: index,
    optionId: output.options[index]?.id ?? null,
    reason,
  };
}

function noAvailableChoice(): PersonaChoiceDecision {
  return {
    input: { type: "quit" },
    optionIndex: null,
    optionId: null,
    reason: { kind: "no-available-option" },
  };
}

function firstAvailableDecision(
  output: Extract<Output, { type: "choice" }>,
): PersonaChoiceDecision {
  const index = output.options.findIndex((option) => option.available);
  return index >= 0
    ? choiceDecision(output, index, {
        kind: "positional-fallback",
        position: "first",
      })
    : noAvailableChoice();
}

/**
 * Explain the exact deterministic choice policy used by built-in autoplay.
 * This deliberately excludes `random`: sampling is not authoring evidence.
 */
export function explainPersonaChoice(
  persona: DeterministicChoicePersona,
  output: Extract<Output, { type: "choice" }>,
): PersonaChoiceDecision {
  if (persona === "objective") {
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
      ? choiceDecision(output, bestIndex, {
          kind: "ai-priority",
          priority: bestPriority,
          explicit: output.options[bestIndex]?.aiPriority !== undefined,
          tiedAvailableOptions: output.options.filter(
            (option) =>
              option.available && (option.aiPriority ?? 0) === bestPriority,
          ).length,
          tieBreak: output.options.filter(
            (option) =>
              option.available && (option.aiPriority ?? 0) === bestPriority,
          ).length > 1
            ? "first"
            : null,
        })
      : noAvailableChoice();
  }

  if (persona === "charmer") {
    const preferredTags = ["social", "compassionate", "romantic", "loyal"];
    const semantic = pickTaggedChoice(output, preferredTags);
    if (semantic) {
      return choiceDecision(output, semantic.index, {
        kind: "semantic-tags",
        preferredTags,
        matchedTags: semantic.matchedTags,
        score: semantic.score,
      });
    }
    for (let index = output.options.length - 1; index >= 0; index -= 1) {
      if (output.options[index]?.available) {
        return choiceDecision(output, index, {
          kind: "positional-fallback",
          position: "last",
        });
      }
    }
    return noAvailableChoice();
  }

  if (persona === "rude") {
    const preferredTags = ["defiant", "blunt", "independent", "selfish"];
    const semantic = pickTaggedChoice(output, preferredTags);
    if (semantic) {
      return choiceDecision(output, semantic.index, {
        kind: "semantic-tags",
        preferredTags,
        matchedTags: semantic.matchedTags,
        score: semantic.score,
      });
    }
    if (output.options[1]?.available) {
      return choiceDecision(output, 1, {
        kind: "positional-fallback",
        position: "second",
      });
    }
    return firstAvailableDecision(output);
  }

  return firstAvailableDecision(output);
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
  const scopeRank = { main: 0, side: 1, mastery: 2 } as const;
  const objectives = [...(output.snapshot.objectives ?? [])].sort(
    (left, right) =>
      Number(right.focus === true) - Number(left.focus === true) ||
      scopeRank[left.scope] - scopeRank[right.scope],
  );
  for (const objective of objectives) {
    if (objective.status !== "active") continue;
    for (const id of objective.relatedActivityIds ?? []) {
      const activity = availableById.get(id);
      if (activity) return { type: "doActivity", id: activity.id };
    }
  }
  return null;
}

function pickTerminalObjectiveActivity(
  output: Extract<Output, { type: "hubMenu" }>,
): Input | null {
  const available = new Set(
    output.snapshot.activities
      .filter((activity) => activity.available)
      .map((activity) => activity.id),
  );
  for (const objective of output.snapshot.objectives ?? []) {
    if (objective.status !== "active" || !objective.terminal) continue;
    const ending = (objective.relatedActivityIds ?? []).find(
      (id) => available.has(id),
    );
    if (ending) return { type: "doActivity", id: ending };
  }
  return null;
}

function pickTaggedActivity(
  output: Extract<Output, { type: "hubMenu" }>,
  preferredTags: readonly string[],
  accepts: (activity: Extract<Output, { type: "hubMenu" }>["snapshot"]["activities"][number]) => boolean = () => true,
): Input | null {
  const weights = new Map(
    preferredTags.map((tag, index) => [tag, preferredTags.length - index]),
  );
  let best: { id: string; score: number } | null = null;
  for (const activity of output.snapshot.activities) {
    if (!activity.available || !accepts(activity)) continue;
    const score = (activity.aiTags ?? []).reduce(
      (sum, tag) => sum + (weights.get(tag) ?? 0),
      0,
    );
    if (score > 0 && (best === null || score > best.score)) {
      best = { id: activity.id, score };
    }
  }
  return best ? { type: "doActivity", id: best.id } : null;
}

export const personas: Record<string, Persona> = {
  // Renderer-neutral AI: follow only the public objective contract. It does
  // not inspect module-specific state or hard-code story thresholds.
  objective: async (output) => {
    if (output.type === "choice") return explainPersonaChoice("objective", output).input;
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
    if (output.type === "choice") return explainPersonaChoice("greedy", output).input;
    if (output.type === "scriptComplete") {
      const first = output.nextAvailable[0];
      return first ? { type: "select", scriptId: first.id } : null;
    }
    if (output.type === "hubMenu") {
      const objectiveInput = pickObjectiveActivity(output);
      const ending = pickTerminalObjectiveActivity(output);
      if (ending) return ending;
      const semantic = pickTaggedActivity(output, [
        "profit",
        "economic",
        "reward",
        "exploration",
      ]);
      if (semantic) return semantic;
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
    if (output.type === "choice") {
      return explainPersonaChoice("charmer", output).input;
    }
    if (output.type === "scriptComplete") {
      const first = output.nextAvailable[0];
      return first ? { type: "select", scriptId: first.id } : null;
    }
    if (output.type === "hubMenu") {
      const ending = pickTerminalObjectiveActivity(output);
      if (ending) return ending;
      const available = output.snapshot.activities.filter((activity) => activity.available);
      const recommended = available.filter((activity) => activity.recommended);
      if (recommended.length > 0) {
        return { type: "doActivity", id: recommended.at(-1)!.id };
      }
      const socialTags = [
        "story",
        "social",
        "compassionate",
        "romantic",
        "loyal",
      ] as const;
      const objective = pickObjectiveActivity(output);
      const objectiveActivity = objective?.type === "doActivity"
        ? available.find((activity) => activity.id === objective.id)
        : undefined;
      // When several equally social actions are visible (for example party
      // invitations), let the public objective disambiguate the intended
      // commitment. This preserves the charmer's social identity without
      // cycling forever between reversible relationship toggles.
      if (objectiveActivity?.category === "social" && objectiveActivity.aiTags?.some((tag) => socialTags.includes(
        tag as typeof socialTags[number],
      ))) return objective;
      const semantic = pickTaggedActivity(
        output,
        socialTags,
        (activity) => activity.category === "social",
      );
      if (semantic) return semantic;
      if (objective) return objective;
      return pickActivity(output, (acts) => acts[acts.length - 1]!.idx);
    }
    if (output.type === "gameEnd") return null;
    return { type: "next" };
  },

  rude: async (output) => {
    if (output.type === "choice") {
      return explainPersonaChoice("rude", output).input;
    }
    if (output.type === "scriptComplete") {
      const first = output.nextAvailable[0];
      return first ? { type: "select", scriptId: first.id } : null;
    }
    if (output.type === "hubMenu") {
      const ending = pickTerminalObjectiveActivity(output);
      if (ending) return ending;
      const semantic = pickTaggedActivity(output, [
        "defiant",
        "aggressive",
        "risky",
        "independent",
        "restrained",
      ]);
      if (semantic) return semantic;
      const objective = pickObjectiveActivity(output);
      if (objective) return objective;
      return pickActivity(output, (acts) => {
        if (acts.length >= 2) return acts[1]!.idx;
        return acts[0]!.idx;
      });
    }
    if (output.type === "gameEnd") return null;
    return { type: "next" };
  },

  random: async (output, _state, _step, context) => {
    const rng = context?.rng ?? Math.random;
    if (output.type === "choice") {
      const available = output.options
        .map((o, i) => ({ o, i }))
        .filter(({ o }) => o.available);
      if (available.length === 0) return { type: "quit" };
      const pick = available[Math.floor(rng() * available.length)]!;
      return chooseOption(output, pick.i);
    }
    if (output.type === "scriptComplete") {
      if (output.nextAvailable.length === 0) return null;
      const pick =
        output.nextAvailable[
          Math.floor(rng() * output.nextAvailable.length)
        ]!;
      return { type: "select", scriptId: pick.id };
    }
    if (output.type === "hubMenu") {
      return pickActivity(output, (acts) => {
        return acts[Math.floor(rng() * acts.length)]!.idx;
      });
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
    if (output.type === "choice") return explainPersonaChoice("hunter", output).input;
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
  charmer: "优先 social / compassionate / romantic / loyal 语义，未标注时选最后一项",
  rude: "优先 defiant / blunt / independent / selfish 语义，未标注时选第二项",
  random: "随机选 — 用来 stress-test 路径",
  hunter: "训练模式专用：优先讨伐妖怪，没怪打就睡，平衡灵体化",
};

export interface AiPersonaRegistryEntry extends AiPersonaDefinition {
  source: "builtin" | `module:${string}`;
}

/** Merge generic runner policies with author-owned module policies. */
export function collectAiPersonas(game: Game): Record<string, AiPersonaRegistryEntry> {
  const registry: Record<string, AiPersonaRegistryEntry> = {};
  for (const [name, decide] of Object.entries(personas)) {
    registry[name] = {
      description: personaDescriptions[name] ?? name,
      decide,
      deterministic: name !== "random",
      source: "builtin",
    };
  }
  for (const module of game.modules ?? []) {
    for (const [name, definition] of Object.entries(module.aiPersonas ?? {})) {
      if (!name.trim()) throw new Error(`Module ${module.id} registers an empty AI persona name`);
      if (registry[name]) {
        throw new Error(
          `AI persona ${name} from module ${module.id} conflicts with ${registry[name]!.source}`,
        );
      }
      if (typeof definition.description !== "string" || !definition.description.trim()) {
        throw new Error(`AI persona ${name} from module ${module.id} needs a description`);
      }
      if (typeof definition.decide !== "function") {
        throw new Error(`AI persona ${name} from module ${module.id} needs a decide function`);
      }
      registry[name] = { ...definition, source: `module:${module.id}` };
    }
  }
  return registry;
}

/** Validate that a project's acceptance matrix names runnable policies. */
export function validateAiPersonaConfig(game: Game): void {
  const registry = collectAiPersonas(game);
  for (const name of [
    ...(game.aiAudit?.personas ?? []),
    ...(game.aiAudit?.fuzzPersonas ?? []),
  ]) {
    if (!registry[name]) {
      throw new Error(
        `game.yaml ai_audit references unknown persona ${name}. ` +
          `Available: ${Object.keys(registry).join(", ")}`,
      );
    }
  }
  for (const name of game.aiAudit?.fuzzPersonas ?? []) {
    if (registry[name]?.deterministic !== false) {
      throw new Error(
        `game.yaml ai_audit.fuzz_personas requires a stochastic persona, but ${name} is deterministic`,
      );
    }
  }
}
