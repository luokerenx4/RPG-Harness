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
          endings: currentCertificate.certificate.audit.diversity.uniqueEndings,
          paths: currentCertificate.certificate.audit.diversity.uniqueDecisionPaths,
        }
      : {
          status: "uncertified" as const,
          inputRevision: null,
          certificateRevision: null,
          createdAt: null,
          endings: 0,
          paths: 0,
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
