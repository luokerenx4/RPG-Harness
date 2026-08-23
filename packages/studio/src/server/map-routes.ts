import { createHash } from "node:crypto";
import type {
  Game,
  MapArrivalDef,
  MapDef,
  MapEventTrigger,
  MapPlacementDef,
  MapPoint,
} from "@rpg-harness/engine";
import { validateGame } from "@rpg-harness/parser";
import { serializeMapPlacementAppend } from "./map-write";
import { updateMapSourcesAtomically } from "./map-source-transaction";
import { MapTopologyError } from "./map-topology-error";

const BUILTIN_TRIGGERS = new Set<MapEventTrigger>([
  "autorun",
  "parallel",
  "interact",
  "player_touch",
  "event_touch",
  "map_enter",
  "manual",
]);

export interface DirectedMapRouteDraft {
  sourceMapId: string;
  targetMapId: string;
  placementId: string;
  at: MapPoint;
  eventId: string;
  label: string;
  trigger: MapEventTrigger;
  arrival?: MapArrivalDef;
}

export interface ReciprocalMapRouteIntent {
  expectedRevision?: string;
  forward: DirectedMapRouteDraft;
  reverse: DirectedMapRouteDraft;
}

export interface ReciprocalMapRoutePlan {
  game: Game;
  revision: string;
  changedIds: string[];
  routes: [DirectedMapRouteDraft, DirectedMapRouteDraft];
}

export interface ReciprocalMapRouteUpdate {
  game: Game;
  changedIds: string[];
}

/** Full semantic CAS identity for the two authored map sources. */
export function reciprocalMapRouteRevision(
  game: Game,
  mapIds: readonly string[],
): string {
  const ids = [...new Set(mapIds)];
  if (ids.length !== 2) {
    throw new MapTopologyError("a reciprocal route revision requires two distinct maps");
  }
  const maps = ids.map((id) => requireUniqueMap(game, id))
    .sort((left, right) => left.id.localeCompare(right.id));
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(maps))).digest("hex")}`;
}

/** Build two independent ordinary directed placement-event routes in memory. */
export function planReciprocalMapRoutes(
  game: Game,
  intent: ReciprocalMapRouteIntent,
): ReciprocalMapRoutePlan {
  validateRouteDraft(intent.forward, "forward");
  validateRouteDraft(intent.reverse, "reverse");
  const forward = intent.forward;
  const reverse = intent.reverse;
  if (forward.sourceMapId === forward.targetMapId) {
    throw new MapTopologyError("a reciprocal route requires two distinct maps");
  }
  if (
    forward.sourceMapId !== reverse.targetMapId ||
    forward.targetMapId !== reverse.sourceMapId
  ) {
    throw new MapTopologyError(
      "forward and reverse routes must have exactly opposite source and target maps",
    );
  }

  const sourceMaps = [
    requireUniqueMap(game, forward.sourceMapId),
    requireUniqueMap(game, reverse.sourceMapId),
  ];
  const revision = reciprocalMapRouteRevision(game, sourceMaps.map((map) => map.id));
  if (intent.expectedRevision !== undefined && intent.expectedRevision !== revision) {
    throw new MapTopologyError(
      "map route sources changed since this dialog opened",
      409,
      "stale_map_routes",
    );
  }

  const routeBySource = new Map([
    [forward.sourceMapId, forward],
    [reverse.sourceMapId, reverse],
  ]);
  const nextMaps = (game.maps ?? []).map((map) => {
    const route = routeBySource.get(map.id);
    if (!route) return map;
    if ((map.placements ?? []).some((placement) => placement.id === route.placementId)) {
      throw new MapTopologyError(
        `map ${map.id} already has placement id ${JSON.stringify(route.placementId)}`,
        409,
        "map_route_id_conflict",
      );
    }
    return {
      ...map,
      placements: [...(map.placements ?? []), routePlacement(route)],
    };
  });
  const nextGame = { ...game, maps: nextMaps };
  validateGame(nextGame);
  return {
    game: nextGame,
    revision,
    changedIds: sourceMaps.map((map) => map.id).sort(),
    routes: [copyRoute(forward), copyRoute(reverse)],
  };
}

/** Persist both directed routes as one journaled two-map Studio transaction. */
export async function updateReciprocalMapRoutes(
  sources: ReadonlyMap<string, string>,
  intent: ReciprocalMapRouteIntent,
  reload: () => Promise<Game>,
  verifyReload?: (game: Game) => Promise<void>,
): Promise<ReciprocalMapRouteUpdate> {
  return updateMapSourcesAtomically(
    sources,
    (game) => {
      const plan = planReciprocalMapRoutes(game, intent);
      const expectedById = new Map(
        (plan.game.maps ?? [])
          .filter((map) => plan.changedIds.includes(map.id))
          .map((map) => [map.id, map]),
      );
      const routeBySource = new Map(
        plan.routes.map((route) => [route.sourceMapId, route] as const),
      );
      return {
        game: plan.game,
        sourceIds: plan.changedIds,
        changedIds: plan.changedIds,
        serialize: (id, original, absolute) => {
          const expected = expectedById.get(id);
          const route = routeBySource.get(id);
          if (!expected || !route) {
            throw new MapTopologyError(`incomplete reciprocal route transaction for map: ${id}`);
          }
          return serializeMapPlacementAppend(original, routePlacement(route), absolute);
        },
      };
    },
    reload,
    verifyReload,
    "reciprocal route",
  );
}

function routePlacement(route: DirectedMapRouteDraft): MapPlacementDef {
  return {
    id: route.placementId,
    at: { x: route.at.x, y: route.at.y },
    resource: { kind: "map", id: route.targetMapId },
    z: 0,
    footprint: { width: 1, height: 1 },
    collision: "trigger",
    visible: true,
    events: [{
      id: route.eventId,
      trigger: route.trigger,
      label: route.label,
      ...(route.arrival ? { arrival: copyArrival(route.arrival) } : {}),
      order: 0,
    }],
  };
}

function validateRouteDraft(route: DirectedMapRouteDraft, label: string): void {
  for (const [field, value] of [
    ["sourceMapId", route.sourceMapId],
    ["targetMapId", route.targetMapId],
    ["placementId", route.placementId],
    ["eventId", route.eventId],
    ["label", route.label],
    ["trigger", route.trigger],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new MapTopologyError(`${label}.${field} must be a non-blank string`);
    }
  }
  validatePoint(route.at, `${label}.at`);
  if (
    !BUILTIN_TRIGGERS.has(route.trigger) &&
    !/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/.test(route.trigger)
  ) {
    throw new MapTopologyError(
      `${label}.trigger must be a built-in trigger or namespaced module trigger`,
    );
  }
  if (route.arrival !== undefined) {
    const hasPlacement = route.arrival.placementId !== undefined;
    const hasPoint = route.arrival.at !== undefined;
    if (hasPlacement === hasPoint) {
      throw new MapTopologyError(`${label}.arrival must declare exactly one of placementId or at`);
    }
    if (
      route.arrival.placementId !== undefined &&
      (typeof route.arrival.placementId !== "string" || route.arrival.placementId.trim().length === 0)
    ) {
      throw new MapTopologyError(`${label}.arrival.placementId must be a non-blank string`);
    }
    if (route.arrival.at !== undefined) validatePoint(route.arrival.at, `${label}.arrival.at`);
  }
}

function validatePoint(point: MapPoint, label: string): void {
  if (
    !point || typeof point !== "object" ||
    !Number.isInteger(point.x) || !Number.isInteger(point.y) ||
    point.x < 0 || point.y < 0
  ) {
    throw new MapTopologyError(`${label} must contain non-negative integer x and y coordinates`);
  }
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

function copyRoute(route: DirectedMapRouteDraft): DirectedMapRouteDraft {
  return {
    ...route,
    at: { ...route.at },
    ...(route.arrival ? { arrival: copyArrival(route.arrival) } : {}),
  };
}

function copyArrival(arrival: MapArrivalDef): MapArrivalDef {
  return arrival.placementId !== undefined
    ? { placementId: arrival.placementId }
    : { at: { ...arrival.at! } };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}
