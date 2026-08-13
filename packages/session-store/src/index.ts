import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
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

export interface CompactSessionCheckpointsOptions {
  apply?: boolean;
}

export interface SessionCheckpointCompactionSummary {
  mode: "dry-run" | "apply";
  legacyFiles: number;
  uniqueRevisions: number;
  objectsAlreadyPresent: number;
  objectsCreated: number;
  legacyFilesRemoved: number;
  legacyBytes: number;
  objectBytesRequired: number;
  reclaimableBytes: number;
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
  await mkdir(dir, { recursive: true });
  await persistCheckpointObject(gameDir, revision, serialized);
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
  const objectFile = checkpointObjectFile(gameDir, checkpoint.revision);
  let serialized: string;
  try {
    serialized = await readVerifiedCheckpoint(objectFile, checkpoint.revision);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A development workspace may be compacted while an older GUI process is
    // still alive. The legacy location is only a migration source; all new
    // writes go to the project object store.
    const legacyFile = path.join(
      gameDir,
      ".rpg-harness",
      "sessions",
      session,
      ...checkpoint.file.split("/"),
    );
    serialized = await readVerifiedCheckpoint(legacyFile, checkpoint.revision);
  }
  return JSON.parse(serialized) as unknown;
}

// Consolidate pre-object-store checkpoint files without rewriting immutable
// session logs. The entire source set is hash-verified before --apply mutates
// anything, and every global object is durable and verified before its legacy
// copies are unlinked, so an interrupted run is safe to resume.
export async function compactSessionCheckpoints(
  gameDir: string,
  options: CompactSessionCheckpointsOptions = {},
): Promise<SessionCheckpointCompactionSummary> {
  const apply = options.apply ?? false;
  const sources = await collectLegacyCheckpointFiles(gameDir);
  const byRevision = new Map<string, LegacyCheckpointFile[]>();
  let legacyBytes = 0;
  for (const source of sources) {
    const serialized = await readVerifiedCheckpoint(source.file, source.revision);
    const bytes = Buffer.byteLength(serialized);
    source.bytes = bytes;
    legacyBytes += bytes;
    const group = byRevision.get(source.revision) ?? [];
    group.push(source);
    byRevision.set(source.revision, group);
  }

  let objectsAlreadyPresent = 0;
  let objectBytesRequired = 0;
  const missing = new Set<string>();
  for (const [revision, group] of byRevision) {
    const target = checkpointObjectFile(gameDir, revision);
    try {
      await readVerifiedCheckpoint(target, revision);
      objectsAlreadyPresent += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.add(revision);
      objectBytesRequired += group[0]?.bytes ?? 0;
    }
  }

  let objectsCreated = 0;
  let legacyFilesRemoved = 0;
  if (apply) {
    for (const [revision, group] of byRevision) {
      if (missing.has(revision)) {
        const source = group[0];
        if (!source) continue;
        const serialized = await readVerifiedCheckpoint(source.file, revision);
        await persistCheckpointObject(gameDir, revision, serialized);
        await readVerifiedCheckpoint(checkpointObjectFile(gameDir, revision), revision);
        objectsCreated += 1;
      }
      for (const source of group) {
        await unlink(source.file);
        legacyFilesRemoved += 1;
      }
    }
    for (const directory of new Set(sources.map((source) => path.dirname(source.file)))) {
      try {
        await rmdir(directory);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
      }
    }
  }

  return {
    mode: apply ? "apply" : "dry-run",
    legacyFiles: sources.length,
    uniqueRevisions: byRevision.size,
    objectsAlreadyPresent,
    objectsCreated,
    legacyFilesRemoved,
    legacyBytes,
    objectBytesRequired,
    reclaimableBytes: legacyBytes - objectBytesRequired,
  };
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

interface LegacyCheckpointFile {
  file: string;
  revision: string;
  bytes: number;
}

async function collectLegacyCheckpointFiles(
  gameDir: string,
): Promise<LegacyCheckpointFile[]> {
  const sessionsRoot = path.join(gameDir, ".rpg-harness", "sessions");
  let sessions;
  try {
    sessions = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const sources: LegacyCheckpointFile[] = [];
  for (const session of sessions.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!session.isDirectory()) continue;
    const directory = path.join(sessionsRoot, session.name, "checkpoints");
    let files;
    try {
      files = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile()) continue;
      const match = /^([a-f0-9]{64})\.json$/.exec(file.name);
      if (!match?.[1]) {
        if (file.name.endsWith(".json")) {
          throw new Error(
            `Invalid legacy checkpoint filename: ${path.join(directory, file.name)}`,
          );
        }
        continue;
      }
      sources.push({
        file: path.join(directory, file.name),
        revision: match[1],
        bytes: 0,
      });
    }
  }
  return sources;
}

function checkpointObjectFile(gameDir: string, revision: string): string {
  return path.join(
    gameDir,
    ".rpg-harness",
    "objects",
    "checkpoints",
    revision.slice(0, 2),
    `${revision}.json`,
  );
}

async function persistCheckpointObject(
  gameDir: string,
  revision: string,
  serialized: string,
): Promise<void> {
  const target = checkpointObjectFile(gameDir, revision);
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true });
  try {
    await readVerifiedCheckpoint(target, revision);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(directory, `.${revision}-${randomUUID()}.tmp`);
  await writeFile(temporary, serialized, "utf-8");
  await rename(temporary, target);
}

async function readVerifiedCheckpoint(
  file: string,
  expectedRevision: string,
): Promise<string> {
  const serialized = await readFile(file, "utf-8");
  const revision = createHash("sha256").update(serialized).digest("hex");
  if (revision !== expectedRevision) {
    throw new Error(
      `Session checkpoint revision mismatch: expected ${expectedRevision}, got ${revision}`,
    );
  }
  return serialized;
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
