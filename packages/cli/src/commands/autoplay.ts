import {
  createInitialState,
  emptyVisualState,
  runLoop,
} from "@rpg-harness/engine";
import type {
  BehaviorCycleDiagnostic,
  LoopReason,
  Output,
  StallDiagnostic,
  TraceEntry,
  VisualState,
  ComposedState,
  Game,
} from "@rpg-harness/engine";
import {
  buildHubView,
  formatActivityForecast,
  formatHubCalendar,
} from "@rpg-harness/frontend-core";
import { access } from "node:fs/promises";
import { createHash, randomInt } from "node:crypto";
import path from "node:path";
import { normalizeAuthoringSource } from "../authoring-source";
import { loadGame } from "../loader";
import { diffVisualLines } from "../presenters/visualSummary";
import { collectAiPersonas } from "../test/personas";
import { appendLog, loadSession, saveSession, sessionDir } from "../session";
import { withSessionLock } from "@rpg-harness/session-store";
import {
  createForkFromSource,
  createForkFromSourceWithLockHeld,
  loadForkSource,
  readSessionLog,
  type ForkSource,
} from "./fork";
import {
  capturePlaytestEvidenceSnapshot,
  recordPlaytestReport,
  type PlaytestEvidenceSnapshot,
  type PlaytestReport,
  type PlaytestSourceTarget,
} from "../playtest-reports";
import {
  collectChoiceCoverage,
  type ChoiceCoverageReport,
  type ChoiceCoverageWorkItem,
} from "./choice-coverage";

export interface AutoplayArgs {
  gameDir: string;
  persona: string;
  verbose: boolean;
  maxSteps: number;
  seed?: number;
  session?: string;
  fromSession?: string;
  fromLogEntry?: number;
  reportOnStop?: boolean;
  pretty?: boolean;
  /** CLI-only escape hatch for the full state, decision trace, and branch evidence. */
  full?: boolean;
  // Internal orchestration input for callers that already froze an exact
  // source. The target fork is created inside the same lock as the run.
  preparedForkSource?: {
    fromSession: string;
    source: ForkSource;
  };
  /** Internal resume fence checked under the target transaction lock. */
  expectedInitialStateRevision?: string;
  // Internal execution target used by `rpgh cover`. The first decision is
  // only submitted after the recoverable checkpoint still presents this
  // exact stable choice and option; option array indexes may safely change.
  targetChoice?: TargetChoice;
  // Internal local-verification boundary used by `rpgh cover`: stop after
  // the selected option's containing script has completed.
  stopAfterTargetScript?: boolean;
}

export interface TargetChoice {
  key: string;
  scriptId: string;
  choiceId: string;
  optionId: string;
  optionText: string;
}

export interface TargetChoiceResult extends TargetChoice {
  status: "selected" | "not-selected";
  index?: number;
}

export interface AutoplaySummary {
  reason: LoopReason;
  /** Exact registered policy used for this run. */
  persona: string;
  /** Shared fresh-world and persona seed, or the persona seed for a resumed save. */
  seed: number;
  error?: string;
  stall?: StallDiagnostic;
  behaviorCycle?: BehaviorCycleDiagnostic;
  progress: AutoplayProgress;
  decisionPath: AutoplayDecisionPath;
  decisions: number;
  rejectedInputs: number;
  steps: number;
  finalState: Awaited<ReturnType<typeof runLoop>>["finalState"];
  ending: string | null;
  session?: string;
  webPath?: string;
  fork?: Awaited<ReturnType<typeof createForkFromSource>>;
  report?: PlaytestReport;
  continuation?: AutoplayContinuation;
  choiceCoverage?: {
    summary: ChoiceCoverageReport["summary"];
    pendingBranches: ChoiceCoverageWorkItem[];
  };
  targetChoice?: TargetChoiceResult;
}

export type AutoplayCommandSummary = Omit<
  AutoplaySummary,
  "progress" | "decisionPath" | "finalState" | "report" | "choiceCoverage"
> & {
  progress: {
    madeProgress: boolean;
    completedScripts: { count: number; recent: string[] };
    objectiveChanges: {
      count: number;
      recent: AutoplayProgress["objectiveChanges"];
    };
    scriptProgress?: NonNullable<AutoplayProgress["scriptProgress"]>;
  };
  /** Stable identity for the full semantic trace without embedding every decision. */
  decisionPath: { revision: string };
  /** Stable identity for the terminal save; inspect the persisted session for details. */
  finalStateRevision: string;
  choiceCoverage?: {
    summary: ChoiceCoverageReport["summary"];
    pendingBranches: number;
    next: {
      command: "worklist";
      args: { session: string };
    };
  };
  report?: Pick<
    PlaytestReport,
    "id" | "status" | "session" | "area" | "severity" | "title" | "target"
  > & {
    next: {
      command: "inspect-report";
      args: { id: string; session: string };
    };
  };
};

export interface AutoplayContinuation {
  kind: "budget-exhausted";
  session: string;
  webPath: string;
  next: {
    command: "autoplay";
    args: {
      persona: string;
      maxSteps: number;
      seed: number;
      session: string;
      reportOnStop: boolean;
    };
  };
}

export type AutoplaySemanticDecision =
  | { type: "choose"; scriptId: string; choiceId: string; optionId: string }
  | { type: "select"; scriptId: string }
  | {
      type: "doActivity";
      id: string;
      actionKind?: string;
      aiTags?: string[];
      /** Active public objectives that explicitly offered this activity. */
      linkedObjectiveIds?: string[];
    };

export interface AutoplayDecisionPath {
  revision: string;
  decisions: AutoplaySemanticDecision[];
}

export interface AutoplayProgress {
  madeProgress: boolean;
  completedScripts: string[];
  objectiveChanges: Array<{
    objectiveId: string;
    requirementId: string;
    from: string | number | boolean;
    to: string | number | boolean;
  }>;
  scriptProgress?: {
    from: string | null;
    to: string | null;
    beatIndexFrom: number;
    beatIndexTo: number;
  };
}

export async function autoplayCommand(args: AutoplayArgs): Promise<void> {
  const summary = await runAutoplay(args, {
    writeTelemetry: (text) => {
      process.stderr.write(text);
    },
  });
  const output = args.full ? summary : compactAutoplaySummary(summary);
  process.stdout.write(
    (args.pretty ? JSON.stringify(output, null, 2) : JSON.stringify(output)) +
      "\n",
  );
}

/**
 * Keep the default agent-facing result bounded even for thousand-decision runs.
 * The complete trace/state remains available through `--full`; persisted runs
 * additionally expose their exact save through the shared session id and turn
 * unexplored choices into the normal executable worklist.
 */
export function compactAutoplaySummary(
  summary: AutoplaySummary,
): AutoplayCommandSummary {
  const {
    progress,
    decisionPath,
    finalState,
    report,
    choiceCoverage,
    ...rest
  } = summary;
  const recentLimit = 10;
  return {
    ...rest,
    progress: {
      madeProgress: progress.madeProgress,
      completedScripts: {
        count: progress.completedScripts.length,
        recent: progress.completedScripts.slice(-recentLimit),
      },
      objectiveChanges: {
        count: progress.objectiveChanges.length,
        recent: progress.objectiveChanges.slice(-recentLimit),
      },
      ...(progress.scriptProgress
        ? { scriptProgress: progress.scriptProgress }
        : {}),
    },
    decisionPath: { revision: decisionPath.revision },
    finalStateRevision: createHash("sha256")
      .update(JSON.stringify(finalState))
      .digest("hex"),
    ...(choiceCoverage && summary.session
      ? {
          choiceCoverage: {
            summary: choiceCoverage.summary,
            pendingBranches: choiceCoverage.pendingBranches.length,
            next: {
              command: "worklist" as const,
              args: { session: summary.session },
            },
          },
        }
      : {}),
    ...(report
      ? {
          report: {
            id: report.id,
            status: report.status,
            session: report.session,
            area: report.area,
            severity: report.severity,
            title: report.title,
            ...(report.target ? { target: report.target } : {}),
            next: {
              command: "inspect-report" as const,
              args: { id: report.id, session: report.session },
            },
          },
        }
      : {}),
  };
}

interface RunAutoplayInternalHooks {
  /** Deterministic test seam at the otherwise-racy boundary between transactions. */
  afterSessionTransaction?: () => Promise<void>;
  /** Runs after fork initialization while the same target transaction remains held. */
  afterForkInitializedWhileLocked?: () => void | Promise<void>;
  /** Presentation sink. Library callers are silent unless they opt in. */
  writeTelemetry?: (text: string) => void;
}

export async function runAutoplay(
  args: AutoplayArgs,
  internalHooks: RunAutoplayInternalHooks = {},
): Promise<AutoplaySummary> {
  const writeTelemetry = internalHooks.writeTelemetry ?? (() => {});
  if (!Number.isInteger(args.maxSteps) || args.maxSteps < 0) {
    throw new Error("--max-steps must be a non-negative integer");
  }
  if (
    args.seed !== undefined &&
    (!Number.isInteger(args.seed) || args.seed < 0 || args.seed > 0xffff_ffff)
  ) {
    throw new Error("--seed must be a uint32 integer");
  }
  if (args.fromSession && !args.session) {
    throw new Error("--from-session requires --session for the AI branch");
  }
  if (args.preparedForkSource && !args.session) {
    throw new Error("A prepared fork source requires a persisted --session");
  }
  if (
    args.preparedForkSource &&
    (args.fromSession || args.fromLogEntry !== undefined)
  ) {
    throw new Error(
      "A prepared fork source cannot be combined with --from-session or --from-at",
    );
  }
  if (
    args.preparedForkSource &&
    args.preparedForkSource.fromSession === args.session
  ) {
    throw new Error(
      "Prepared fork source and autoplay target sessions must differ",
    );
  }
  if (args.fromLogEntry !== undefined && !args.fromSession) {
    throw new Error("--from-at requires --from-session");
  }
  if (
    args.fromLogEntry !== undefined &&
    (!Number.isInteger(args.fromLogEntry) || args.fromLogEntry < 0)
  ) {
    throw new Error("--from-at must be a non-negative integer");
  }
  if (args.reportOnStop && !args.session) {
    throw new Error("--report-on-stop requires a persisted --session");
  }
  const game = await loadGame(args.gameDir);
  const personaRegistry = collectAiPersonas(game);
  const personaDefinition = personaRegistry[args.persona];
  if (!personaDefinition) {
    const available = Object.entries(personaRegistry)
      .map(([name, entry]) => `  ${name.padEnd(10)} — ${entry.description}`)
      .join("\n");
    throw new Error(
      `Unknown persona: ${args.persona}\n\nAvailable personas:\n${available}`,
    );
  }
  const persona = personaDefinition.decide;
  // Every run needs one public causal seed. On a fresh save it seeds both
  // world/module initialization and the independent persona stream; on a
  // resumed save the persisted world cursor wins and it seeds the persona.
  // This makes ordinary successful exploration reproducible too, rather than
  // preserving determinism only after a run has already become an incident.
  const effectiveSeed = args.seed ?? randomInt(0, 0x1_0000_0000);

  let fork: Awaited<ReturnType<typeof createForkFromSource>> | undefined;
  let preparedForkSource = args.preparedForkSource;
  if (args.fromSession && args.session) {
    try {
      await access(path.join(sessionDir(args.gameDir, args.fromSession), "state.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Source session does not exist: ${args.fromSession}`);
      }
      throw error;
    }
    preparedForkSource = {
      fromSession: args.fromSession,
      source: await loadForkSource(
        args.gameDir,
        args.fromSession,
        args.fromLogEntry,
      ),
    };
  }
  // Persona sampling is deliberately separate from the engine's persisted
  // RNG. A fresh state may consume randomness while it initializes, whereas a
  // checkpoint replay does not; sharing global Math.random made the same seed
  // choose a different first move on causal replay (and let concurrent lanes
  // overwrite one another's stream).
  const personaRng = createPersonaRng(effectiveSeed);

  writeTelemetry(
    `\n=== autoplay: ${game.title} (persona: ${args.persona}) ===\n\n`,
  );

  const assetMap = new Map((game.assets ?? []).map((a) => [a.path, a]));
  // Closure-tracked previous visual state so we only emit framing
  // lines on *changes* — without this every dialogue/narration that
  // carries an unchanged visualState would re-print the same banner.
  let prevVisuals: VisualState = emptyVisualState();
  let targetChoiceResult: TargetChoiceResult | undefined = args.targetChoice
    ? { ...args.targetChoice, status: "not-selected" }
    : undefined;
  let awaitingTarget = args.targetChoice !== undefined;
  let targetSelected = false;

  const targetedPersona = async (
    output: Output,
    state: Parameters<typeof persona>[1],
    step: number,
  ) => {
    if (!awaitingTarget) {
      return persona(output, state, step, { rng: personaRng.next });
    }
    if (output.type !== "choice") {
      throw new Error(
        `Choice coverage checkpoint mismatch: expected ${args.targetChoice!.scriptId}/${args.targetChoice!.choiceId}, got ${output.type}`,
      );
    }
    if (
      output.scriptId !== args.targetChoice!.scriptId ||
      output.choiceId !== args.targetChoice!.choiceId
    ) {
      throw new Error(
        `Choice coverage checkpoint mismatch: expected ${args.targetChoice!.scriptId}/${args.targetChoice!.choiceId}, got ${output.scriptId ?? "<legacy>"}/${output.choiceId ?? "<legacy>"}`,
      );
    }
    const index = output.options.findIndex(
      (option) => option.id === args.targetChoice!.optionId,
    );
    if (index < 0) {
      throw new Error(
        `Choice coverage option is stale: ${args.targetChoice!.optionId} no longer exists on ${args.targetChoice!.key}`,
      );
    }
    if (!output.options[index]!.available) {
      throw new Error(
        `Choice coverage option is now locked: ${args.targetChoice!.optionId} on ${args.targetChoice!.key}`,
      );
    }
    awaitingTarget = false;
    targetSelected = true;
    targetChoiceResult = {
      ...args.targetChoice!,
      status: "selected",
      index,
    };
    return {
      type: "choose" as const,
      choiceId: args.targetChoice!.choiceId,
      optionId: args.targetChoice!.optionId,
    };
  };

  let autoplayInitialState: Awaited<ReturnType<typeof loadSession>> | undefined;
  let autoplayReplayLogEntry: number | undefined;
  let incidentEvidence: PlaytestEvidenceSnapshot | undefined;
  const play = async () => {
    if (args.session && preparedForkSource) {
      fork = await createForkFromSourceWithLockHeld({
        gameDir: args.gameDir,
        from: preparedForkSource.fromSession,
        to: args.session,
        at: preparedForkSource.source.selectedEntry,
        pretty: false,
      }, preparedForkSource.source, {
        onCreatedWhileLocked: internalHooks.afterForkInitializedWhileLocked,
      });
    }
    autoplayReplayLogEntry = args.session
      ? (await readSessionLog(args.gameDir, args.session)).length
      : 0;
    const initialState = args.session
      ? await loadSession(
          args.gameDir,
          args.session,
          game,
          { seed: effectiveSeed },
        )
      : createInitialState(game, { seed: effectiveSeed });
    if (args.expectedInitialStateRevision !== undefined) {
      const actualRevision = createHash("sha256")
        .update(JSON.stringify(initialState))
        .digest("hex");
      if (actualRevision !== args.expectedInitialStateRevision) {
        throw new Error(
          `Autoplay resume ownership lost for ${args.session}: expected state ${args.expectedInitialStateRevision}, found ${actualRevision}`,
        );
      }
    }
    autoplayInitialState = initialState;
    const result = await runLoop(game, initialState, targetedPersona, {
      maxSteps: args.maxSteps,
      stallDetection: { repetitions: 3, maxCycleLength: 20 },
      onStep: async (entry, state) => {
        if (args.session && entry.input) {
          await saveSession(args.gameDir, args.session, state);
          await appendLog(args.gameDir, args.session, {
            t: Date.now(),
            source: `autoplay:${args.persona}`,
            input: entry.input,
            output: entry.output,
            ...(entry.inputResult ? { inputResult: entry.inputResult } : {}),
            ...(entry.decision ? { decision: entry.decision } : {}),
          }, state);
        }
        if (!args.verbose) return;
        const nextVisuals = entry.output.visualState;
        if (nextVisuals) {
          for (const line of diffVisualLines(
            prevVisuals,
            nextVisuals,
            assetMap,
          )) {
            writeTelemetry("  " + line + "\n");
          }
          // Snapshot: the engine mutates state.baseline.visuals
          // in place, so without a deep copy `prevVisuals` would
          // point to the same live object as `nextVisuals` and
          // future diffs would always be empty.
          prevVisuals = {
            bg: nextVisuals.bg,
            portraits: { ...nextVisuals.portraits },
            cg: nextVisuals.cg,
          };
        }
        const line = formatOutput(entry.output);
        if (line) writeTelemetry(line + "\n");
      },
      ...(args.stopAfterTargetScript && args.targetChoice
        ? {
            stopWhen: (_entry: unknown, state: ComposedState) =>
              targetSelected &&
              state.baseline.scripts[args.targetChoice!.scriptId]?.completed === true,
          }
        : {}),
    });
    // Persist the exact terminal state as well as each successful step. This
    // matters when a run stops between public outputs (max-steps) or an input
    // throws after mutating state: the issue checkpoint must capture the
    // actual stop site rather than the previous log entry's state.
    if (args.session) {
      await saveSession(args.gameDir, args.session, result.finalState);
      if (args.reportOnStop && isReportableAutoplayStop(result)) {
        // Freeze the incident before releasing the transaction. A GUI step can
        // legitimately win the next lock before issues.jsonl is appended; the
        // report must still describe this autoplay terminal state and log.
        incidentEvidence = await capturePlaytestEvidenceSnapshot(
          args.gameDir,
          args.session,
        );
      }
    }
    return result;
  };
  const result = args.session
    ? await withSessionLock(args.gameDir, args.session, play)
    : await play();
  if (args.session && internalHooks.afterSessionTransaction) {
    await internalHooks.afterSessionTransaction();
  }

  writeTelemetry(
    `\n=== done: ${result.reason} after ${countDecisions(result.trace)} decisions / ${countRejectedInputs(result.trace)} rejected inputs / ${result.trace.length} visible outputs ===\n`,
  );
  if (result.error) writeTelemetry(`error: ${result.error}\n`);

  const ending = detectTerminalScriptId(result);
  if (ending) writeTelemetry(`ending: ${ending}\n`);
  const progress = summarizeAutoplayProgress(
    autoplayInitialState,
    result.finalState,
    result.trace,
  );
  const decisionPath = summarizeDecisionPath(result.trace);
  const continuation: AutoplayContinuation | undefined =
    args.session && result.reason === "max-steps" && !result.behaviorCycle
      ? {
          kind: "budget-exhausted",
          session: args.session,
          webPath: `/?session=${encodeURIComponent(args.session)}`,
          next: {
            command: "autoplay",
            args: {
              persona: args.persona,
              // A zero-budget inspection still returns a continuation that can
              // actually advance when an orchestrator executes it verbatim.
              maxSteps: Math.max(1, args.maxSteps),
              seed: personaRng.state(),
              session: args.session,
              reportOnStop: args.reportOnStop ?? false,
            },
          },
        }
      : undefined;

  let report: PlaytestReport | undefined;
  if (args.reportOnStop && args.session && isReportableAutoplayStop(result)) {
    if (
      !autoplayInitialState ||
      autoplayReplayLogEntry === undefined ||
      !incidentEvidence
    ) {
      throw new Error("Autoplay report is missing transaction-frozen evidence");
    }
    const sourceTargets = collectAutoplaySourceTargets(
      args.gameDir,
      game,
      result.trace,
      result.stall ?? result.behaviorCycle,
      result.finalState.baseline.currentScriptId,
    );
    const terminalScriptTarget = sourceTargets.find((target) =>
      target.kind === "script" &&
      target.scriptId === result.finalState.baseline.currentScriptId
    );
    const primaryTarget = terminalScriptTarget?.file ??
      sourceTargets.at(-1)?.file;
    report = await recordPlaytestReport({
      gameDir: args.gameDir,
      session: args.session,
      area: "tooling",
      severity: result.reason === "error" ? "blocker" : "major",
      title: result.reason === "completed"
          ? `Autoplay ${args.persona} completed without a public gameEnd`
          : `Autoplay ${args.persona} stopped before game end (${result.reason})`,
      ...(primaryTarget ? { target: primaryTarget } : {}),
      ...(sourceTargets.length > 0 ? { sourceTargets } : {}),
      details: [
        `Built-in persona \`${args.persona}\` stopped after ${countDecisions(result.trace)} decisions, ${countRejectedInputs(result.trace)} rejected inputs, and ${result.trace.length} visible outputs.`,
        `Reason: \`${result.reason}\`.`,
        `Replay seed: \`${effectiveSeed}\`.`,
        ...(result.reason === "completed"
          ? ["The runner returned without a public gameEnd output."]
          : []),
        ...(progress.madeProgress
          ? [`Progress made: ${formatAutoplayProgress(progress)}.`]
          : ["No authored script or public objective progress was observed during this run."]),
        ...(result.stall
          ? [
              `Detected an exact ${result.stall.cycleLength}-output cycle repeated ${result.stall.repetitions} times across trace indexes ${result.stall.firstTraceIndex}–${result.stall.lastTraceIndex}: ${formatStallCycle(result.stall)}.`,
            ]
          : []),
        ...(result.behaviorCycle
          ? [
              `The final budget window contains a repeated ${result.behaviorCycle.cycleLength}-output behavior cycle (${formatStallCycle(result.behaviorCycle)}) while only these state paths kept changing: ${result.behaviorCycle.changingStatePaths.join(", ")}.`,
            ]
          : []),
        ...(result.error ? [`Engine error: ${result.error}`] : []),
        ...(fork
          ? [
              `AI branch \`${args.session}\` was forked from player session \`${fork.fromSession}\` at source log entry ${fork.sourceLogEntry}.`,
            ]
          : []),
        "Reproduce from the attached immutable checkpoint, then convert the stop into a fixture or repair the persona/objective contract.",
      ].join(" "),
      ...(result.stall ? { stall: result.stall } : {}),
      ...(result.behaviorCycle ? { behaviorCycle: result.behaviorCycle } : {}),
      evidenceSnapshot: incidentEvidence,
      autoplay: {
        replayState: autoplayInitialState,
        replayLogEntry: autoplayReplayLogEntry,
        persona: args.persona,
        maxSteps: args.maxSteps,
        seed: effectiveSeed,
        stopReason: result.reason,
        decisions: countDecisions(result.trace),
        rejectedInputs: countRejectedInputs(result.trace),
        steps: result.trace.length,
        decisionPathRevision: decisionPath.revision,
        ...(fork
          ? {
              sourceSession: fork.fromSession,
              sourceLogEntry: fork.sourceLogEntry,
            }
          : {}),
      },
    });
  }

  const choiceCoverage = args.session
    ? await collectChoiceCoverage(args.gameDir, args.session)
    : undefined;

  return {
    reason: result.reason,
    persona: args.persona,
    seed: effectiveSeed,
    ...(result.error ? { error: result.error } : {}),
    ...(result.stall ? { stall: result.stall } : {}),
    ...(result.behaviorCycle ? { behaviorCycle: result.behaviorCycle } : {}),
    progress,
    decisionPath,
    decisions: countDecisions(result.trace),
    rejectedInputs: countRejectedInputs(result.trace),
    steps: result.trace.length,
    finalState: result.finalState,
    ending,
    ...(args.session
      ? {
          session: args.session,
          webPath: `/?session=${encodeURIComponent(args.session)}`,
        }
      : {}),
    ...(fork ? { fork } : {}),
    ...(report ? { report } : {}),
    ...(continuation ? { continuation } : {}),
    ...(choiceCoverage
      ? {
          choiceCoverage: {
            summary: choiceCoverage.summary,
            pendingBranches: choiceCoverage.workItems,
          },
        }
      : {}),
    ...(targetChoiceResult ? { targetChoice: targetChoiceResult } : {}),
  };
}

function isReportableAutoplayStop(result: {
  reason: LoopReason;
  done: boolean;
  trace: ReadonlyArray<{ output: Output }>;
  behaviorCycle?: BehaviorCycleDiagnostic;
}): boolean {
  if (detectTerminalScriptId(result) !== null) return false;
  return result.reason !== "max-steps" || result.behaviorCycle !== undefined;
}

export function collectAutoplaySourceTargets(
  gameDir: string,
  game: Game,
  trace: ReadonlyArray<TraceEntry>,
  diagnostic?: Pick<StallDiagnostic, "firstTraceIndex" | "lastTraceIndex">,
  terminalScriptId?: string | null,
): PlaytestSourceTarget[] {
  const firstIndex = diagnostic?.firstTraceIndex ?? Math.max(0, trace.length - 20);
  const lastIndex = diagnostic?.lastTraceIndex ?? trace.length - 1;
  const targets: PlaytestSourceTarget[] = [];

  const addScript = (
    scriptId: string | undefined,
    details: Pick<PlaytestSourceTarget, "scriptRevision" | "choiceId"> = {},
  ) => {
    if (!scriptId) return;
    const script = game.scripts.find(({ id }) => id === scriptId);
    if (!script?.source) return;
    targets.push({
      kind: "script",
      file: normalizeAuthoringSource(gameDir, script.source),
      scriptId,
      ...details,
    });
  };

  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const entry = trace[index];
    if (!entry || entry.inputResult?.accepted === false) continue;
    const previousOutput = index > 0 ? trace[index - 1]?.output : undefined;
    if (entry.decision) {
      const choice = previousOutput?.type === "choice" ? previousOutput : undefined;
      addScript(entry.decision.scriptId, {
        ...(choice?.scriptRevision
          ? { scriptRevision: choice.scriptRevision }
          : {}),
        choiceId: entry.decision.choiceId,
      });
      continue;
    }
    if (entry.input?.type === "select") {
      addScript(entry.input.scriptId);
      continue;
    }
    if (entry.input?.type !== "doActivity") continue;
    const activityId = entry.input.id;
    const hub = previousOutput?.type === "hubMenu"
      ? previousOutput
      : entry.output.type === "hubMenu"
        ? entry.output
        : undefined;
    const activity = hub?.snapshot.activities.find(
      ({ id }) => id === activityId,
    );
    if (!activity) continue;
    if (activity.kind === "script") {
      addScript(activity.id);
      continue;
    }
    const actionKind = activity.actionKind ?? game.actions?.find(
      ({ id }) => id === activity.id,
    )?.kind;
    if (!actionKind) continue;
    const owner = actionOwner(game, actionKind);
    if (!owner?.source) continue;
    targets.push({
      kind: "module-action",
      file: normalizeAuthoringSource(gameDir, owner.source),
      moduleId: owner.id,
      actionKind,
      activityId: activity.id,
    });
  }
  addScript(terminalScriptId ?? undefined);

  const unique = new Map<string, PlaytestSourceTarget>();
  for (const target of targets) {
    const key = JSON.stringify(target);
    // Refresh duplicates so the final entry remains the most recent causal
    // contract and can serve as the report's primary coding target.
    unique.delete(key);
    unique.set(key, target);
  }
  return [...unique.values()];
}

function actionOwner(game: Game, actionKind: string) {
  const separator = actionKind.indexOf(":");
  if (separator > 0) {
    const moduleId = actionKind.slice(0, separator);
    const kind = actionKind.slice(separator + 1);
    return game.modules?.find((mod) =>
      mod.id === moduleId && Object.hasOwn(mod.actionHandlers ?? {}, kind)
    );
  }
  const owners = (game.modules ?? []).filter((mod) =>
    Object.hasOwn(mod.actionHandlers ?? {}, actionKind)
  );
  return owners.length === 1 ? owners[0] : undefined;
}

export function summarizeDecisionPath(
  trace: ReadonlyArray<Pick<TraceEntry, "input" | "decision" | "inputResult"> &
    Partial<Pick<TraceEntry, "output">>>,
): AutoplayDecisionPath {
  const decisions: AutoplaySemanticDecision[] = [];
  let previousOutput: Output | undefined;
  for (const entry of trace) {
    if (entry.inputResult?.accepted !== false) {
      if (entry.decision) {
        decisions.push({ type: "choose", ...entry.decision });
      } else if (entry.input?.type === "select") {
        decisions.push({ type: "select", scriptId: entry.input.scriptId });
      } else if (entry.input?.type === "doActivity") {
        // Trace entries pair an input with the output produced *after* it.
        // The selected activity contract therefore lives on the preceding
        // hub output. The same-entry fallback keeps this utility convenient
        // for callers that provide compact synthetic traces.
        const activitySource = previousOutput?.type === "hubMenu"
          ? previousOutput
          : entry.output?.type === "hubMenu"
            ? entry.output
            : undefined;
        const activityId = entry.input.id;
        const activity = activitySource?.snapshot.activities.find(
          ({ id }) => id === activityId,
        );
        const linkedObjectiveIds = activitySource?.snapshot.objectives
          ?.filter((objective) =>
            objective.status === "active" &&
            objective.relatedActivityIds?.includes(activityId)
          )
          .map((objective) => objective.id)
          .sort();
        decisions.push({
          type: "doActivity",
          id: activityId,
          ...(activity?.actionKind ? { actionKind: activity.actionKind } : {}),
          ...(activity?.aiTags?.length ? { aiTags: [...activity.aiTags] } : {}),
          ...(linkedObjectiveIds?.length ? { linkedObjectiveIds } : {}),
        });
      }
    }
    if (entry.output) previousOutput = entry.output;
  }
  return {
    revision: createHash("sha256").update(JSON.stringify(decisions)).digest("hex"),
    decisions,
  };
}

export function summarizeAutoplayProgress(
  initialState: Awaited<ReturnType<typeof loadSession>> | undefined,
  finalState: Awaited<ReturnType<typeof runLoop>>["finalState"],
  trace: Awaited<ReturnType<typeof runLoop>>["trace"],
): AutoplayProgress {
  const initialOrder = initialState?.baseline.completionOrder ?? [];
  const initialCompleted = new Set(initialOrder);
  const completedScripts = finalState.baseline.completionOrder.filter(
    (scriptId) => !initialCompleted.has(scriptId),
  );
  const firstRequirements = new Map<string, string | number | boolean>();
  const lastRequirements = new Map<string, string | number | boolean>();
  for (const entry of trace) {
    if (entry.output.type !== "hubMenu") continue;
    for (const objective of entry.output.snapshot.objectives ?? []) {
      for (const requirement of objective.requirements ?? []) {
        const key = `${objective.id}\u0000${requirement.id}`;
        if (!firstRequirements.has(key)) firstRequirements.set(key, requirement.current);
        lastRequirements.set(key, requirement.current);
      }
    }
  }
  const objectiveChanges = [...firstRequirements.entries()].flatMap(([key, from]) => {
    const to = lastRequirements.get(key);
    if (to === undefined || Object.is(from, to)) return [];
    const [objectiveId, requirementId] = key.split("\u0000");
    return [{ objectiveId: objectiveId!, requirementId: requirementId!, from, to }];
  });
  const scriptFrom = initialState?.baseline.currentScriptId ?? null;
  const scriptTo = finalState.baseline.currentScriptId;
  const beatIndexFrom = initialState?.baseline.beatIndex ?? 0;
  const beatIndexTo = finalState.baseline.beatIndex;
  const scriptAdvanced = scriptTo !== null && (
    scriptTo !== scriptFrom || beatIndexTo !== beatIndexFrom
  );
  return {
    madeProgress: completedScripts.length > 0 || objectiveChanges.length > 0 || scriptAdvanced,
    completedScripts,
    objectiveChanges,
    ...(scriptAdvanced
      ? { scriptProgress: { from: scriptFrom, to: scriptTo, beatIndexFrom, beatIndexTo } }
      : {}),
  };
}

function formatAutoplayProgress(progress: AutoplayProgress): string {
  const parts: string[] = [];
  if (progress.completedScripts.length > 0) {
    parts.push(`completed scripts [${progress.completedScripts.join(", ")}]`);
  }
  if (progress.objectiveChanges.length > 0) {
    parts.push(`objective changes [${progress.objectiveChanges.map((change) =>
      `${change.objectiveId}/${change.requirementId}:${String(change.from)}→${String(change.to)}`
    ).join(", ")}]`);
  }
  if (progress.scriptProgress) {
    parts.push(`script ${progress.scriptProgress.from ?? "hub"}@${progress.scriptProgress.beatIndexFrom}→${progress.scriptProgress.to}@${progress.scriptProgress.beatIndexTo}`);
  }
  return parts.join("; ") || "none";
}

function formatStallCycle(stall: StallDiagnostic): string {
  return stall.cycle.map((step) => {
    const input = step.input?.type === "doActivity"
      ? `doActivity:${step.input.id}`
      : step.input?.type ?? "initial";
    return `${input} -> ${step.output}`;
  }).join(" | ");
}

function countDecisions(trace: Array<{ input: unknown | null }>): number {
  return trace.reduce((count, entry) => count + (entry.input === null ? 0 : 1), 0);
}

function countRejectedInputs(
  trace: Array<{ inputResult?: { accepted: boolean } }>,
): number {
  return trace.reduce(
    (count, entry) => count + (entry.inputResult?.accepted === false ? 1 : 0),
    0,
  );
}

export function detectTerminalScriptId(result: {
  done: boolean;
  trace: ReadonlyArray<{ output: Output }>;
}): string | null {
  if (!result.done) return null;
  const output = result.trace.at(-1)?.output;
  if (output?.type !== "gameEnd") return null;
  const ending = output.endingId;
  return typeof ending === "string" && ending.trim() ? ending : "game-end";
}

function createPersonaRng(seed: number): {
  next: () => number;
  state: () => number;
} {
  let state = seed;
  return {
    next: () => {
      state = (state * 9301 + 49297) % 233280;
      return state / 233280;
    },
    state: () => state,
  };
}

function formatOutput(o: Output): string | null {
  switch (o.type) {
    case "narration":
      return `  ${o.text}`;
    case "dialogue":
      return `  ${o.speakerName}: 「${o.text}」`;
    case "choice":
      return (
        `  ? ${o.prompt ?? ""}\n` +
        o.options
          .map(
            (opt, i) =>
              `    ${i + 1}. ${opt.text}${
                opt.available ? "" : "  (locked)"
              }`,
          )
          .join("\n")
      );
    case "scriptComplete":
      return `  ─── ${o.completedId ?? "(start)"} ─── next: ${
        o.nextAvailable.map((s) => s.id).join(", ") || "(none)"
      }`;
    case "hubMenu": {
      const s = o.snapshot;
      const view = buildHubView(s);
      const opportunityByCategory = new Map(
        view.opportunityGroups.map((group) => [group.category, group]),
      );
      const calendar = formatHubCalendar(s);
      const stats = s.stats.map((st) => `${st.name}:${st.value}`).join(" ");
      const resources = (s.resourceGroups ?? [])
        .map(
          (group) =>
            `  {${group.title}: ${group.resources
              .map((resource) => `${resource.name}×${resource.quantity}`)
              .join("、")}}`,
        )
        .join("\n");
      let index = 0;
      const sections = view.sections
        .map((section) => {
          const acts = section.activities
            .map(({ activity }) => {
              index += 1;
              const primary =
                activity.id === view.primaryActivityId ? " ★" : "";
              const forecast = formatActivityForecast(activity);
              return `${index}. ${activity.title}${primary}${
                activity.available ? "" : " (locked)"
              }${forecast ? ` [${forecast}]` : ""}`;
            })
            .join("  ");
          return `    [${section.category} ${section.availableCount}/${
            section.activities.length
          }${
            opportunityByCategory.get(section.category)?.decisionRequired
              ? " choice"
              : ""
          }] ${acts}`;
        })
        .join("\n");
      return `  ${calendar ? `[${calendar}]  ` : ""}${stats}${
        resources ? `\n${resources}` : ""
      }${
        view.strategyDecisionRequired
          ? `\n  [strategy ${view.opportunityGroups.length} paths]`
          : ""
      }\n${sections}`;
    }
    case "gameEnd":
      return `  ═══ GAME END ═══${o.reason ? ` (${o.reason})` : ""}`;
    case "clear":
      return `  ─── scene ───`;
  }
}
