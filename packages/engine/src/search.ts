import { cloneState } from "./state";
import { peek, step } from "./step";
import { evaluateCondition } from "./condition";
import type { ComposedState, Condition, Game, Input, Output } from "./types";

export interface ChoiceSearchTarget {
  scriptId: string;
  choiceId: string;
}

export interface ChoiceSearchOptions {
  maxNodes?: number;
  maxSteps?: number;
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
}

interface SearchNode {
  state: ComposedState;
  output: Output | null;
  done: boolean;
  inputs: Input[];
}

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
  const maxNodes = options.maxNodes ?? 5_000;
  const maxSteps = options.maxSteps ?? 250;
  if (!Number.isInteger(maxNodes) || maxNodes < 1) {
    throw new Error("choice search maxNodes must be a positive integer");
  }
  if (!Number.isInteger(maxSteps) || maxSteps < 0) {
    throw new Error("choice search maxSteps must be a non-negative integer");
  }

  const start = await settleForced(
    game,
    cloneState(initialState),
    [],
    target,
    maxSteps,
  );
  const queue: SearchNode[] = [start];
  const visited = new Set<string>();
  let exploredNodes = 0;
  let deepestSteps = start.inputs.length;
  let closest = assessNode(game, target, start);
  let closestNode = start;

  while (queue.length > 0) {
    queue.sort((left, right) =>
      compareAssessment(
        assessNode(game, target, right),
        assessNode(game, target, left),
      )
    );
    const node = queue.shift()!;
    deepestSteps = Math.max(deepestSteps, node.inputs.length);
    const fingerprint = stateFingerprint(node.state);
    if (visited.has(fingerprint)) continue;
    visited.add(fingerprint);
    exploredNodes += 1;
    const assessment = assessNode(game, target, node);
    if (compareAssessment(assessment, closest) > 0) {
      closest = assessment;
      closestNode = node;
    }

    if (isTargetChoice(node.output, target)) {
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

    for (const input of candidateInputs(node.output, target)) {
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
        );
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
  target: ChoiceSearchTarget,
  maxSteps: number,
  initialOutput?: Output | null,
  initialDone?: boolean,
): Promise<SearchNode> {
  let state = initialState;
  let output = initialOutput;
  let done = initialDone ?? false;
  const inputs = [...initialInputs];
  if (output === undefined) {
    const current = await peek(game, state);
    state = current.state;
    output = current.output;
    done = current.done;
  }

  while (
    !done &&
    output !== null &&
    !isTargetChoice(output, target) &&
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
  return { state, output, done, inputs };
}

function candidateInputs(
  output: Output,
  target: ChoiceSearchTarget,
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
      return output.snapshot.activities
        .filter((activity) => activity.available)
        .sort((left, right) =>
          Number(right.id === `script:${target.scriptId}`) -
          Number(left.id === `script:${target.scriptId}`)
        )
        .map((activity) => ({ type: "doActivity" as const, id: activity.id }));
    case "gameEnd":
      return [];
  }
}

function isTargetChoice(
  output: Output | null,
  target: ChoiceSearchTarget,
): boolean {
  return (
    output?.type === "choice" &&
    output.scriptId === target.scriptId &&
    output.choiceId === target.choiceId
  );
}

function stateFingerprint(state: ComposedState): string {
  // Keep the engine browser-compatible: search is also usable by Web/Studio,
  // so it must not depend on node:crypto. Full JSON avoids hash collisions;
  // the caller's node budget bounds memory.
  return JSON.stringify(state);
}

function assessNode(
  game: Game,
  target: ChoiceSearchTarget,
  node: SearchNode,
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
  const targetScriptCompleted =
    node.state.baseline.scripts[target.scriptId]?.completed === true;
  const targetScriptActive =
    node.state.baseline.currentScriptId === target.scriptId ||
    (node.output?.type === "choice" && node.output.scriptId === target.scriptId);
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
  };
}

function compareAssessment(
  left: ChoiceSearchClosest,
  right: ChoiceSearchClosest,
): number {
  if (left.targetScriptCompleted !== right.targetScriptCompleted) {
    return left.targetScriptCompleted ? -1 : 1;
  }
  if (left.targetScriptActive !== right.targetScriptActive) {
    return left.targetScriptActive ? 1 : -1;
  }
  if (left.progress !== right.progress) return left.progress - right.progress;
  if (left.satisfiedRequirements !== right.satisfiedRequirements) {
    return left.satisfiedRequirements - right.satisfiedRequirements;
  }
  return right.steps - left.steps;
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
