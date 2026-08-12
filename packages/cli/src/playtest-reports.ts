import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  BehaviorCycleDiagnostic,
  ComposedState,
  StallDiagnostic,
} from "@rpg-harness/engine";
import {
  appendCheckpointedSessionEvent,
  assertSessionName,
  withSessionLock,
} from "@rpg-harness/session-store";
import { saveSession, sessionDir } from "./session";

export const PLAYTEST_AREAS = [
  "narrative",
  "gameplay",
  "engine",
  "ui",
  "tooling",
] as const;
export type PlaytestArea = (typeof PLAYTEST_AREAS)[number];

export const PLAYTEST_SEVERITIES = [
  "note",
  "minor",
  "major",
  "blocker",
] as const;
export type PlaytestSeverity = (typeof PLAYTEST_SEVERITIES)[number];

const REPORTS_FILE = "issues.jsonl";
const ISSUE_CHECKPOINTS_DIR = "issue-checkpoints";

export interface PlaytestCheckpointRef {
  schemaVersion: 1;
  file: string;
  revision: string;
}

export interface PlaytestEvidence {
  statePath: string;
  logPath: string;
  logEntry: number | null;
  currentScriptId: string | null;
  lastCompletedScriptId: string | null;
  lastEvent: {
    input: unknown;
    output: unknown;
    inputResult?: unknown;
  } | null;
  visualState?: {
    bg: string | null;
    portraits: Record<string, string | null>;
    cg: string | null;
  };
  checkpoint?: PlaytestCheckpointRef;
  stall?: StallDiagnostic;
  behaviorCycle?: BehaviorCycleDiagnostic;
  auditMatrix?: PlaytestAuditMatrixEvidence;
  captureErrors?: string[];
}

export interface PlaytestAuditMatrixEvidence {
  sourceRevision: string;
  sessionPrefix: string;
  /** Present on reports created after deterministic audit verification shipped. */
  maxSteps?: number;
  seed?: number;
  policy: {
    minUniqueEndings?: number;
    minUniqueDecisionPaths?: number;
  };
  observed: {
    uniqueEndings: number;
    uniqueDecisionPaths: number;
  };
  classification:
    | "identical-path"
    | "convergent-paths"
    | "divergent-endings"
    | "incomplete";
  violations: string[];
  lanes: Array<{
    persona: string;
    session: string;
    webPath: string;
    ending: string | null;
    reason: string;
    pathRevision: string;
  }>;
  choiceDivergences: Array<{
    scriptId: string;
    choiceId: string;
    selections: Array<{ optionId: string; personas: string[] }>;
    notReachedBy: string[];
  }>;
}

export interface PlaytestReport {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  status: "open" | "resolved";
  session: string;
  area: PlaytestArea;
  severity: PlaytestSeverity;
  title: string;
  details?: string;
  target?: string;
  resolvedAt?: string;
  resolution?: string;
  verification?: PlaytestVerification;
  evidence: PlaytestEvidence;
}

export interface PlaytestVerification {
  kind: "ai-audit";
  verifiedAt: string;
  sessionPrefix: string;
  sourceRevision: string;
  policy: {
    minUniqueEndings?: number;
    minUniqueDecisionPaths?: number;
  };
  observed: {
    uniqueEndings: number;
    uniqueDecisionPaths: number;
  };
  classification:
    | "identical-path"
    | "convergent-paths"
    | "divergent-endings";
  lanes: Array<{
    persona: string;
    session: string;
    webPath: string;
    ending: string;
    pathRevision: string;
  }>;
}

export interface RecordPlaytestReportArgs {
  gameDir: string;
  session: string;
  area: PlaytestArea;
  severity: PlaytestSeverity;
  title: string;
  details?: string;
  target?: string;
  stall?: StallDiagnostic;
  behaviorCycle?: BehaviorCycleDiagnostic;
  auditMatrix?: PlaytestAuditMatrixEvidence;
}

export interface ResolvePlaytestReportArgs {
  gameDir: string;
  id: string;
  session?: string;
  resolution?: string;
  verification?: PlaytestVerification;
}

export interface ReproducePlaytestReportArgs {
  gameDir: string;
  id: string;
  to: string;
  session?: string;
}

export async function recordPlaytestReport(
  args: RecordPlaytestReportArgs,
): Promise<PlaytestReport> {
  assertSessionName(args.session);
  if (!args.title.trim()) throw new Error("Playtest report title cannot be empty");
  return withSessionLock(args.gameDir, args.session, async () => {
    const createdAt = new Date().toISOString();
    const report: PlaytestReport = {
      schemaVersion: 1,
      id: `pt-${createdAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`,
      createdAt,
      status: "open",
      session: args.session,
      area: args.area,
      severity: args.severity,
      title: args.title.trim(),
      ...(args.details?.trim() ? { details: args.details.trim() } : {}),
      ...(args.target?.trim() ? { target: args.target.trim() } : {}),
      evidence: {
        ...await captureEvidence(args.gameDir, args.session),
        ...(args.stall ? { stall: args.stall } : {}),
        ...(args.behaviorCycle ? { behaviorCycle: args.behaviorCycle } : {}),
        ...(args.auditMatrix ? { auditMatrix: args.auditMatrix } : {}),
      },
    };

    const dir = sessionDir(args.gameDir, args.session);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, REPORTS_FILE), JSON.stringify(report) + "\n", {
      flag: "a",
    });
    return report;
  });
}

export async function listPlaytestReports(
  gameDir: string,
  session?: string,
): Promise<PlaytestReport[]> {
  if (session !== undefined) {
    assertSessionName(session);
    return readReportFile(path.join(sessionDir(gameDir, session), REPORTS_FILE));
  }

  const root = path.join(gameDir, ".rpg-harness", "sessions");
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const reports = (
    await Promise.all(
      names.map((name) =>
        readReportFile(path.join(sessionDir(gameDir, name), REPORTS_FILE)),
      ),
    )
  ).flat();
  return reports.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function resolvePlaytestReport(
  args: ResolvePlaytestReportArgs,
): Promise<PlaytestReport> {
  if (!args.id.trim()) throw new Error("Playtest report id cannot be empty");
  if (args.session !== undefined) assertSessionName(args.session);
  const files = await reportFiles(args.gameDir, args.session);
  const matches: Array<{
    file: string;
    index: number;
    reports: PlaytestReport[];
  }> = [];
  for (const file of files) {
    const reports = await readReportFile(file);
    const index = reports.findIndex((report) => report.id === args.id);
    if (index >= 0) matches.push({ file, index, reports });
  }
  if (matches.length === 0) {
    throw new Error(`Playtest report not found: ${args.id}`);
  }
  if (matches.length > 1) {
    throw new Error(`Duplicate playtest report id: ${args.id}`);
  }

  const match = matches[0]!;
  const current = match.reports[match.index]!;
  if (current.status === "resolved") return current;
  const resolved: PlaytestReport = {
    ...current,
    status: "resolved",
    resolvedAt: new Date().toISOString(),
    ...(args.resolution?.trim() ? { resolution: args.resolution.trim() } : {}),
    ...(args.verification ? { verification: args.verification } : {}),
  };
  match.reports[match.index] = resolved;
  const temporary = `${match.file}.${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    match.reports.map((report) => JSON.stringify(report)).join("\n") + "\n",
    "utf-8",
  );
  await rename(temporary, match.file);
  return resolved;
}

export async function getPlaytestReport(
  gameDir: string,
  id: string,
  session?: string,
): Promise<PlaytestReport> {
  if (!id.trim()) throw new Error("Playtest report id cannot be empty");
  if (session !== undefined) assertSessionName(session);
  const matches = (await listPlaytestReports(gameDir, session)).filter(
    (report) => report.id === id,
  );
  if (matches.length === 0) throw new Error(`Playtest report not found: ${id}`);
  if (matches.length > 1) throw new Error(`Duplicate playtest report id: ${id}`);
  return matches[0]!;
}

export async function reproducePlaytestReport(
  args: ReproducePlaytestReportArgs,
) {
  assertSessionName(args.to);
  const report = await getPlaytestReport(args.gameDir, args.id, args.session);
  const checkpoint = report.evidence.checkpoint;
  if (!isPlaytestCheckpointRef(checkpoint)) {
    throw new Error(
      `Playtest report ${report.id} has no recoverable checkpoint; record a new report at the issue site`,
    );
  }
  const state = await loadPlaytestCheckpoint(
    args.gameDir,
    report.session,
    checkpoint,
  ) as ComposedState;

  return withSessionLock(args.gameDir, args.to, async () => {
    await assertReproductionTargetEmpty(args.gameDir, args.to);
    await saveSession(args.gameDir, args.to, state);
    const provenance = {
      schemaVersion: 1,
      fromReport: report.id,
      fromSession: report.session,
      sourceLogEntry: report.evidence.logEntry,
      mode: "playtest-checkpoint" as const,
      createdAt: new Date().toISOString(),
    };
    await writeFile(
      path.join(sessionDir(args.gameDir, args.to), "fork.json"),
      JSON.stringify(provenance, null, 2) + "\n",
      "utf-8",
    );
    await appendCheckpointedSessionEvent(
      args.gameDir,
      args.to,
      { t: Date.now(), source: "playtest-report", report: provenance },
      state,
    );
    return {
      session: args.to,
      ...provenance,
      webPath: `/?session=${encodeURIComponent(args.to)}`,
    };
  });
}

export function formatPlaytestReports(reports: PlaytestReport[]): string {
  if (reports.length === 0) return "(no playtest reports)";
  const rows = reports.map((report) => [
    report.id,
    report.status,
    report.severity,
    report.area,
    report.session,
    report.evidence.currentScriptId ?? "—",
    report.title,
  ]);
  const headers = [
    "ID",
    "STATUS",
    "SEVERITY",
    "AREA",
    "SESSION",
    "SCRIPT",
    "TITLE",
  ];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  return [headers, ...rows]
    .map((row) =>
      row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd(),
    )
    .join("\n");
}

async function reportFiles(
  gameDir: string,
  session?: string,
): Promise<string[]> {
  if (session !== undefined) {
    return [path.join(sessionDir(gameDir, session), REPORTS_FILE)];
  }
  const root = path.join(gameDir, ".rpg-harness", "sessions");
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, REPORTS_FILE))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function captureEvidence(
  gameDir: string,
  session: string,
): Promise<PlaytestEvidence> {
  const dir = sessionDir(gameDir, session);
  const stateFile = path.join(dir, "state.json");
  const logFile = path.join(dir, "log.jsonl");
  const relativeRoot = path.join(".rpg-harness", "sessions", session);
  const captureErrors: string[] = [];
  let currentScriptId: string | null = null;
  let lastCompletedScriptId: string | null = null;
  let logEntry: number | null = null;
  let lastEvent: PlaytestEvidence["lastEvent"] = null;
  let visualState: PlaytestEvidence["visualState"];
  let checkpoint: PlaytestCheckpointRef | undefined;

  try {
    const serialized = await readFile(stateFile, "utf-8");
    const state = JSON.parse(serialized) as {
      baseline?: {
        currentScriptId?: unknown;
        completionOrder?: unknown;
        visuals?: unknown;
      };
    };
    if (typeof state.baseline?.currentScriptId === "string") {
      currentScriptId = state.baseline.currentScriptId;
    }
    const order = state.baseline?.completionOrder;
    if (Array.isArray(order)) {
      const last = order[order.length - 1];
      if (typeof last === "string") lastCompletedScriptId = last;
    }
    visualState = compactVisualState(state.baseline?.visuals);
    checkpoint = await persistPlaytestCheckpoint(gameDir, session, serialized);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      captureErrors.push(`state.json: ${(error as Error).message}`);
    }
  }

  try {
    const lines = (await readFile(logFile, "utf-8"))
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    if (lines.length > 0) {
      logEntry = lines.length;
      const entry = JSON.parse(lines[lines.length - 1] ?? "null") as {
        input?: unknown;
        output?: unknown;
        inputResult?: unknown;
      } | null;
      if (entry) {
        lastEvent = {
          input: entry.input ?? null,
          output: compactOutput(entry.output),
          ...(entry.inputResult !== undefined ? { inputResult: entry.inputResult } : {}),
        };
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      captureErrors.push(`log.jsonl: ${(error as Error).message}`);
    }
  }

  return {
    statePath: path.join(relativeRoot, "state.json"),
    logPath: path.join(relativeRoot, "log.jsonl"),
    logEntry,
    currentScriptId,
    lastCompletedScriptId,
    lastEvent,
    ...(visualState !== undefined ? { visualState } : {}),
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    ...(captureErrors.length > 0 ? { captureErrors } : {}),
  };
}

function compactVisualState(
  value: unknown,
): PlaytestEvidence["visualState"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const visuals = value as Record<string, unknown>;
  const bg = typeof visuals.bg === "string" ? visuals.bg : null;
  const cg = typeof visuals.cg === "string" ? visuals.cg : null;
  const portraits: Record<string, string | null> = {};
  if (
    visuals.portraits &&
    typeof visuals.portraits === "object" &&
    !Array.isArray(visuals.portraits)
  ) {
    for (const [slot, asset] of Object.entries(
      visuals.portraits as Record<string, unknown>,
    )) {
      if (typeof asset === "string" || asset === null) portraits[slot] = asset;
    }
  }
  return { bg, portraits, cg };
}

async function persistPlaytestCheckpoint(
  gameDir: string,
  session: string,
  serialized: string,
): Promise<PlaytestCheckpointRef> {
  const revision = createHash("sha256").update(serialized).digest("hex");
  const relativeFile = path.posix.join(
    ISSUE_CHECKPOINTS_DIR,
    `${revision}.json`,
  );
  const dir = path.join(sessionDir(gameDir, session), ISSUE_CHECKPOINTS_DIR);
  const target = path.join(dir, `${revision}.json`);
  await mkdir(dir, { recursive: true });
  try {
    await stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const temporary = path.join(dir, `.${revision}-${randomUUID()}.tmp`);
    await writeFile(temporary, serialized, "utf-8");
    await rename(temporary, target);
  }
  return { schemaVersion: 1, file: relativeFile, revision };
}

function isPlaytestCheckpointRef(
  value: unknown,
): value is PlaytestCheckpointRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return (
    ref.schemaVersion === 1 &&
    typeof ref.revision === "string" &&
    /^[a-f0-9]{64}$/.test(ref.revision) &&
    ref.file === `${ISSUE_CHECKPOINTS_DIR}/${ref.revision}.json`
  );
}

async function loadPlaytestCheckpoint(
  gameDir: string,
  session: string,
  checkpoint: PlaytestCheckpointRef,
): Promise<unknown> {
  if (!isPlaytestCheckpointRef(checkpoint)) {
    throw new Error("Invalid playtest checkpoint reference");
  }
  const serialized = await readFile(
    path.join(sessionDir(gameDir, session), ...checkpoint.file.split("/")),
    "utf-8",
  );
  const revision = createHash("sha256").update(serialized).digest("hex");
  if (revision !== checkpoint.revision) {
    throw new Error(
      `Playtest checkpoint revision mismatch: expected ${checkpoint.revision}, got ${revision}`,
    );
  }
  return JSON.parse(serialized) as unknown;
}

async function assertReproductionTargetEmpty(
  gameDir: string,
  session: string,
): Promise<void> {
  for (const file of [
    "state.json",
    "log.jsonl",
    "fork.json",
    "checkpoints",
    REPORTS_FILE,
    ISSUE_CHECKPOINTS_DIR,
  ]) {
    try {
      await access(path.join(sessionDir(gameDir, session), file));
      throw new Error(`Target session already exists: ${session}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function compactOutput(output: unknown): unknown {
  if (!output || typeof output !== "object") return output ?? null;
  const obj = output as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "unknown";
  if (type === "dialogue") {
    return pick(obj, ["type", "speakerId", "speakerName", "text"]);
  }
  if (type === "narration") return pick(obj, ["type", "text"]);
  if (type === "choice") return pick(obj, ["type", "prompt", "options"]);
  if (type === "hubMenu") {
    const snapshot = obj.snapshot as
      | {
          day?: unknown;
          maxDay?: unknown;
          slot?: unknown;
          slotName?: unknown;
          stats?: Array<{ id?: unknown; value?: unknown; max?: unknown }>;
          affections?: Array<{ id?: unknown; value?: unknown }>;
          objectives?: Array<{
            id?: unknown;
            title?: unknown;
            description?: unknown;
            status?: unknown;
            requirements?: unknown;
            relatedActivityIds?: unknown;
          }>;
          resourceGroups?: Array<{
            id: unknown;
            title: unknown;
            description?: unknown;
            resources: Array<{
              id: unknown;
              name: unknown;
              quantity: unknown;
            }>;
          }>;
          activities?: Array<{
            id?: unknown;
            title?: unknown;
            category?: unknown;
            available?: unknown;
            lockedReason?: unknown;
            requires?: unknown;
            forecast?: unknown;
          }>;
        }
      | undefined;
    return {
      type,
      day: snapshot?.day ?? null,
      maxDay: snapshot?.maxDay ?? null,
      slot: snapshot?.slot ?? null,
      slotName: snapshot?.slotName ?? null,
      stats: (snapshot?.stats ?? []).map((stat) => ({
        id: stat.id ?? null,
        value: stat.value ?? null,
        max: stat.max ?? null,
      })),
      affections: (snapshot?.affections ?? []).map((affection) => ({
        id: affection.id ?? null,
        value: affection.value ?? null,
      })),
      ...(snapshot?.objectives !== undefined
        ? {
            objectives: snapshot.objectives.map((objective) => ({
              id: objective.id ?? null,
              title: objective.title ?? null,
              description: objective.description ?? null,
              status: objective.status ?? null,
              requirements: objective.requirements ?? [],
              relatedActivityIds: objective.relatedActivityIds ?? [],
            })),
          }
        : {}),
      ...(snapshot?.resourceGroups !== undefined
        ? {
            resourceGroups: snapshot.resourceGroups.map((group) => ({
              id: group.id,
              title: group.title,
              description: group.description ?? null,
              resources: group.resources.map((resource) => ({
                id: resource.id,
                name: resource.name,
                quantity: resource.quantity,
              })),
            })),
          }
        : {}),
      activities: (snapshot?.activities ?? []).map((activity) => ({
        id: activity.id ?? null,
        title: activity.title ?? null,
        category: activity.category ?? null,
        available: activity.available ?? null,
        ...(activity.forecast !== undefined
          ? { forecast: activity.forecast }
          : {}),
        ...(activity.lockedReason !== undefined
          ? { lockedReason: activity.lockedReason }
          : {}),
        ...(activity.requires !== undefined
          ? { requires: activity.requires }
          : {}),
      })),
    };
  }
  return pick(obj, [
    "type",
    "scriptId",
    "reason",
    "endingId",
    "nextAvailable",
    "text",
  ]);
}

function pick(
  source: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

async function readReportFile(file: string): Promise<PlaytestReport[]> {
  let content: string;
  try {
    content = await readFile(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as PlaytestReport;
      } catch (error) {
        throw new Error(`${file}:${index + 1}: invalid report JSON — ${(error as Error).message}`);
      }
    });
}
