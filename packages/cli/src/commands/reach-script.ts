import {
  choiceDecisionContext,
  compareChoiceSearchAssessment,
  peek,
  searchForScript,
  scriptRevision,
  step,
  type ChoiceSearchClosest,
  type ChoiceSearchProgress,
  type ComposedState,
  type Input,
  type Output,
} from "@rpg-harness/engine";
import { withSessionLock } from "@rpg-harness/session-store";
import { loadGame } from "../loader";
import { appendLog, loadSession, saveSession } from "../session";
import {
  historicalActiveScriptCheckpoint,
  historicalSessionCheckpoints,
} from "../session-lineage";
import { collectScriptCoverage } from "./coverage";
import {
  assertTargetEmpty,
  createForkFromSource,
  loadForkSource,
  type ForkSource,
} from "./fork";
import { summarizeReachPath, type ReachChoicePathSummary } from "./reach-choice";

export interface ReachScriptArgs {
  gameDir: string;
  fromSession: string;
  fromLogEntry?: number;
  session: string;
  scriptId: string;
  maxNodes: number;
  maxSteps: number;
  pretty: boolean;
  onProgress?: (progress: ChoiceSearchProgress) => void;
}

export interface ReachScriptSummary {
  status: "reached" | "not-reached";
  found: boolean;
  reason: "found" | "exhausted" | "max-nodes";
  target: { scriptId: string; title: string; source?: string };
  inputs: Input[];
  path: ReachChoicePathSummary;
  search: {
    exploredNodes: number;
    visitedStates: number;
    deepestSteps: number;
    attemptedSources: number;
  };
  requestedSession: string;
  source: {
    session: string;
    logEntry: number;
    mode: ForkSource["mode"];
    historyFallback: boolean;
  };
  session?: string;
  webPath?: string;
  fork?: Awaited<ReturnType<typeof createForkFromSource>>;
  output: Output | null;
  replayVerified: boolean;
  closest: ChoiceSearchClosest;
}

export async function reachScriptCommand(args: ReachScriptArgs): Promise<void> {
  const summary = await runReachScript({
    ...args,
    onProgress: (progress) => {
      const requirement = progress.closest.guidanceRequirement;
      process.stderr.write(
        `search: ${progress.exploredNodes} explored · ${progress.frontierNodes} frontier · depth ${progress.deepestSteps} · best ${requirement ? `${requirement.activityId} ${requirement.satisfiedRequirements}/${requirement.totalRequirements}` : `${progress.closest.satisfiedRequirements}/${progress.closest.totalRequirements} requirements`}\n`,
      );
    },
  });
  process.stdout.write(
    (args.pretty ? JSON.stringify(summary, null, 2) : JSON.stringify(summary)) + "\n",
  );
  if (!summary.found) process.exitCode = 1;
}

export async function runReachScript(args: ReachScriptArgs): Promise<ReachScriptSummary> {
  await assertTargetEmpty(args.gameDir, args.session);
  const game = await loadGame(args.gameDir);
  const script = game.scripts.find((candidate) => candidate.id === args.scriptId);
  if (!script) {
    throw new Error(
      `Script not found: ${args.scriptId}\n\nAvailable scripts:\n  ${game.scripts.map(({ id }) => id).sort().join("\n  ")}`,
    );
  }
  const coverage = await collectScriptCoverage(args.gameDir, args.fromSession);
  if (coverage.sessionErrors.length > 0) {
    throw new Error(`Cannot read source session: ${coverage.sessionErrors[0]!.error}`);
  }
  const row = coverage.scripts.find((candidate) => candidate.id === args.scriptId)!;
  if (row.status === "completed") {
    throw new Error(`Script is already completed in ${args.fromSession}: ${args.scriptId}`);
  }

  const primarySource = await loadForkSource(
    args.gameDir,
    args.fromSession,
    args.fromLogEntry,
  );
  const attempts: Array<{
    session: string;
    source: ForkSource;
    search: Awaited<ReturnType<typeof searchForScript>>;
  }> = [];
  let remainingNodes = args.maxNodes;
  const runAttempt = async (session: string, source: ForkSource) => {
    const search = await searchForScript(game, source.state, { scriptId: args.scriptId }, {
      maxNodes: remainingNodes,
      maxSteps: args.maxSteps,
      progressEvery: 100,
      ...(args.onProgress ? { onProgress: args.onProgress } : {}),
    });
    attempts.push({ session, source, search });
    remainingNodes = Math.max(0, remainingNodes - search.exploredNodes);
    return search.found;
  };

  const activeCheckpoint = row.status === "stale"
    ? await historicalActiveScriptCheckpoint(
        args.gameDir,
        args.fromSession,
        primarySource.selectedEntry,
        args.scriptId,
      )
    : null;
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
      new Set(["choice", "hubMenu", "scriptComplete"]),
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
    compareChoiceSearchAssessment(
        candidate.search.closest,
        best.search.closest,
        true,
      ) > 0
      ? candidate
      : best
  );
  const source = selectedAttempt.source;
  const sourceSession = selectedAttempt.session;
  const selectedSearch = selectedAttempt.search;
  const inputs = foundAttempt?.search.inputs ?? selectedSearch.closest.inputs;
  const found = foundAttempt !== undefined;
  const reason = found
    ? "found" as const
    : remainingNodes === 0
      ? "max-nodes" as const
      : "exhausted" as const;
  const exploredNodes = attempts.reduce((sum, attempt) => sum + attempt.search.exploredNodes, 0);
  const visitedStates = attempts.reduce((sum, attempt) => sum + attempt.search.visitedStates, 0);
  const deepestSteps = Math.max(...attempts.map((attempt) => attempt.search.deepestSteps));

  let replayVerified = false;
  let output = selectedSearch.output;
  let fork: Awaited<ReturnType<typeof createForkFromSource>> | undefined;
  if (found) {
    fork = await createForkFromSource({
      gameDir: args.gameDir,
      from: sourceSession,
      to: args.session,
      at: source.selectedEntry,
      pretty: false,
    }, source);
    const replay = await replayPath(args, game, inputs);
    output = replay.output;
    const completed = replay.state.baseline.scripts[args.scriptId];
    if (completed?.completed !== true || completed.completedRevision !== scriptRevision(script)) {
      throw new Error(`Reach replay did not complete script ${args.scriptId}`);
    }
    if (canonicalJson(replay.state) !== canonicalJson(foundAttempt.search.state)) {
      throw new Error(`Reach replay diverged from search result for script ${args.scriptId}`);
    }
    replayVerified = true;
  }

  return {
    status: found ? "reached" : "not-reached",
    found,
    reason,
    target: {
      scriptId: script.id,
      title: script.title,
      ...(script.source ? { source: script.source } : {}),
    },
    inputs: found ? foundAttempt.search.inputs : [],
    path: summarizeReachPath(found ? foundAttempt.search.inputs : []),
    search: { exploredNodes, visitedStates, deepestSteps, attemptedSources: attempts.length },
    requestedSession: args.session,
    source: {
      session: sourceSession,
      logEntry: source.selectedEntry,
      mode: source.mode,
      historyFallback: sourceSession !== args.fromSession ||
        source.selectedEntry !== primarySource.selectedEntry,
    },
    ...(fork ? { session: args.session, webPath: `/?session=${encodeURIComponent(args.session)}`, fork } : {}),
    output,
    replayVerified,
    closest: selectedSearch.closest,
  };
}

async function replayPath(
  args: ReachScriptArgs,
  game: Awaited<ReturnType<typeof loadGame>>,
  inputs: Input[],
): Promise<{ output: Output | null; state: ComposedState }> {
  return withSessionLock(args.gameDir, args.session, async () => {
    let state = await loadSession(args.gameDir, args.session, game);
    const targetScript = game.scripts.find((script) => script.id === args.scriptId)!;
    const prior = state.baseline.scripts[args.scriptId];
    if (prior?.completed === true && prior.completedRevision !== scriptRevision(targetScript)) {
      prior.completed = false;
      state.baseline.completionOrder = state.baseline.completionOrder
        .filter((scriptId) => scriptId !== args.scriptId);
    }
    let current = await peek(game, state);
    state = current.state;
    for (const input of inputs) {
      const before = current.output;
      current = await step(game, state, input);
      state = current.state;
      await saveSession(args.gameDir, args.session, state);
      const decision = choiceDecisionContext(before, input);
      await appendLog(args.gameDir, args.session, {
        t: Date.now(),
        source: "reach-script",
        input,
        output: current.output,
        ...(decision ? { decision } : {}),
      }, state);
    }
    return { output: current.output, state };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
