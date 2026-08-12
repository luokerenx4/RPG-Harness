import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { sessionDir } from "./session";

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

export interface PlaytestEvidence {
  statePath: string;
  logPath: string;
  logEntry: number | null;
  currentScriptId: string | null;
  lastCompletedScriptId: string | null;
  lastEvent: {
    input: unknown;
    output: unknown;
  } | null;
  captureErrors?: string[];
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
  evidence: PlaytestEvidence;
}

export interface RecordPlaytestReportArgs {
  gameDir: string;
  session: string;
  area: PlaytestArea;
  severity: PlaytestSeverity;
  title: string;
  details?: string;
  target?: string;
}

export interface ResolvePlaytestReportArgs {
  gameDir: string;
  id: string;
  session?: string;
  resolution?: string;
}

export async function recordPlaytestReport(
  args: RecordPlaytestReportArgs,
): Promise<PlaytestReport> {
  assertSessionName(args.session);
  if (!args.title.trim()) throw new Error("Playtest report title cannot be empty");

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
    evidence: await captureEvidence(args.gameDir, args.session),
  };

  const dir = sessionDir(args.gameDir, args.session);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, REPORTS_FILE), JSON.stringify(report) + "\n", {
    flag: "a",
  });
  return report;
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

  try {
    const state = JSON.parse(await readFile(stateFile, "utf-8")) as {
      baseline?: {
        currentScriptId?: unknown;
        completionOrder?: unknown;
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
      } | null;
      if (entry) {
        lastEvent = {
          input: entry.input ?? null,
          output: compactOutput(entry.output),
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
    ...(captureErrors.length > 0 ? { captureErrors } : {}),
  };
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

function assertSessionName(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error(`Invalid session name: ${JSON.stringify(name)}`);
  }
}
