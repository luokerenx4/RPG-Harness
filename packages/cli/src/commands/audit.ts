import { access } from "node:fs/promises";
import { createHash, randomInt } from "node:crypto";
import path from "node:path";
import { assertSessionName, withSessionLock } from "@rpg-harness/session-store";
import { createInitialState, type AiAuditConfig } from "@rpg-harness/engine";
import { saveSession, sessionDir } from "../session";
import { loadGame } from "../loader";
import {
  capturePlaytestEvidenceSnapshot,
  recordPlaytestReport,
  type PlaytestEvidenceSnapshot,
  type PlaytestReport,
} from "../playtest-reports";
import { collectAiPersonas } from "../test/personas";
import {
  assertTargetEmpty,
  createForkFromSource,
  loadForkSource,
  type ForkSource,
} from "./fork";
import {
  runAutoplay,
  type AutoplaySemanticDecision,
  type AutoplayProgress,
  type AutoplaySummary,
} from "./autoplay";

export const DEFAULT_AUDIT_PERSONAS = [
  "objective",
  "greedy",
  "charmer",
  "rude",
  "hunter",
] as const;

export interface AuditArgs {
  gameDir: string;
  /** Existing GUI/TUI lineage to freeze. Omit to audit a seeded fresh game. */
  fromSession?: string;
  fromLogEntry?: number;
  sessionPrefix: string;
  personas: string[];
  /** Maximum resumable autoplay budget slices consumed by each persona lane. */
  maxSegments?: number;
  maxSteps: number;
  seed?: number;
  reportOnStop: boolean;
  /** Internal verification mode: retain a failed result without duplicating its issue. */
  reportOnQualityFailure?: boolean;
  /** Internal verification mode: never accept a gate weaker than this policy. */
  qualityFloor?: AiAuditConfig;
  pretty: boolean;
}

export interface AuditLaneSummary {
  persona: string;
  session: string;
  webPath: string;
  reason: AutoplaySummary["reason"];
  /** Number of bounded autoplay slices consumed by this lane. */
  segments: number;
  decisions: number;
  steps: number;
  rejectedInputs: number;
  ending: string | null;
  progress: AutoplayProgress;
  path: {
    revision: string;
    semanticDecisions: number;
    choices: number;
    activityTags: string[];
    semanticActivityCounts: Record<string, number>;
    /** Public objective ids observed linking each executed semantic activity. */
    semanticActivityObjectives: Record<string, string[]>;
  };
  stall?: AutoplaySummary["stall"];
  behaviorCycle?: AutoplaySummary["behaviorCycle"];
  report?: {
    id: string;
    severity: string;
    title: string;
  };
}

export interface AuditSummary {
  source: {
    session: string;
    at: number;
    entries: number;
    mode: "checkpoint" | "initial-state" | "current-state";
    stateRevision: string;
  };
  sessionPrefix: string;
  /** Seed shared by fresh-game PRNG initialization and the persona matrix. */
  seed: number;
  maxSegments: number;
  maxSteps: number;
  lanes: AuditLaneSummary[];
  totals: {
    lanes: number;
    segments: number;
    completed: number;
    stalled: number;
    behaviorCycles: number;
    budgetCheckpoints: number;
    errors: number;
    rejectedInputs: number;
    openReports: number;
  };
  endings: Record<string, number>;
  activityCoverage: {
    coveredTags: string[];
    byPersona: Record<string, string[]>;
  };
  scriptCoverage: {
    completedScripts: string[];
    byPersona: Record<string, string[]>;
  };
  diversity: {
    classification:
      | "identical-path"
      | "convergent-paths"
      | "divergent-endings"
      | "incomplete";
    uniqueEndings: number;
    uniqueDecisionPaths: number;
    choiceDivergences: Array<{
      scriptId: string;
      choiceId: string;
      selections: Array<{ optionId: string; personas: string[] }>;
      notReachedBy: string[];
    }>;
  };
  qualityGate?: {
    policy: AiAuditConfig;
    status: "passed" | "failed" | "not-evaluated";
    observed: {
      uniqueEndings: number;
      uniqueDecisionPaths: number;
      coveredActivityTags?: string[];
      completedScripts?: string[];
      maxActivityRepetition?: {
        persona: string;
        activityKind: string;
        count: number;
        limit: number;
        objectiveIds?: string[];
      };
    };
    violations: string[];
    evidenceSession?: string;
    report?: {
      id: string;
      severity: string;
      title: string;
    };
  };
}

export interface AuditHooks {
  // A narrow lifecycle seam for concurrency regression tests and embedding.
  // Production CLI callers do not need it.
  onLaneComplete?: (lane: AuditLaneSummary, index: number) => void | Promise<void>;
  /** Runs after one bounded lane slice unlocks and before an optional resume. */
  onLaneSegmentComplete?: (
    persona: string,
    session: string,
    segment: number,
    summary: AutoplaySummary,
  ) => void | Promise<void>;
  /** Runs after the quality-evidence fork unlocks but before its report is recorded. */
  onQualityEvidenceForked?: (session: string) => void | Promise<void>;
}

export async function auditCommand(args: AuditArgs): Promise<void> {
  const summary = await runAudit(args);
  process.stdout.write(
    (args.pretty ? JSON.stringify(summary, null, 2) : JSON.stringify(summary)) + "\n",
  );
  if (summary.qualityGate?.status === "failed") process.exitCode = 1;
}

export async function runAudit(
  args: AuditArgs,
  hooks: AuditHooks = {},
  preparedSource?: ForkSource,
): Promise<AuditSummary> {
  validateAuditArgs(args);
  if (preparedSource && args.fromSession === undefined) {
    throw new Error("A prepared audit source must name its --from-session provenance");
  }
  if (args.fromSession !== undefined) {
    assertSessionName(args.fromSession);
    await assertSourceExists(args.gameDir, args.fromSession);
  }
  const game = await loadGame(args.gameDir);
  const personaRegistry = collectAiPersonas(game);
  for (const persona of args.personas) {
    if (!personaRegistry[persona]) {
      throw new Error(
        `Unknown audit persona: ${persona}. Available: ${Object.keys(personaRegistry).join(", ")}`,
      );
    }
  }
  const stochasticPersonas = args.personas.filter(
    (persona) => personaRegistry[persona]?.deterministic === false,
  );
  if (stochasticPersonas.length > 0 && args.seed === undefined) {
    throw new Error(
      `Audit personas [${stochasticPersonas.join(", ")}] require --seed for reproducibility`,
    );
  }
  // Every retained quality finding must be replayable even if a currently
  // deterministic project persona later becomes stochastic. Preserve a
  // caller seed or mint one before any lane starts, then freeze it in the
  // audit evidence.
  const effectiveSeed = args.seed ?? randomInt(0, 233_280);
  const maxSegments = args.maxSegments ?? 4;
  const sourceSession = args.fromSession ?? `${args.sessionPrefix}-source`;
  assertSessionName(sourceSession);
  const qualityPolicy = mergeQualityPolicies(game.aiAudit, args.qualityFloor);
  const acceptanceMatrixMatches = qualityPolicy?.personas === undefined ||
    samePersonaSet(args.personas, qualityPolicy.personas);

  const targets = args.personas.map((persona) => ({
    persona,
    session: `${args.sessionPrefix}-${persona}`,
  }));
  for (const target of targets) {
    assertSessionName(target.session);
    await assertTargetEmpty(args.gameDir, target.session);
  }
  const qualityEvidenceSession = qualityPolicy && acceptanceMatrixMatches &&
    args.reportOnQualityFailure !== false
    ? `${args.sessionPrefix}-quality-gate`
    : undefined;
  if (qualityEvidenceSession) {
    assertSessionName(qualityEvidenceSession);
    await assertTargetEmpty(args.gameDir, qualityEvidenceSession);
  }

  // A fresh audit owns one explicit GUI-compatible source save. Preflight it
  // alongside every lane before writing anything, then seed the persisted
  // engine PRNG from the same public seed used by the persona matrix. Repeating
  // a fresh audit with the same game + seed therefore freezes the same source
  // revision instead of depending on ambient Math.random state.
  if (args.fromSession === undefined) {
    await assertTargetEmpty(args.gameDir, sourceSession);
  }

  // Capture the live player branch exactly once. The player may keep using
  // GUI/TUI while this matrix runs; every AI lane must still start from this
  // same audit-time state rather than whatever state happens to be current
  // when its sequential turn begins.
  const source = preparedSource ?? (args.fromSession === undefined
    ? await createFreshAuditSource(
        args.gameDir,
        sourceSession,
        game,
        effectiveSeed,
      )
    : await loadForkSource(
        args.gameDir,
        args.fromSession,
        args.fromLogEntry,
      ));
  const stateRevision = createHash("sha256")
    .update(JSON.stringify(source.state))
    .digest("hex");

  const lanes: AuditLaneSummary[] = [];
  const choicesByPersona = new Map<string, Array<{
    scriptId: string;
    choiceId: string;
    optionId: string;
  }>>();
  for (const [index, target] of targets.entries()) {
    // The audit root seed is uint32; derive each independent persona lane in
    // the same closed domain so a valid 0xffffffff root cannot overflow the
    // autoplay fresh-world contract on lane two.
    let laneSeed = (effectiveSeed + index) >>> 0;
    let expectedInitialStateRevision: string | undefined;
    const segments: AutoplaySummary[] = [];
    for (let segment = 0; segment < maxSegments; segment += 1) {
      const summary = await runAutoplay({
        gameDir: args.gameDir,
        persona: target.persona,
        verbose: false,
        maxSteps: args.maxSteps,
        session: target.session,
        ...(segment === 0
          ? {
              preparedForkSource: {
                fromSession: sourceSession,
                source,
              },
            }
          : {}),
        reportOnStop: args.reportOnStop,
        seed: laneSeed,
        ...(expectedInitialStateRevision
          ? { expectedInitialStateRevision }
          : {}),
      });
      segments.push(summary);
      await hooks.onLaneSegmentComplete?.(
        target.persona,
        target.session,
        segment,
        summary,
      );
      if (
        args.maxSteps === 0 ||
        summary.reason !== "max-steps" ||
        summary.behaviorCycle ||
        !summary.continuation
      ) break;
      laneSeed = summary.continuation.next.args.seed;
      expectedInitialStateRevision = createHash("sha256")
        .update(JSON.stringify(summary.finalState))
        .digest("hex");
    }
    const { lane, decisions } = summarizeAuditLane(target.persona, segments);
    choicesByPersona.set(
      target.persona,
      decisions.filter(
        (decision): decision is Extract<typeof decision, { type: "choose" }> =>
          decision.type === "choose",
      ),
    );
    lanes.push(lane);
    await hooks.onLaneComplete?.(lane, index);
  }

  const endings: Record<string, number> = {};
  for (const lane of lanes) {
    if (lane.ending) endings[lane.ending] = (endings[lane.ending] ?? 0) + 1;
  }
  const uniqueDecisionPaths = new Set(lanes.map((lane) => lane.path.revision)).size;
  const uniqueEndings = Object.keys(endings).length;
  const activityTagsByPersona = Object.fromEntries(
    lanes.map((lane) => [lane.persona, lane.path.activityTags]),
  );
  const coveredActivityTags = [...new Set(
    lanes.flatMap((lane) => lane.path.activityTags),
  )].sort();
  const maxActivityRepetition = maximumActivityBudgetUtilization(
    lanes,
    qualityPolicy,
  );
  const completedScriptsByPersona = Object.fromEntries(
    lanes.map((lane) => [lane.persona, [...lane.progress.completedScripts].sort()]),
  );
  const completedScripts = [...new Set(
    lanes.flatMap((lane) => lane.progress.completedScripts),
  )].sort();
  const choiceDivergences = summarizeChoiceDivergences(
    args.personas,
    choicesByPersona,
  );
  const allTerminal = lanes.every(
    (lane) => lane.reason === "completed" && lane.ending !== null,
  );
  const classification = !allTerminal
    ? "incomplete" as const
    : uniqueEndings > 1
      ? "divergent-endings" as const
      : uniqueDecisionPaths > 1
        ? "convergent-paths" as const
        : "identical-path" as const;
  const quality = qualityPolicy
    ? evaluateQualityGate(
        qualityPolicy,
        acceptanceMatrixMatches,
        allTerminal,
        args.maxSteps > 0,
        lanes.filter((lane) =>
          lane.reason !== "completed" || lane.ending === null
        ).map((lane) => `${lane.persona}=${lane.reason}`),
        uniqueEndings,
        uniqueDecisionPaths,
        coveredActivityTags,
        completedScripts,
        maxActivityRepetition,
      )
    : undefined;
  let qualityReport: PlaytestReport | undefined;
  if (quality?.status === "failed" && qualityEvidenceSession &&
    args.reportOnQualityFailure !== false) {
    let evidenceSnapshot: PlaytestEvidenceSnapshot | undefined;
    await createForkFromSource({
      gameDir: args.gameDir,
      from: sourceSession,
      to: qualityEvidenceSession,
      pretty: false,
    }, source, {
      onCreatedWhileLocked: async () => {
        evidenceSnapshot = await capturePlaytestEvidenceSnapshot(
          args.gameDir,
          qualityEvidenceSession,
        );
      },
    });
    if (!evidenceSnapshot) {
      throw new Error("AI audit failed to freeze its quality evidence snapshot");
    }
    await hooks.onQualityEvidenceForked?.(qualityEvidenceSession);
    qualityReport = await recordPlaytestReport({
      gameDir: args.gameDir,
      session: qualityEvidenceSession,
      area: "gameplay",
      severity: "major",
      title: `AI audit quality gate failed (${uniqueEndings} endings, ${uniqueDecisionPaths} paths)`,
      details: [
        `The deterministic persona matrix ran ${lanes.length} lanes from one frozen source revision (${stateRevision}).`,
        `Observed endings: ${formatEndingCounts(endings)}.`,
        `Covered activity tags: ${coveredActivityTags.join(", ") || "none"}.`,
        `Completed scripts: ${completedScripts.join(", ") || "none"}.`,
        `Quality violations: ${quality.violations.join("; ")}.`,
        `Classification: ${classification}.`,
        `Personas: ${args.personas.join(", ")}.`,
        "Reproduce the attached audit-source checkpoint, then decide whether to improve authored intent/route reachability or revise the explicit game-level threshold.",
      ].join(" "),
      target: "game.yaml",
      evidenceSnapshot,
      auditMatrix: {
        sourceRevision: stateRevision,
        sessionPrefix: args.sessionPrefix,
        maxSteps: args.maxSteps,
        maxSegments,
        seed: effectiveSeed,
        policy: qualityPolicy!,
        observed: {
          uniqueEndings,
          uniqueDecisionPaths,
          ...(quality.observed.coveredActivityTags
            ? { coveredActivityTags: quality.observed.coveredActivityTags }
            : {}),
          ...(quality.observed.completedScripts
            ? { completedScripts: quality.observed.completedScripts }
            : {}),
          ...(quality.observed.maxActivityRepetition
            ? { maxActivityRepetition: quality.observed.maxActivityRepetition }
            : {}),
        },
        classification,
        violations: quality.violations,
        lanes: lanes.map((lane) => ({
          persona: lane.persona,
          deterministic: personaRegistry[lane.persona]?.deterministic !== false,
          session: lane.session,
          webPath: lane.webPath,
          ending: lane.ending,
          reason: lane.reason,
          pathRevision: lane.path.revision,
          activityTags: lane.path.activityTags,
          completedScripts: lane.progress.completedScripts,
          semanticActivityCounts: lane.path.semanticActivityCounts,
          semanticActivityObjectives: lane.path.semanticActivityObjectives,
        })),
        choiceDivergences,
      },
    });
  }
  return {
    source: {
      session: sourceSession,
      at: source.selectedEntry,
      entries: source.sourceEntries,
      mode: source.mode,
      stateRevision,
    },
    sessionPrefix: args.sessionPrefix,
    seed: effectiveSeed,
    maxSegments,
    maxSteps: args.maxSteps,
    lanes,
    totals: {
      lanes: lanes.length,
      segments: lanes.reduce((sum, lane) => sum + lane.segments, 0),
      completed: lanes.filter((lane) => lane.reason === "completed").length,
      stalled: lanes.filter((lane) => lane.reason === "stalled").length,
      behaviorCycles: lanes.filter((lane) => lane.behaviorCycle !== undefined).length,
      budgetCheckpoints: lanes.filter((lane) =>
        lane.reason === "max-steps" && lane.progress.madeProgress && !lane.behaviorCycle
      ).length,
      errors: lanes.filter((lane) => lane.reason === "error").length,
      rejectedInputs: lanes.reduce((sum, lane) => sum + lane.rejectedInputs, 0),
      openReports: lanes.filter((lane) => lane.report !== undefined).length +
        (qualityReport ? 1 : 0),
    },
    endings,
    activityCoverage: {
      coveredTags: coveredActivityTags,
      byPersona: activityTagsByPersona,
    },
    scriptCoverage: {
      completedScripts,
      byPersona: completedScriptsByPersona,
    },
    diversity: {
      classification,
      uniqueEndings,
      uniqueDecisionPaths,
      choiceDivergences,
    },
    ...(quality
      ? {
          qualityGate: {
            policy: qualityPolicy!,
            ...quality,
            ...(qualityEvidenceSession && quality.status === "failed"
              ? { evidenceSession: qualityEvidenceSession }
              : {}),
            ...(qualityReport
              ? {
                  report: {
                    id: qualityReport.id,
                    severity: qualityReport.severity,
                    title: qualityReport.title,
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

function summarizeAuditLane(
  persona: string,
  segments: AutoplaySummary[],
): { lane: AuditLaneSummary; decisions: AutoplaySemanticDecision[] } {
  const final = segments.at(-1);
  if (!final) throw new Error(`AI audit lane ${persona} produced no segments`);
  const decisions = segments.flatMap((segment) => segment.decisionPath.decisions);
  const pathRevision = createHash("sha256")
    .update(JSON.stringify(decisions))
    .digest("hex");
  const completedScripts = [...new Set(
    segments.flatMap((segment) => segment.progress.completedScripts),
  )];
  const objectiveChanges = new Map<string, AutoplayProgress["objectiveChanges"][number]>();
  for (const segment of segments) {
    for (const change of segment.progress.objectiveChanges) {
      const key = `${change.objectiveId}\u0000${change.requirementId}`;
      const previous = objectiveChanges.get(key);
      objectiveChanges.set(key, previous
        ? { ...change, from: previous.from }
        : change);
    }
  }
  const scriptProgress = segments.flatMap((segment) =>
    segment.progress.scriptProgress ? [segment.progress.scriptProgress] : []
  );
  const firstScriptProgress = scriptProgress[0];
  const lastScriptProgress = scriptProgress.at(-1);
  const progress: AutoplayProgress = {
    madeProgress: segments.some((segment) => segment.progress.madeProgress),
    completedScripts,
    objectiveChanges: [...objectiveChanges.values()],
    ...(firstScriptProgress && lastScriptProgress
      ? {
          scriptProgress: {
            from: firstScriptProgress.from,
            to: lastScriptProgress.to,
            beatIndexFrom: firstScriptProgress.beatIndexFrom,
            beatIndexTo: lastScriptProgress.beatIndexTo,
          },
        }
      : {}),
  };
  return {
    decisions,
    lane: {
      persona,
      session: final.session!,
      webPath: final.webPath!,
      reason: final.reason,
      segments: segments.length,
      decisions: segments.reduce((sum, segment) => sum + segment.decisions, 0),
      steps: segments.reduce((sum, segment) => sum + segment.steps, 0),
      rejectedInputs: segments.reduce(
        (sum, segment) => sum + segment.rejectedInputs,
        0,
      ),
      ending: final.ending,
      progress,
      path: {
        revision: pathRevision,
        semanticDecisions: decisions.length,
        choices: decisions.filter((decision) => decision.type === "choose").length,
        activityTags: [...new Set(decisions.flatMap((decision) =>
          decision.type === "doActivity" ? decision.aiTags ?? [] : []
        ))].sort(),
        semanticActivityCounts: Object.fromEntries(
          [...decisions.reduce((counts, decision) => {
            if (decision.type === "doActivity") {
              const semanticActivity = decision.actionKind ?? decision.id;
              counts.set(
                semanticActivity,
                (counts.get(semanticActivity) ?? 0) + 1,
              );
            }
            return counts;
          }, new Map<string, number>())]
            .sort(([left], [right]) => left.localeCompare(right)),
        ),
        semanticActivityObjectives: Object.fromEntries(
          [...decisions.reduce((objectives, decision) => {
            if (decision.type !== "doActivity" || !decision.linkedObjectiveIds?.length) {
              return objectives;
            }
            const semanticActivity = decision.actionKind ?? decision.id;
            const ids = objectives.get(semanticActivity) ?? new Set<string>();
            for (const id of decision.linkedObjectiveIds) ids.add(id);
            objectives.set(semanticActivity, ids);
            return objectives;
          }, new Map<string, Set<string>>())]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([activityKind, ids]) => [activityKind, [...ids].sort()]),
        ),
      },
      ...(final.stall ? { stall: final.stall } : {}),
      ...(final.behaviorCycle ? { behaviorCycle: final.behaviorCycle } : {}),
      ...(final.report
        ? {
            report: {
              id: final.report.id,
              severity: final.report.severity,
              title: final.report.title,
            },
          }
        : {}),
    },
  };
}

function samePersonaSet(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length &&
    actual.every((persona) => expected.includes(persona));
}

function mergeQualityPolicies(
  current: AiAuditConfig | undefined,
  floor: AiAuditConfig | undefined,
): AiAuditConfig | undefined {
  if (!current && !floor) return undefined;
  const matricesCompatible = current?.personas === undefined ||
    floor?.personas === undefined ||
    samePersonaSet(current.personas, floor.personas);
  const minUniqueEndings = maxDefined(
    matricesCompatible ? current?.minUniqueEndings : undefined,
    floor?.minUniqueEndings,
  );
  const minUniqueDecisionPaths = maxDefined(
    matricesCompatible ? current?.minUniqueDecisionPaths : undefined,
    floor?.minUniqueDecisionPaths,
  );
  const maxActivityRepetitions = minDefined(
    matricesCompatible ? current?.maxActivityRepetitions : undefined,
    floor?.maxActivityRepetitions,
  );
  const maxActivityRepetitionsByKind = mergeActivityRepetitionLimits(
    matricesCompatible ? current : undefined,
    floor,
    maxActivityRepetitions,
  );
  const requiredActivityTags = mergeRequiredTags(
    matricesCompatible ? current?.requiredActivityTags : undefined,
    floor?.requiredActivityTags,
  );
  const requiredScripts = mergeRequiredTags(
    matricesCompatible ? current?.requiredScripts : undefined,
    floor?.requiredScripts,
  );
  return {
    ...(floor?.personas !== undefined
      ? { personas: [...floor.personas] }
      : current?.personas !== undefined
        ? { personas: [...current.personas] }
        : {}),
    ...(floor?.seeds !== undefined
      ? { seeds: [...floor.seeds] }
      : current?.seeds !== undefined
        ? { seeds: [...current.seeds] }
        : {}),
    ...(minUniqueEndings !== undefined ? { minUniqueEndings } : {}),
    ...(minUniqueDecisionPaths !== undefined ? { minUniqueDecisionPaths } : {}),
    ...(maxActivityRepetitions !== undefined ? { maxActivityRepetitions } : {}),
    ...(maxActivityRepetitionsByKind !== undefined
      ? { maxActivityRepetitionsByKind }
      : {}),
    ...(requiredActivityTags !== undefined ? { requiredActivityTags } : {}),
    ...(requiredScripts !== undefined ? { requiredScripts } : {}),
  };
}

function mergeRequiredTags(
  current: string[] | undefined,
  floor: string[] | undefined,
): string[] | undefined {
  if (current === undefined && floor === undefined) return undefined;
  return [...new Set([...(current ?? []), ...(floor ?? [])])];
}

function maxDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function minDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function evaluateQualityGate(
  policy: AiAuditConfig,
  acceptanceMatrixMatches: boolean,
  allTerminal: boolean,
  executionBudgeted: boolean,
  incompleteLanes: string[],
  uniqueEndings: number,
  uniqueDecisionPaths: number,
  coveredActivityTags: string[],
  completedScripts: string[],
  maxActivityRepetition: {
    persona: string;
    activityKind: string;
    count: number;
    limit: number;
    objectiveIds?: string[];
  } | undefined,
): Omit<NonNullable<AuditSummary["qualityGate"]>, "policy" | "evidenceSession" | "report"> {
  const observed = {
    uniqueEndings,
    uniqueDecisionPaths,
    ...(policy.requiredActivityTags
      ? { coveredActivityTags: [...coveredActivityTags] }
      : {}),
    ...(policy.requiredScripts ? { completedScripts: [...completedScripts] } : {}),
    ...((policy.maxActivityRepetitions !== undefined ||
      policy.maxActivityRepetitionsByKind !== undefined) && maxActivityRepetition
      ? { maxActivityRepetition }
      : {}),
  };
  if (!acceptanceMatrixMatches) {
    return {
      status: "not-evaluated",
      observed,
      violations: [
        `project acceptance requires personas [${policy.personas?.join(", ") ?? ""}]`,
      ],
    };
  }
  if (!allTerminal) {
    const violation = `audit lanes did not reach terminal endings: ${incompleteLanes.join(", ")}`;
    return {
      status: executionBudgeted ? "failed" : "not-evaluated",
      observed,
      violations: [violation],
    };
  }
  const violations: string[] = [];
  if (policy.minUniqueEndings !== undefined &&
    uniqueEndings < policy.minUniqueEndings) {
    violations.push(
      `unique endings ${uniqueEndings} < required ${policy.minUniqueEndings}`,
    );
  }
  if (policy.minUniqueDecisionPaths !== undefined &&
    uniqueDecisionPaths < policy.minUniqueDecisionPaths) {
    violations.push(
      `unique decision paths ${uniqueDecisionPaths} < required ${policy.minUniqueDecisionPaths}`,
    );
  }
  if (policy.requiredActivityTags !== undefined) {
    const covered = new Set(coveredActivityTags);
    const missing = policy.requiredActivityTags.filter((tag) => !covered.has(tag));
    if (missing.length > 0) {
      violations.push(`required activity tags not covered: ${missing.join(", ")}`);
    }
  }
  if (policy.requiredScripts !== undefined) {
    const completed = new Set(completedScripts);
    const missing = policy.requiredScripts.filter((id) => !completed.has(id));
    if (missing.length > 0) {
      violations.push(`required scripts not completed: ${missing.join(", ")}`);
    }
  }
  if (
    maxActivityRepetition &&
    maxActivityRepetition.count > maxActivityRepetition.limit
  ) {
    violations.push(
      `activity repetition ${maxActivityRepetition.persona}/${maxActivityRepetition.activityKind} = ${maxActivityRepetition.count} > allowed ${maxActivityRepetition.limit}` +
        (maxActivityRepetition.objectiveIds?.length
          ? `; linked objectives [${maxActivityRepetition.objectiveIds.join(", ")}]`
          : ""),
    );
  }
  return {
    status: violations.length > 0 ? "failed" : "passed",
    observed,
    violations,
  };
}

function mergeActivityRepetitionLimits(
  current: AiAuditConfig | undefined,
  floor: AiAuditConfig | undefined,
  mergedDefault: number | undefined,
): Record<string, number> | undefined {
  const keys = new Set([
    ...Object.keys(current?.maxActivityRepetitionsByKind ?? {}),
    ...Object.keys(floor?.maxActivityRepetitionsByKind ?? {}),
  ]);
  const merged: Record<string, number> = {};
  for (const kind of [...keys].sort()) {
    const limit = minDefined(
      current?.maxActivityRepetitionsByKind?.[kind] ?? current?.maxActivityRepetitions,
      floor?.maxActivityRepetitionsByKind?.[kind] ?? floor?.maxActivityRepetitions,
    );
    if (limit !== undefined && limit !== mergedDefault) merged[kind] = limit;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function maximumActivityBudgetUtilization(
  lanes: AuditLaneSummary[],
  policy: AiAuditConfig | undefined,
) {
  if (!policy) return undefined;
  return lanes.flatMap((lane) =>
    Object.entries(lane.path.semanticActivityCounts).flatMap(([activityKind, count]) => {
      const limit = policy.maxActivityRepetitionsByKind?.[activityKind] ??
        policy.maxActivityRepetitions;
      if (limit === undefined) return [];
      return [{
        persona: lane.persona,
        activityKind,
        count,
        limit,
        ...(lane.path.semanticActivityObjectives[activityKind]?.length
          ? { objectiveIds: lane.path.semanticActivityObjectives[activityKind] }
          : {}),
      }];
    })
  ).sort((left, right) =>
    right.count * left.limit - left.count * right.limit ||
    right.count - left.count ||
    left.persona.localeCompare(right.persona) ||
    left.activityKind.localeCompare(right.activityKind)
  )[0];
}

function formatEndingCounts(endings: Record<string, number>): string {
  const entries = Object.entries(endings);
  return entries.length > 0
    ? entries.map(([ending, count]) => `${ending}=${count}`).join(", ")
    : "none";
}

function summarizeChoiceDivergences(
  personas: string[],
  choicesByPersona: Map<string, Array<{
    scriptId: string;
    choiceId: string;
    optionId: string;
  }>>,
): AuditSummary["diversity"]["choiceDivergences"] {
  const choices = new Map<string, {
    scriptId: string;
    choiceId: string;
    selections: Map<string, string[]>;
    reachedBy: Set<string>;
  }>();
  for (const persona of personas) {
    for (const decision of choicesByPersona.get(persona) ?? []) {
      const key = `${decision.scriptId}\u0000${decision.choiceId}`;
      let choice = choices.get(key);
      if (!choice) {
        choice = {
          scriptId: decision.scriptId,
          choiceId: decision.choiceId,
          selections: new Map(),
          reachedBy: new Set(),
        };
        choices.set(key, choice);
      }
      choice.reachedBy.add(persona);
      const selectedBy = choice.selections.get(decision.optionId) ?? [];
      if (!selectedBy.includes(persona)) selectedBy.push(persona);
      choice.selections.set(decision.optionId, selectedBy);
    }
  }
  return [...choices.values()].flatMap((choice) => {
    const notReachedBy = personas.filter((persona) => !choice.reachedBy.has(persona));
    if (choice.selections.size === 1 && notReachedBy.length === 0) return [];
    return [{
      scriptId: choice.scriptId,
      choiceId: choice.choiceId,
      selections: [...choice.selections].map(([optionId, selectedBy]) => ({
        optionId,
        personas: selectedBy,
      })),
      notReachedBy,
    }];
  });
}

function validateAuditArgs(args: AuditArgs): void {
  if (!Number.isInteger(args.maxSteps) || args.maxSteps < 0) {
    throw new Error("--max-steps must be a non-negative integer");
  }
  if (args.maxSegments !== undefined &&
    (!Number.isInteger(args.maxSegments) || args.maxSegments < 1)) {
    throw new Error("--max-segments must be a positive integer");
  }
  if (args.fromLogEntry !== undefined && (
    !Number.isInteger(args.fromLogEntry) || args.fromLogEntry < 0
  )) throw new Error("--from-at must be a non-negative integer");
  if (args.fromSession === undefined && args.fromLogEntry !== undefined) {
    throw new Error("--from-at requires --from-session");
  }
  if (args.personas.length === 0) throw new Error("--personas must contain at least one persona");
  const duplicate = args.personas.find((persona, index) =>
    args.personas.indexOf(persona) !== index
  );
  if (duplicate) throw new Error(`Duplicate audit persona: ${duplicate}`);
  if (args.personas.includes("random") && args.seed === undefined) {
    throw new Error("Audit persona random requires --seed for reproducibility");
  }
  if (args.seed !== undefined && (!Number.isInteger(args.seed) || args.seed < 0)) {
    throw new Error("--seed must be a non-negative integer");
  }
  if (
    args.fromSession === undefined &&
    args.seed !== undefined &&
    args.seed > 0xffff_ffff
  ) {
    throw new Error("A fresh audit --seed must fit in uint32");
  }
}

async function createFreshAuditSource(
  gameDir: string,
  session: string,
  game: Awaited<ReturnType<typeof loadGame>>,
  seed: number,
): Promise<ForkSource> {
  return withSessionLock(gameDir, session, async () => {
    await assertTargetEmpty(gameDir, session);
    const state = createInitialState(game, { seed });
    await saveSession(gameDir, session, state);
    return {
      state,
      selectedEntry: 0,
      sourceEntries: 0,
      mode: "initial-state",
    };
  });
}

async function assertSourceExists(gameDir: string, session: string): Promise<void> {
  try {
    await access(path.join(sessionDir(gameDir, session), "state.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Source session does not exist: ${session}`);
    }
    throw error;
  }
}
