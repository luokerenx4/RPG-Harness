import { access } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { assertSessionName } from "@rpg-harness/session-store";
import type { AiAuditConfig } from "@rpg-harness/engine";
import { sessionDir } from "../session";
import { loadGame } from "../loader";
import {
  recordPlaytestReport,
  type PlaytestReport,
} from "../playtest-reports";
import { collectAiPersonas } from "../test/personas";
import {
  assertTargetEmpty,
  createForkFromSource,
  loadForkSource,
} from "./fork";
import {
  runAutoplay,
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
  fromSession: string;
  fromLogEntry?: number;
  sessionPrefix: string;
  personas: string[];
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
  maxSteps: number;
  lanes: AuditLaneSummary[];
  totals: {
    lanes: number;
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
): Promise<AuditSummary> {
  validateAuditArgs(args);
  assertSessionName(args.fromSession);
  await assertSourceExists(args.gameDir, args.fromSession);
  const game = await loadGame(args.gameDir);
  const personaRegistry = collectAiPersonas(game);
  for (const persona of args.personas) {
    if (!personaRegistry[persona]) {
      throw new Error(
        `Unknown audit persona: ${persona}. Available: ${Object.keys(personaRegistry).join(", ")}`,
      );
    }
  }
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

  // Capture the live player branch exactly once. The player may keep using
  // GUI/TUI while this matrix runs; every AI lane must still start from this
  // same audit-time state rather than whatever state happens to be current
  // when its sequential turn begins.
  const source = await loadForkSource(
    args.gameDir,
    args.fromSession,
    args.fromLogEntry,
  );
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
    const preparedFork = await createForkFromSource({
      gameDir: args.gameDir,
      from: args.fromSession,
      to: target.session,
      pretty: false,
    }, source);
    const summary = await runAutoplay({
      gameDir: args.gameDir,
      persona: target.persona,
      verbose: false,
      maxSteps: args.maxSteps,
      session: target.session,
      preparedFork,
      reportOnStop: args.reportOnStop,
      ...(args.seed !== undefined ? { seed: args.seed + index } : {}),
    });
    const lane: AuditLaneSummary = {
      persona: target.persona,
      session: target.session,
      webPath: summary.webPath!,
      reason: summary.reason,
      decisions: summary.decisions,
      steps: summary.steps,
      rejectedInputs: summary.rejectedInputs,
      ending: summary.ending,
      progress: summary.progress,
      path: {
        revision: summary.decisionPath.revision,
        semanticDecisions: summary.decisionPath.decisions.length,
        choices: summary.decisionPath.decisions.filter(
          (decision) => decision.type === "choose",
        ).length,
        activityTags: collectActivityTags(summary),
      },
      ...(summary.stall ? { stall: summary.stall } : {}),
      ...(summary.behaviorCycle ? { behaviorCycle: summary.behaviorCycle } : {}),
      ...(summary.report
        ? {
            report: {
              id: summary.report.id,
              severity: summary.report.severity,
              title: summary.report.title,
            },
          }
        : {}),
    };
    choicesByPersona.set(
      target.persona,
      summary.decisionPath.decisions.filter(
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
        uniqueEndings,
        uniqueDecisionPaths,
        coveredActivityTags,
      )
    : undefined;
  let qualityReport: PlaytestReport | undefined;
  if (quality?.status === "failed" && qualityEvidenceSession &&
    args.reportOnQualityFailure !== false) {
    await createForkFromSource({
      gameDir: args.gameDir,
      from: args.fromSession,
      to: qualityEvidenceSession,
      pretty: false,
    }, source);
    qualityReport = await recordPlaytestReport({
      gameDir: args.gameDir,
      session: qualityEvidenceSession,
      area: "gameplay",
      severity: "major",
      title: `AI audit quality gate failed (${uniqueEndings} endings, ${uniqueDecisionPaths} paths)`,
      details: [
        `The deterministic persona matrix completed ${lanes.length} lanes from one frozen source revision (${stateRevision}).`,
        `Observed endings: ${formatEndingCounts(endings)}.`,
        `Covered activity tags: ${coveredActivityTags.join(", ") || "none"}.`,
        `Quality violations: ${quality.violations.join("; ")}.`,
        `Classification: ${classification}.`,
        `Personas: ${args.personas.join(", ")}.`,
        "Reproduce the attached audit-source checkpoint, then decide whether to improve authored intent/route reachability or revise the explicit game-level threshold.",
      ].join(" "),
      target: "game.yaml",
      auditMatrix: {
        sourceRevision: stateRevision,
        sessionPrefix: args.sessionPrefix,
        maxSteps: args.maxSteps,
        ...(args.seed !== undefined ? { seed: args.seed } : {}),
        policy: qualityPolicy!,
        observed: {
          uniqueEndings,
          uniqueDecisionPaths,
          ...(quality.observed.coveredActivityTags
            ? { coveredActivityTags: quality.observed.coveredActivityTags }
            : {}),
        },
        classification,
        violations: quality.violations,
        lanes: lanes.map((lane) => ({
          persona: lane.persona,
          session: lane.session,
          webPath: lane.webPath,
          ending: lane.ending,
          reason: lane.reason,
          pathRevision: lane.path.revision,
          activityTags: lane.path.activityTags,
        })),
        choiceDivergences,
      },
    });
  }
  return {
    source: {
      session: args.fromSession,
      at: source.selectedEntry,
      entries: source.sourceEntries,
      mode: source.mode,
      stateRevision,
    },
    sessionPrefix: args.sessionPrefix,
    maxSteps: args.maxSteps,
    lanes,
    totals: {
      lanes: lanes.length,
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
  const requiredActivityTags = mergeRequiredTags(
    matricesCompatible ? current?.requiredActivityTags : undefined,
    floor?.requiredActivityTags,
  );
  return {
    ...(floor?.personas !== undefined
      ? { personas: [...floor.personas] }
      : current?.personas !== undefined
        ? { personas: [...current.personas] }
        : {}),
    ...(minUniqueEndings !== undefined ? { minUniqueEndings } : {}),
    ...(minUniqueDecisionPaths !== undefined ? { minUniqueDecisionPaths } : {}),
    ...(requiredActivityTags !== undefined ? { requiredActivityTags } : {}),
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

function evaluateQualityGate(
  policy: AiAuditConfig,
  acceptanceMatrixMatches: boolean,
  allTerminal: boolean,
  uniqueEndings: number,
  uniqueDecisionPaths: number,
  coveredActivityTags: string[],
): Omit<NonNullable<AuditSummary["qualityGate"]>, "policy" | "evidenceSession" | "report"> {
  const observed = {
    uniqueEndings,
    uniqueDecisionPaths,
    ...(policy.requiredActivityTags
      ? { coveredActivityTags: [...coveredActivityTags] }
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
    return {
      status: "not-evaluated",
      observed,
      violations: ["not every audit lane reached a terminal ending"],
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
  return {
    status: violations.length > 0 ? "failed" : "passed",
    observed,
    violations,
  };
}

function collectActivityTags(summary: AutoplaySummary): string[] {
  return [...new Set(summary.decisionPath.decisions.flatMap((decision) =>
    decision.type === "doActivity" ? decision.aiTags ?? [] : []
  ))].sort();
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
  if (args.fromLogEntry !== undefined && (
    !Number.isInteger(args.fromLogEntry) || args.fromLogEntry < 0
  )) throw new Error("--from-at must be a non-negative integer");
  if (args.personas.length === 0) throw new Error("--personas must contain at least one persona");
  const duplicate = args.personas.find((persona, index) =>
    args.personas.indexOf(persona) !== index
  );
  if (duplicate) throw new Error(`Duplicate audit persona: ${duplicate}`);
  if (args.personas.includes("random") && args.seed === undefined) {
    throw new Error("Audit persona random requires --seed for reproducibility");
  }
  if (args.seed !== undefined && !Number.isInteger(args.seed)) {
    throw new Error("--seed must be an integer");
  }
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
