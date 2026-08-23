import type { Condition, MapConnection, MapDef, MapEventTrigger, MapPoint } from "./types";

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
