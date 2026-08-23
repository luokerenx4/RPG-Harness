import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { MapTopologyError } from "./map-topology-error";

const TRANSACTION_ROOT = ".studio-transactions";
const LOCK_ROOT = "process-lock";
const HOLDER_PREFIX = "holder-";
const RECORD = "record.json";
const CHOOSING_WAIT_MS = 1_000;
const STARTUP_WAIT_MS = 5_000;

interface ProjectProcessLockOptions {
  /** Startup may wait briefly for a live request in another Studio process. */
  waitForStale?: boolean;
}

interface HolderIdentity {
  pid: number;
  token: string;
  directory: string;
}

interface HolderRecord extends HolderIdentity {
  version: 1;
  ticket: number;
  createdAt: string;
}

interface LockSnapshot {
  choosing: HolderIdentity[];
  records: HolderRecord[];
}

/**
 * Cross-process project lease used by every Studio snapshot and mutation.
 *
 * Each attempt owns a never-reused directory and participates in Lamport's
 * Bakery algorithm. A crashed attempt can therefore be removed by its unique
 * token without ever unlinking a fixed path that a newer owner may have
 * replaced. PID liveness is only used to collect that immutable contender;
 * a live process is never evicted because a heartbeat happened to be late.
 * This protocol is intentionally local-host/local-filesystem only; a shared
 * filesystem with unrelated PID namespaces needs a different lock service.
 */
export async function withProjectProcessLock<T>(
  gameDir: string,
  operation: () => Promise<T>,
  options: ProjectProcessLockOptions = {},
): Promise<T> {
  const transactionRoot = path.join(path.resolve(gameDir), TRANSACTION_ROOT);
  const lockRoot = path.join(transactionRoot, LOCK_ROOT);
  const holder = createHolder(lockRoot);

  let result: T | undefined;
  let primaryError: unknown;
  try {
    await createHolderDirectory(lockRoot, holder.directory);
    const ticket = await chooseTicket(lockRoot, holder);
    const record = await publishRecord(holder, ticket);
    await waitForTurn(lockRoot, record, options.waitForStale ? STARTUP_WAIT_MS : 0);
    result = await operation();
  } catch (error) {
    primaryError = normalizeLockError(error);
  }

  let cleanupError: unknown;
  try {
    await rm(holder.directory, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
  }
  try {
    await removeEmptyRoots(lockRoot, transactionRoot);
  } catch (error) {
    cleanupError ??= error;
  }

  if (cleanupError) {
    throw new MapTopologyError(
      `failed to release Studio project process lock: ${(cleanupError as Error).message}`,
      500,
      "map_topology_recovery_required",
    );
  }
  if (primaryError !== undefined) throw primaryError;
  return result as T;
}

async function createHolderDirectory(lockRoot: string, holderDirectory: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await mkdir(lockRoot, { recursive: true });
    try {
      await mkdir(holderDirectory);
      return;
    } catch (error) {
      // Another releaser may remove the empty parent between the two mkdirs.
      if (nodeErrorCode(error) === "ENOENT") continue;
      if (nodeErrorCode(error) === "EEXIST") {
        throw recoveryError("Studio project process lock UUID collision");
      }
      throw error;
    }
  }
  throw recoveryError("could not publish Studio project process lock contender");
}

function createHolder(lockRoot: string): HolderIdentity {
  const token = randomUUID();
  return {
    pid: process.pid,
    token,
    directory: path.join(lockRoot, `${HOLDER_PREFIX}${process.pid}-${token}`),
  };
}

async function chooseTicket(
  lockRoot: string,
  holder: HolderIdentity,
): Promise<number> {
  const { records } = await inspectHolders(lockRoot, holder.token);
  const maximum = records.reduce((value, record) => Math.max(value, record.ticket), 0);
  if (!Number.isSafeInteger(maximum + 1)) {
    throw recoveryError("Studio project process lock ticket space is exhausted");
  }
  return maximum + 1;
}

async function publishRecord(
  holder: HolderIdentity,
  ticket: number,
): Promise<HolderRecord> {
  const record: HolderRecord = {
    ...holder,
    version: 1,
    ticket,
    createdAt: new Date().toISOString(),
  };
  const serializable = {
    version: record.version,
    pid: record.pid,
    token: record.token,
    ticket: record.ticket,
    createdAt: record.createdAt,
  };
  const temporary = path.join(holder.directory, `${RECORD}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(serializable)}\n`, {
    encoding: "utf-8",
    flag: "wx",
  });
  await rename(temporary, path.join(holder.directory, RECORD));
  return record;
}

async function waitForTurn(
  lockRoot: string,
  holder: HolderRecord,
  activeHolderWaitMs: number,
): Promise<void> {
  const choosingDeadline = Date.now() + CHOOSING_WAIT_MS;
  const activeDeadline = Date.now() + activeHolderWaitMs;
  while (true) {
    const snapshot = await inspectHolders(lockRoot, holder.token);
    if (snapshot.choosing.length > 0) {
      if (Date.now() >= choosingDeadline) throw busyError();
      await Bun.sleep(10);
      continue;
    }
    const earlier = snapshot.records.find((record) => compareHolder(record, holder) < 0);
    if (!earlier) return;
    if (activeHolderWaitMs === 0 || Date.now() >= activeDeadline) throw busyError();
    await Bun.sleep(25);
  }
}

async function inspectHolders(
  lockRoot: string,
  ownToken: string,
): Promise<LockSnapshot> {
  const entries = await readdir(lockRoot, { withFileTypes: true }).catch((error) => {
    if (nodeErrorCode(error) === "ENOENT") return [];
    throw error;
  });
  const snapshot: LockSnapshot = { choosing: [], records: [] };
  for (const entry of entries) {
    if (!entry.name.startsWith(HOLDER_PREFIX)) continue;
    const identity = parseHolderName(lockRoot, entry.name);
    if (!entry.isDirectory()) {
      throw recoveryError(`invalid Studio project process lock holder: ${entry.name}`);
    }
    if (identity.token === ownToken) continue;
    const source = await readFile(path.join(identity.directory, RECORD), "utf-8").catch((error) => {
      if (["ENOENT", "ENOTDIR"].includes(nodeErrorCode(error))) return undefined;
      throw error;
    });
    if (source === undefined) {
      if (holderIsAlive(identity)) snapshot.choosing.push(identity);
      else await removeDeadHolder(identity);
      continue;
    }
    let record: HolderRecord;
    try {
      record = parseRecord(source, identity);
    } catch (error) {
      if (!holderIsAlive(identity)) {
        await removeDeadHolder(identity);
        continue;
      }
      throw recoveryError(
        `invalid live Studio project process lock ${entry.name}: ${(error as Error).message}`,
      );
    }
    if (holderIsAlive(record)) snapshot.records.push(record);
    else await removeDeadHolder(record);
  }
  return snapshot;
}

function parseHolderName(lockRoot: string, name: string): HolderIdentity {
  const match = name.match(
    /^holder-([1-9][0-9]*)-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
  );
  if (!match?.[1] || !match[2]) {
    throw recoveryError(`invalid Studio project process lock holder name: ${name}`);
  }
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid)) {
    throw recoveryError(`invalid Studio project process lock holder pid: ${name}`);
  }
  return { pid, token: match[2], directory: path.join(lockRoot, name) };
}

function parseRecord(source: string, identity: HolderIdentity): HolderRecord {
  const parsed = JSON.parse(source) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("holder record must be an object");
  }
  const raw = parsed as Record<string, unknown>;
  const allowed = new Set(["version", "pid", "token", "ticket", "createdAt"]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (
    unknown.length > 0 ||
    raw.version !== 1 ||
    raw.pid !== identity.pid ||
    raw.token !== identity.token ||
    typeof raw.ticket !== "number" ||
    !Number.isSafeInteger(raw.ticket) ||
    raw.ticket < 1 ||
    typeof raw.createdAt !== "string"
  ) {
    throw new Error("holder record does not match its immutable identity");
  }
  return {
    ...identity,
    version: 1,
    ticket: raw.ticket,
    createdAt: raw.createdAt,
  } as HolderRecord;
}

function holderIsAlive(holder: HolderIdentity): boolean {
  // Unknown same-PID tokens may belong to another Worker/isolate or duplicate
  // module instance. Fail closed instead of recursively deleting a live peer.
  if (holder.pid === process.pid) return true;
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (error) {
    return nodeErrorCode(error) === "EPERM";
  }
}

async function removeDeadHolder(holder: HolderIdentity): Promise<void> {
  // The UUID directory is never reused, so concurrent collectors can only
  // remove this dead attempt; they cannot unlink a later owner's lease.
  await rm(holder.directory, { recursive: true, force: true });
}

function compareHolder(left: HolderRecord, right: HolderRecord): number {
  if (left.ticket !== right.ticket) return left.ticket - right.ticket;
  return left.token < right.token ? -1 : left.token > right.token ? 1 : 0;
}

function normalizeLockError(error: unknown): unknown {
  if (error instanceof MapTopologyError) return error;
  return recoveryError(`could not use Studio project process lock: ${(error as Error).message}`);
}

function busyError(): MapTopologyError {
  return new MapTopologyError(
    "another Studio process is using this project",
    409,
    "map_topology_project_busy",
  );
}

function recoveryError(message: string): MapTopologyError {
  return new MapTopologyError(message, 500, "map_topology_recovery_required");
}

/** Non-recursive rmdir cannot erase a root another process just populated. */
async function removeEmptyRoots(lockRoot: string, transactionRoot: string): Promise<void> {
  await removeEmptyDirectory(lockRoot);
  await removeEmptyDirectory(transactionRoot);
}

async function removeEmptyDirectory(directory: string): Promise<void> {
  try {
    await rmdir(directory);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(nodeErrorCode(error))) throw error;
  }
}

function nodeErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}
