import { randomUUID } from "node:crypto";
import { access, readFile, rename, writeFile } from "node:fs/promises";
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

export interface ForkArgs {
  gameDir: string;
  from: string;
  to: string;
  at?: number;
  pretty: boolean;
}

export interface LoggedStep {
  t?: unknown;
  source?: unknown;
  input?: unknown;
  output?: unknown;
  decision?: unknown;
  activityDecision?: unknown;
  inputResult?: unknown;
  checkpoint?: unknown;
  fork?: unknown;
}

export interface ForkSource {
  state: ComposedState;
  selectedEntry: number;
  sourceEntries: number;
  mode: "checkpoint" | "initial-state" | "current-state";
}

export interface CreateForkFromSourceHooks {
  /** Runs after state, provenance, and the fork log are written, while the target lock is held. */
  onCreatedWhileLocked?: () => void | Promise<void>;
}

export interface DevelopmentBranchHandoff {
  schemaVersion: 1;
  workKey: string;
  priority: "P0" | "P1" | "P2" | "P3";
  kind: string;
  title: string;
  operation: string;
  state: "target-reached" | "closest" | "reproduced" | "covered";
  preparedAt: string;
  target?: string;
  coordinates?: {
    reportId?: string;
    scriptId?: string;
    choiceId?: string;
    optionId?: string;
  };
  /** Narrative context injected when this fork starts after an AI selection. */
  premiere?: {
    prompt?: string;
    optionText: string;
  };
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
  const prepared = await loadForkSource(args.gameDir, args.from, args.at);
  return createForkFromSource(args, prepared);
}

export async function loadForkSource(
  gameDir: string,
  from: string,
  at?: number,
): Promise<ForkSource> {
  assertSessionName(from);
  if (at !== undefined && (!Number.isInteger(at) || at < 0)) {
    throw new Error("--at must be a non-negative 1-based log entry number");
  }
  const game = await loadGame(gameDir);
  return withSessionLock(gameDir, from, async () => {
    const entries = await readSessionLog(gameDir, from);
    const selectedEntry = at ?? entries.length;
    if (selectedEntry > entries.length) {
      throw new Error(
        `--at ${selectedEntry} exceeds source log length ${entries.length}`,
      );
    }

    // No log does not mean no save: GUI/TUI may have persisted state before
    // their first checkpointed input. With no explicit --at, fork that current
    // state. Only `--at 0` means "start from a fresh initial state".
    if (selectedEntry === 0 && at === undefined) {
      const state = await loadSession(gameDir, from, game);
      return {
        state,
        selectedEntry,
        sourceEntries: entries.length,
        mode: "current-state" as const,
      };
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
        gameDir,
        from,
        checkpoint,
      )) as ComposedState;
      return {
        state,
        selectedEntry,
        sourceEntries: entries.length,
        mode: "checkpoint" as const,
      };
    }

    if (at === undefined) {
      const state = await loadSession(gameDir, from, game);
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
}

export async function createForkFromSource(
  args: ForkArgs,
  source: ForkSource,
  hooks: CreateForkFromSourceHooks = {},
) {
  assertSessionName(args.from);
  assertSessionName(args.to);
  if (args.from === args.to) throw new Error("Source and target sessions must differ");
  return withSessionLock(args.gameDir, args.to, () =>
    createForkFromSourceWithLockHeld(args, source, hooks)
  );
}

/**
 * Initialize a fork while the caller already owns the target session lock.
 * This is the atomic seam used by autoplay: fork publication and the first
 * engine transition must share one transaction so no GUI step can interleave.
 */
export async function createForkFromSourceWithLockHeld(
  args: ForkArgs,
  source: ForkSource,
  hooks: CreateForkFromSourceHooks = {},
) {
  assertSessionName(args.from);
  assertSessionName(args.to);
  if (args.from === args.to) throw new Error("Source and target sessions must differ");
  await assertTargetEmpty(args.gameDir, args.to);
  await saveSession(args.gameDir, args.to, source.state);
  const provenance = {
    schemaVersion: 1,
    fromSession: args.from,
    sourceLogEntry: source.selectedEntry,
    sourceLogEntries: source.sourceEntries,
    mode: source.mode,
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
    source.state,
  );
  await hooks.onCreatedWhileLocked?.();
  return { session: args.to, ...provenance };
}

/**
 * Attach the coding-work intent to an already materialized branch. The save
 * state remains untouched; Web can project this advisory metadata alongside
 * the exact fork provenance when handing the branch to a player.
 */
export async function attachDevelopmentBranchHandoff(
  gameDir: string,
  session: string,
  handoff: DevelopmentBranchHandoff,
): Promise<DevelopmentBranchHandoff> {
  assertSessionName(session);
  return withSessionLock(gameDir, session, async () => {
    const file = path.join(sessionDir(gameDir, session), "fork.json");
    const value = JSON.parse(await readFile(file, "utf-8")) as Record<string, unknown>;
    if (value.schemaVersion !== 1 || typeof value.fromSession !== "string") {
      throw new Error(`Cannot attach development handoff to invalid fork: ${session}`);
    }
    const temporary = path.join(
      sessionDir(gameDir, session),
      `.fork-${randomUUID()}.tmp`,
    );
    await writeFile(
      temporary,
      JSON.stringify({ ...value, handoff }, null, 2) + "\n",
      "utf-8",
    );
    await rename(temporary, file);
    return handoff;
  });
}

export async function loadDevelopmentBranchHandoff(
  gameDir: string,
  session: string,
): Promise<DevelopmentBranchHandoff | null> {
  assertSessionName(session);
  try {
    const value = JSON.parse(await readFile(
      path.join(sessionDir(gameDir, session), "fork.json"),
      "utf-8",
    )) as Record<string, unknown>;
    const handoff = value.handoff as DevelopmentBranchHandoff | undefined;
    if (handoff?.schemaVersion !== 1) return null;
    if (
      handoff.premiere !== undefined &&
      (
        !handoff.premiere ||
        typeof handoff.premiere.optionText !== "string" ||
        !handoff.premiere.optionText.trim() ||
        (handoff.premiere.prompt !== undefined &&
          (typeof handoff.premiere.prompt !== "string" || !handoff.premiere.prompt.trim()))
      )
    ) throw new Error(`Invalid premiere handoff for session: ${session}`);
    return handoff;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readSessionLog(
  gameDir: string,
  session: string,
): Promise<LoggedStep[]> {
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

export async function assertTargetEmpty(gameDir: string, session: string): Promise<void> {
  for (const file of ["state.json", "log.jsonl", "fork.json", "co-play.json", "checkpoints"]) {
    try {
      await access(path.join(sessionDir(gameDir, session), file));
      throw new Error(`Target session already exists: ${session}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
