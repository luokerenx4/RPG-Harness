import { access } from "node:fs/promises";
import path from "node:path";
import { assertSessionName } from "@rpg-harness/session-store";
import { sessionDir } from "../session";
import { personaDescriptions, personas } from "../test/personas";
import { assertTargetEmpty } from "./fork";
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
  stall?: AutoplaySummary["stall"];
  behaviorCycle?: AutoplaySummary["behaviorCycle"];
  report?: {
    id: string;
    severity: string;
    title: string;
  };
}

export interface AuditSummary {
  source: { session: string; at?: number };
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
}

export async function auditCommand(args: AuditArgs): Promise<void> {
  const summary = await runAudit(args);
  process.stdout.write(
    (args.pretty ? JSON.stringify(summary, null, 2) : JSON.stringify(summary)) + "\n",
  );
}

export async function runAudit(args: AuditArgs): Promise<AuditSummary> {
  validateAuditArgs(args);
  assertSessionName(args.fromSession);
  await assertSourceExists(args.gameDir, args.fromSession);

  const targets = args.personas.map((persona) => ({
    persona,
    session: `${args.sessionPrefix}-${persona}`,
  }));
  for (const target of targets) {
    assertSessionName(target.session);
    await assertTargetEmpty(args.gameDir, target.session);
  }

  const lanes: AuditLaneSummary[] = [];
  for (const [index, target] of targets.entries()) {
    const summary = await runAutoplay({
      gameDir: args.gameDir,
      persona: target.persona,
      verbose: false,
      maxSteps: args.maxSteps,
      fromSession: args.fromSession,
      ...(args.fromLogEntry !== undefined ? { fromLogEntry: args.fromLogEntry } : {}),
      session: target.session,
      reportOnStop: args.reportOnStop,
      ...(args.seed !== undefined ? { seed: args.seed + index } : {}),
    });
    lanes.push({
      persona: target.persona,
      session: target.session,
      webPath: summary.webPath!,
      reason: summary.reason,
      decisions: summary.decisions,
      steps: summary.steps,
      rejectedInputs: summary.rejectedInputs,
      ending: summary.ending,
      progress: summary.progress,
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
    });
  }

  const endings: Record<string, number> = {};
  for (const lane of lanes) {
    if (lane.ending) endings[lane.ending] = (endings[lane.ending] ?? 0) + 1;
  }
  return {
    source: {
      session: args.fromSession,
      ...(args.fromLogEntry !== undefined ? { at: args.fromLogEntry } : {}),
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
      openReports: lanes.filter((lane) => lane.report !== undefined).length,
    },
    endings,
  };
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
  for (const persona of args.personas) {
    if (!personas[persona]) {
      throw new Error(
        `Unknown audit persona: ${persona}. Available: ${Object.keys(personaDescriptions).join(", ")}`,
      );
    }
  }
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
