import {
  choiceDecisionContext,
  peek,
  searchForChoice,
  step,
  type ComposedState,
  type Input,
  type Output,
} from "@rpg-harness/engine";
import { withSessionLock } from "@rpg-harness/session-store";
import { loadGame } from "../loader";
import { appendLog, loadSession, saveSession } from "../session";
import {
  collectChoiceCoverage,
  type ChoiceAuthoringWorkItem,
} from "./choice-coverage";
import {
  assertTargetEmpty,
  createForkFromSource,
  forkSession,
  loadForkSource,
} from "./fork";

export interface ReachChoiceArgs {
  gameDir: string;
  fromSession: string;
  fromLogEntry?: number;
  session: string;
  key?: string;
  maxNodes: number;
  maxSteps: number;
  pretty: boolean;
}

export interface ReachChoiceSummary {
  found: boolean;
  reason: "found" | "exhausted" | "max-nodes";
  target: Extract<ChoiceAuthoringWorkItem, { kind: "reach-choice" }>;
  inputs: Input[];
  decisions: number;
  exploredNodes: number;
  visitedStates: number;
  deepestSteps: number;
  session?: string;
  webPath?: string;
  requestedSession: string;
  fork?: Awaited<ReturnType<typeof forkSession>>;
  output: Output | null;
  replayVerified: boolean;
}

export async function reachChoiceCommand(args: ReachChoiceArgs): Promise<void> {
  const summary = await runReachChoice(args);
  process.stdout.write(
    (args.pretty ? JSON.stringify(summary, null, 2) : JSON.stringify(summary)) +
      "\n",
  );
}

export async function runReachChoice(
  args: ReachChoiceArgs,
): Promise<ReachChoiceSummary> {
  await assertTargetEmpty(args.gameDir, args.session);
  const coverage = await collectChoiceCoverage(args.gameDir, args.fromSession);
  if (coverage.sessionErrors.length > 0) {
    throw new Error(
      `Cannot read source lineage: ${coverage.sessionErrors
        .map(({ session, error }) => `${session}: ${error}`)
        .join("; ")}`,
    );
  }
  const targets = coverage.authoring.workItems.filter(
    (item): item is Extract<ChoiceAuthoringWorkItem, { kind: "reach-choice" }> =>
      item.kind === "reach-choice",
  );
  const target = selectTarget(targets, args.key);
  const game = await loadGame(args.gameDir);
  const source = await loadForkSource(
    args.gameDir,
    args.fromSession,
    args.fromLogEntry,
  );
  const search = await searchForChoice(
    game,
    source.state,
    { scriptId: target.scriptId, choiceId: target.choiceId },
    { maxNodes: args.maxNodes, maxSteps: args.maxSteps },
  );

  let replayVerified = false;
  let output = search.output;
  let fork: Awaited<ReturnType<typeof forkSession>> | undefined;
  if (search.found) {
    fork = await createForkFromSource({
      gameDir: args.gameDir,
      from: args.fromSession,
      to: args.session,
      ...(args.fromLogEntry !== undefined ? { at: args.fromLogEntry } : {}),
      pretty: false,
    }, source);
    const replay = await replayPath(
      args.gameDir,
      args.session,
      game,
      search.inputs,
    );
    output = replay.output;
    if (!isTarget(output, target)) {
      throw new Error(
        `Reach replay missed target ${target.scriptId}/${target.choiceId}; got ${describeOutput(output)}`,
      );
    }
    if (canonicalJson(replay.state) !== canonicalJson(search.state)) {
      const difference = firstDifference(search.state, replay.state);
      throw new Error(
        `Reach replay diverged from search result for ${target.key} at ${difference}; persisted RNG or transition purity is broken`,
      );
    }
    replayVerified = true;
  }

  return {
    found: search.found,
    reason: search.reason,
    target,
    inputs: search.inputs,
    decisions: search.inputs.length,
    exploredNodes: search.exploredNodes,
    visitedStates: search.visitedStates,
    deepestSteps: search.deepestSteps,
    requestedSession: args.session,
    ...(search.found
      ? {
          session: args.session,
          webPath: `/?session=${encodeURIComponent(args.session)}`,
        }
      : {}),
    ...(fork ? { fork } : {}),
    output,
    replayVerified,
  };
}

async function replayPath(
  gameDir: string,
  session: string,
  game: Awaited<ReturnType<typeof loadGame>>,
  inputs: Input[],
): Promise<{ output: Output | null; state: ComposedState }> {
  return withSessionLock(gameDir, session, async () => {
    let state = await loadSession(gameDir, session, game);
    let current = await peek(game, state);
    state = current.state;
    for (const input of inputs) {
      const before = current.output;
      current = await step(game, state, input);
      state = current.state;
      await saveSession(gameDir, session, state);
      const decision = choiceDecisionContext(before, input);
      await appendLog(gameDir, session, {
        t: Date.now(),
        source: "reach-choice",
        input,
        output: current.output,
        ...(decision ? { decision } : {}),
      }, state);
    }
    if (inputs.length === 0 && current.output !== null) {
      await saveSession(gameDir, session, state);
      await appendLog(gameDir, session, {
        t: Date.now(),
        source: "reach-choice:target",
        output: current.output,
      }, state);
    }
    return { output: current.output, state };
  });
}

function selectTarget(
  targets: Array<Extract<ChoiceAuthoringWorkItem, { kind: "reach-choice" }>>,
  key?: string,
) {
  if (key === undefined) {
    const first = targets[0];
    if (!first) throw new Error("No unseen stable authored choices in this lineage");
    return first;
  }
  const target = targets.find((item) => item.key === key);
  if (target) return target;
  throw new Error(
    `Unseen stable choice not found: ${key}${
      targets.length > 0
        ? `\n\nAvailable reach work items:\n  ${targets.map((item) => item.key).join("\n  ")}`
        : ""
    }`,
  );
}

function isTarget(
  output: Output | null,
  target: { scriptId: string; choiceId: string },
): boolean {
  return output?.type === "choice" &&
    output.scriptId === target.scriptId &&
    output.choiceId === target.choiceId;
}

function describeOutput(output: Output | null): string {
  if (output === null) return "<none>";
  return output.type === "choice"
    ? `${output.scriptId ?? "<legacy>"}/${output.choiceId ?? "<legacy>"}`
    : output.type;
}

function firstDifference(expected: unknown, actual: unknown, path = "state"): string {
  if (canonicalJson(expected) === canonicalJson(actual)) return "<none>";
  if (Object.is(expected, actual)) return "<none>";
  if (
    expected === null || actual === null ||
    typeof expected !== "object" || typeof actual !== "object"
  ) {
    return `${path} (search=${JSON.stringify(expected)}, replay=${JSON.stringify(actual)})`;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return path;
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      if (!Object.is(expected[index], actual[index])) {
        return firstDifference(expected[index], actual[index], `${path}[${index}]`);
      }
    }
    return path;
  }
  const expectedRecord = expected as Record<string, unknown>;
  const actualRecord = actual as Record<string, unknown>;
  for (const key of new Set([
    ...Object.keys(expectedRecord),
    ...Object.keys(actualRecord),
  ])) {
    if (canonicalJson(expectedRecord[key]) !== canonicalJson(actualRecord[key])) {
      return firstDifference(
        expectedRecord[key],
        actualRecord[key],
        `${path}.${key}`,
      );
    }
  }
  return path;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}
