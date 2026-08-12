import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export interface SessionCheckpointRef {
  schemaVersion: 1;
  file: string;
  revision: string;
}

export interface CheckpointedSessionEvent {
  checkpoint: SessionCheckpointRef;
  [key: string]: unknown;
}

export interface SessionLockOptions {
  timeoutMs?: number;
  staleAfterMs?: number;
  retryMs?: number;
}

// Cross-process transaction boundary shared by `rpgh step` and the local Web
// bridge. mkdir is atomic on the filesystem; holding this directory covers the
// entire read → engine transition → state/log write transaction, not only the
// final rename. That makes the Web revision check a real CAS against CLI writes.
export async function withSessionLock<T>(
  gameDir: string,
  session: string,
  operation: () => Promise<T>,
  options: SessionLockOptions = {},
): Promise<T> {
  assertSessionName(session);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleAfterMs = options.staleAfterMs ?? 30_000;
  const retryMs = options.retryMs ?? 20;
  const lockDir = path.join(
    gameDir,
    ".rpg-harness",
    "sessions",
    session,
    ".transaction-lock",
  );
  await mkdir(path.dirname(lockDir), { recursive: true });
  const started = Date.now();

  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await removeIfStale(lockDir, staleAfterMs)) continue;
      if (Date.now() - started >= timeoutMs) {
        throw new Error(
          `Timed out waiting for session transaction lock: ${session}`,
        );
      }
      await delay(retryMs);
    }
  }

  try {
    return await operation();
  } finally {
    try {
      await rmdir(lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

// Call this while holding the session transaction lock. The immutable,
// content-addressed state file makes each log event a reproducible fork point
// without inflating log.jsonl with a full ComposedState on every line.
export async function appendCheckpointedSessionEvent(
  gameDir: string,
  session: string,
  event: Record<string, unknown>,
  state: unknown,
): Promise<SessionCheckpointRef> {
  assertSessionName(session);
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("checkpoint state must be a JSON object");
  }
  const serialized = JSON.stringify(state);
  const revision = createHash("sha256").update(serialized).digest("hex");
  const relativeFile = path.posix.join("checkpoints", `${revision}.json`);
  const dir = path.join(gameDir, ".rpg-harness", "sessions", session);
  const checkpointDir = path.join(dir, "checkpoints");
  const target = path.join(checkpointDir, `${revision}.json`);
  await mkdir(checkpointDir, { recursive: true });
  try {
    await stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const temporary = path.join(checkpointDir, `.${revision}-${randomUUID()}.tmp`);
    await writeFile(temporary, serialized, "utf-8");
    await rename(temporary, target);
  }
  const checkpoint: SessionCheckpointRef = {
    schemaVersion: 1,
    file: relativeFile,
    revision,
  };
  await appendFile(
    path.join(dir, "log.jsonl"),
    JSON.stringify({ ...event, checkpoint }) + "\n",
    "utf-8",
  );
  return checkpoint;
}

export async function loadSessionCheckpoint(
  gameDir: string,
  session: string,
  checkpoint: SessionCheckpointRef,
): Promise<unknown> {
  assertSessionName(session);
  assertCheckpointRef(checkpoint);
  const file = path.join(
    gameDir,
    ".rpg-harness",
    "sessions",
    session,
    ...checkpoint.file.split("/"),
  );
  const serialized = await readFile(file, "utf-8");
  const revision = createHash("sha256").update(serialized).digest("hex");
  if (revision !== checkpoint.revision) {
    throw new Error(
      `Session checkpoint revision mismatch: expected ${checkpoint.revision}, got ${revision}`,
    );
  }
  return JSON.parse(serialized) as unknown;
}

export function isSessionCheckpointRef(
  value: unknown,
): value is SessionCheckpointRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return (
    ref.schemaVersion === 1 &&
    typeof ref.revision === "string" &&
    /^[a-f0-9]{64}$/.test(ref.revision) &&
    ref.file === `checkpoints/${ref.revision}.json`
  );
}

function assertCheckpointRef(
  checkpoint: SessionCheckpointRef,
): void {
  if (!isSessionCheckpointRef(checkpoint)) {
    throw new Error("Invalid session checkpoint reference");
  }
}

async function removeIfStale(
  lockDir: string,
  staleAfterMs: number,
): Promise<boolean> {
  try {
    const lockStat = await stat(lockDir);
    if (Date.now() - lockStat.mtimeMs <= staleAfterMs) return false;
    await rmdir(lockDir);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
}

export function assertSessionName(name: string): void {
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
