import { cloneState } from "./state";
import { peek, step } from "./step";
import type { ComposedState, Game, Input, Output } from "./types";

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
}

interface SearchNode {
  state: ComposedState;
  output: Output | null;
  done: boolean;
  inputs: Input[];
}

/**
 * Breadth-first search over the same public Input/Output contract used by GUI
 * and Headless play. Forced advances are collapsed, meaningful decisions are
 * branched, and the persisted RNG cursor makes every discovered path replayable.
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
  let last = start;

  while (queue.length > 0) {
    const node = queue.shift()!;
    last = node;
    deepestSteps = Math.max(deepestSteps, node.inputs.length);
    const fingerprint = stateFingerprint(node.state);
    if (visited.has(fingerprint)) continue;
    visited.add(fingerprint);
    exploredNodes += 1;

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
        output: node.output,
        state: node.state,
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
    output: last.output,
    state: last.state,
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
