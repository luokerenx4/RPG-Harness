import {
  getPlaytestReport,
  reproducePlaytestReport,
  resolvePlaytestReport,
  type PlaytestVerification,
} from "../playtest-reports";
import { runAudit, type AuditSummary } from "./audit";
import { assertTargetEmpty } from "./fork";

export interface VerifyAuditArgs {
  gameDir: string;
  reportId: string;
  sessionPrefix: string;
}

export interface VerifyAuditSummary {
  status: "verified" | "failed";
  reportId: string;
  sourceSession: string;
  sourceRevisionMatches: boolean;
  qualityGate: AuditSummary["qualityGate"];
  diversity: AuditSummary["diversity"];
  lanes: Array<{
    persona: string;
    session: string;
    webPath: string;
    reason: string;
    ending: string | null;
    pathRevision: string;
    activityTags: string[];
    completedScripts: string[];
  }>;
  resolvedReport?: {
    id: string;
    status: "resolved";
    resolvedAt: string;
    resolution?: string;
    verification: PlaytestVerification;
  };
}

/** Re-run an audit issue from its immutable source and close it only on proof. */
export async function verifyAuditReport(
  args: VerifyAuditArgs,
): Promise<VerifyAuditSummary> {
  const report = await getPlaytestReport(args.gameDir, args.reportId);
  if (report.status !== "open") {
    throw new Error(`Playtest report is already resolved: ${report.id}`);
  }
  const evidence = report.evidence.auditMatrix;
  if (!evidence) {
    throw new Error(`Playtest report is not an AI audit finding: ${report.id}`);
  }
  const personas = evidence.lanes.map((lane) => lane.persona);
  if (new Set(personas).size !== personas.length || personas.length === 0) {
    throw new Error(`AI audit report has invalid persona evidence: ${report.id}`);
  }
  if (!Number.isInteger(evidence.maxSteps) || evidence.maxSteps! < 0) {
    throw new Error(
      `AI audit report lacks a deterministic maxSteps budget; reproduce it manually or record a fresh audit: ${report.id}`,
    );
  }

  const sourceSession = `${args.sessionPrefix}-source`;
  for (const session of [
    sourceSession,
    ...personas.map((persona) => `${args.sessionPrefix}-${persona}`),
  ]) {
    await assertTargetEmpty(args.gameDir, session);
  }
  await reproducePlaytestReport({
    gameDir: args.gameDir,
    id: report.id,
    session: report.session,
    to: sourceSession,
  });
  const audit = await runAudit({
    gameDir: args.gameDir,
    fromSession: sourceSession,
    sessionPrefix: args.sessionPrefix,
    personas,
    maxSteps: evidence.maxSteps!,
    ...(evidence.seed !== undefined ? { seed: evidence.seed } : {}),
    reportOnStop: false,
    reportOnQualityFailure: false,
    qualityFloor: {
      ...evidence.policy,
      personas: evidence.policy.personas ?? personas,
    },
    pretty: false,
  });
  const sourceRevisionMatches = audit.source.stateRevision === evidence.sourceRevision;
  const lanes = audit.lanes.map((lane) => ({
    persona: lane.persona,
    session: lane.session,
    webPath: lane.webPath,
    reason: lane.reason,
    ending: lane.ending,
    pathRevision: lane.path.revision,
    activityTags: lane.path.activityTags,
    completedScripts: lane.progress.completedScripts,
  }));
  const passed = sourceRevisionMatches && audit.qualityGate?.status === "passed";
  if (!passed) {
    return {
      status: "failed",
      reportId: report.id,
      sourceSession,
      sourceRevisionMatches,
      qualityGate: audit.qualityGate,
      diversity: audit.diversity,
      lanes,
    };
  }

  const qualityGate = audit.qualityGate!;

  const verification: PlaytestVerification = {
    kind: "ai-audit",
    verifiedAt: new Date().toISOString(),
    sessionPrefix: args.sessionPrefix,
    sourceRevision: audit.source.stateRevision,
    policy: qualityGate.policy,
    observed: qualityGate.observed,
    classification: audit.diversity.classification as Exclude<
      AuditSummary["diversity"]["classification"],
      "incomplete"
    >,
    lanes: lanes.map((lane) => ({
      persona: lane.persona,
      session: lane.session,
      webPath: lane.webPath,
      ending: lane.ending!,
      pathRevision: lane.pathRevision,
      activityTags: lane.activityTags,
      completedScripts: lane.completedScripts,
    })),
  };
  const resolved = await resolvePlaytestReport({
    gameDir: args.gameDir,
    id: report.id,
    session: report.session,
    resolution: [
      `AI audit quality gate passed with ${verification.observed.uniqueEndings} endings`,
      `${verification.observed.uniqueDecisionPaths} semantic decision paths`,
      ...(verification.observed.coveredActivityTags
        ? [`activity tags [${verification.observed.coveredActivityTags.join(", ")}]`]
        : []),
    ].join(", ") + ".",
    verification,
  });
  return {
    status: "verified",
    reportId: report.id,
    sourceSession,
    sourceRevisionMatches,
    qualityGate: audit.qualityGate,
    diversity: audit.diversity,
    lanes,
    resolvedReport: {
      id: resolved.id,
      status: "resolved",
      resolvedAt: resolved.resolvedAt!,
      ...(resolved.resolution ? { resolution: resolved.resolution } : {}),
      verification,
    },
  };
}
