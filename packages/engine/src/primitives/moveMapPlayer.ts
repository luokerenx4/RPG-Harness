import { collectMapAvailableResources } from "./collectMapResources";
import { mapPointBlocker, mapPositionLayoutKey } from "../maps";
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
  const position = reconcileMapPlayerPosition(ctx);
  if (!position) return { moved: false };
  const delta = DIRECTION_DELTAS[direction];
  const next = {
    x: position.x + delta.x,
    y: position.y + delta.y,
  };
  const blocker = mapPointBlocker(map, next);
  if (blocker) return { moved: false, position: runtime.mapPosition, blockedBy: blocker };

  runtime.mapPosition = next;
  const touched = collectMapAvailableResources(ctx).find((resource) =>
    resource.trigger === "player_touch" && resource.available && resource.activity &&
    resource.placementId !== undefined &&
    (map.placements ?? []).some((placement) =>
      placement.id === resource.placementId &&
      containsPoint(placement.at, placement.footprint, next)
    )
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

/**
 * Rebase an old or hot-reloaded save when the current map gains or changes a
 * layout. Position ownership is explicit so a legitimate player at (0,0) is
 * never mistaken for an uninitialized cursor.
 */
export function reconcileMapPlayerPosition(ctx: PresetContext): MapPoint | undefined {
  const mapId = ctx.state.baseline.currentMapId;
  const map = mapId ? ctx.mapMap.get(mapId) : undefined;
  if (!map?.layout) return undefined;
  const runtime = ctx.state.runtime;
  const layoutKey = mapPositionLayoutKey(map);
  const position = runtime.mapPosition;
  const inBounds = position !== undefined && position.x >= 0 && position.y >= 0 &&
    position.x < map.layout.width && position.y < map.layout.height;
  if (
    runtime.mapPositionMapId !== mapId ||
    runtime.mapPositionLayoutKey !== layoutKey ||
    !inBounds
  ) {
    runtime.mapPositionMapId = mapId;
    runtime.mapPositionLayoutKey = layoutKey;
    runtime.mapPosition = map.layout.playerStart ?? { x: 0, y: 0 };
  }
  return runtime.mapPosition;
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
