import {
  getPlaytestReport,
  hasVerifiableAuditReport,
  loadPlaytestReportCheckpointSource,
  reproducePlaytestReport,
  resolveVerifiedPlaytestReport,
  type PlaytestAuditVerification,
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
    semanticActivityCounts: Record<string, number>;
    semanticActivityActionCounts: Record<string, number>;
    semanticActivityObjectives: Record<string, string[]>;
  }>;
  resolvedReport?: {
    id: string;
    status: "resolved";
    resolvedAt: string;
    resolution?: string;
    verification: PlaytestAuditVerification;
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
  if (!hasVerifiableAuditReport(report)) {
    throw new Error(
      `AI audit report has incomplete deterministic replay or incident evidence; record a fresh audit or resolve this legacy report manually: ${report.id}`,
    );
  }
  const personas = evidence.lanes.map((lane) => lane.persona);

  const sourceSession = `${args.sessionPrefix}-source`;
  for (const session of [
    sourceSession,
    ...personas.map((persona) => `${args.sessionPrefix}-${persona}`),
  ]) {
    await assertTargetEmpty(args.gameDir, session);
  }
  const frozenSource = await loadPlaytestReportCheckpointSource(
    args.gameDir,
    report,
    "issue",
  );
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
    maxSegments: evidence.maxSegments ?? 1,
    seed: evidence.seed!,
    reportOnStop: false,
    reportOnQualityFailure: false,
    qualityFloor: {
      ...evidence.policy,
      personas: evidence.policy.personas ?? personas,
    },
    pretty: false,
  }, {}, {
    state: frozenSource.state,
    selectedEntry: frozenSource.sourceLogEntry,
    sourceEntries: frozenSource.sourceLogEntry,
    mode: "checkpoint",
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
    semanticActivityCounts: lane.path.semanticActivityCounts,
    semanticActivityActionCounts: lane.path.semanticActivityActionCounts,
    semanticActivityObjectives: lane.path.semanticActivityObjectives,
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

  const verification: PlaytestAuditVerification = {
    kind: "ai-audit",
    verifiedAt: new Date().toISOString(),
    issueCheckpointRevision: report.evidence.checkpoint!.revision,
    sessionPrefix: args.sessionPrefix,
    sourceRevision: audit.source.stateRevision,
    maxSteps: evidence.maxSteps!,
    maxSegments: evidence.maxSegments,
    seed: evidence.seed!,
    // Persist the exact frozen policy from the finding. The verification run
    // may add the original persona set internally to make the quality gate
    // evaluable, but that orchestration detail must not change the evidence
    // contract being proven.
    policy: evidence.policy,
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
      semanticActivityCounts: lane.semanticActivityCounts,
      semanticActivityActionCounts: lane.semanticActivityActionCounts,
      semanticActivityObjectives: lane.semanticActivityObjectives,
    })),
  };
  const resolved = await resolveVerifiedPlaytestReport({
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
  if (resolved.verification?.kind !== "ai-audit") {
    throw new Error(`Resolved AI audit report lost its verification: ${report.id}`);
  }
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
      verification: resolved.verification,
    },
  };
}
