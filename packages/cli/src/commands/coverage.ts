import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ComposedState, Game } from "@rpg-harness/engine";
import { assertSessionName } from "@rpg-harness/session-store";
import { loadGame } from "../loader";
import { listSessions, sessionDir } from "../session";

export type CoverageStatus =
  | "completed"
  | "started"
  | "uncovered"
  | "ignored";

export interface ScriptCoverageRow {
  id: string;
  title: string;
  status: CoverageStatus;
  completedSessions: string[];
  startedSessions: string[];
  ignoreReason?: string;
}

export interface ScriptCoverageReport {
  summary: {
    total: number;
    tracked: number;
    completed: number;
    started: number;
    uncovered: number;
    ignored: number;
    completionPercent: number;
  };
  sessions: string[];
  sessionErrors: Array<{ session: string; error: string }>;
  scripts: ScriptCoverageRow[];
}

interface CoverageArgs {
  gameDir: string;
  session?: string;
  status: "pending" | CoverageStatus | "all";
  format: "table" | "json";
}

export async function coverageCommand(args: CoverageArgs): Promise<void> {
  const report = await collectScriptCoverage(args.gameDir, args.session);
  const scripts = report.scripts.filter((row) =>
    args.status === "all"
      ? true
      : args.status === "pending"
        ? row.status === "started" || row.status === "uncovered"
        : row.status === args.status,
  );
  if (args.format === "json") {
    process.stdout.write(JSON.stringify({ ...report, scripts }, null, 2) + "\n");
    return;
  }
  process.stdout.write(formatScriptCoverage(report, scripts));
}

export async function collectScriptCoverage(
  gameDir: string,
  onlySession?: string,
): Promise<ScriptCoverageReport> {
  if (onlySession !== undefined) assertSessionName(onlySession);
  const game = await loadGame(gameDir);
  const names = onlySession === undefined ? await listSessions(gameDir) : [onlySession];
  const states: Array<{ session: string; state: ComposedState }> = [];
  const sessionErrors: Array<{ session: string; error: string }> = [];
  for (const session of names) {
    try {
      const state = JSON.parse(
        await readFile(path.join(sessionDir(gameDir, session), "state.json"), "utf-8"),
      ) as ComposedState;
      states.push({ session, state });
    } catch (error) {
      if (
        onlySession === undefined &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        continue;
      }
      sessionErrors.push({ session, error: (error as Error).message });
    }
  }
  return analyzeScriptCoverage(game, states, sessionErrors);
}

export function analyzeScriptCoverage(
  game: Game,
  states: Array<{ session: string; state: ComposedState }>,
  sessionErrors: Array<{ session: string; error: string }> = [],
): ScriptCoverageReport {
  const scripts = game.scripts.map((script): ScriptCoverageRow => {
    const completedSessions = states
      .filter(({ state }) =>
        state.baseline.scripts[script.id]?.completed === true ||
        state.baseline.completionOrder.includes(script.id),
      )
      .map(({ session }) => session)
      .sort();
    const startedSessions = states
      .filter(({ session, state }) =>
        state.baseline.currentScriptId === script.id &&
        !completedSessions.includes(session),
      )
      .map(({ session }) => session)
      .sort();
    const status: CoverageStatus = script.coverage?.ignore
      ? "ignored"
      : completedSessions.length > 0
        ? "completed"
        : startedSessions.length > 0
          ? "started"
          : "uncovered";
    return {
      id: script.id,
      title: script.title,
      status,
      completedSessions,
      startedSessions,
      ...(script.coverage?.reason ? { ignoreReason: script.coverage.reason } : {}),
    };
  });
  scripts.sort((a, b) => a.id.localeCompare(b.id));
  const count = (status: CoverageStatus) =>
    scripts.filter((row) => row.status === status).length;
  const ignored = count("ignored");
  const tracked = scripts.length - ignored;
  const completed = count("completed");
  return {
    summary: {
      total: scripts.length,
      tracked,
      completed,
      started: count("started"),
      uncovered: count("uncovered"),
      ignored,
      completionPercent:
        tracked === 0 ? 100 : Math.round((completed / tracked) * 10_000) / 100,
    },
    sessions: states.map(({ session }) => session).sort(),
    sessionErrors,
    scripts,
  };
}

function formatScriptCoverage(
  report: ScriptCoverageReport,
  scripts: ScriptCoverageRow[],
): string {
  const lines = [
    `Story coverage: ${report.summary.completed}/${report.summary.tracked} completed (${report.summary.completionPercent}%) · ${report.summary.started} started · ${report.summary.uncovered} uncovered · ${report.summary.ignored} ignored`,
  ];
  if (scripts.length === 0) lines.push("(no matching scripts)");
  else {
    const idWidth = Math.max("ID".length, ...scripts.map((row) => row.id.length));
    const statusWidth = Math.max("STATUS".length, ...scripts.map((row) => row.status.length));
    lines.push(`${"STATUS".padEnd(statusWidth)}  ${"ID".padEnd(idWidth)}  TITLE  SESSIONS`);
    for (const row of scripts) {
      const sessions =
        row.status === "completed"
          ? row.completedSessions.join(",")
          : row.status === "started"
            ? row.startedSessions.join(",")
            : row.ignoreReason ?? "—";
      lines.push(
        `${row.status.padEnd(statusWidth)}  ${row.id.padEnd(idWidth)}  ${row.title}  ${sessions || "—"}`,
      );
    }
  }
  if (report.sessionErrors.length > 0) {
    lines.push("", "SESSION ERRORS");
    for (const error of report.sessionErrors) {
      lines.push(`  ${error.session}: ${error.error}`);
    }
  }
  return lines.join("\n") + "\n";
}
