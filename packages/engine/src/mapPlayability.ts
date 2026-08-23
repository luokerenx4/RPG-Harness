import {
  collectMapRoutes,
  isMapPlacementLayerVisible,
  mapPlacementDistance,
  mapPointBlocker,
  resolveMapPointBlocker,
  type MapPointBlocker,
  type MapRoute,
} from "./maps";
import { mapPlacementEventKey } from "./resources";
import type {
  Game,
  MapArrivalDef,
  MapDef,
  MapPlacementDef,
  MapPoint,
} from "./types";

export type MapPlayabilityDiagnosticCode =
  | "blocked-player-start"
  | "blocked-route-arrival"
  | "player-touch-no-walkable-entry"
  | "player-touch-unreachable"
  | "interaction-hidden"
  | "interaction-unreachable"
  | "unscheduled-spatial-trigger";

export type MapPlayabilityDiagnosticSeverity = "warning" | "info";

/**
 * Stable affected-map locator for authoring surfaces. Route diagnostics keep
 * their authored source in the `source*` fields instead of overloading this
 * target focus with the source door's placement id.
 */
export type MapPlayabilityDiagnosticFocus =
  | { kind: "point"; role: "player-start" | "route-arrival"; at: MapPoint }
  | { kind: "placement"; placementId: string };

/**
 * Advisory authoring feedback for a spatial map. `mapId` identifies the map
 * whose field playability is affected. For an incoming route, `path` and the
 * optional source metadata identify the route that authored the landing.
 */
export interface MapPlayabilityDiagnostic {
  mapId: string;
  path: string;
  code: MapPlayabilityDiagnosticCode;
  severity: MapPlayabilityDiagnosticSeverity;
  message: string;
  focus: MapPlayabilityDiagnosticFocus;
  blocker?: MapPointBlocker;
  /** Placement and event affected inside `mapId`. */
  placementId?: string;
  eventId?: string;
  /** Authored route source which produced an incoming-arrival warning. */
  sourceMapId?: string;
  sourceConnectionIndex?: number;
  sourcePlacementId?: string;
  sourceEventId?: string;
  sourceKey?: string;
}

interface IncomingRoute {
  sourceMap: MapDef;
  route: MapRoute;
}

interface ReachableMapPoints {
  keys: Set<string>;
  points: MapPoint[];
}

/**
 * Analyze whether renderer-driven spatial interactions can be reached from at
 * least one authored way into a map. This is intentionally advisory-only: it
 * does not evaluate conditions, mutate the game, or participate in validateGame.
 * Era-style node maps and renderer-independent event triggers remain valid.
 */
export function analyzeMapPlayability(game: Game): MapPlayabilityDiagnostic[];
export function analyzeMapPlayability(
  maps: readonly MapDef[],
): MapPlayabilityDiagnostic[];
export function analyzeMapPlayability(
  input: Game | readonly MapDef[],
): MapPlayabilityDiagnostic[] {
  const maps = Array.isArray(input)
    ? input as readonly MapDef[]
    : (input as Game).maps ?? [];
  const spatialMaps = maps.filter((map) => map.layout !== undefined);
  const spatialMapIds = new Set(spatialMaps.map((map) => map.id));
  const incomingByTarget = collectIncomingRoutes(maps, spatialMapIds);
  const diagnostics: MapPlayabilityDiagnostic[] = [];

  for (const map of spatialMaps) {
    const start = map.layout!.playerStart ?? { x: 0, y: 0 };
    const seeds: MapPoint[] = [];
    if (isValidMapPoint(map, start)) {
      seeds.push(start);
      const blocker = resolveMapPointBlocker(map, start);
      if (blocker) {
        diagnostics.push({
          mapId: map.id,
          path: `map ${map.id}.layout.player_start`,
          code: "blocked-player-start",
          severity: "warning",
          focus: { kind: "point", role: "player-start", at: { ...start } },
          blocker,
          message:
            `Player start ${formatPoint(start)} is blocked by "${formatBlocker(blocker)}". ` +
            `Runtime can walk out of a blocked landing, but the start should be intentional.`,
        });
      }
    }

    const incoming = [...(incomingByTarget.get(map.id) ?? [])]
      .sort((left, right) => left.route.key.localeCompare(right.route.key));
    for (const { sourceMap, route } of incoming) {
      const point = resolveArrivalPoint(map, route.arrival);
      if (!point || !isValidMapPoint(map, point)) continue;
      seeds.push(point);
      // An omitted arrival deliberately uses the same default start diagnosed
      // above. Do not repeat that one landing warning for every incoming edge.
      if (!route.arrival) continue;
      const blocker = resolveMapPointBlocker(map, point);
      if (!blocker) continue;
      diagnostics.push({
        mapId: map.id,
        path: routeArrivalPath(sourceMap, route),
        code: "blocked-route-arrival",
        severity: "warning",
        focus: { kind: "point", role: "route-arrival", at: { ...point } },
        blocker,
        message:
          `Route "${route.key}" from map "${sourceMap.id}" lands at ` +
          `${formatPoint(point)}, blocked by "${formatBlocker(blocker)}". Runtime can walk out ` +
          `of this landing, but the arrival should be intentional.`,
        ...(route.placementId ? { sourcePlacementId: route.placementId } : {}),
        ...(route.eventId ? { sourceEventId: route.eventId } : {}),
        ...(route.connectionIndex !== undefined
          ? { sourceConnectionIndex: route.connectionIndex }
          : {}),
        sourceMapId: sourceMap.id,
        sourceKey: route.key,
      });
    }

    const reachable = floodReachablePoints(map, seeds);
    for (const placement of map.placements ?? []) {
      analyzePlacement(map, placement, reachable, diagnostics);
    }
  }

  return diagnostics;
}

function collectIncomingRoutes(
  maps: readonly MapDef[],
  spatialMapIds: ReadonlySet<string>,
): Map<string, IncomingRoute[]> {
  const incoming = new Map<string, IncomingRoute[]>();
  for (const sourceMap of maps) {
    for (const route of collectMapRoutes(sourceMap)) {
      if (
        !spatialMapIds.has(route.target) ||
        route.chance === 0 ||
        route.trigger === "parallel" ||
        (sourceMap.layout !== undefined && route.trigger === "event_touch")
      ) continue;
      const routes = incoming.get(route.target) ?? [];
      routes.push({ sourceMap, route });
      incoming.set(route.target, routes);
    }
  }
  return incoming;
}

function analyzePlacement(
  map: MapDef,
  placement: MapPlacementDef,
  reachable: ReachableMapPoints,
  diagnostics: MapPlayabilityDiagnostic[],
): void {
  const placementPath = `map ${map.id}.placements[${placement.id}]`;
  for (const event of placement.events) {
    if (event.chance === 0) continue;
    if (event.trigger.includes(":")) continue;
    if (event.trigger === "autorun" || event.trigger === "map_enter") continue;

    const eventPath = `${placementPath}.events[${event.id}]`;
    const metadata = {
      placementId: placement.id,
      eventId: event.id,
      focus: { kind: "placement", placementId: placement.id } as const,
      sourceKey: mapPlacementEventKey(map.id, placement.id, event.id),
    };

    if (event.trigger === "event_touch" || event.trigger === "parallel") {
      diagnostics.push({
        mapId: map.id,
        path: `${eventPath}.trigger`,
        code: "unscheduled-spatial-trigger",
        severity: "warning",
        message:
          `Core trigger "${event.trigger}" is not scheduled by the spatial runtime. ` +
          `Use a module-owned namespaced trigger or a currently scheduled core trigger.`,
        ...metadata,
      });
      continue;
    }

    if (event.trigger === "player_touch") {
      const walkableEntryPoints = placementFootprintPoints(map, placement)
        .filter((point) => mapPointBlocker(map, point) === undefined);
      if (walkableEntryPoints.length === 0) {
        diagnostics.push({
          mapId: map.id,
          path: `${eventPath}.trigger`,
          code: "player-touch-no-walkable-entry",
          severity: "warning",
          message:
            `Player-touch event "${event.id}" has no walkable tile inside ` +
            `placement "${placement.id}".`,
          ...metadata,
        });
      } else if (!walkableEntryPoints.some((point) =>
        neighbors(point).some((neighbor) => reachable.keys.has(pointKey(neighbor)))
      )) {
        diagnostics.push({
          mapId: map.id,
          path: `${eventPath}.trigger`,
          code: "player-touch-unreachable",
          severity: "warning",
          message:
            `Player-touch event "${event.id}" cannot be reached from any player ` +
            `start or incoming route arrival.`,
          ...metadata,
        });
      }
      continue;
    }

    if (event.trigger !== "interact" && event.trigger !== "manual") continue;

    if (!isMapPlacementLayerVisible(map, placement)) {
      const hiddenByPlacement = !placement.visible;
      diagnostics.push({
        mapId: map.id,
        path: `${placementPath}.${hiddenByPlacement ? "visible" : "layer"}`,
        code: "interaction-hidden",
        severity: "warning",
        message: hiddenByPlacement
          ? `Interaction "${event.id}" is attached to hidden placement "${placement.id}".`
          : `Interaction "${event.id}" is attached to placement "${placement.id}" ` +
            `on hidden layer "${placement.layer ?? ""}".`,
        ...metadata,
      });
    }

    if (!reachable.points.some((point) => mapPlacementDistance(point, placement) <= 1)) {
      diagnostics.push({
        mapId: map.id,
        path: `${eventPath}.trigger`,
        code: "interaction-unreachable",
        severity: "warning",
        message:
          `Interaction "${event.id}" has no reachable player tile within distance 1 ` +
          `of placement "${placement.id}".`,
        ...metadata,
      });
    }
  }
}

function floodReachablePoints(
  map: MapDef,
  seeds: readonly MapPoint[],
): ReachableMapPoints {
  const keys = new Set<string>();
  const points: MapPoint[] = [];
  for (const seed of seeds) {
    const key = pointKey(seed);
    if (keys.has(key)) continue;
    keys.add(key);
    points.push({ ...seed });
  }

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    for (const next of neighbors(point)) {
      const key = pointKey(next);
      if (
        keys.has(key) ||
        !isValidMapPoint(map, next) ||
        mapPointBlocker(map, next) !== undefined
      ) {
        continue;
      }
      keys.add(key);
      points.push(next);
    }
  }
  return { keys, points };
}

function resolveArrivalPoint(
  target: MapDef,
  arrival?: MapArrivalDef,
): MapPoint | undefined {
  if (arrival?.at) return { ...arrival.at };
  if (arrival?.placementId !== undefined) {
    const placement = (target.placements ?? []).find(
      (candidate) => candidate.id === arrival.placementId,
    );
    return placement ? { ...placement.at } : undefined;
  }
  const start = target.layout?.playerStart ?? { x: 0, y: 0 };
  return { ...start };
}

function routeArrivalPath(sourceMap: MapDef, route: MapRoute): string {
  if (route.placementId && route.eventId) {
    return `map ${sourceMap.id}.placements[${route.placementId}].events[${route.eventId}].arrival`;
  }
  return `map ${sourceMap.id}.connections[${route.connectionIndex ?? route.target}].arrival`;
}

function placementFootprintPoints(
  map: MapDef,
  placement: MapPlacementDef,
): MapPoint[] {
  const points: MapPoint[] = [];
  for (let y = placement.at.y; y < placement.at.y + placement.footprint.height; y += 1) {
    for (let x = placement.at.x; x < placement.at.x + placement.footprint.width; x += 1) {
      const point = { x, y };
      if (isValidMapPoint(map, point)) points.push(point);
    }
  }
  return points;
}

function isValidMapPoint(map: MapDef, point: MapPoint): boolean {
  const layout = map.layout;
  return layout !== undefined &&
    Number.isInteger(point.x) && Number.isInteger(point.y) &&
    point.x >= 0 && point.y >= 0 &&
    point.x < layout.width && point.y < layout.height;
}

function neighbors(point: MapPoint): MapPoint[] {
  return [
    { x: point.x, y: point.y - 1 },
    { x: point.x + 1, y: point.y },
    { x: point.x, y: point.y + 1 },
    { x: point.x - 1, y: point.y },
  ];
}

function pointKey(point: MapPoint): string {
  return `${point.x},${point.y}`;
}

function formatPoint(point: MapPoint): string {
  return `(${point.x}, ${point.y})`;
}

function formatBlocker(blocker: MapPointBlocker): string {
  if (blocker.kind === "bounds") return "bounds";
  if (blocker.kind === "placement") return blocker.placementId;
  return `layer:${blocker.layerId}`;
}
