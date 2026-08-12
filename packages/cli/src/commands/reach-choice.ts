import {
  choiceDecisionContext,
  compareChoiceSearchAssessment,
  peek,
  searchForChoice,
  step,
  type ComposedState,
  type ChoiceSearchClosest,
  type ChoiceSearchProgress,
  type Input,
  type Output,
} from "@rpg-harness/engine";
import { withSessionLock } from "@rpg-harness/session-store";
import { createHash } from "node:crypto";
import { loadGame } from "../loader";
import { appendLog, loadSession, saveSession } from "../session";
import {
  historicalActiveScriptCheckpoint,
  historicalSessionCheckpoints,
} from "../session-lineage";
import {
  recordPlaytestReport,
  type PlaytestReport,
} from "../playtest-reports";
import {
  collectChoiceCoverage,
  type ChoiceAuthoringWorkItem,
} from "./choice-coverage";
import {
  assertTargetEmpty,
  createForkFromSource,
  forkSession,
  loadForkSource,
  type ForkSource,
} from "./fork";

export interface ReachChoiceArgs {
  gameDir: string;
  fromSession: string;
  fromLogEntry?: number;
  session: string;
  key?: string;
  maxNodes: number;
  maxSteps: number;
  reportOnMiss?: boolean;
  pretty: boolean;
  onProgress?: (progress: ChoiceSearchProgress) => void;
}

export interface ReachChoiceSummary {
  status: "reached" | "not-reached";
  found: boolean;
  reason: "found" | "exhausted" | "max-nodes";
  target: Extract<ChoiceAuthoringWorkItem, { kind: "reach-choice" }>;
  inputs: Input[];
  path: ReachChoicePathSummary;
  exploredNodes: number;
  visitedStates: number;
  deepestSteps: number;
  session?: string;
  webPath?: string;
  requestedSession: string;
  source: {
    session: string;
    logEntry: number;
    mode: ForkSource["mode"];
    historyFallback: boolean;
  };
  attemptedSources: number;
  fork?: Awaited<ReturnType<typeof forkSession>>;
  output: Output | null;
  replayVerified: boolean;
  closest: ChoiceSearchClosest;
  report?: PlaytestReport;
}

export interface ReachChoicePathSummary {
  revision: string;
  inputs: number;
  decisions: number;
  forcedAdvances: number;
  choices: number;
  activities: number;
  scriptSelections: number;
}

export async function reachChoiceCommand(args: ReachChoiceArgs): Promise<void> {
  const summary = await runReachChoice({
    ...args,
    onProgress: (progress) => {
      const requirement = progress.closest.guidanceRequirement;
      process.stderr.write(
        `search: ${progress.exploredNodes} explored · ${progress.frontierNodes} frontier · depth ${progress.deepestSteps} · best ${requirement ? `${requirement.activityId} ${requirement.satisfiedRequirements}/${requirement.totalRequirements}` : `${progress.closest.satisfiedRequirements}/${progress.closest.totalRequirements} requirements`}\n`,
      );
    },
  });
  process.stdout.write(
    (args.pretty ? JSON.stringify(summary, null, 2) : JSON.stringify(summary)) +
      "\n",
  );
  if (!summary.found) process.exitCode = 1;
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
  const primarySource = await loadForkSource(
    args.gameDir,
    args.fromSession,
    args.fromLogEntry,
  );
  const targetCoordinates = { scriptId: target.scriptId, choiceId: target.choiceId };
  const attempts: Array<{
    session: string;
    source: ForkSource;
    search: Awaited<ReturnType<typeof searchForChoice>>;
  }> = [];
  let remainingNodes = args.maxNodes;

  const runAttempt = async (session: string, source: ForkSource) => {
    const search = await searchForChoice(game, source.state, targetCoordinates, {
      maxNodes: remainingNodes,
      maxSteps: args.maxSteps,
      progressEvery: 100,
      ...(args.onProgress ? { onProgress: args.onProgress } : {}),
    });
    attempts.push({ session, source, search });
    remainingNodes = Math.max(0, remainingNodes - search.exploredNodes);
    return search.found;
  };

  const activeCheckpoint = await historicalActiveScriptCheckpoint(
    args.gameDir,
    args.fromSession,
    primarySource.selectedEntry,
    target.scriptId,
    "earliest",
  );
  if (activeCheckpoint) {
    await runAttempt(
      activeCheckpoint.session,
      await loadForkSource(
        args.gameDir,
        activeCheckpoint.session,
        activeCheckpoint.logEntry,
      ),
    );
  }
  if (!attempts.some((attempt) => attempt.search.found) && remainingNodes > 0) {
    await runAttempt(args.fromSession, primarySource);
  }
  if (!attempts.some((attempt) => attempt.search.found) && args.fromLogEntry === undefined && remainingNodes > 0) {
    for (const coordinate of await historicalSessionCheckpoints(
      args.gameDir,
      args.fromSession,
      primarySource.selectedEntry,
      new Set(["choice"]),
    )) {
      const source = await loadForkSource(
        args.gameDir,
        coordinate.session,
        coordinate.logEntry,
      );
      if (await runAttempt(coordinate.session, source) || remainingNodes === 0) break;
    }
  }

  const foundAttempt = attempts.find((attempt) => attempt.search.found);
  const selectedAttempt = foundAttempt ?? attempts.reduce((best, candidate) =>
    compareChoiceSearchAssessment(candidate.search.closest, best.search.closest) > 0
      ? candidate
      : best
  );
  const source = selectedAttempt.source;
  const sourceSession = selectedAttempt.session;
  const selectedSearch = selectedAttempt.search;
  const exploredNodes = attempts.reduce((sum, attempt) => sum + attempt.search.exploredNodes, 0);
  const visitedStates = attempts.reduce((sum, attempt) => sum + attempt.search.visitedStates, 0);
  const deepestSteps = Math.max(...attempts.map((attempt) => attempt.search.deepestSteps));
  const search = {
    ...selectedSearch,
    found: foundAttempt !== undefined,
    reason: foundAttempt
      ? "found" as const
      : remainingNodes === 0
        ? "max-nodes" as const
        : "exhausted" as const,
    exploredNodes,
    visitedStates,
    deepestSteps,
  };

  let replayVerified = false;
  let output = search.output;
  let fork: Awaited<ReturnType<typeof forkSession>> | undefined;
  let report: PlaytestReport | undefined;
  if (search.found) {
    fork = await createForkFromSource({
      gameDir: args.gameDir,
      from: sourceSession,
      to: args.session,
      at: source.selectedEntry,
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
  } else if (args.reportOnMiss) {
    fork = await createForkFromSource({
      gameDir: args.gameDir,
      from: sourceSession,
      to: args.session,
      at: source.selectedEntry,
      pretty: false,
    }, source);
    const replay = await replayPath(
      args.gameDir,
      args.session,
      game,
      search.closest.inputs,
    );
    output = replay.output;
    if (canonicalJson(replay.state) !== canonicalJson(search.state)) {
      const difference = firstDifference(search.state, replay.state);
      throw new Error(
        `Reach miss replay diverged from closest search state for ${target.key} at ${difference}`,
      );
    }
    replayVerified = true;
    report = await recordPlaytestReport({
      gameDir: args.gameDir,
      session: args.session,
      area: "gameplay",
      severity: "note",
      title: `Stable choice not reached: ${target.key} (${search.reason})`,
      details: formatMissDetails(search.closest, search, args),
      ...(target.source ? { target: target.source } : {}),
    });
  }

  return {
    status: search.found ? "reached" : "not-reached",
    found: search.found,
    reason: search.reason,
    target,
    inputs: search.inputs,
    path: summarizeReachPath(search.inputs),
    exploredNodes: search.exploredNodes,
    visitedStates: search.visitedStates,
    deepestSteps: search.deepestSteps,
    requestedSession: args.session,
    source: {
      session: sourceSession,
      logEntry: source.selectedEntry,
      mode: source.mode,
      historyFallback: sourceSession !== args.fromSession ||
        source.selectedEntry !== primarySource.selectedEntry,
    },
    attemptedSources: attempts.length,
    ...(fork
      ? {
          session: args.session,
          webPath: `/?session=${encodeURIComponent(args.session)}`,
        }
      : {}),
    ...(fork ? { fork } : {}),
    output,
    replayVerified,
    closest: search.closest,
    ...(report ? { report } : {}),
  };
}

export function summarizeReachPath(inputs: Input[]): ReachChoicePathSummary {
  const choices = inputs.filter((input) => input.type === "choose").length;
  const activities = inputs.filter((input) => input.type === "doActivity").length;
  const scriptSelections = inputs.filter((input) => input.type === "select").length;
  const decisions = choices + activities + scriptSelections;
  return {
    revision: createHash("sha256").update(JSON.stringify(inputs)).digest("hex"),
    inputs: inputs.length,
    decisions,
    forcedAdvances: inputs.length - decisions,
    choices,
    activities,
    scriptSelections,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
        source: "reach-choice:checkpoint",
        output: current.output,
      }, state);
    }
    return { output: current.output, state };
  });
}

function formatMissDetails(
  closest: ChoiceSearchClosest,
  search: {
    reason: string;
    exploredNodes: number;
    visitedStates: number;
    deepestSteps: number;
  },
  args: ReachChoiceArgs,
): string {
  const requirements = closest.requirements.length === 0
    ? ["Target script has no declared top-level requirements; inspect route control flow."]
    : closest.requirements.map((item, index) =>
        `${index + 1}. ${item.satisfied ? "satisfied" : "blocked"}: ${
          item.reason ?? JSON.stringify(item.condition)
        } (progress ${item.progress.toFixed(3)})`
      );
  return [
    `Bounded Headless search stopped with \`${search.reason}\` after ${search.exploredNodes} explored nodes (${search.visitedStates} unique states; deepest path ${search.deepestSteps} inputs).`,
    `Closest recoverable state is ${closest.steps} public inputs from \`${args.fromSession}\`; ${closest.satisfiedRequirements}/${closest.totalRequirements} target requirements are satisfied.`,
    ...requirements,
    `Closest input path: ${closest.inputs.length === 0 ? "(source checkpoint)" : JSON.stringify(closest.inputs)}.`,
    "Reproduce this report to inspect the closest state in GUI or Headless, then decide whether the route is intentionally exclusive, needs author guidance, or contains a progression defect.",
  ].join(" ");
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
