import type { Condition, MapConnection, MapDef, MapEventTrigger, MapLayerDef, MapPlacementDef, MapPoint } from "./types";
import { mapPlacementEventKey } from "./resources";

const MAP_LAYER_ORDER_STRIDE = 10_000;
const MAP_ENTITY_ORDER_OFFSET = 1_000;

export function isMapEventPlayerAction(trigger: MapEventTrigger): boolean {
  return trigger === "interact" || trigger === "player_touch" ||
    trigger === "event_touch" || trigger === "manual";
}

/** Stable ownership key for save-compatible spatial cursor reconciliation. */
export function mapPositionLayoutKey(map: MapDef): string | null {
  if (!map.layout) return null;
  const start = map.layout.playerStart ?? { x: 0, y: 0 };
  return `${map.layout.width}x${map.layout.height}@${start.x},${start.y}`;
}

/**
 * Resolve canonical map collision for both renderers and runtime movement.
 * Collision-layer tile id 0 is walkable; every non-zero integer is solid.
 * Layer visibility only controls rendering and never changes navigation.
 */
export function mapPointBlocker(map: MapDef, point: MapPoint): string | undefined {
  const layout = map.layout;
  if (!layout || point.x < 0 || point.y < 0 || point.x >= layout.width || point.y >= layout.height) {
    return "bounds";
  }
  const placement = (map.placements ?? []).find((candidate) =>
    candidate.collision === "block" &&
    point.x >= candidate.at.x && point.y >= candidate.at.y &&
    point.x < candidate.at.x + candidate.footprint.width &&
    point.y < candidate.at.y + candidate.footprint.height
  );
  if (placement) return placement.id;
  const collisionLayer = layout.layers.find((layer) =>
    layer.kind === "collision" && (layer.tiles?.[point.y]?.[point.x] ?? 0) !== 0
  );
  return collisionLayer ? `layer:${collisionLayer.id}` : undefined;
}

/** Manhattan distance from a grid point to the nearest cell in a footprint. */
export function mapPlacementDistance(
  point: MapPoint,
  placement: MapPlacementDef,
): number {
  if (placement.footprint.width <= 0 || placement.footprint.height <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const maxX = placement.at.x + placement.footprint.width - 1;
  const maxY = placement.at.y + placement.footprint.height - 1;
  const dx = point.x < placement.at.x
    ? placement.at.x - point.x
    : point.x > maxX ? point.x - maxX : 0;
  const dy = point.y < placement.at.y
    ? placement.at.y - point.y
    : point.y > maxY ? point.y - maxY : 0;
  return dx + dy;
}

/**
 * Stable renderer order for a map layer. Large strides leave room for
 * entity foot-Y sorting without letting a tall sprite cross authored layers.
 */
export function mapLayerDisplayOrder(z: number): number {
  return Math.round(z * MAP_LAYER_ORDER_STRIDE);
}

/**
 * RPG field ordering: authored layer first, explicit placement z as a layer
 * offset, then the footprint's bottom edge so lower feet render in front.
 */
export function mapPlacementDisplayOrder(map: MapDef, placement: MapPlacementDef): number {
  const layerZ = placement.layer
    ? map.layout?.layers.find((layer) => layer.id === placement.layer)?.z ?? 0
    : 0;
  const feetY = placement.at.y + placement.footprint.height - 1;
  return mapLayerDisplayOrder(layerZ + placement.z) + MAP_ENTITY_ORDER_OFFSET + feetY;
}

/** The player walks in the map's first visible object layer by convention. */
export function mapPlayerDisplayOrder(map: MapDef, point: MapPoint): number {
  const layers = map.layout?.layers ?? [];
  const objectLayer = layers.find((layer) => layer.kind === "object" && layer.visible)
    ?? layers.find((layer) => layer.kind === "object");
  return mapLayerDisplayOrder(objectLayer?.z ?? 0) + MAP_ENTITY_ORDER_OFFSET + point.y;
}

/** Visual surfaces honor both the placement and its authored layer visibility. */
export function isMapPlacementLayerVisible(map: MapDef, placement: MapPlacementDef): boolean {
  if (!placement.visible) return false;
  if (!placement.layer) return true;
  return map.layout?.layers.find((layer) => layer.id === placement.layer)?.visible ?? true;
}

/** Full-canvas image layers are a renderer concern backed by ordinary assets. */
export function collectMapImageLayers(map: MapDef): MapLayerDef[] {
  return (map.layout?.layers ?? []).filter((layer) => layer.kind === "image" && layer.visible && layer.asset);
}

export type MapRouteSource = "legacy-connection" | "placement-event";

/**
 * One resolved outgoing route with the stable authored source that owns it.
 *
 * A target map is not enough to identify a route: RPG Maker-style maps may
 * deliberately place multiple doors to the same destination, each with its
 * own event page, condition and player-facing label. Runtime dispatch carries
 * this key so it never resolves one door through another door's gate.
 */
export interface MapRoute extends MapConnection {
  key: string;
  source: MapRouteSource;
  placementId?: string;
  eventId?: string;
  trigger?: MapEventTrigger;
  chance?: number;
}

export function mapLegacyConnectionKey(mapId: string, index: number): string {
  return `map:${mapId}/legacy-connection:${index}`;
}

/** Resolve both canonical placement events and transitional flat edges. */
export function collectMapRoutes(map: MapDef): MapRoute[] {
  const routes: MapRoute[] = (map.connections ?? []).map((connection, index) => ({
    ...connection,
    key: mapLegacyConnectionKey(map.id, index),
    source: "legacy-connection",
  }));
  for (const placement of map.placements ?? []) {
    for (const event of placement.events) {
      const ref = event.run ?? placement.resource;
      if (ref?.kind !== "map") continue;
      const requires = combineConditions(placement.requires, event.requires);
      routes.push({
        key: mapPlacementEventKey(map.id, placement.id, event.id),
        source: "placement-event",
        placementId: placement.id,
        eventId: event.id,
        trigger: event.trigger,
        ...(event.chance !== undefined ? { chance: event.chance } : {}),
        ...(event.arrival !== undefined ? { arrival: event.arrival } : {}),
        dir: event.label ?? ref.id,
        target: ref.id,
        ...(requires ? { requires } : {}),
        ...(event.lockedHint ? { lockedHint: event.lockedHint } : {}),
      });
    }
  }
  return routes;
}

/**
 * Compatibility projection for callers that only need graph edges. New
 * dispatch code must use `collectMapRoutes` so event-page identity survives.
 */
export function collectMapConnections(map: MapDef): MapConnection[] {
  return collectMapRoutes(map).map(({
    key: _key,
    source: _source,
    placementId: _placementId,
    eventId: _eventId,
    trigger: _trigger,
    chance: _chance,
    ...connection
  }) => connection);
}

/** Preserve the historic `move:<target>` id unless it would be ambiguous. */
export function mapRouteActivityId(routes: readonly MapRoute[], route: MapRoute): string {
  const base = `move:${route.target}`;
  return routes.filter((candidate) => candidate.target === route.target).length === 1
    ? base
    : `${base}#${route.key}`;
}

/**
 * Resolve a dispatched route fail-closed. Older activities without a route
 * key remain compatible only when their target identifies exactly one edge.
 */
export function resolveMapRoute(
  map: MapDef,
  target: string,
  routeKey?: string,
): MapRoute | undefined {
  const routes = collectMapRoutes(map);
  if (routeKey !== undefined) {
    return routes.find((route) => route.key === routeKey && route.target === target);
  }
  const matches = routes.filter((route) => route.target === target);
  return matches.length === 1 ? matches[0] : undefined;
}

function combineConditions(
  left?: Condition,
  right?: Condition,
): Condition | undefined {
  if (left && right) return { all: [left, right] };
  return left ?? right;
}
