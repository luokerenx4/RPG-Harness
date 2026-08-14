import {
  activityDecisionContext,
  choiceDecisionContext,
  cloneState,
  compareChoiceSearchAssessment,
  evaluateCondition,
  peek,
  searchForChoice,
  step,
  type ComposedState,
  type Condition,
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
  createForkFromSourceWithLockHeld,
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
  reportOnQuality?: boolean;
  pretty: boolean;
  onProgress?: (progress: ChoiceSearchProgress) => void;
}

export interface ReachChoiceSummary {
  status: "reached" | "paused" | "not-reached";
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
  sourceErrors?: Array<{ session: string; logEntry: number; error: string }>;
  fork?: Awaited<ReturnType<typeof createForkFromSourceWithLockHeld>>;
  output: Output | null;
  replayVerified: boolean;
  closest: ChoiceSearchClosest;
  report?: PlaytestReport;
  continuation?: ReachChoiceContinuation;
}

export interface ReachChoiceContinuation {
  kind: "search-budget-exhausted";
  sourceSession: string;
  webPath: string;
  frontier: ChoiceSearchClosest;
  next: {
    command: "reach";
    args: {
      key: string;
      fromSession: string;
      fromLogEntry: number;
      session: "<new-session>";
      maxNodes: number;
      maxSteps: number;
    };
  };
}

export interface ReachChoicePathSummary {
  revision: string;
  inputs: number;
  decisions: number;
  forcedAdvances: number;
  choices: number;
  activities: number;
  scriptSelections: number;
  quality: ReachChoicePathQuality;
}

export interface ReachChoicePathQuality {
  status: "clean" | "churn";
  navigationCycle?: {
    activityIds: [string, string];
    repetitions: number;
    activityStart: number;
    activityEnd: number;
  };
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
  if (summary.status === "not-reached") process.exitCode = 1;
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
  const sourceErrors: Array<{ session: string; logEntry: number; error: string }> = [];
  let attemptedSources = 0;
  let remainingNodes = args.maxNodes;

  const runAttempt = async (session: string, source: ForkSource) => {
    attemptedSources += 1;
    try {
      const search = await searchForChoice(game, source.state, targetCoordinates, {
        maxNodes: remainingNodes,
        maxSteps: args.maxSteps,
        progressEvery: 100,
        ...(args.onProgress ? { onProgress: args.onProgress } : {}),
      });
      attempts.push({ session, source, search });
      remainingNodes = Math.max(0, remainingNodes - search.exploredNodes);
      return search.found;
    } catch (cause) {
      sourceErrors.push({
        session,
        logEntry: source.selectedEntry,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return false;
    }
  };

  const sourceCandidates: ReachChoiceSourceCandidate[] = [
    { session: args.fromSession, source: primarySource },
  ];
  if (args.fromLogEntry === undefined) {
    const activeCheckpoint = await historicalActiveScriptCheckpoint(
      args.gameDir,
      args.fromSession,
      primarySource.selectedEntry,
      target.scriptId,
      "earliest",
    );
    if (activeCheckpoint) {
      sourceCandidates.unshift({
        session: activeCheckpoint.session,
        source: await loadForkSource(
          args.gameDir,
          activeCheckpoint.session,
          activeCheckpoint.logEntry,
        ),
      });
    }
    const historical = await historicalSessionCheckpoints(
      args.gameDir,
      args.fromSession,
      primarySource.selectedEntry,
      new Set(["choice"]),
    );
    sourceCandidates.push(...await Promise.all(historical.map(async (coordinate) => ({
      session: coordinate.session,
      source: await loadForkSource(
        args.gameDir,
        coordinate.session,
        coordinate.logEntry,
      ),
    }))));
  }

  for (const candidate of await rankReachChoiceSources(
    game,
    targetCoordinates,
    deduplicateReachChoiceSources(sourceCandidates),
  )) {
    if (remainingNodes === 0) break;
    if (candidate.preflightError) {
      attemptedSources += 1;
      sourceErrors.push({
        session: candidate.session,
        logEntry: candidate.source.selectedEntry,
        error: candidate.preflightError,
      });
      continue;
    }
    if (await runAttempt(candidate.session, candidate.source)) break;
  }

  if (attempts.length === 0) {
    throw new Error(
      `Every recoverable source failed before choice search: ${sourceErrors
        .map(({ session, logEntry, error }) => `${session}@${logEntry}: ${error}`)
        .join("; ")}`,
    );
  }

  const foundAttempt = attempts.find((attempt) => attempt.search.found);
  const closestAttempt = attempts.reduce((best, candidate) =>
    compareChoiceSearchAssessment(candidate.search.closest, best.search.closest) > 0
      ? candidate
      : best
  );
  const frontierAttempt = attempts
    .filter((attempt) => attempt.search.frontier !== undefined)
    .reduce<(typeof attempts)[number] | undefined>((best, candidate) =>
      !best || compareChoiceSearchAssessment(
          candidate.search.frontier!.closest,
          best.search.frontier!.closest,
        ) > 0
        ? candidate
        : best,
    undefined);
  const selectedAttempt = foundAttempt ?? frontierAttempt ?? closestAttempt;
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
      : frontierAttempt && remainingNodes === 0
        ? "max-nodes" as const
        : "exhausted" as const,
    exploredNodes,
    visitedStates,
    deepestSteps,
    closest: closestAttempt.search.closest,
    state: foundAttempt?.search.state ??
      frontierAttempt?.search.frontier?.state ??
      closestAttempt.search.state,
  };

  const replayInputs = foundAttempt?.search.inputs ??
    frontierAttempt?.search.frontier?.inputs ??
    closestAttempt.search.closest.inputs;
  const pathSummary = summarizeReachPath(replayInputs);
  const materialized = await materializeReachChoicePath(
    args,
    game,
    sourceSession,
    source,
    replayInputs,
  );
  let replayVerified = false;
  let output = materialized.replay.output;
  const fork = materialized.fork;
  let report: PlaytestReport | undefined;
  if (search.found) {
    if (!isTarget(output, target)) {
      throw new Error(
        `Reach replay missed target ${target.scriptId}/${target.choiceId}; got ${describeOutput(output)}`,
      );
    }
    if (canonicalJson(materialized.replay.state) !== canonicalJson(search.state)) {
      const difference = firstDifference(search.state, materialized.replay.state);
      throw new Error(
        `Reach replay diverged from search result for ${target.key} at ${difference}; persisted RNG or transition purity is broken`,
      );
    }
    replayVerified = true;
  } else {
    if (canonicalJson(materialized.replay.state) !== canonicalJson(search.state)) {
      const difference = firstDifference(search.state, materialized.replay.state);
      throw new Error(
        `Reach miss replay diverged from closest search state for ${target.key} at ${difference}`,
      );
    }
    replayVerified = true;
  }
  if (!search.found && search.reason === "exhausted" && args.reportOnMiss) {
    report = await recordPlaytestReport({
      gameDir: args.gameDir,
      session: args.session,
      area: "gameplay",
      severity: "note",
      title: `Stable choice not reached: ${target.key} (${search.reason})`,
      details: formatMissDetails(search.closest, search, args),
      ...(target.source ? { target: target.source } : {}),
    });
  } else if (
    search.found &&
    args.reportOnQuality &&
    pathSummary.quality.status === "churn"
  ) {
    const cycle = pathSummary.quality.navigationCycle!;
    report = await recordPlaytestReport({
      gameDir: args.gameDir,
      session: args.session,
      area: "engine",
      severity: "minor",
      title: `Reach path contains navigation churn: ${target.key}`,
      details: [
        `A verified successful reach path repeated ${cycle.activityIds.join(" ↔ ")} for ${cycle.repetitions} consecutive rounds.`,
        `Activity decisions ${cycle.activityStart}–${cycle.activityEnd}; ${pathSummary.inputs} total inputs / ${pathSummary.decisions} decisions.`,
        `Path revision: ${pathSummary.revision}. Search explored ${search.exploredNodes} nodes.`,
        "Treat the route as successful evidence, but improve search ranking or authored progression so repeated navigation is not rewarded as development progress.",
      ].join("\n"),
      target: "packages/engine/src/search.ts",
    });
  }

  const continuation: ReachChoiceContinuation | undefined = search.reason === "max-nodes"
    ? {
        kind: "search-budget-exhausted",
        sourceSession: args.session,
        webPath: `/?session=${encodeURIComponent(args.session)}`,
        frontier: selectedSearch.frontier!.closest,
        next: {
          command: "reach",
          args: {
            key: target.key,
            fromSession: args.session,
            fromLogEntry: materialized.logEntry,
            session: "<new-session>",
            maxNodes: args.maxNodes,
            maxSteps: args.maxSteps,
          },
        },
      }
    : undefined;

  return {
    status: search.found ? "reached" : search.reason === "max-nodes" ? "paused" : "not-reached",
    found: search.found,
    reason: search.reason,
    target,
    inputs: replayInputs,
    path: pathSummary,
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
    attemptedSources,
    ...(sourceErrors.length > 0 ? { sourceErrors } : {}),
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
    ...(continuation ? { continuation } : {}),
  };
}

interface ReachChoiceSourceCandidate {
  session: string;
  source: ForkSource;
  preflightError?: string;
}

function deduplicateReachChoiceSources(
  candidates: ReachChoiceSourceCandidate[],
): ReachChoiceSourceCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.session}:${candidate.source.selectedEntry}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Prefer recoverable choices whose authored consequences can satisfy the
 * target script gate. A completed story branch is otherwise irreversible in
 * the live state, so spending the whole node budget there can never discover
 * a sibling ending that is already present in checkpoint history.
 */
async function rankReachChoiceSources(
  game: Awaited<ReturnType<typeof loadGame>>,
  target: { scriptId: string; choiceId: string },
  candidates: ReachChoiceSourceCandidate[],
): Promise<ReachChoiceSourceCandidate[]> {
  const conditions = topLevelConditions(
    game.scripts.find((script) => script.id === target.scriptId)?.requires,
  );
  const scored = await Promise.all(candidates.map(async (candidate, order) => {
    try {
      const current = await peek(game, cloneState(candidate.source.state));
      const exactTarget = current.output?.type === "choice" &&
        current.output.scriptId === target.scriptId &&
        current.output.choiceId === target.choiceId;
      const currentSatisfied = satisfiedConditions(conditions, current.state);
      let projectedSatisfied = currentSatisfied;
      if (current.output?.type === "choice") {
        for (const [index, option] of current.output.options.entries()) {
          if (!option.available) continue;
          try {
            const transitioned = await step(
              game,
              cloneState(current.state),
              current.output.choiceId && option.id
                ? {
                    type: "choose",
                    choiceId: current.output.choiceId,
                    optionId: option.id,
                  }
                : { type: "choose", index },
            );
            projectedSatisfied = Math.max(
              projectedSatisfied,
              satisfiedConditions(conditions, transitioned.state),
            );
          } catch {
            // A module-rejected historical option is not useful as a rewind
            // source, but it must not hide other recoverable checkpoints.
          }
        }
      }
      return {
        candidate,
        order,
        preflightError: false,
        exactTarget,
        viable: !current.done && current.output !== null,
        currentSatisfied,
        projectedSatisfied,
      };
    } catch (cause) {
      return {
        candidate: {
          ...candidate,
          preflightError: cause instanceof Error ? cause.message : String(cause),
        },
        order,
        preflightError: true,
        exactTarget: false,
        viable: false,
        currentSatisfied: -1,
        projectedSatisfied: -1,
      };
    }
  }));
  return scored
    .sort((left, right) =>
      Number(right.preflightError) - Number(left.preflightError) ||
      Number(right.exactTarget) - Number(left.exactTarget) ||
      Number(right.viable) - Number(left.viable) ||
      right.projectedSatisfied - left.projectedSatisfied ||
      right.currentSatisfied - left.currentSatisfied ||
      left.order - right.order
    )
    .map(({ candidate }) => candidate);
}

function topLevelConditions(condition: Condition | undefined): Condition[] {
  if (!condition) return [];
  return "all" in condition ? condition.all : [condition];
}

function satisfiedConditions(
  conditions: Condition[],
  state: ComposedState,
): number {
  return conditions.filter((condition) => evaluateCondition(condition, state).ok).length;
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
    quality: summarizeReachPathQuality(inputs),
  };
}

function summarizeReachPathQuality(inputs: Input[]): ReachChoicePathQuality {
  const activities = inputs.flatMap((input) =>
    input.type === "doActivity" ? [input.id] : []
  );
  let best: ReachChoicePathQuality["navigationCycle"];
  for (let start = 0; start + 1 < activities.length; start += 1) {
    const left = activities[start]!;
    const right = activities[start + 1]!;
    if (
      left === right ||
      !left.startsWith("move:") ||
      !right.startsWith("move:")
    ) continue;
    let end = start + 2;
    while (
      end < activities.length &&
      activities[end] === ((end - start) % 2 === 0 ? left : right)
    ) {
      end += 1;
    }
    const repetitions = Math.floor((end - start) / 2);
    if (repetitions < 6 || (best && best.repetitions >= repetitions)) continue;
    best = {
      activityIds: [left, right],
      repetitions,
      activityStart: start + 1,
      activityEnd: start + repetitions * 2,
    };
  }
  return best
    ? { status: "churn", navigationCycle: best }
    : { status: "clean" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function materializeReachChoicePath(
  args: ReachChoiceArgs,
  game: Awaited<ReturnType<typeof loadGame>>,
  sourceSession: string,
  source: ForkSource,
  inputs: Input[],
): Promise<{
  fork: Awaited<ReturnType<typeof createForkFromSourceWithLockHeld>>;
  replay: { output: Output | null; state: ComposedState };
  logEntry: number;
}> {
  return withSessionLock(args.gameDir, args.session, async () => {
    const fork = await createForkFromSourceWithLockHeld({
      gameDir: args.gameDir,
      from: sourceSession,
      to: args.session,
      at: source.selectedEntry,
      pretty: false,
    }, source);
    let state = await loadSession(args.gameDir, args.session, game);
    let current = await peek(game, state);
    state = current.state;
    for (const input of inputs) {
      const before = current.output;
      current = await step(game, state, input);
      state = current.state;
      await saveSession(args.gameDir, args.session, state);
      const decision = choiceDecisionContext(before, input);
      const activityDecision = activityDecisionContext(before, input);
      await appendLog(args.gameDir, args.session, {
        t: Date.now(),
        source: "reach-choice",
        input,
        output: current.output,
        ...(decision ? { decision } : {}),
        ...(activityDecision ? { activityDecision } : {}),
      }, state);
    }
    if (inputs.length === 0 && current.output !== null) {
      await saveSession(args.gameDir, args.session, state);
      await appendLog(args.gameDir, args.session, {
        t: Date.now(),
        source: "reach-choice:checkpoint",
        output: current.output,
      }, state);
    }
    return {
      fork,
      replay: { output: current.output, state },
      logEntry: 1 + Math.max(1, inputs.length),
    };
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
