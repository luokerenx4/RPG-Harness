import {
  getPlaytestReport,
  resolveVerifiedPlaytestReport,
  type PlaytestPlayerFeedbackVerification,
} from "../playtest-reports";
import { collectProjectDevelopmentStatus } from "./project-status";
import {
  currentQualityAuditInputRevision,
  runProjectQualityGate,
} from "./quality-certificate";

export interface VerifyFeedbackArgs {
  gameDir: string;
  reportId: string;
  sessionPrefix: string;
  resolution: string;
}

export interface VerifyFeedbackSummary {
  status: "verified" | "failed";
  reportId: string;
  reason?: "project-unchanged" | "work-pending" | "quality-uncertified";
  originalInputRevision: string;
  currentInputRevision: string | null;
  certificateRevision: string | null;
  worklistRevision: string;
  worklistTotal: number;
  resolvedReport?: {
    id: string;
    status: "resolved";
    resolvedAt: string;
    resolution: string;
    verification: PlaytestPlayerFeedbackVerification;
  };
}

export async function verifyFeedbackReport(
  args: VerifyFeedbackArgs,
): Promise<VerifyFeedbackSummary> {
  if (!args.resolution.trim()) {
    throw new Error("Verifying player feedback requires a resolution for the player");
  }
  const report = await getPlaytestReport(args.gameDir, args.reportId);
  if (report.status !== "open") {
    throw new Error(`Playtest report is already closed: ${report.id}`);
  }
  const originalInputRevision = report.origin?.kind === "player-feedback"
    ? report.origin.projectInputRevision
    : undefined;
  if (!originalInputRevision) {
    throw new Error(
      `Player feedback report has no project-input baseline; record a fresh finding or supersede this legacy report: ${report.id}`,
    );
  }
  const before = await collectProjectDevelopmentStatus(args.gameDir);
  const currentInputRevision = await currentQualityAuditInputRevision(args.gameDir);
  const base = {
    reportId: report.id,
    originalInputRevision,
    currentInputRevision,
    certificateRevision: before.quality.certificateRevision,
    worklistRevision: before.revision,
    worklistTotal: before.worklist.total,
  };
  if (currentInputRevision === originalInputRevision) {
    return { status: "failed", reason: "project-unchanged", ...base };
  }
  if (before.worklist.total !== 1 || before.worklist.next?.key !== `report/${report.id}`) {
    return { status: "failed", reason: "work-pending", ...base };
  }
  const qualityGate = await runProjectQualityGate({
    gameDir: args.gameDir,
    sessionPrefix: args.sessionPrefix,
  });
  if (
    qualityGate.status !== "passed" ||
    !qualityGate.inputRevision ||
    !qualityGate.certificate
  ) {
    return { status: "failed", reason: "quality-uncertified", ...base };
  }
  const status = await collectProjectDevelopmentStatus(args.gameDir);
  if (
    status.quality.status !== "certified" ||
    status.quality.inputRevision !== qualityGate.inputRevision ||
    status.quality.certificateRevision !== qualityGate.certificate.revision ||
    !status.quality.createdAt
  ) throw new Error("Project quality certificate was not current after verification");
  if (status.worklist.total !== 1 || status.worklist.next?.key !== `report/${report.id}`) {
    return {
      status: "failed",
      reason: "work-pending",
      ...base,
      currentInputRevision: qualityGate.inputRevision,
      certificateRevision: qualityGate.certificate.revision,
      worklistRevision: status.revision,
      worklistTotal: status.worklist.total,
    };
  }
  const finalInputRevision = await currentQualityAuditInputRevision(args.gameDir);
  if (finalInputRevision !== qualityGate.inputRevision) {
    return {
      status: "failed",
      reason: "quality-uncertified",
      ...base,
      currentInputRevision: finalInputRevision,
      certificateRevision: null,
      worklistRevision: status.revision,
      worklistTotal: status.worklist.total,
    };
  }
  const verification: PlaytestPlayerFeedbackVerification = {
    kind: "player-feedback",
    verifiedAt: new Date().toISOString(),
    originalInputRevision,
    fixedInputRevision: qualityGate.inputRevision,
    certificateRevision: qualityGate.certificate.revision,
    certificateCreatedAt: status.quality.createdAt,
    worklistRevision: status.revision,
    unrelatedWorkItems: 0,
  };
  const resolved = await resolveVerifiedPlaytestReport({
    gameDir: args.gameDir,
    id: report.id,
    session: report.session,
    resolution: args.resolution.trim(),
    verification,
  });
  if (resolved.verification?.kind !== "player-feedback") {
    throw new Error(`Resolved player feedback lost its verification: ${report.id}`);
  }
  const closedStatus = await collectProjectDevelopmentStatus(args.gameDir);
  return {
    status: "verified",
    ...base,
    currentInputRevision: qualityGate.inputRevision,
    certificateRevision: qualityGate.certificate.revision,
    worklistRevision: closedStatus.revision,
    worklistTotal: closedStatus.worklist.total,
    resolvedReport: {
      id: resolved.id,
      status: "resolved",
      resolvedAt: resolved.resolvedAt!,
      resolution: resolved.resolution!,
      verification: resolved.verification,
    },
  };
}
