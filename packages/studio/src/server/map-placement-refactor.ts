import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  collectMapArrivalBacklinks,
  collectMapRoutes,
  mapPlacementKey,
  type Game,
  type MapArrivalBacklink,
  type MapDef,
  type MapPlacementDef,
  type MapPlacementEventDef,
} from "@rpg-harness/engine";
import { validateGame } from "@rpg-harness/parser";
import {
  serializeMapPlacementRefactor,
  type MapPlacementRefactorPatch,
} from "./map-write";
import { updateMapSourcesAtomically } from "./map-source-transaction";
import { MapTopologyError } from "./map-topology-error";

export interface MapPlacementRenameIntent {
  mapId: string;
  placementId: string;
  newPlacementId: string;
  expectedRevision?: string;
}

export interface MapPlacementRenamePlan {
  game: Game;
  revision: string;
  changedIds: string[];
  backlinks: MapArrivalBacklink[];
  targetKey: string;
}

export interface MapPlacementRenameUpdate {
  game: Game;
  changedIds: string[];
}

/** CAS identity for the exact rename intent plus every placement-anchored route. */
export function mapPlacementRenameRevision(
  game: Game,
  intent: Pick<MapPlacementRenameIntent, "mapId" | "placementId" | "newPlacementId">,
): string {
  const rows = (game.maps ?? []).map((map) => ({
    id: map.id,
    placements: (map.placements ?? []).map((placement) => placement.id).sort(),
    arrivals: collectMapRoutes(map).flatMap((route) =>
      route.arrival?.placementId === undefined
        ? []
        : [{
          sourceKey: route.key,
          targetMapId: route.target,
          targetPlacementId: route.arrival.placementId,
        }]
    ).sort((left, right) => left.sourceKey.localeCompare(right.sourceKey)),
  })).sort((left, right) => left.id.localeCompare(right.id));
  return `sha256:${createHash("sha256").update(JSON.stringify({
    intent: {
      mapId: intent.mapId,
      placementId: intent.placementId,
      newPlacementId: intent.newPlacementId,
    },
    rows,
  })).digest("hex")}`;
}

/** Build and validate the complete cross-map placement refactor in memory. */
export function planMapPlacementRename(
  game: Game,
  intent: MapPlacementRenameIntent,
): MapPlacementRenamePlan {
  assertNonBlank(intent.mapId, "mapId");
  assertNonBlank(intent.placementId, "placementId");
  assertStablePlacementId(intent.newPlacementId, "newPlacementId");
  if (intent.newPlacementId === intent.placementId) {
    throw new MapTopologyError("newPlacementId must be different from placementId");
  }

  const target = requireUniqueMap(game, intent.mapId);
  const matches = (target.placements ?? []).filter(
    (placement) => placement.id === intent.placementId,
  );
  if (matches.length !== 1) {
    throw new MapTopologyError(
      matches.length === 0
        ? `map ${intent.mapId} has no placement ${JSON.stringify(intent.placementId)}`
        : `map ${intent.mapId} placement id is not unique: ${intent.placementId}`,
      matches.length === 0 ? 404 : 409,
      matches.length === 0 ? "map_placement_not_found" : "map_placement_id_conflict",
    );
  }
  if ((target.placements ?? []).some((placement) => placement.id === intent.newPlacementId)) {
    throw new MapTopologyError(
      `map ${intent.mapId} already has placement id ${JSON.stringify(intent.newPlacementId)}`,
      409,
      "map_placement_id_conflict",
    );
  }

  const revision = mapPlacementRenameRevision(game, intent);
  if (intent.expectedRevision !== undefined && intent.expectedRevision !== revision) {
    throw new MapTopologyError(
      "map placement arrivals changed since this refactor was previewed",
      409,
      "stale_map_placement_refs",
    );
  }
  const backlinks = collectMapArrivalBacklinks(
    game.maps ?? [],
    intent.mapId,
    intent.placementId,
  );
  const sourceIds = new Set([intent.mapId, ...backlinks.map((backlink) => backlink.sourceMapId)]);
  const nextMaps = (game.maps ?? []).map((map) =>
    sourceIds.has(map.id) ? renamePlacementInMap(map, intent) : map
  );
  const nextGame = { ...game, maps: nextMaps };
  validateGame(nextGame);
  return {
    game: nextGame,
    revision,
    changedIds: [...sourceIds].sort(),
    backlinks,
    targetKey: mapPlacementKey(intent.mapId, intent.placementId),
  };
}

/**
 * Prove that every current authoritative YAML source can represent the exact
 * in-memory plan. Preview and commit share this gate so aliases, block scalars,
 * or other unsafe authoring trivia fail before a transaction is advertised.
 */
export async function verifyMapPlacementRenameSources(
  sources: ReadonlyMap<string, string>,
  plan: MapPlacementRenamePlan,
  intent: MapPlacementRenameIntent,
): Promise<void> {
  for (const id of plan.changedIds) {
    const absolute = sources.get(id);
    const expected = (plan.game.maps ?? []).find((map) => map.id === id);
    if (!absolute || !expected) {
      throw new MapTopologyError(`incomplete map placement refactor source: ${id}`);
    }
    const original = await readFile(absolute, "utf-8");
    const next = serializePlacementRefactorSource(id, original, absolute, intent);
    if (!isDeepStrictEqual(next.map, expected)) {
      throw unsafePlacementSource(
        id,
        "serialized YAML does not match the engine-proven refactor plan",
      );
    }
  }
}

/** Persist the target definition and all incoming anchors as one transaction. */
export async function updateMapPlacementRename(
  sources: ReadonlyMap<string, string>,
  intent: MapPlacementRenameIntent,
  reload: () => Promise<Game>,
  verifyReload?: (game: Game) => Promise<void>,
): Promise<MapPlacementRenameUpdate> {
  return updateMapSourcesAtomically(
    sources,
    (game) => {
      const plan = planMapPlacementRename(game, intent);
      return {
        game: plan.game,
        sourceIds: plan.changedIds,
        changedIds: plan.changedIds,
        serialize: (id, original, absolute) => serializePlacementRefactorSource(
          id,
          original,
          absolute,
          intent,
        ),
      };
    },
    reload,
    verifyReload,
    "map placement refactor",
  );
}

function serializePlacementRefactorSource(
  id: string,
  original: string,
  absolute: string,
  intent: MapPlacementRenameIntent,
): ReturnType<typeof serializeMapPlacementRefactor> {
  try {
    return serializeMapPlacementRefactor(
      original,
      {
        sourceMapId: id,
        targetMapId: intent.mapId,
        placementId: intent.placementId,
        newPlacementId: intent.newPlacementId,
      } satisfies MapPlacementRefactorPatch,
      absolute,
    );
  } catch (cause) {
    throw unsafePlacementSource(
      id,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

function unsafePlacementSource(id: string, reason: string): MapTopologyError {
  return new MapTopologyError(
    `map ${id} cannot safely represent this placement refactor: ${reason}`,
    422,
    "invalid_map_placement_refactor",
  );
}

function renamePlacementInMap(
  map: MapDef,
  intent: MapPlacementRenameIntent,
): MapDef {
  let changed = false;
  const connections = (map.connections ?? []).map((connection) => {
    if (
      connection.target !== intent.mapId ||
      connection.arrival?.placementId !== intent.placementId
    ) return connection;
    changed = true;
    return { ...connection, arrival: { placementId: intent.newPlacementId } };
  });
  const placements = (map.placements ?? []).map((placement) => {
    const ownId = map.id === intent.mapId && placement.id === intent.placementId
      ? intent.newPlacementId
      : placement.id;
    const events = placement.events.map((event) =>
      renameEventArrival(event, placement, intent, () => { changed = true; })
    );
    if (ownId === placement.id && events.every((event, index) => event === placement.events[index])) {
      return placement;
    }
    changed = true;
    return { ...placement, id: ownId, events };
  });
  if (!changed) return map;
  return {
    ...map,
    ...(map.connections !== undefined ? { connections } : {}),
    ...(map.placements !== undefined ? { placements } : {}),
  };
}

function renameEventArrival(
  event: MapPlacementEventDef,
  placement: MapPlacementDef,
  intent: MapPlacementRenameIntent,
  markChanged: () => void,
): MapPlacementEventDef {
  const target = event.run ?? placement.resource;
  if (
    target?.kind !== "map" ||
    target.id !== intent.mapId ||
    event.arrival?.placementId !== intent.placementId
  ) return event;
  markChanged();
  return { ...event, arrival: { placementId: intent.newPlacementId } };
}

function requireUniqueMap(game: Game, id: string): MapDef {
  const matches = (game.maps ?? []).filter((map) => map.id === id);
  if (matches.length !== 1) {
    throw new MapTopologyError(
      matches.length === 0 ? `map not found: ${id}` : `map id is not unique: ${id}`,
      matches.length === 0 ? 404 : 409,
    );
  }
  return matches[0]!;
}

function assertStablePlacementId(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)) {
    throw new MapTopologyError(
      `${field} must be 1-80 stable ASCII letters, numbers, dashes, or underscores`,
    );
  }
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new MapTopologyError(`${field} must be a non-empty string`);
  }
}
