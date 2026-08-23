import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { Game, MapDef } from "@rpg-harness/engine";
import { parseMap, validateGame } from "@rpg-harness/parser";
import { withMapWriteLocks } from "./map-write";
import { MapTopologyError } from "./map-topology-error";
import {
  discardMapTopologyJournal,
  markMapTopologyJournalCommitted,
  prepareMapTopologyJournal,
  type MapTopologyJournal,
} from "./map-topology-journal";

export interface MapSourceTransactionPlan {
  game: Game;
  sourceIds: string[];
  changedIds: string[];
  serialize(
    id: string,
    original: string,
    absolute: string,
  ): { content: string; map: MapDef };
}

export interface MapSourceTransactionUpdate {
  game: Game;
  changedIds: string[];
}

interface MapSourceMutation {
  id: string;
  absolute: string;
  original: string;
  updated: string;
  temporary: string;
  committed: boolean;
}

/**
 * Commit one validated logical edit spanning canonical map sources.
 *
 * Callers own the in-memory plan and serializer. This layer owns the shared
 * Studio durability contract: stable path locks, source-byte CAS, recovery
 * journal publication, authoritative reload, and compare-before-rollback.
 */
export async function updateMapSourcesAtomically(
  sources: ReadonlyMap<string, string>,
  buildPlan: (game: Game) => MapSourceTransactionPlan,
  reload: () => Promise<Game>,
  verifyReload?: (game: Game) => Promise<void>,
  label = "topology",
): Promise<MapSourceTransactionUpdate> {
  const initialPlan = buildPlan(await reload());
  const initialSourceIds = uniqueIds(initialPlan.sourceIds, "transaction source").sort();
  const lockPaths = initialSourceIds.map((id) => {
    const source = sources.get(id);
    if (!source) throw new MapTopologyError(`map source file not found: ${id}`, 404);
    return source;
  });

  return withMapWriteLocks(lockPaths, async () => {
    const currentGame = await reload();
    const plan = buildPlan(currentGame);
    const replannedSourceIds = uniqueIds(plan.sourceIds, "transaction source").sort();
    if (
      replannedSourceIds.length !== initialSourceIds.length ||
      replannedSourceIds.some((id, index) => id !== initialSourceIds[index])
    ) {
      throw new MapTopologyError(
        `transaction sources changed after ${label} validation`,
        409,
        "stale_map_source",
      );
    }
    const sourceIds = new Set(replannedSourceIds);
    const changedIds = uniqueIds(plan.changedIds, "changed map").sort();
    for (const id of changedIds) {
      if (!sourceIds.has(id)) {
        throw new MapTopologyError(`changed map is not a transaction source: ${id}`);
      }
    }
    if (changedIds.length === 0) {
      await verifyReload?.(plan.game);
      return { game: plan.game, changedIds };
    }

    const expectedById = new Map(
      (plan.game.maps ?? [])
        .filter((map) => changedIds.includes(map.id))
        .map((map) => [map.id, map]),
    );
    const mutations: MapSourceMutation[] = [];
    for (const id of changedIds) {
      const absolute = sources.get(id);
      const expected = expectedById.get(id);
      if (!absolute || !expected) {
        throw new MapTopologyError(`incomplete ${label} transaction for map: ${id}`);
      }
      const original = await readMapSource(absolute, id, `after ${label} validation`);
      const currentMap = (currentGame.maps ?? []).find((map) => map.id === id);
      let parsedCurrent: MapDef;
      try {
        parsedCurrent = parseMap(original, absolute);
      } catch {
        throw staleSource(id, `after ${label} validation`);
      }
      if (!currentMap || !isDeepStrictEqual(parsedCurrent, currentMap)) {
        throw staleSource(id, `after ${label} validation`);
      }
      const next = plan.serialize(id, original, absolute);
      if (next.map.id !== id) {
        throw new MapTopologyError(`map id changed from ${id} to ${next.map.id}`);
      }
      if (!isDeepStrictEqual(next.map, expected)) {
        throw new MapTopologyError(`serialized ${label} does not match the validated map: ${id}`);
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
        const current = await readMapSource(
          mutation.absolute,
          mutation.id,
          `before ${label} commit`,
        );
        if (current !== mutation.original) {
          throw staleSource(mutation.id, `before ${label} commit`);
        }
      }
      for (const mutation of mutations) {
        await rename(mutation.temporary, mutation.absolute);
        mutation.committed = true;
      }

      const updated = await reload();
      validateGame(updated);
      for (const mutation of mutations) {
        const current = await readMapSource(
          mutation.absolute,
          mutation.id,
          `during ${label} reload`,
        );
        if (current !== mutation.updated) {
          throw staleSource(mutation.id, `during ${label} reload`);
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
        if (!isDeepStrictEqual(matches[0]!, expected)) {
          throw new MapTopologyError(
            `reloaded map does not match the ${label} transaction: ${mutation.id}`,
          );
        }
      }
      await verifyReload?.(updated);
      await markMapTopologyJournalCommitted(journal);
      await discardMapTopologyJournal(journal).catch(() => {});
      return { game: updated, changedIds };
    } catch (error) {
      const rollbackErrors: string[] = [];
      const rollbackSkipped: string[] = [];
      for (const mutation of [...mutations].reverse()) {
        if (!mutation.committed) continue;
        const current = await readFile(mutation.absolute, "utf-8").catch(() => undefined);
        if (current === mutation.original) continue;
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

function uniqueIds(ids: readonly string[], label: string): string[] {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id) throw new MapTopologyError(`${label} id must not be empty`);
    if (seen.has(id)) throw new MapTopologyError(`duplicate ${label}: ${id}`);
    seen.add(id);
  }
  return [...seen];
}

async function readMapSource(
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
    if (code === "ENOENT" || code === "ENOTDIR") throw staleSource(mapId, stage);
    throw error;
  }
}

function staleSource(mapId: string, stage: string): MapTopologyError {
  return new MapTopologyError(
    `map source changed ${stage}: ${mapId}`,
    409,
    "stale_map_source",
  );
}
