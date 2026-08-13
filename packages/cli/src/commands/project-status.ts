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
    maxActivityRepetitions: number | null;
    maxActivityRepetition: {
      seed: number;
      persona: string;
      activityKind: string;
      count: number;
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
          maxActivityRepetitions:
            currentCertificate.certificate.audits[0]?.qualityGate?.policy.maxActivityRepetitions ?? null,
          maxActivityRepetition: currentCertificate.certificate.audits
            .flatMap((audit) => audit.qualityGate?.observed.maxActivityRepetition
              ? [{ seed: audit.seed, ...audit.qualityGate.observed.maxActivityRepetition }]
              : [])
            .sort((left, right) => right.count - left.count)[0] ?? null,
        }
      : {
          status: "uncertified" as const,
          inputRevision: null,
          certificateRevision: null,
          createdAt: null,
          endings: 0,
          paths: 0,
          seeds: [],
          maxActivityRepetitions: null,
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
