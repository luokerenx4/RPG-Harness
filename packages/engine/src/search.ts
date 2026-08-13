import { cloneState } from "./state";
import { peek, step } from "./step";
import { evaluateCondition } from "./condition";
import { scriptRevision } from "./scriptRevision";
import type {
  ComposedState,
  Condition,
  Game,
  Input,
  Output,
  StateDelta,
} from "./types";

export interface ChoiceSearchTarget {
  scriptId: string;
  choiceId: string;
}

export interface ScriptSearchTarget {
  scriptId: string;
}

export interface ChoiceSearchOptions {
  maxNodes?: number;
  maxSteps?: number;
  /** Emit bounded progress without coupling the engine to a renderer. */
  onProgress?: (progress: ChoiceSearchProgress) => void;
  progressEvery?: number;
}

export interface ChoiceSearchProgress {
  exploredNodes: number;
  visitedStates: number;
  frontierNodes: number;
  deepestSteps: number;
  closest: ChoiceSearchClosest;
}

export interface ChoiceSearchResult {
  found: boolean;
  reason: "found" | "exhausted" | "max-nodes";
  inputs: Input[];
  exploredNodes: number;
  visitedStates: number;
  deepestSteps: number;
  output: Output | null;
  state: ComposedState;
  closest: ChoiceSearchClosest;
}

export interface ChoiceSearchRequirement {
  condition: Condition;
  satisfied: boolean;
  progress: number;
  reason?: string;
}

export interface ChoiceSearchClosest {
  inputs: Input[];
  steps: number;
  progress: number;
  satisfiedRequirements: number;
  totalRequirements: number;
  targetScriptCompleted: boolean;
  targetScriptActive: boolean;
  requirements: ChoiceSearchRequirement[];
  outputType: Output["type"] | null;
  /** Ordered authored activity breadcrumbs currently followed by this path. */
  guidanceProgress?: number;
  /** Low-risk cycle recovery taken while the next authored activity is closed. */
  guidancePreparation?: number;
  /** Progress toward the exact gate on the next authored hub activity. */
  guidanceRequirement?: ChoiceSearchRequirement & {
    activityId: string;
    satisfiedRequirements: number;
    totalRequirements: number;
    regressionsFromSource: number;
    /** Requirements acquired and then lost on this candidate path. */
    regressionsFromPath?: number;
  };
}

interface SearchNode {
  state: ComposedState;
  output: Output | null;
  done: boolean;
  inputs: Input[];
  guidanceGates: Map<string, Condition>;
  /** Gate leaves satisfied at any point on this path, used to avoid trading
   * away a newly acquired prerequisite for a superficially closer one. */
  satisfiedGuidanceLeaves: Set<string>;
}

type SearchTarget =
  | { kind: "choice"; scriptId: string; choiceId: string; relatedActivityIds: string[] }
  | {
      kind: "script";
      scriptId: string;
      revision: string;
      acceptUnversionedCompletion: true;
      relatedActivityIds: string[];
    };

/**
 * Goal-directed best-first search over the same public Input/Output contract
 * used by GUI and Headless play. Forced advances are collapsed, meaningful
 * decisions are branched, and the persisted RNG cursor makes every discovered
 * path replayable.
 */
export async function searchForChoice(
  game: Game,
  initialState: ComposedState,
  target: ChoiceSearchTarget,
  options: ChoiceSearchOptions = {},
): Promise<ChoiceSearchResult> {
  return searchForTarget(game, initialState, {
    kind: "choice",
    ...target,
    relatedActivityIds: relatedActivities(game, target.scriptId),
  }, options);
}

/** Find and complete a script through the same public inputs used by every renderer. */
export async function searchForScript(
  game: Game,
  initialState: ComposedState,
  target: ScriptSearchTarget,
  options: ChoiceSearchOptions = {},
): Promise<ChoiceSearchResult> {
  return searchForTarget(game, initialState, {
    kind: "script",
    ...target,
    revision: scriptRevision(game.scripts.find((script) => script.id === target.scriptId) ?? {
      id: target.scriptId,
      title: target.scriptId,
      beats: [],
    }),
    acceptUnversionedCompletion: true,
    relatedActivityIds: relatedActivities(game, target.scriptId),
  }, options);
}

async function searchForTarget(
  game: Game,
  initialState: ComposedState,
  target: SearchTarget,
  options: ChoiceSearchOptions,
): Promise<ChoiceSearchResult> {
  const maxNodes = options.maxNodes ?? 5_000;
  const maxSteps = options.maxSteps ?? 250;
  if (!Number.isInteger(maxNodes) || maxNodes < 1) {
    throw new Error("choice search maxNodes must be a positive integer");
  }
  if (!Number.isInteger(maxSteps) || maxSteps < 0) {
    throw new Error("choice search maxSteps must be a non-negative integer");
  }
  const progressEvery = options.progressEvery ?? 250;
  if (!Number.isInteger(progressEvery) || progressEvery < 1) {
    throw new Error("choice search progressEvery must be a positive integer");
  }

  const startingState = cloneState(initialState);
  if (isScriptTarget(target)) {
    const prior = startingState.baseline.scripts[target.scriptId];
    if (prior?.completed === true && prior.completedRevision !== target.revision) {
      prior.completed = false;
      startingState.baseline.completionOrder = startingState.baseline.completionOrder
        .filter((scriptId) => scriptId !== target.scriptId);
    }
  }
  const start = await settleForced(
    game,
    startingState,
    [],
    target,
    maxSteps,
  );
  const queue: SearchNode[] = [start];
  rememberGuidanceGates(start.output, target, start.guidanceGates);
  rememberSatisfiedGuidanceLeaves(start, target);
  const visited = new Set<string>();
  let exploredNodes = 0;
  let deepestSteps = start.inputs.length;
  let closest = assessNode(game, target, start, initialState);
  let closestNode = start;

  while (queue.length > 0) {
    queue.sort((left, right) =>
      compareChoiceSearchAssessment(
        assessNode(game, target, right, initialState),
        assessNode(game, target, left, initialState),
        isScriptTarget(target),
      )
    );
    const node = queue.shift()!;
    deepestSteps = Math.max(deepestSteps, node.inputs.length);
    const fingerprint = stateFingerprint(node, target);
    if (visited.has(fingerprint)) continue;
    visited.add(fingerprint);
    exploredNodes += 1;
    const assessment = assessNode(game, target, node, initialState);
    if (compareChoiceSearchAssessment(
      assessment,
      closest,
      isScriptTarget(target),
    ) > 0) {
      closest = assessment;
      closestNode = node;
    }
    if (options.onProgress && exploredNodes % progressEvery === 0) {
      options.onProgress({
        exploredNodes,
        visitedStates: visited.size,
        frontierNodes: queue.length,
        deepestSteps,
        closest,
      });
    }

    if (isTargetReached(node, target)) {
      return {
        found: true,
        reason: "found",
        inputs: node.inputs,
        exploredNodes,
        visitedStates: visited.size,
        deepestSteps,
        output: node.output,
        state: node.state,
        closest: assessment,
      };
    }
    if (exploredNodes >= maxNodes) {
      return {
        found: false,
        reason: "max-nodes",
        inputs: [],
        exploredNodes,
        visitedStates: visited.size,
        deepestSteps,
        output: closestNode.output,
        state: closestNode.state,
        closest,
      };
    }
    if (node.done || node.output === null || node.inputs.length >= maxSteps) {
      continue;
    }

    for (const input of candidateInputs(
      node.output,
      target,
      rememberedGuidanceCondition(node.inputs, target, node.guidanceGates),
      node.state,
      nextGuidanceActivityId(node.inputs, target),
    )) {
      if (node.inputs.length + 1 > maxSteps) continue;
      try {
        const transitioned = await step(game, cloneState(node.state), input);
        const child = await settleForced(
          game,
          transitioned.state,
          [...node.inputs, input],
          target,
          maxSteps,
          transitioned.output,
          transitioned.done,
          node.satisfiedGuidanceLeaves,
          node.guidanceGates,
        );
        rememberGuidanceGates(child.output, target, child.guidanceGates);
        rememberSatisfiedGuidanceLeaves(child, target);
        queue.push(child);
      } catch {
        // One malformed or module-rejected edge must not abort exploration of
        // other public actions. A replay only occurs after a complete path is
        // found and independently verified by the CLI.
      }
    }
  }

  return {
    found: false,
    reason: "exhausted",
    inputs: [],
    exploredNodes,
    visitedStates: visited.size,
    deepestSteps,
    output: closestNode.output,
    state: closestNode.state,
    closest,
  };
}

async function settleForced(
  game: Game,
  initialState: ComposedState,
  initialInputs: Input[],
  target: SearchTarget,
  maxSteps: number,
  initialOutput?: Output | null,
  initialDone?: boolean,
  inheritedGuidanceLeaves: ReadonlySet<string> = new Set(),
  inheritedGuidanceGates: ReadonlyMap<string, Condition> = new Map(),
): Promise<SearchNode> {
  let state = initialState;
  let output = initialOutput;
  let done = initialDone ?? false;
  const inputs = [...initialInputs];
  const satisfiedGuidanceLeaves = new Set(inheritedGuidanceLeaves);
  const guidanceGates = new Map(inheritedGuidanceGates);
  if (output === undefined) {
    const current = await peek(game, state);
    state = current.state;
    output = current.output;
    done = current.done;
  }

  while (
    !done &&
    output !== null &&
    !isTargetReached({ state, output }, target) &&
    inputs.length < maxSteps
  ) {
    const candidates = candidateInputs(output, target);
    if (candidates.length !== 1) break;
    const input = candidates[0]!;
    const next = await step(game, state, input);
    inputs.push(input);
    state = next.state;
    output = next.output;
    done = next.done;
  }
  return {
    state,
    output,
    done,
    inputs,
    guidanceGates,
    satisfiedGuidanceLeaves,
  };
}

function candidateInputs(
  output: Output,
  target: SearchTarget,
  guidanceCondition?: Condition,
  state?: ComposedState,
  nextGuidanceId?: string,
): Input[] {
  switch (output.type) {
    case "narration":
    case "dialogue":
    case "clear":
      return [{ type: "next" }];
    case "choice":
      return output.options.flatMap((option, index) =>
        option.available ? [{ type: "choose" as const, index }] : [],
      );
    case "scriptComplete":
      return [...output.nextAvailable]
        .sort((left, right) =>
          Number(right.id === target.scriptId) - Number(left.id === target.scriptId)
        )
        .map((script) => ({
        type: "select" as const,
        scriptId: script.id,
      }));
    case "hubMenu":
      const authoredActivityRank = new Map(
        target.relatedActivityIds.map((id, index) => [id, index]),
      );
      const hasAvailableAuthoredActivity = output.snapshot.activities.some(
        (activity) => activity.available && authoredActivityRank.has(activity.id),
      );
      const objectiveActivityRank = new Map(
        (output.snapshot.objectives ?? [])
          .filter((objective) => objective.status === "active")
          .flatMap((objective) => objective.relatedActivityIds ?? [])
          .map((id, index) => [id, index]),
      );
      return output.snapshot.activities
        .filter((activity) => activity.available)
        .sort((left, right) => {
          const targetDifference =
            Number(right.id === `script:${target.scriptId}`) -
            Number(left.id === `script:${target.scriptId}`);
          if (targetDifference !== 0) return targetDifference;
          const guidanceDifference =
            Number(right.id === nextGuidanceId) -
            Number(left.id === nextGuidanceId);
          if (guidanceDifference !== 0) return guidanceDifference;
          const leftAuthoredRank = authoredActivityRank.get(left.id) ?? Number.MAX_SAFE_INTEGER;
          const rightAuthoredRank = authoredActivityRank.get(right.id) ?? Number.MAX_SAFE_INTEGER;
          if (leftAuthoredRank !== rightAuthoredRank) return leftAuthoredRank - rightAuthoredRank;
          const leftForecast = guidanceCondition && state
            ? forecastMatches(left.forecast?.effects, guidanceCondition, state)
            : 0;
          const rightForecast = guidanceCondition && state
            ? forecastMatches(right.forecast?.effects, guidanceCondition, state)
            : 0;
          if (leftForecast !== rightForecast) return rightForecast - leftForecast;
          // A rest action commonly advances the gameplay cycle and restores
          // access to departures. Prefer it over unrelated economy/social
          // churn only while none of the authored route is currently open.
          if (!hasAvailableAuthoredActivity) {
            const recoveryDifference =
              Number(right.id === "rest") - Number(left.id === "rest");
            if (recoveryDifference !== 0) return recoveryDifference;
          }
          const leftRank = objectiveActivityRank.get(left.id) ?? Number.MAX_SAFE_INTEGER;
          const rightRank = objectiveActivityRank.get(right.id) ?? Number.MAX_SAFE_INTEGER;
          return leftRank - rightRank;
        })
        .map((activity) => ({ type: "doActivity" as const, id: activity.id }));
    case "gameEnd":
      return [];
  }
}

function relatedActivities(game: Game, scriptId: string): string[] {
  return game.scripts.find((script) => script.id === scriptId)?.ai
    ?.relatedActivityIds ?? [];
}

function isTargetReached(
  node: Pick<SearchNode, "state" | "output">,
  target: SearchTarget,
): boolean {
  if (isScriptTarget(target)) {
    const state = node.state.baseline.scripts[target.scriptId];
    return state?.completed === true && (
      state.completedRevision === target.revision ||
      target.acceptUnversionedCompletion
    );
  }
  return node.output?.type === "choice" &&
    node.output.scriptId === target.scriptId &&
    node.output.choiceId === target.choiceId;
}

function isScriptTarget(target: SearchTarget): target is Extract<SearchTarget, { kind: "script" }> {
  return target.kind === "script";
}

function stateFingerprint(node: SearchNode, target: SearchTarget): string {
  // Keep the engine browser-compatible: search is also usable by Web/Studio,
  // so it must not depend on node:crypto. Full JSON avoids hash collisions;
  // the caller's node budget bounds memory.
  return JSON.stringify({
    state: node.state,
    guidanceProgress: orderedGuidanceProgress(
      node.inputs,
      target.relatedActivityIds,
    ),
    guidanceGates: [...node.guidanceGates.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    ),
    satisfiedGuidanceLeaves: [...node.satisfiedGuidanceLeaves].sort(),
  });
}

function assessNode(
  game: Game,
  target: SearchTarget,
  node: SearchNode,
  initialState: ComposedState,
): ChoiceSearchClosest {
  const script = game.scripts.find((candidate) => candidate.id === target.scriptId);
  const conditions = topLevelRequirements(script?.requires);
  const requirements = conditions.map((condition): ChoiceSearchRequirement => {
    const evaluated = evaluateCondition(condition, node.state);
    return {
      condition,
      satisfied: evaluated.ok,
      progress: conditionProgress(condition, node.state),
      ...(evaluated.reason ? { reason: evaluated.reason } : {}),
    };
  });
  const targetState = node.state.baseline.scripts[target.scriptId];
  const targetScriptCompleted = targetState?.completed === true &&
    (!isScriptTarget(target) || targetState.completedRevision === target.revision);
  const targetScriptActive =
    node.state.baseline.currentScriptId === target.scriptId ||
    (node.output?.type === "choice" && node.output.scriptId === target.scriptId);
  const guidanceProgress = orderedGuidanceProgress(
    node.inputs,
    target.relatedActivityIds,
  );
  const nextGuidanceActivityId = target.relatedActivityIds[guidanceProgress];
  const guidanceCondition = nextGuidanceActivityId
    ? node.guidanceGates.get(nextGuidanceActivityId)
    : undefined;
  const guidanceRequirement = guidanceCondition
    ? summarizeGuidanceRequirement(
        guidanceCondition,
        initialState,
        node.state,
      )
    : undefined;
  return {
    inputs: node.inputs,
    steps: node.inputs.length,
    progress: requirements.reduce((sum, item) => sum + item.progress, 0),
    satisfiedRequirements: requirements.filter((item) => item.satisfied).length,
    totalRequirements: requirements.length,
    targetScriptCompleted,
    targetScriptActive,
    requirements,
    outputType: node.output?.type ?? null,
    guidanceProgress,
    ...(guidanceRequirement && nextGuidanceActivityId
      ? {
          guidanceRequirement: {
            activityId: nextGuidanceActivityId,
            ...guidanceRequirement,
            regressionsFromPath: topLevelRequirements(guidanceCondition).filter(
              (leaf) =>
                node.satisfiedGuidanceLeaves.has(
                  guidanceLeafKey(nextGuidanceActivityId, leaf),
                ) && !evaluateCondition(leaf, node.state).ok,
            ).length,
          },
        }
      : {}),
    guidancePreparation: guidanceProgress === 0 &&
        target.relatedActivityIds.length > 0 &&
        latestActivityId(node.inputs) === "rest"
      ? 1
      : 0,
  };
}

function rememberGuidanceGates(
  output: Output | null,
  target: SearchTarget,
  gates: Map<string, Condition>,
): void {
  if (output?.type !== "hubMenu") return;
  for (const activity of output.snapshot.activities) {
    if (activity.requires && target.relatedActivityIds.includes(activity.id)) {
      gates.set(activity.id, activity.requires);
    }
  }
}

function rememberSatisfiedGuidanceLeaves(
  node: SearchNode,
  target: SearchTarget,
): void {
  const progress = orderedGuidanceProgress(node.inputs, target.relatedActivityIds);
  const activityId = target.relatedActivityIds[progress];
  const condition = activityId ? node.guidanceGates.get(activityId) : undefined;
  if (!activityId || !condition) return;
  for (const leaf of topLevelRequirements(condition)) {
    if (evaluateCondition(leaf, node.state).ok) {
      node.satisfiedGuidanceLeaves.add(guidanceLeafKey(activityId, leaf));
    }
  }
}

function guidanceLeafKey(activityId: string, condition: Condition): string {
  return `${activityId}:${JSON.stringify(condition)}`;
}

export function compareChoiceSearchAssessment(
  left: ChoiceSearchClosest,
  right: ChoiceSearchClosest,
  targetCompletionIsSuccess = false,
): number {
  if (left.targetScriptCompleted !== right.targetScriptCompleted) {
    return left.targetScriptCompleted === targetCompletionIsSuccess ? 1 : -1;
  }
  if (left.targetScriptActive !== right.targetScriptActive) {
    return left.targetScriptActive ? 1 : -1;
  }
  if (left.progress !== right.progress) return left.progress - right.progress;
  if (left.satisfiedRequirements !== right.satisfiedRequirements) {
    return left.satisfiedRequirements - right.satisfiedRequirements;
  }
  if ((left.guidanceProgress ?? 0) !== (right.guidanceProgress ?? 0)) {
    return (left.guidanceProgress ?? 0) - (right.guidanceProgress ?? 0);
  }
  const leftGuidanceRequirement = left.guidanceRequirement?.progress ?? 0;
  const rightGuidanceRequirement = right.guidanceRequirement?.progress ?? 0;
  const leftGuidanceRegressions =
    left.guidanceRequirement?.regressionsFromPath ??
      left.guidanceRequirement?.regressionsFromSource ?? 0;
  const rightGuidanceRegressions =
    right.guidanceRequirement?.regressionsFromPath ??
      right.guidanceRequirement?.regressionsFromSource ?? 0;
  if (leftGuidanceRegressions !== rightGuidanceRegressions) {
    return rightGuidanceRegressions - leftGuidanceRegressions;
  }
  const leftGuidanceSatisfied =
    left.guidanceRequirement?.satisfiedRequirements ?? 0;
  const rightGuidanceSatisfied =
    right.guidanceRequirement?.satisfiedRequirements ?? 0;
  if (leftGuidanceSatisfied !== rightGuidanceSatisfied) {
    return leftGuidanceSatisfied - rightGuidanceSatisfied;
  }
  if (leftGuidanceRequirement !== rightGuidanceRequirement) {
    return leftGuidanceRequirement - rightGuidanceRequirement;
  }
  if ((left.guidancePreparation ?? 0) !== (right.guidancePreparation ?? 0)) {
    return (left.guidancePreparation ?? 0) - (right.guidancePreparation ?? 0);
  }
  const leftTerminal = left.outputType === "gameEnd";
  const rightTerminal = right.outputType === "gameEnd";
  if (leftTerminal !== rightTerminal) return leftTerminal ? -1 : 1;
  // While a gate is still closed, a shallower tie-break breadth-explores every
  // hub permutation before a raid-sized path can change it. Follow that
  // plateau deeper. Once every authored requirement is satisfied, however,
  // extra depth is only churn: prefer the shortest route to the now-open
  // script activity.
  const requirementsStillBlocked = left.totalRequirements > 0 &&
    left.satisfiedRequirements < left.totalRequirements;
  return requirementsStillBlocked
    ? left.steps - right.steps
    : right.steps - left.steps;
}

function rememberedGuidanceCondition(
  inputs: Input[],
  target: SearchTarget,
  gates: ReadonlyMap<string, Condition>,
): Condition | undefined {
  const progress = orderedGuidanceProgress(inputs, target.relatedActivityIds);
  const activityId = target.relatedActivityIds[progress];
  return activityId ? gates.get(activityId) : undefined;
}

function nextGuidanceActivityId(
  inputs: Input[],
  target: SearchTarget,
): string | undefined {
  return target.relatedActivityIds[
    orderedGuidanceProgress(inputs, target.relatedActivityIds)
  ];
}

function forecastMatches(
  effects: StateDelta | undefined,
  condition: Condition,
  state: ComposedState,
): number {
  if (!effects) return 0;
  return topLevelRequirements(condition).filter((leaf) => {
    if (evaluateCondition(leaf, state).ok) return false;
    if ("inventory" in leaf) {
      return (effects.inventory?.[leaf.inventory.itemId] ?? 0) > 0;
    }
    if ("characterStat" in leaf) {
      return (effects.characterStats?.[leaf.characterStat.character]
        ?.[leaf.characterStat.name] ?? 0) > 0;
    }
    if ("variable" in leaf && typeof leaf.variable.min === "number") {
      return typeof effects.variables?.[leaf.variable.name] === "number" &&
        (effects.variables[leaf.variable.name] as number) > 0;
    }
    if ("switch" in leaf) {
      return effects.switches?.[leaf.switch.name] === true;
    }
    return false;
  }).length;
}

function summarizeGuidanceRequirement(
  condition: Condition,
  initialState: ComposedState,
  state: ComposedState,
): ChoiceSearchRequirement & {
  satisfiedRequirements: number;
  totalRequirements: number;
  regressionsFromSource: number;
} {
  const leaves = topLevelRequirements(condition);
  const summary = evaluateSearchRequirement(condition, state);
  return {
    ...summary,
    satisfiedRequirements: leaves.filter((leaf) =>
      evaluateCondition(leaf, state).ok
    ).length,
    totalRequirements: leaves.length,
    regressionsFromSource: leaves.filter((leaf) =>
      evaluateCondition(leaf, initialState).ok &&
      !evaluateCondition(leaf, state).ok
    ).length,
  };
}

function evaluateSearchRequirement(
  condition: Condition,
  state: ComposedState,
): ChoiceSearchRequirement {
  const evaluated = evaluateCondition(condition, state);
  return {
    condition,
    satisfied: evaluated.ok,
    progress: conditionProgress(condition, state),
    ...(evaluated.reason ? { reason: evaluated.reason } : {}),
  };
}

function latestActivityId(inputs: Input[]): string | null {
  for (let index = inputs.length - 1; index >= 0; index -= 1) {
    const input = inputs[index]!;
    if (input.type === "doActivity") return input.id;
  }
  return null;
}

function orderedGuidanceProgress(inputs: Input[], relatedActivityIds: string[]): number {
  if (relatedActivityIds.length === 0) return 0;
  let progress = 0;
  for (const input of inputs) {
    if (input.type !== "doActivity") continue;
    if (input.id === relatedActivityIds[progress]) {
      progress += 1;
      if (progress === relatedActivityIds.length) return progress;
      continue;
    }
    // Breadcrumbs are a monotonic subsequence, not a macro. Repeating an
    // earlier traversal while preparing a later gate must not erase progress;
    // only the next authored activity advances the route.
  }
  return progress;
}

function topLevelRequirements(condition: Condition | undefined): Condition[] {
  if (condition === undefined) return [];
  return "all" in condition ? condition.all : [condition];
}

function conditionProgress(condition: Condition, state: ComposedState): number {
  if ("all" in condition) {
    if (condition.all.length === 0) return 1;
    return condition.all.reduce(
      (sum, child) => sum + conditionProgress(child, state),
      0,
    ) / condition.all.length;
  }
  if ("any" in condition) {
    return Math.max(0, ...condition.any.map((child) => conditionProgress(child, state)));
  }
  if ("not" in condition) return evaluateCondition(condition, state).ok ? 1 : 0;
  if ("scriptCompleted" in condition) {
    return state.baseline.scripts[condition.scriptCompleted]?.completed ? 1 : 0;
  }
  if ("switch" in condition) {
    return evaluateCondition(condition, state).ok ? 1 : 0;
  }
  if ("selfSwitch" in condition) {
    return evaluateCondition(condition, state).ok ? 1 : 0;
  }
  if ("affection" in condition) {
    return rangeProgress(
      state.baseline.characters[condition.affection.character]?.stats.affection ?? 0,
      condition.affection,
    );
  }
  if ("characterStat" in condition) {
    return rangeProgress(
      state.baseline.characters[condition.characterStat.character]
        ?.stats[condition.characterStat.name] ?? 0,
      condition.characterStat,
    );
  }
  if ("variable" in condition) {
    const value = state.baseline.variables[condition.variable.name];
    return typeof value === "number"
      ? rangeProgress(value, condition.variable)
      : evaluateCondition(condition, state).ok ? 1 : 0;
  }
  if ("inventory" in condition) {
    return rangeProgress(
      state.baseline.inventory[condition.inventory.itemId] ?? 0,
      condition.inventory,
    );
  }
  if ("weaponPower" in condition) {
    return rangeProgress(
      state.baseline.weapons[condition.weaponPower.weaponId]?.power ?? 0,
      condition.weaponPower,
    );
  }
  if ("stat" in condition) {
    return rangeProgress(state.training?.stats[condition.stat.name] ?? 0, condition.stat);
  }
  if ("day" in condition) {
    return rangeProgress(state.training?.day ?? 0, condition.day);
  }
  if ("slot" in condition) {
    return rangeProgress(state.training?.slot ?? 0, condition.slot);
  }
  return evaluateCondition(condition, state).ok ? 1 : 0;
}

function rangeProgress(
  value: number,
  query: { min?: number; max?: number; eq?: number | string | boolean },
): number {
  if (query.eq !== undefined) {
    return typeof query.eq === "number"
      ? 1 / (1 + Math.abs(value - query.eq))
      : 0;
  }
  let progress = 1;
  if (query.min !== undefined && value < query.min) {
    progress *= 1 / (1 + query.min - value);
  }
  if (query.max !== undefined && value > query.max) {
    progress *= 1 / (1 + value - query.max);
  }
  return progress;
}
