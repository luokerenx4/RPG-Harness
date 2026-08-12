import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInitialState, type ComposedState } from "@rpg-harness/engine";
import {
  appendCheckpointedSessionEvent,
  assertSessionName,
  isSessionCheckpointRef,
  loadSessionCheckpoint,
  withSessionLock,
} from "@rpg-harness/session-store";
import { loadGame } from "../loader";
import { loadSession, saveSession, sessionDir } from "../session";

interface ForkArgs {
  gameDir: string;
  from: string;
  to: string;
  at?: number;
  pretty: boolean;
}

interface LoggedStep {
  input?: unknown;
  output?: unknown;
  checkpoint?: unknown;
}

export async function forkCommand(args: ForkArgs): Promise<void> {
  const result = await forkSession(args);
  process.stdout.write(
    (args.pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result)) + "\n",
  );
}

export async function forkSession(args: ForkArgs) {
  assertSessionName(args.from);
  assertSessionName(args.to);
  if (args.from === args.to) throw new Error("Source and target sessions must differ");
  if (args.at !== undefined && (!Number.isInteger(args.at) || args.at < 0)) {
    throw new Error("--at must be a non-negative 1-based log entry number");
  }
  const game = await loadGame(args.gameDir);
  const prepared = await withSessionLock(args.gameDir, args.from, async () => {
    const entries = await readLog(args.gameDir, args.from);
    const selectedEntry = args.at ?? entries.length;
    if (selectedEntry > entries.length) {
      throw new Error(
        `--at ${selectedEntry} exceeds source log length ${entries.length}`,
      );
    }

    if (selectedEntry === 0) {
      return {
        state: createInitialState(game),
        selectedEntry,
        sourceEntries: entries.length,
        mode: "initial-state" as const,
      };
    }
    const checkpoint = entries[selectedEntry - 1]?.checkpoint;
    if (isSessionCheckpointRef(checkpoint)) {
      const state = (await loadSessionCheckpoint(
        args.gameDir,
        args.from,
        checkpoint,
      )) as ComposedState;
      return {
        state,
        selectedEntry,
        sourceEntries: entries.length,
        mode: "checkpoint" as const,
      };
    }

    if (args.at === undefined) {
      const state = await loadSession(args.gameDir, args.from, game);
      return {
        state,
        selectedEntry,
        sourceEntries: entries.length,
        mode: "current-state" as const,
      };
    }
    throw new Error(
      `Log entry ${selectedEntry} has no recoverable checkpoint; legacy logs cannot be replayed exactly because RNG state was not recorded`,
    );
  });
  return createFork({ ...args, ...prepared });
}

async function createFork(args: ForkArgs & {
  state: ComposedState;
  selectedEntry: number;
  sourceEntries: number;
  mode: "checkpoint" | "initial-state" | "current-state";
}) {
  return withSessionLock(args.gameDir, args.to, async () => {
    await assertTargetEmpty(args.gameDir, args.to);
    await saveSession(args.gameDir, args.to, args.state);
    const provenance = {
      schemaVersion: 1,
      fromSession: args.from,
      sourceLogEntry: args.selectedEntry,
      sourceLogEntries: args.sourceEntries,
      mode: args.mode,
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
      { t: Date.now(), source: "fork", fork: provenance },
      args.state,
    );
    return { session: args.to, ...provenance };
  });
}

async function readLog(gameDir: string, session: string): Promise<LoggedStep[]> {
  try {
    return (await readFile(path.join(sessionDir(gameDir, session), "log.jsonl"), "utf-8"))
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line, index) => {
        try {
          return JSON.parse(line) as LoggedStep;
        } catch (error) {
          throw new Error(`Invalid JSON in log entry ${index + 1}: ${(error as Error).message}`);
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function assertTargetEmpty(gameDir: string, session: string): Promise<void> {
  for (const file of ["state.json", "log.jsonl", "fork.json", "checkpoints"]) {
    try {
      await access(path.join(sessionDir(gameDir, session), file));
      throw new Error(`Target session already exists: ${session}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
