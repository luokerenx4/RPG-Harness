import React from "react";
import { isMapEventPlayerAction, mapPlacementEventKey } from "@rpg-harness/engine";
import type {
  HubActivity,
  Input,
  MapDef,
  MapPlacementDef,
  MapPlacementEventDef,
  MapPoint,
  ProjectResourceRef,
} from "@rpg-harness/engine";

export interface SpatialPlacementOperation {
  event: MapPlacementEventDef;
  resource?: ProjectResourceRef;
  activity?: HubActivity;
}

type SpatialResourceLabels = ReadonlyMap<string, string>;

export function resolveSpatialPlacementOperations(
  map: MapDef,
  placement: MapPlacementDef,
  activities: ReadonlyMap<string, HubActivity>,
): SpatialPlacementOperation[] {
  return placement.events.flatMap((event) => {
    if (!isMapEventPlayerAction(event.trigger)) return [];
    const resource = event.run ?? placement.resource;
    const stableId = mapPlacementEventKey(map.id, placement.id, event.id);
    const activity = resource?.kind === "map"
      ? activities.get(`move:${resource.id}`) ?? activities.get(stableId)
      : activities.get(stableId);
    return [{ event, resource, activity }];
  });
}

export function SpatialMapSurface({
  map,
  activities,
  backgroundUrl,
  playerPosition,
  resourceLabels,
  onInput,
}: {
  map: MapDef;
  activities: HubActivity[];
  backgroundUrl?: string;
  playerPosition?: MapPoint;
  resourceLabels?: SpatialResourceLabels;
  onInput: (input: Input) => void;
}) {
  const layout = map.layout;
  if (!layout) return null;
  const byId = new Map(activities.map((activity) => [activity.id, activity]));
  const visiblePlacements = (map.placements ?? []).filter((placement) => placement.visible);
  const nearestPlacement = playerPosition
    ? visiblePlacements
      .map((placement) => ({ placement, distance: mapPlacementDistance(playerPosition, placement) }))
      .sort((left, right) => left.distance - right.distance)[0]
    : undefined;
  const nearestOperations = nearestPlacement
    ? resolveSpatialPlacementOperations(map, nearestPlacement.placement, byId)
    : [];
  const nearestManualOperations = nearestOperations.filter(
    ({ event }) => event.trigger === "interact" || event.trigger === "manual",
  );
  const nearestAction = nearestManualOperations.find(({ activity }) => activity?.available)
    ?? nearestManualOperations[0];
  const nearestName = nearestPlacement
    ? placementDisplayName(nearestPlacement.placement, resourceLabels)
    : undefined;
  const moveAvailability = mapMoveAvailability(layout, playerPosition);

  return (
    <section className="spatial-map-surface" aria-label={`${map.name} 二维地图`}>
      <header className="spatial-map-head">
        <div>
          <span className="spatial-map-kicker">MAP · {layout.width} × {layout.height}</span>
          <strong>{map.name}</strong>
        </div>
        <div className="spatial-map-meta">
          <span>{visiblePlacements.length} LANDMARKS</span>
          <small>{playerPosition ? `POSITION ${playerPosition.x},${playerPosition.y}` : "POSITION —"}</small>
        </div>
      </header>
      <div
        className="spatial-map-canvas"
        style={{
          aspectRatio: `${layout.width} / ${layout.height}`,
          backgroundImage: [
            backgroundUrl ? `linear-gradient(rgba(8, 12, 18, .48), rgba(8, 12, 18, .68)), url(${JSON.stringify(backgroundUrl)})` : undefined,
            "linear-gradient(rgba(255,255,255,.055) 1px, transparent 1px)",
            "linear-gradient(90deg, rgba(255,255,255,.055) 1px, transparent 1px)",
          ].filter(Boolean).join(", "),
          backgroundSize: backgroundUrl
            ? `cover, ${100 / layout.width}% ${100 / layout.height}%, ${100 / layout.width}% ${100 / layout.height}%`
            : `${100 / layout.width}% ${100 / layout.height}%, ${100 / layout.width}% ${100 / layout.height}%`,
        }}
      >
        <div className="spatial-map-compass" aria-hidden="true"><span>N</span><i>◆</i></div>
        <div className="spatial-map-frame" aria-hidden="true" />
        {layout.regions.map((region) => (
          <div
            className="spatial-map-region"
            key={region.id}
            role="img"
            aria-label={`区域 ${region.name ?? formatResourceName(region.id)}`}
            style={{
              left: `${region.x / layout.width * 100}%`,
              top: `${region.y / layout.height * 100}%`,
              width: `${region.width / layout.width * 100}%`,
              height: `${region.height / layout.height * 100}%`,
            }}
            title={region.name ?? region.id}
          >
            <span>{region.name ?? formatResourceName(region.id)}</span>
          </div>
        ))}
        {visiblePlacements.map((placement) => (
          <Placement
            key={placement.id}
            map={map}
            placement={placement}
            activities={byId}
            playerPosition={playerPosition}
            resourceLabels={resourceLabels}
          />
        ))}
        {playerPosition && (
          <div
            className="spatial-map-player"
            aria-label={`玩家位置 ${playerPosition.x},${playerPosition.y}`}
            style={{
              left: `${playerPosition.x / layout.width * 100}%`,
              top: `${playerPosition.y / layout.height * 100}%`,
              width: `${100 / layout.width}%`,
              height: `${100 / layout.height}%`,
            }}
          ><span>◆</span><small>YOU</small></div>
        )}
      </div>
      <div className="spatial-map-navigation">
        <div className="spatial-map-awareness" aria-live="polite">
          <span className="spatial-map-awareness-icon" aria-hidden="true">
            {nearestPlacement?.placement.resource?.kind === "map" ? "↗" : nearestPlacement ? "◇" : "·"}
          </span>
          <span className="spatial-map-awareness-copy">
            <small>NEARBY · {playerPosition ? `座標 ${playerPosition.x}, ${playerPosition.y}` : "座標 —"}</small>
            <strong>{nearestName ?? "可见地标なし"}</strong>
            <em>{nearestPlacement && playerPosition
              ? describePlacementApproach(playerPosition, nearestPlacement.placement, nearestPlacement.distance)
              : "地图上没有已显露的资源"}</em>
          </span>
          {nearestAction && (
            <button
              className="spatial-map-interact"
              type="button"
              disabled={!nearestAction.activity?.available || nearestPlacement!.distance > 1}
              title={nearestPlacement!.distance > 1
                ? `接近地标后可互动 · 距离 ${nearestPlacement!.distance} 格`
                : nearestAction.activity?.lockedReason ?? nearestAction.event.lockedHint ?? ""}
              onClick={() => nearestAction.activity && onInput({ type: "doActivity", id: nearestAction.activity.id })}
            >
              <small>ACTION</small>
              <strong>{nearestAction.event.label ?? nearestAction.activity?.title ?? "调查"}</strong>
            </button>
          )}
        </div>
        <div className="spatial-map-controls" aria-label="二维地图移动">
          <button type="button" aria-label="向北移动" disabled={!moveAvailability.north} onClick={() => onInput({ type: "moveMap", direction: "north" })}><small>N</small>↑</button>
          <span>
            <button type="button" aria-label="向西移动" disabled={!moveAvailability.west} onClick={() => onInput({ type: "moveMap", direction: "west" })}><small>W</small>←</button>
            <button type="button" aria-label="向南移动" disabled={!moveAvailability.south} onClick={() => onInput({ type: "moveMap", direction: "south" })}><small>S</small>↓</button>
            <button type="button" aria-label="向东移动" disabled={!moveAvailability.east} onClick={() => onInput({ type: "moveMap", direction: "east" })}><small>E</small>→</button>
          </span>
        </div>
      </div>
      <p className="spatial-map-footnote">
        <kbd>方向键</kbd> / <kbd>WASD</kbd> 移动 · 接触事件与 Headless 共用同一条语义行动
      </p>
    </section>
  );
}

function Placement({
  map,
  placement,
  activities,
  playerPosition,
  resourceLabels,
}: {
  map: MapDef;
  placement: MapPlacementDef;
  activities: Map<string, HubActivity>;
  playerPosition?: MapPoint;
  resourceLabels?: SpatialResourceLabels;
}) {
  const layout = map.layout!;
  const operations = resolveSpatialPlacementOperations(map, placement, activities);
  const resourceKind = placement.resource?.kind ?? "event";
  const resourceName = placementDisplayName(placement, resourceLabels);
  const primaryOperation = operations.find(({ activity }) => activity?.available)
    ?? operations[0];
  const primaryOperationIsManual = primaryOperation?.event.trigger === "interact"
    || primaryOperation?.event.trigger === "manual";
  const distance = playerPosition ? mapPlacementDistance(playerPosition, placement) : undefined;
  const nearby = distance !== undefined && distance <= 1;
  const position = {
    left: `${placement.at.x / layout.width * 100}%`,
    top: `${placement.at.y / layout.height * 100}%`,
    width: `${placement.footprint.width / layout.width * 100}%`,
    height: `${placement.footprint.height / layout.height * 100}%`,
    zIndex: Math.round(placement.z + 100),
  };

  return (
    <div
      className={`spatial-placement resource-${resourceKind} collision-${placement.collision}${primaryOperation?.activity?.available ? " placement-actionable" : ""}${distance === 0 ? " placement-here" : nearby ? " placement-nearby" : " placement-distant"}`}
      style={position}
      title={`${resourceKindLabel(resourceKind)} · ${resourceName}`}
      aria-label={`${resourceKindLabel(resourceKind)} ${resourceName}`}
      role="img"
    >
      <span className="spatial-placement-marker" aria-hidden="true">
        {resourceKindIcon(resourceKind)}
      </span>
      <span className="spatial-placement-label">
        <strong>{resourceName}</strong>
        <small>{distance === 0
          ? `${resourceKindLabel(resourceKind)} · 目前地`
          : nearby && primaryOperation
            ? `${resourceKindLabel(resourceKind)} · ${primaryOperationIsManual ? "可互动" : "接触触发"}`
            : distance !== undefined
              ? `${resourceKindLabel(resourceKind)} · ${distance} 格`
              : resourceKindLabel(resourceKind)}</small>
      </span>
    </div>
  );
}

export function mapPlacementDistance(point: MapPoint, placement: MapPlacementDef): number {
  const right = placement.at.x + placement.footprint.width - 1;
  const bottom = placement.at.y + placement.footprint.height - 1;
  const dx = point.x < placement.at.x
    ? placement.at.x - point.x
    : point.x > right ? point.x - right : 0;
  const dy = point.y < placement.at.y
    ? placement.at.y - point.y
    : point.y > bottom ? point.y - bottom : 0;
  return dx + dy;
}

function placementDisplayName(
  placement: MapPlacementDef,
  resourceLabels?: SpatialResourceLabels,
): string {
  if (placement.resource) {
    const label = resourceLabels?.get(`${placement.resource.kind}:${placement.resource.id}`);
    if (label) return label;
  }
  return formatResourceName(placement.resource?.id ?? placement.id);
}

export function mapMoveAvailability(layout: MapDef["layout"], point?: MapPoint) {
  if (!layout || !point) return { north: true, east: true, south: true, west: true };
  return {
    north: point.y > 0,
    east: point.x < layout.width - 1,
    south: point.y < layout.height - 1,
    west: point.x > 0,
  };
}

export function describePlacementApproach(
  point: MapPoint,
  placement: MapPlacementDef,
  distance = mapPlacementDistance(point, placement),
): string {
  if (distance === 0) return placement.resource?.kind === "map" ? "脚下是区域出口" : "目前地 · 可以调查";
  const right = placement.at.x + placement.footprint.width - 1;
  const bottom = placement.at.y + placement.footprint.height - 1;
  const vertical = point.y < placement.at.y ? "向南" : point.y > bottom ? "向北" : "";
  const horizontal = point.x < placement.at.x ? "向东" : point.x > right ? "向西" : "";
  const direction = [vertical, horizontal].filter(Boolean).join("再");
  const triggerHint = placement.resource?.kind === "map" && distance === 1 ? " · 接触后移动" : "";
  return `${direction || "附近"} ${distance} 格${triggerHint}`;
}

function formatResourceName(id: string): string {
  return id
    .split(/[\/_-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resourceKindLabel(kind: string): string {
  return ({
    action: "行动",
    asset: "场景",
    character: "角色",
    enemy: "敌人",
    item: "道具",
    map: "出口",
    script: "事件",
  } as Record<string, string>)[kind] ?? "事件";
}

function resourceKindIcon(kind: string): string {
  return ({
    action: "!",
    asset: "◇",
    character: "人",
    enemy: "鬼",
    item: "◆",
    map: "↗",
    script: "!",
  } as Record<string, string>)[kind] ?? "·";
}
