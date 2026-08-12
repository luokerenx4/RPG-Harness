import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
  status: "open";
  session: string;
  area: PlaytestArea;
  severity: PlaytestSeverity;
  title: string;
  details?: string;
  target?: string;
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

export function formatPlaytestReports(reports: PlaytestReport[]): string {
  if (reports.length === 0) return "(no playtest reports)";
  const rows = reports.map((report) => [
    report.id,
    report.severity,
    report.area,
    report.session,
    report.evidence.currentScriptId ?? "—",
    report.title,
  ]);
  const headers = ["ID", "SEVERITY", "AREA", "SESSION", "SCRIPT", "TITLE"];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  return [headers, ...rows]
    .map((row) =>
      row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd(),
    )
    .join("\n");
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
      | { activities?: Array<{ id?: unknown; available?: unknown }> }
      | undefined;
    return {
      type,
      activities: (snapshot?.activities ?? []).map((activity) => ({
        id: activity.id ?? null,
        available: activity.available ?? null,
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
