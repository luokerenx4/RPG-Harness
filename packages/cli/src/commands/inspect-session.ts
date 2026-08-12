import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ComposedState } from "@rpg-harness/engine";
import {
  assertSessionName,
  isSessionCheckpointRef,
  loadSessionCheckpoint,
} from "@rpg-harness/session-store";
import { sessionDir } from "../session";
import type { LoggedStep } from "./fork";

export interface InspectSessionArgs {
  gameDir: string;
  session: string;
  surfaces?: Array<"state" | "log">;
  pretty: boolean;
}

export interface SessionInspection {
  session: string;
  requestedSurfaces: Array<"state" | "log">;
  state: {
    path: string;
    status: "valid" | "missing" | "invalid";
    error: string | null;
    currentScriptId: string | null;
    completedScriptCount: number | null;
  };
  log: {
    path: string;
    status: "valid" | "missing" | "invalid";
    error: string | null;
    entries: number;
    validEntries: number;
    invalidEntries: Array<{ entry: number; error: string }>;
  };
  recovery: {
    currentStateReadable: boolean;
    latestCheckpoint: {
      logEntry: number;
      file: string;
      revision: string;
      valid: boolean;
      error: string | null;
    } | null;
    note: string;
  };
  evaluation: "read-only";
}

export async function inspectSessionCommand(args: InspectSessionArgs): Promise<void> {
  const inspection = await inspectSession(args);
  process.stdout.write(
    (args.pretty
      ? JSON.stringify(inspection, null, 2)
      : JSON.stringify(inspection)) + "\n",
  );
}

export async function inspectSession(args: InspectSessionArgs): Promise<SessionInspection> {
  assertSessionName(args.session);
  const root = sessionDir(args.gameDir, args.session);
  const statePath = path.join(root, "state.json");
  const logPath = path.join(root, "log.jsonl");
  const state = await inspectState(statePath);
  const log = await inspectLog(logPath);

  let latestCheckpoint: SessionInspection["recovery"]["latestCheckpoint"] = null;
  for (let index = log.parsed.length - 1; index >= 0; index -= 1) {
    const checkpoint = log.parsed[index]?.checkpoint;
    if (!isSessionCheckpointRef(checkpoint)) continue;
    try {
      await loadSessionCheckpoint(args.gameDir, args.session, checkpoint);
      latestCheckpoint = {
        logEntry: index + 1,
        file: checkpoint.file,
        revision: checkpoint.revision,
        valid: true,
        error: null,
      };
    } catch (error) {
      latestCheckpoint = {
        logEntry: index + 1,
        file: checkpoint.file,
        revision: checkpoint.revision,
        valid: false,
        error: (error as Error).message,
      };
    }
    break;
  }

  const currentStateReadable = state.result.status === "valid";
  const checkpointReadable = latestCheckpoint?.valid === true;
  const recoveryLogEntry = latestCheckpoint?.logEntry ?? null;
  const note = currentStateReadable && log.result.status === "valid"
    ? "State and log are readable; no session repair is indicated."
    : checkpointReadable && log.result.status === "valid"
      ? `The current state is unreadable, but log entry ${recoveryLogEntry} is a verified recovery point; fork that entry into a new session instead of overwriting this one.`
      : checkpointReadable
        ? `A verified checkpoint exists at log entry ${recoveryLogEntry}, but malformed log data prevents normal fork replay; preserve the session and repair the JSONL evidence before recovery.`
        : currentStateReadable
          ? "The current state is readable, but the log has no verified recovery point; preserve state.json and repair or quarantine the log before continuing."
          : "No readable current state or verified checkpoint was found; preserve the directory for manual diagnosis and do not overwrite it."

  return {
    session: args.session,
    requestedSurfaces: args.surfaces ?? ["state", "log"],
    state: state.result,
    log: log.result,
    recovery: { currentStateReadable, latestCheckpoint, note },
    evaluation: "read-only",
  };
}

async function inspectState(file: string): Promise<{
  result: SessionInspection["state"];
}> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf-8")) as ComposedState;
    if (!parsed || typeof parsed !== "object" || !parsed.baseline) {
      throw new Error("state root must be an object with baseline state");
    }
    return {
      result: {
        path: file,
        status: "valid",
        error: null,
        currentScriptId: parsed.baseline.currentScriptId ?? null,
        completedScriptCount: parsed.baseline.completionOrder?.length ?? 0,
      },
    };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      result: {
        path: file,
        status: missing ? "missing" : "invalid",
        error: missing ? null : (error as Error).message,
        currentScriptId: null,
        completedScriptCount: null,
      },
    };
  }
}

async function inspectLog(file: string): Promise<{
  result: SessionInspection["log"];
  parsed: Array<LoggedStep | null>;
}> {
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        result: {
          path: file,
          status: "missing",
          error: null,
          entries: 0,
          validEntries: 0,
          invalidEntries: [],
        },
        parsed: [],
      };
    }
    throw error;
  }

  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const parsed: Array<LoggedStep | null> = [];
  const invalidEntries: Array<{ entry: number; error: string }> = [];
  for (const [index, line] of lines.entries()) {
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("log entry must be a JSON object");
      }
      parsed.push(value as LoggedStep);
    } catch (error) {
      parsed.push(null);
      invalidEntries.push({ entry: index + 1, error: (error as Error).message });
    }
  }
  return {
    result: {
      path: file,
      status: invalidEntries.length > 0 ? "invalid" : "valid",
      error: invalidEntries.length > 0
        ? `${invalidEntries.length} malformed log entr${invalidEntries.length === 1 ? "y" : "ies"}`
        : null,
      entries: lines.length,
      validEntries: lines.length - invalidEntries.length,
      invalidEntries,
    },
    parsed,
  };
}
