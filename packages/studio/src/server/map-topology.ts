import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { collectMapConnections, type Game, type MapDef } from "@rpg-harness/engine";
import { parseMap, validateGame } from "@rpg-harness/parser";
import {
  serializeMapTopologyPatch,
  withMapWriteLocks,
} from "./map-write";
import { MapTopologyError } from "./map-topology-error";
import {
  discardMapTopologyJournal,
  markMapTopologyJournalCommitted,
  prepareMapTopologyJournal,
  type MapTopologyJournal,
} from "./map-topology-journal";
export { MapTopologyError } from "./map-topology-error";

export interface MapTopologyAssignment {
  id: string;
  chain: string | null;
  isEntry: boolean;
}

export interface MapTopologyPreview {
  game: Game;
  changedIds: string[];
}

export type MapTopologyEntryMode = "keep-existing" | "make-selected";

export interface MapTopologyIntent {
  mapId: string;
  expected: {
    chain: string | null;
    isEntry: boolean;
    sourceEntryId: string | null;
    destinationEntryId: string | null;
    revision?: string;
  };
  destination: {
    chain: string | null;
    entry: MapTopologyEntryMode;
  };
  sourceReplacementEntryId?: string;
}

export interface MapTopologyPlan extends MapTopologyPreview {
  assignments: MapTopologyAssignment[];
}

export interface MapTopologyUpdate extends MapTopologyPreview {}

/** Convert one user intent into every map assignment required for validity. */
export function planMapTopology(
  game: Game,
  intent: MapTopologyIntent,
): MapTopologyPlan {
  if (!intent.mapId) throw new MapTopologyError("map id must not be empty");
  if (intent.destination.chain !== null && intent.destination.chain.length === 0) {
    throw new MapTopologyError("destination chain must be non-empty or null");
  }
  const matches = (game.maps ?? []).filter((map) => map.id === intent.mapId);
  if (matches.length !== 1) {
    throw new MapTopologyError(
      matches.length === 0
        ? `map not found: ${intent.mapId}`
        : `map id is not unique: ${intent.mapId}`,
      matches.length === 0 ? 404 : 409,
    );
  }
  const selected = matches[0]!;
  const revision = mapTopologyRevision(game);
  const sourceChain = selected.chain ?? null;
  const destinationChain = intent.destination.chain;
  const sourceEntryId = exactChainEntryId(game, sourceChain);
  const destinationEntryId = exactChainEntryId(game, destinationChain);
  if (
    (intent.expected.revision !== undefined && intent.expected.revision !== revision) ||
    intent.expected.chain !== sourceChain ||
    intent.expected.isEntry !== Boolean(selected.isEntry) ||
    intent.expected.sourceEntryId !== sourceEntryId ||
    intent.expected.destinationEntryId !== destinationEntryId
  ) {
    throw new MapTopologyError(
      `map topology changed since this dialog opened: ${intent.mapId}`,
      409,
      "stale_map_topology",
    );
  }

  const assignmentById = new Map<string, MapTopologyAssignment>();
  const assign = (map: MapDef, chain: string | null, isEntry: boolean) => {
    assignmentById.set(map.id, { id: map.id, chain, isEntry });
  };
  const sourceChanged = sourceChain !== destinationChain;
  if (sourceChanged && selected.isEntry && sourceChain !== null) {
    const remaining = (game.maps ?? []).filter((map) =>
      map.id !== selected.id && map.chain === sourceChain
    );
    if (remaining.length > 0) {
      const replacement = remaining.find((map) => map.id === intent.sourceReplacementEntryId);
      if (!replacement) {
        throw new MapTopologyError(
          `moving entry ${selected.id} requires a replacement entry in chain ${JSON.stringify(sourceChain)}`,
        );
      }
      assign(replacement, sourceChain, true);
    } else if (intent.sourceReplacementEntryId !== undefined) {
      throw new MapTopologyError(`source chain ${JSON.stringify(sourceChain)} has no remaining maps`);
    }
  } else if (intent.sourceReplacementEntryId !== undefined) {
    throw new MapTopologyError("source replacement entry is not required for this topology change");
  }

  if (destinationChain === null) {
    if (intent.destination.entry !== "keep-existing") {
      throw new MapTopologyError("standalone maps cannot become chain entries");
    }
    assign(selected, null, false);
  } else {
    const destinationMembers = (game.maps ?? []).filter((map) =>
      map.id !== selected.id && map.chain === destinationChain
    );
    if (destinationMembers.length === 0 && sourceChain !== destinationChain) {
      if (intent.destination.entry !== "make-selected") {
        throw new MapTopologyError(
          `new chain ${JSON.stringify(destinationChain)} must use ${selected.id} as its entry`,
        );
      }
      assign(selected, destinationChain, true);
    } else if (intent.destination.entry === "make-selected") {
      const oldEntry = (game.maps ?? []).find((map) =>
        map.id !== selected.id && map.chain === destinationChain && map.isEntry
      );
      if (oldEntry) assign(oldEntry, destinationChain, false);
      assign(selected, destinationChain, true);
    } else {
      if (destinationEntryId === null) {
        throw new MapTopologyError(
          `chain ${JSON.stringify(destinationChain)} does not have an entry to keep`,
        );
      }
      assign(selected, destinationChain, destinationEntryId === selected.id);
    }
  }

  const assignments = [...assignmentById.values()];
  const preview = previewMapTopology(game, assignments);
  return { ...preview, assignments };
}

/** Stable CAS identity for authored membership, entry roles and reachability edges. */
export function mapTopologyRevision(game: Game): string {
  const rows = (game.maps ?? []).map((map) => ({
    id: map.id,
    chain: map.chain ?? null,
    isEntry: Boolean(map.isEntry),
    targets: collectMapConnections(map).map((connection) => connection.target).sort(),
  })).sort((left, right) =>
    left.id.localeCompare(right.id) ||
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
  return `sha256:${createHash("sha256").update(JSON.stringify(rows)).digest("hex")}`;
}

/** Apply exact final topology values in memory and validate the whole project. */
export function previewMapTopology(
  game: Game,
  assignments: MapTopologyAssignment[],
): MapTopologyPreview {
  if (assignments.length === 0) {
    throw new MapTopologyError("topology assignments must not be empty");
  }
  const assignmentById = new Map<string, MapTopologyAssignment>();
  for (const assignment of assignments) {
    if (!assignment.id) throw new MapTopologyError("topology assignment id must not be empty");
    if (assignmentById.has(assignment.id)) {
      throw new MapTopologyError(`duplicate topology assignment: ${assignment.id}`);
    }
    if (assignment.chain !== null && assignment.chain.length === 0) {
      throw new MapTopologyError(`map ${assignment.id}: chain must be non-empty or null`);
    }
    if (assignment.chain === null && assignment.isEntry) {
      throw new MapTopologyError(`map ${assignment.id}: a standalone map cannot be a chain entry`);
    }
    assignmentById.set(assignment.id, assignment);
  }

  const idCounts = new Map<string, number>();
  for (const map of game.maps ?? []) {
    idCounts.set(map.id, (idCounts.get(map.id) ?? 0) + 1);
  }
  for (const id of assignmentById.keys()) {
    const count = idCounts.get(id) ?? 0;
    if (count !== 1) {
      throw new MapTopologyError(
        count === 0 ? `map not found: ${id}` : `map id is not unique: ${id}`,
        count === 0 ? 404 : 409,
      );
    }
  }

  const changedIds: string[] = [];
  const nextMaps = (game.maps ?? []).map((map) => {
    const assignment = assignmentById.get(map.id);
    if (!assignment) return map;
    if (
      (map.chain ?? null) === assignment.chain &&
      Boolean(map.isEntry) === assignment.isEntry
    ) {
      return map;
    }
    changedIds.push(map.id);
    return assignMapTopology(map, assignment);
  });
  const nextGame = { ...game, maps: nextMaps };
  validateGame(nextGame);
  return { game: nextGame, changedIds: changedIds.sort() };
}

/**
 * Commit a validated multi-map topology change as one Studio transaction.
 *
 * Every source is staged before the first replacement. Studio map writes are
 * locked in stable path order, authoritative reload must reproduce the exact
 * parsed maps, and rollback uses content comparison so it never overwrites an
 * external edit that landed after this transaction.
 */
export async function updateMapTopology(
  sources: ReadonlyMap<string, string>,
  intent: MapTopologyIntent,
  reload: () => Promise<Game>,
  verifyReload?: (game: Game) => Promise<void>,
): Promise<MapTopologyUpdate> {
  const initialPlan = planMapTopology(await reload(), intent);
  const lockPaths = initialPlan.assignments.map((assignment) => {
    const source = sources.get(assignment.id);
    if (!source) throw new MapTopologyError(`map source file not found: ${assignment.id}`, 404);
    return source;
  });

  return withMapWriteLocks(lockPaths, async () => {
    const currentGame = await reload();
    const plan = planMapTopology(currentGame, intent);
    if (plan.changedIds.length === 0) {
      await verifyReload?.(plan.game);
      return plan;
    }

    const assignmentById = new Map(plan.assignments.map((assignment) => [assignment.id, assignment]));
    const expectedById = new Map(
      (plan.game.maps ?? [])
        .filter((map) => assignmentById.has(map.id))
        .map((map) => [map.id, map]),
    );
    const mutations: MapTopologyMutation[] = [];
    for (const id of plan.changedIds) {
      const absolute = sources.get(id);
      const assignment = assignmentById.get(id);
      const expected = expectedById.get(id);
      if (!absolute || !assignment || !expected) {
        throw new MapTopologyError(`incomplete topology transaction for map: ${id}`);
      }
      const original = await readTopologySource(absolute, id, "after topology validation");
      const currentMap = (currentGame.maps ?? []).find((map) => map.id === id);
      let parsedCurrent: MapDef;
      try {
        parsedCurrent = parseMap(original, absolute);
      } catch {
        throw new MapTopologyError(
          `map source changed after topology validation: ${id}`,
          409,
          "stale_map_source",
        );
      }
      if (!currentMap || !sameMap(parsedCurrent, currentMap)) {
        throw new MapTopologyError(
          `map source changed after topology validation: ${id}`,
          409,
          "stale_map_source",
        );
      }
      const next = serializeMapTopologyPatch(original, assignment, absolute);
      if (next.map.id !== id) {
        throw new MapTopologyError(`map id changed from ${id} to ${next.map.id}`);
      }
      if (!sameMap(next.map, expected)) {
        throw new MapTopologyError(`serialized topology does not match the validated map: ${id}`);
      }
      mutations.push({
        id,
        absolute,
        original,
        updated: next.content,
        temporary: `${absolute}.studio.topology.${randomUUID()}.tmp`,
        committed: false,
      });
    }

    let journal: MapTopologyJournal | undefined;
    try {
      journal = await prepareMapTopologyJournal(mutations);
      for (const mutation of mutations) {
        await writeFile(mutation.temporary, mutation.updated, "utf-8");
      }
      for (const mutation of mutations) {
        const current = await readTopologySource(
          mutation.absolute,
          mutation.id,
          "before topology commit",
        );
        if (current !== mutation.original) {
          throw new MapTopologyError(
            `map source changed before topology commit: ${mutation.id}`,
            409,
            "stale_map_source",
          );
        }
      }
      for (const mutation of mutations) {
        await rename(mutation.temporary, mutation.absolute);
        mutation.committed = true;
      }

      const updated = await reload();
      validateGame(updated);
      for (const mutation of mutations) {
        const current = await readTopologySource(
          mutation.absolute,
          mutation.id,
          "during topology reload",
        );
        if (current !== mutation.updated) {
          throw new MapTopologyError(
            `map source changed during topology reload: ${mutation.id}`,
            409,
            "stale_map_source",
          );
        }
        const matches = (updated.maps ?? []).filter((map) => map.id === mutation.id);
        if (matches.length !== 1) {
          throw new MapTopologyError(
            matches.length === 0
              ? `reloaded map not found: ${mutation.id}`
              : `reloaded map id is not unique: ${mutation.id}`,
          );
        }
        const expected = expectedById.get(mutation.id)!;
        if (!sameMap(matches[0]!, expected)) {
          throw new MapTopologyError(
            `reloaded map does not match the topology transaction: ${mutation.id}`,
          );
        }
      }
      await verifyReload?.(updated);
      await markMapTopologyJournalCommitted(journal);
      await discardMapTopologyJournal(journal).catch(() => {});
      return { game: updated, changedIds: plan.changedIds };
    } catch (error) {
      const rollbackErrors: string[] = [];
      const rollbackSkipped: string[] = [];
      for (const mutation of [...mutations].reverse()) {
        if (!mutation.committed) continue;
        const current = await readFile(mutation.absolute, "utf-8").catch(() => undefined);
        if (current !== mutation.updated) {
          rollbackSkipped.push(mutation.id);
          continue;
        }
        const rollback = `${mutation.absolute}.studio.topology.rollback.${randomUUID()}.tmp`;
        try {
          await writeFile(rollback, mutation.original, "utf-8");
          await rename(rollback, mutation.absolute);
        } catch (rollbackError) {
          await unlink(rollback).catch(() => {});
          rollbackErrors.push(`${mutation.id}: ${(rollbackError as Error).message}`);
        }
      }
      if (rollbackSkipped.length > 0 || rollbackErrors.length > 0) {
        const details = [
          rollbackSkipped.length > 0
            ? `Rollback skipped for externally changed maps: ${rollbackSkipped.join(", ")}`
            : "",
          rollbackErrors.length > 0
            ? `Rollback failed:\n${rollbackErrors.join("\n")}`
            : "",
        ].filter(Boolean).join("\n");
        throw new MapTopologyError(
          `${(error as Error).message}\n${details}`,
          500,
          "map_topology_recovery_required",
        );
      }
      if (journal) await discardMapTopologyJournal(journal).catch(() => {});
      throw error;
    } finally {
      await Promise.all(mutations.map((mutation) => unlink(mutation.temporary).catch(() => {})));
    }
  });
}

interface MapTopologyMutation {
  id: string;
  absolute: string;
  original: string;
  updated: string;
  temporary: string;
  committed: boolean;
}

function assignMapTopology(
  map: MapDef,
  assignment: MapTopologyAssignment,
): MapDef {
  const next = { ...map };
  delete next.chain;
  delete next.isEntry;
  if (assignment.chain !== null) next.chain = assignment.chain;
  if (assignment.isEntry) next.isEntry = true;
  return next;
}

function sameMap(left: MapDef, right: MapDef): boolean {
  return isDeepStrictEqual(left, right);
}

async function readTopologySource(
  absolute: string,
  mapId: string,
  stage: string,
): Promise<string> {
  try {
    return await readFile(absolute, "utf-8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new MapTopologyError(
        `map source changed ${stage}: ${mapId}`,
        409,
        "stale_map_source",
      );
    }
    throw error;
  }
}

function exactChainEntryId(game: Game, chain: string | null): string | null {
  if (chain === null) return null;
  const entries = (game.maps ?? []).filter((map) => map.chain === chain && map.isEntry);
  if (entries.length > 1) {
    throw new MapTopologyError(
      `chain ${JSON.stringify(chain)} has multiple entries: ${entries.map((map) => map.id).join(", ")}`,
      409,
    );
  }
  return entries[0]?.id ?? null;
}
