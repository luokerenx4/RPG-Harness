import { collectMapAvailableResources } from "./collectMapResources";
import type {
  MapFacing,
  MapPoint,
  PresetContext,
} from "../types";

export interface MapMoveResult {
  moved: boolean;
  position?: MapPoint;
  blockedBy?: "bounds" | string;
  activityId?: string;
}

/**
 * Move the authoritative spatial cursor without changing Headless semantics.
 * A player-touch event resolves to the same activity already published by the
 * current Hub; the preset then dispatches that activity through the normal path.
 */
export function moveMapPlayer(
  ctx: PresetContext,
  direction: MapFacing,
): MapMoveResult {
  const mapId = ctx.state.baseline.currentMapId;
  const map = mapId ? ctx.mapMap.get(mapId) : undefined;
  if (!map?.layout) return { moved: false };

  const runtime = ctx.state.runtime;
  if (runtime.mapPositionMapId !== mapId || !runtime.mapPosition) {
    runtime.mapPositionMapId = mapId;
    runtime.mapPosition = map.layout.playerStart ?? { x: 0, y: 0 };
  }
  const delta = DIRECTION_DELTAS[direction];
  const next = {
    x: runtime.mapPosition.x + delta.x,
    y: runtime.mapPosition.y + delta.y,
  };
  if (
    next.x < 0 || next.y < 0 ||
    next.x >= map.layout.width || next.y >= map.layout.height
  ) {
    return { moved: false, position: runtime.mapPosition, blockedBy: "bounds" };
  }

  const blocker = (map.placements ?? []).find((placement) =>
    placement.collision === "block" && containsPoint(placement.at, placement.footprint, next)
  );
  if (blocker) {
    return { moved: false, position: runtime.mapPosition, blockedBy: blocker.id };
  }

  runtime.mapPosition = next;
  const touched = collectMapAvailableResources(ctx).find((resource) =>
    resource.trigger === "player_touch" && resource.available && resource.activity &&
    resource.placementId !== undefined &&
    (map.placements ?? []).some((placement) =>
      placement.id === resource.placementId &&
      containsPoint(placement.at, placement.footprint, next)
    ) &&
    (resource.chance === undefined || ctx.rng() < resource.chance)
  );
  if (!touched?.activity) return { moved: true, position: next };

  const published = ctx.state.runtime.lastHubActivities.find((activity) =>
    activity.id === touched.activity!.id ||
    activity.sourceKey === touched.key ||
    (touched.resource?.kind === "map" && activity.id === `move:${touched.resource.id}`)
  );
  return {
    moved: true,
    position: next,
    activityId: published?.id ?? touched.activity.id,
  };
}

const DIRECTION_DELTAS: Record<MapFacing, MapPoint> = {
  north: { x: 0, y: -1 },
  east: { x: 1, y: 0 },
  south: { x: 0, y: 1 },
  west: { x: -1, y: 0 },
};

function containsPoint(
  at: MapPoint,
  footprint: { width: number; height: number },
  point: MapPoint,
): boolean {
  return point.x >= at.x && point.y >= at.y &&
    point.x < at.x + footprint.width && point.y < at.y + footprint.height;
}
