import type { Condition, MapConnection, MapDef, MapEventTrigger, MapLayerDef, MapPlacementDef, MapPoint } from "./types";

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

/**
 * Canonical outgoing-map projection during Map v2 migration. Placement-backed
 * exits and legacy `connections` share one runtime contract, so modules do not
 * need to know which authoring shape produced an edge.
 */
export function collectMapConnections(map: MapDef): MapConnection[] {
  const connections = [...(map.connections ?? [])];
  for (const placement of map.placements ?? []) {
    for (const event of placement.events) {
      const ref = event.run ?? placement.resource;
      if (ref?.kind !== "map") continue;
      const requires = combineConditions(placement.requires, event.requires);
      connections.push({
        dir: event.label ?? ref.id,
        target: ref.id,
        ...(requires ? { requires } : {}),
        ...(event.lockedHint ? { lockedHint: event.lockedHint } : {}),
      });
    }
  }
  return connections;
}

function combineConditions(
  left?: Condition,
  right?: Condition,
): Condition | undefined {
  if (left && right) return { all: [left, right] };
  return left ?? right;
}
