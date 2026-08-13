import { createHash } from "node:crypto";
import { collectDevelopmentWorklist } from "./worklist";
import { findCurrentQualityAuditCertificate } from "./quality-certificate";

export interface ProjectDevelopmentStatus {
  revision: string;
  worklist: {
    total: number;
    executable: number;
    diagnostic: number;
    authoring: number;
    highestPriority: "P0" | "P1" | "P2" | "P3" | null;
    next: { key: string; title: string } | null;
  };
  quality: {
    status: "certified" | "uncertified";
    inputRevision: string | null;
    certificateRevision: string | null;
    createdAt: string | null;
    endings: number;
    paths: number;
    seeds: number[];
    fuzzPersonas: string[];
    fuzzLanes: number;
    fuzzMaxDecisions: { seed: number; persona: string; decisions: number } | null;
    maxActivityRepetitions: number | null;
    maxActivityRepetitionsByKind: Record<string, number> | null;
    maxActivityRepetition: {
      seed: number;
      persona: string;
      activityKind: string;
      count: number;
      limit: number;
      objectiveIds?: string[];
    } | null;
  };
}

export async function collectProjectDevelopmentStatus(
  gameDir: string,
): Promise<ProjectDevelopmentStatus> {
  const [worklist, currentCertificate] = await Promise.all([
    collectDevelopmentWorklist(gameDir),
    findCurrentQualityAuditCertificate(gameDir),
  ]);
  const status = {
    worklist: {
      total: worklist.summary.total,
      executable: worklist.summary.byActionability.executable,
      diagnostic: worklist.summary.byActionability.diagnostic,
      authoring: worklist.summary.byActionability.authoring,
      highestPriority: worklist.items[0]?.priority ?? null,
      next: worklist.items[0]
        ? { key: worklist.items[0].key, title: worklist.items[0].title }
        : null,
    },
    quality: currentCertificate
      ? {
          status: "certified" as const,
          inputRevision: currentCertificate.certificate.inputRevision,
          certificateRevision: currentCertificate.certificate.revision,
          createdAt: currentCertificate.certificate.createdAt,
          endings: Math.min(...currentCertificate.certificate.audits.map(
            (audit) => audit.diversity.uniqueEndings,
          )),
          paths: Math.min(...currentCertificate.certificate.audits.map(
            (audit) => audit.diversity.uniqueDecisionPaths,
          )),
          seeds: currentCertificate.certificate.audits.map((audit) => audit.seed),
          fuzzPersonas:
            currentCertificate.certificate.audits[0]?.qualityGate?.policy.fuzzPersonas ?? [],
          fuzzLanes: currentCertificate.certificate.fuzzAudits.reduce(
            (total, audit) => total + audit.lanes.length,
            0,
          ),
          fuzzMaxDecisions: currentCertificate.certificate.fuzzAudits
            .flatMap((audit) => audit.lanes.map((lane) => ({
              seed: audit.seed,
              persona: lane.persona,
              decisions: lane.decisions,
            })))
            .sort((left, right) =>
              right.decisions - left.decisions ||
              left.seed - right.seed ||
              left.persona.localeCompare(right.persona)
            )[0] ?? null,
          maxActivityRepetitions:
            currentCertificate.certificate.audits[0]?.qualityGate?.policy.maxActivityRepetitions ?? null,
          maxActivityRepetitionsByKind:
            currentCertificate.certificate.audits[0]?.qualityGate?.policy
              .maxActivityRepetitionsByKind ?? null,
          maxActivityRepetition: currentCertificate.certificate.audits
            .flatMap((audit) => audit.qualityGate?.observed.maxActivityRepetition
              ? [{ seed: audit.seed, ...audit.qualityGate.observed.maxActivityRepetition }]
              : [])
            .sort((left, right) =>
              right.count * left.limit - left.count * right.limit ||
              right.count - left.count ||
              left.seed - right.seed ||
              left.persona.localeCompare(right.persona) ||
              left.activityKind.localeCompare(right.activityKind)
            )[0] ?? null,
        }
      : {
          status: "uncertified" as const,
          inputRevision: null,
          certificateRevision: null,
          createdAt: null,
          endings: 0,
          paths: 0,
          seeds: [],
          fuzzPersonas: [],
          fuzzLanes: 0,
          fuzzMaxDecisions: null,
          maxActivityRepetitions: null,
          maxActivityRepetitionsByKind: null,
          maxActivityRepetition: null,
        },
  };
  return {
    revision: createHash("sha256")
      .update(JSON.stringify(status))
      .digest("hex")
      .slice(0, 16),
    ...status,
  };
}

export async function projectStatusCommand(
  gameDir: string,
  pretty: boolean,
): Promise<void> {
  const status = await collectProjectDevelopmentStatus(gameDir);
  process.stdout.write(JSON.stringify(status, null, pretty ? 2 : undefined) + "\n");
}
