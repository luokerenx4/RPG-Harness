import path from "node:path";
import { realpath } from "node:fs/promises";

const projectMutationQueues = new Map<string, Promise<void>>();

/** Serialize Studio project snapshots so multi-file commits are never observed halfway. */
export async function withProjectSnapshotLock<T>(
  gameDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = await realpath(gameDir).catch(() => path.resolve(gameDir));
  const previous = projectMutationQueues.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(() => undefined, () => undefined);
  projectMutationQueues.set(key, tail);
  try {
    return await result;
  } finally {
    if (projectMutationQueues.get(key) === tail) projectMutationQueues.delete(key);
  }
}
