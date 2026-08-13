import {
  getPlaytestReport,
  reproducePlaytestReport,
  resolvePlaytestReport,
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

/** Re-run an ordinary autoplay stop from its immutable checkpoint and close it only on completion. */
export async function verifyAutoplayReport(
  args: VerifyAutoplayArgs,
): Promise<VerifyAutoplaySummary> {
  const report = await getPlaytestReport(args.gameDir, args.reportId);
  if (report.status !== "open") {
    throw new Error(`Playtest report is already resolved: ${report.id}`);
  }
  const evidence = report.evidence.autoplay;
  if (!evidence) {
    throw new Error(`Playtest report is not a structured autoplay finding: ${report.id}`);
  }
  if (!report.evidence.checkpoint) {
    throw new Error(`Autoplay report has no recoverable checkpoint: ${report.id}`);
  }
  if (typeof evidence.persona !== "string" || !evidence.persona.trim()) {
    throw new Error(`Autoplay report has invalid persona evidence: ${report.id}`);
  }
  if (!Number.isInteger(evidence.maxSteps) || evidence.maxSteps < 0) {
    throw new Error(`Autoplay report has invalid maxSteps evidence: ${report.id}`);
  }
  if (!Number.isInteger(evidence.seed) || evidence.seed! < 0) {
    throw new Error(
      `Autoplay report lacks a deterministic seed; reproduce it manually or record a fresh run: ${report.id}`,
    );
  }

  const sourceSession = `${args.sessionPrefix}-source`;
  const runSession = `${args.sessionPrefix}-run`;
  await assertTargetEmpty(args.gameDir, sourceSession);
  await assertTargetEmpty(args.gameDir, runSession);
  await reproducePlaytestReport({
    gameDir: args.gameDir,
    id: report.id,
    session: report.session,
    to: sourceSession,
  });
  const autoplay = await runAutoplay({
    gameDir: args.gameDir,
    persona: evidence.persona,
    verbose: false,
    maxSteps: evidence.maxSteps,
    ...(evidence.seed !== undefined ? { seed: evidence.seed } : {}),
    fromSession: sourceSession,
    session: runSession,
    reportOnStop: false,
    pretty: false,
  });
  const original = {
    persona: evidence.persona,
    maxSteps: evidence.maxSteps,
    ...(evidence.seed !== undefined ? { seed: evidence.seed } : {}),
    stopReason: evidence.stopReason,
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
  if (autoplay.reason !== "completed") {
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
    sourceCheckpointRevision: report.evidence.checkpoint.revision,
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
  const resolved = await resolvePlaytestReport({
    gameDir: args.gameDir,
    id: report.id,
    session: report.session,
    resolution: `Autoplay ${evidence.persona} completed from the immutable issue checkpoint after ${autoplay.decisions} decisions.`,
    verification,
  });
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
      verification,
    },
  };
}
