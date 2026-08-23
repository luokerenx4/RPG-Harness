import type { Condition, MapConnection, MapDef, MapEventTrigger } from "./types";

export function isMapEventPlayerAction(trigger: MapEventTrigger): boolean {
  return trigger === "interact" || trigger === "player_touch" ||
    trigger === "event_touch" || trigger === "manual";
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
