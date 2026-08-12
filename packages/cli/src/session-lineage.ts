import { assertSessionName } from "@rpg-harness/session-store";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readSessionLog, type LoggedStep } from "./commands/fork";
import { sessionDir } from "./session";

export interface SessionLineageSlice {
  session: string;
  entries: LoggedStep[];
  includedEntries: number;
  totalEntries: number;
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
