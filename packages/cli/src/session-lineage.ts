import {
  assertSessionName,
  isSessionCheckpointRef,
  loadSessionCheckpoint,
} from "@rpg-harness/session-store";
import type { ComposedState } from "@rpg-harness/engine";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readSessionLog, type LoggedStep } from "./commands/fork";
import { listSessions, sessionDir } from "./session";

export interface SessionLineageSlice {
  session: string;
  entries: LoggedStep[];
  includedEntries: number;
  totalEntries: number;
}

export interface SessionCheckpointCoordinate {
  session: string;
  logEntry: number;
}

export async function readSessionLineage(
  gameDir: string,
  session: string,
  limit?: number,
  seen: Set<string> = new Set(),
): Promise<SessionLineageSlice[]> {
  assertSessionName(session);
  if (seen.has(session)) {
    throw new Error(`Fork lineage cycle detected at session: ${session}`);
  }
  seen.add(session);
  const allEntries = await readSessionLog(gameDir, session);
  const entries = allEntries.slice(0, limit);
  const current = {
    session,
    entries,
    includedEntries: entries.length,
    totalEntries: allEntries.length,
  };
  const provenance = await readForkProvenance(gameDir, session);
  if (!provenance) return [current];
  const ancestors = await readSessionLineage(
    gameDir,
    provenance.fromSession,
    provenance.sourceLogEntry,
    seen,
  );
  return [...ancestors, current];
}

export async function readForkProvenance(
  gameDir: string,
  session: string,
): Promise<{ fromSession: string; sourceLogEntry: number } | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(sessionDir(gameDir, session), "fork.json"), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (
    typeof value.fromSession !== "string" ||
    !Number.isInteger(value.sourceLogEntry) ||
    (value.sourceLogEntry as number) < 0
  ) {
    throw new Error(`Invalid fork provenance for session: ${session}`);
  }
  assertSessionName(value.fromSession);
  return {
    fromSession: value.fromSession,
    sourceLogEntry: value.sourceLogEntry as number,
  };
}

/**
 * Return a source session and every transitive fork descendant. Development
 * coverage uses this family so isolated AI branches feed evidence back into
 * the player's queue without ever mutating the player save.
 */
export async function sessionFamily(
  gameDir: string,
  sourceSession: string,
): Promise<string[]> {
  assertSessionName(sourceSession);
  const names = await listSessions(gameDir);
  const children = new Map<string, string[]>();
  for (const name of names) {
    const provenance = await readForkProvenance(gameDir, name);
    if (!provenance) continue;
    const siblings = children.get(provenance.fromSession) ?? [];
    siblings.push(name);
    children.set(provenance.fromSession, siblings);
  }
  const family: string[] = [];
  const queue = [sourceSession];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const session = queue.shift()!;
    if (seen.has(session)) continue;
    seen.add(session);
    family.push(session);
    queue.push(...(children.get(session) ?? []).sort());
  }
  return family;
}

/**
 * Return recoverable checkpoints before a source coordinate, newest first,
 * following fork provenance into every ancestor rather than treating a child
 * branch's short local log as its whole playable history.
 */
export async function historicalSessionCheckpoints(
  gameDir: string,
  session: string,
  beforeEntry: number,
  outputTypes: ReadonlySet<string>,
): Promise<SessionCheckpointCoordinate[]> {
  const lineage = await readSessionLineage(gameDir, session, beforeEntry);
  const seenRevisions = new Set<string>();
  const candidates: SessionCheckpointCoordinate[] = [];
  for (let sliceIndex = lineage.length - 1; sliceIndex >= 0; sliceIndex -= 1) {
    const slice = lineage[sliceIndex]!;
    const isCurrent = slice.session === session;
    const lastIndex = isCurrent
      ? Math.min(beforeEntry - 2, slice.entries.length - 1)
      : slice.entries.length - 1;
    for (let index = lastIndex; index >= 0; index -= 1) {
      const entry = slice.entries[index]!;
      if (
        !isSessionCheckpointRef(entry.checkpoint) ||
        seenRevisions.has(entry.checkpoint.revision) ||
        !isRecord(entry.output) ||
        !outputTypes.has(String(entry.output.type))
      ) {
        continue;
      }
      seenRevisions.add(entry.checkpoint.revision);
      candidates.push({ session: slice.session, logEntry: index + 1 });
    }
  }
  return candidates;
}

/**
 * Locate the newest recoverable point inside a particular script across a
 * fork lineage. This gives edited-script revalidation a precise replay frame
 * instead of asking broad state-space search to rediscover old route setup.
 */
export async function historicalActiveScriptCheckpoint(
  gameDir: string,
  session: string,
  beforeEntry: number,
  scriptId: string,
  preference: "earliest" | "latest" = "latest",
): Promise<SessionCheckpointCoordinate | null> {
  const lineage = await readSessionLineage(gameDir, session, beforeEntry);
  const sliceIndexes = preference === "latest"
    ? [...lineage.keys()].reverse()
    : [...lineage.keys()];
  for (const sliceIndex of sliceIndexes) {
    const slice = lineage[sliceIndex]!;
    const entryIndexes = preference === "latest"
      ? [...slice.entries.keys()].reverse()
      : [...slice.entries.keys()];
    for (const index of entryIndexes) {
      const checkpoint = slice.entries[index]!.checkpoint;
      if (!isSessionCheckpointRef(checkpoint)) continue;
      const state = await loadSessionCheckpoint(
        gameDir,
        slice.session,
        checkpoint,
      ) as ComposedState;
      if (state.baseline.currentScriptId === scriptId) {
        return { session: slice.session, logEntry: index + 1 };
      }
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
