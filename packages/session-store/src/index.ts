import { mkdir, rmdir, stat } from "node:fs/promises";
import path from "node:path";

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
