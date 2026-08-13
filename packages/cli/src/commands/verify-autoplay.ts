import {
  getPlaytestReport,
  hasCausallyVerifiableAutoplayReport,
  loadPlaytestReportCheckpointSource,
  reproducePlaytestReport,
  resolveVerifiedPlaytestReport,
  type PlaytestAutoplayVerification,
} from "../playtest-reports";
import { runAutoplay, type AutoplaySummary } from "./autoplay";
import { assertTargetEmpty } from "./fork";

export interface VerifyAutoplayArgs {
  gameDir: string;
  reportId: string;
  sessionPrefix: string;
}

export interface VerifyAutoplaySummary {
  status: "verified" | "failed";
  reportId: string;
  sourceSession: string;
  runSession: string;
  original: {
    persona: string;
    maxSteps: number;
    seed?: number;
    stopReason: AutoplaySummary["reason"];
    decisionPathRevision: string;
  };
  result: {
    reason: AutoplaySummary["reason"];
    ending: string | null;
    decisions: number;
    rejectedInputs: number;
    steps: number;
    decisionPathRevision: string;
    completedScripts: string[];
    objectiveChanges: number;
    webPath: string;
  };
  resolvedReport?: {
    id: string;
    status: "resolved";
    resolvedAt: string;
    resolution?: string;
    verification: PlaytestAutoplayVerification;
  };
}

interface VerifyAutoplayInternalHooks {
  /** Deterministic seam after the inspection source exists but before proof runs. */
  afterSourceMaterialized?: (sourceSession: string) => void | Promise<void>;
}

/** Re-run the full causal autoplay path from its immutable pre-run checkpoint. */
export async function verifyAutoplayReport(
  args: VerifyAutoplayArgs,
  hooks: VerifyAutoplayInternalHooks = {},
): Promise<VerifyAutoplaySummary> {
  const report = await getPlaytestReport(args.gameDir, args.reportId);
  if (report.status !== "open") {
    throw new Error(`Playtest report is already resolved: ${report.id}`);
  }
  const evidence = report.evidence.autoplay;
  if (!evidence) {
    throw new Error(`Playtest report is not a structured autoplay finding: ${report.id}`);
  }
  if (!hasCausallyVerifiableAutoplayReport(report)) {
    throw new Error(
      `Autoplay report has incomplete causal replay or incident evidence; record a fresh finding or resolve this legacy report manually: ${report.id}`,
    );
  }

  const sourceSession = `${args.sessionPrefix}-source`;
  const runSession = `${args.sessionPrefix}-run`;
  await assertTargetEmpty(args.gameDir, sourceSession);
  await assertTargetEmpty(args.gameDir, runSession);
  const replaySource = await loadPlaytestReportCheckpointSource(
    args.gameDir,
    report,
    "autoplay-replay",
  );
  await reproducePlaytestReport({
    gameDir: args.gameDir,
    id: report.id,
    session: report.session,
    to: sourceSession,
    checkpoint: "autoplay-replay",
  });
  await hooks.afterSourceMaterialized?.(sourceSession);
  const autoplay = await runAutoplay({
    gameDir: args.gameDir,
    persona: evidence.persona,
    verbose: false,
    maxSteps: evidence.maxSteps,
    ...(evidence.seed !== undefined ? { seed: evidence.seed } : {}),
    session: runSession,
    preparedForkSource: {
      fromSession: sourceSession,
      source: {
        state: replaySource.state,
        selectedEntry: replaySource.sourceLogEntry,
        sourceEntries: replaySource.sourceLogEntry,
        mode: "checkpoint",
      },
    },
    reportOnStop: false,
    pretty: false,
  });
  const original = {
    persona: evidence.persona,
    maxSteps: evidence.maxSteps,
    ...(evidence.seed !== undefined ? { seed: evidence.seed } : {}),
    stopReason: evidence.stopReason,
    decisionPathRevision: evidence.decisionPathRevision,
  };
  const result = {
    reason: autoplay.reason,
    ending: autoplay.ending,
    decisions: autoplay.decisions,
    rejectedInputs: autoplay.rejectedInputs,
    steps: autoplay.steps,
    decisionPathRevision: autoplay.decisionPath.revision,
    completedScripts: autoplay.progress.completedScripts,
    objectiveChanges: autoplay.progress.objectiveChanges.length,
    webPath: autoplay.webPath!,
  };
  // A generator can return without yielding gameEnd. runLoop classifies that
  // exhaustion as completed, but it is not evidence that the authored route
  // reached a public terminal output. `ending` is populated only from the
  // final gameEnd's explicit identity (or the legacy generic fallback).
  if (autoplay.reason !== "completed" || autoplay.ending === null) {
    return {
      status: "failed",
      reportId: report.id,
      sourceSession,
      runSession,
      original,
      result,
    };
  }

  const verification: PlaytestAutoplayVerification = {
    kind: "autoplay",
    verifiedAt: new Date().toISOString(),
    replayCheckpointRevision: evidence.replayCheckpoint.revision,
    issueCheckpointRevision: report.evidence.checkpoint!.revision,
    originalStopReason: evidence.stopReason,
    persona: evidence.persona,
    maxSteps: evidence.maxSteps,
    ...(evidence.seed !== undefined ? { seed: evidence.seed } : {}),
    session: runSession,
    webPath: autoplay.webPath!,
    result: {
      reason: "completed",
      ending: autoplay.ending,
      decisions: autoplay.decisions,
      rejectedInputs: autoplay.rejectedInputs,
      steps: autoplay.steps,
      decisionPathRevision: autoplay.decisionPath.revision,
      completedScripts: autoplay.progress.completedScripts,
      objectiveChanges: autoplay.progress.objectiveChanges.length,
    },
  };
  const resolved = await resolveVerifiedPlaytestReport({
    gameDir: args.gameDir,
    id: report.id,
    session: report.session,
    resolution: `Autoplay ${evidence.persona} reached terminal ending ${autoplay.ending} in a causal replay from the immutable pre-run checkpoint after ${autoplay.decisions} decisions.`,
    verification,
  });
  if (resolved.verification?.kind !== "autoplay") {
    throw new Error(`Resolved autoplay report lost its verification: ${report.id}`);
  }
  return {
    status: "verified",
    reportId: report.id,
    sourceSession,
    runSession,
    original,
    result,
    resolvedReport: {
      id: resolved.id,
      status: "resolved",
      resolvedAt: resolved.resolvedAt!,
      ...(resolved.resolution ? { resolution: resolved.resolution } : {}),
      verification: resolved.verification,
    },
  };
}
