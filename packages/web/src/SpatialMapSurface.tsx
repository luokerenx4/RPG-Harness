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
  onInput,
}: {
  map: MapDef;
  activities: HubActivity[];
  backgroundUrl?: string;
  playerPosition?: MapPoint;
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
        {layout.regions.map((region) => (
          <div
            className="spatial-map-region"
            key={region.id}
            style={{
              left: `${region.x / layout.width * 100}%`,
              top: `${region.y / layout.height * 100}%`,
              width: `${region.width / layout.width * 100}%`,
              height: `${region.height / layout.height * 100}%`,
            }}
            title={region.name ?? region.id}
          />
        ))}
        {visiblePlacements.map((placement) => (
          <Placement
            key={placement.id}
            map={map}
            placement={placement}
            activities={byId}
            playerPosition={playerPosition}
            onInput={onInput}
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
          ><span>◆</span></div>
        )}
      </div>
      <div className="spatial-map-navigation">
        <div className="spatial-map-awareness" aria-live="polite">
          <span><small>CURRENT</small><strong>{playerPosition ? `${playerPosition.x}, ${playerPosition.y}` : "—"}</strong></span>
          <i />
          <span><small>NEAREST</small><strong>{nearestPlacement
            ? `${placementDisplayName(nearestPlacement.placement)} · ${nearestPlacement.distance === 0 ? "目前地" : `${nearestPlacement.distance} 格`}`
            : "地标なし"}</strong></span>
        </div>
        <div className="spatial-map-controls" aria-label="二维地图移动">
          <button type="button" aria-label="向北移动" onClick={() => onInput({ type: "moveMap", direction: "north" })}>↑</button>
          <span>
            <button type="button" aria-label="向西移动" onClick={() => onInput({ type: "moveMap", direction: "west" })}>←</button>
            <button type="button" aria-label="向南移动" onClick={() => onInput({ type: "moveMap", direction: "south" })}>↓</button>
            <button type="button" aria-label="向东移动" onClick={() => onInput({ type: "moveMap", direction: "east" })}>→</button>
          </span>
        </div>
      </div>
      <p className="spatial-map-footnote">
        方向键 / WASD 可移动；触发结果仍提交与 Headless 相同的语义行动。
      </p>
    </section>
  );
}

function Placement({
  map,
  placement,
  activities,
  playerPosition,
  onInput,
}: {
  map: MapDef;
  placement: MapPlacementDef;
  activities: Map<string, HubActivity>;
  playerPosition?: MapPoint;
  onInput: (input: Input) => void;
}) {
  const layout = map.layout!;
  const operations = resolveSpatialPlacementOperations(map, placement, activities);
  const resourceKind = placement.resource?.kind ?? "event";
  const resourceName = formatResourceName(placement.resource?.id ?? placement.id);
  const manualOperations = operations.filter(
    ({ event }) => event.trigger === "interact" || event.trigger === "manual",
  );
  const primaryOperation = manualOperations.find(({ activity }) => activity?.available)
    ?? manualOperations[0];
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
    >
      <span className="spatial-placement-marker" aria-hidden="true">
        {resourceKindIcon(resourceKind)}
      </span>
      <span className="spatial-placement-label">
        <strong>{primaryOperation?.activity?.title ?? primaryOperation?.event.label ?? resourceName}</strong>
        <small>{distance === 0
          ? `${resourceKindLabel(resourceKind)} · 目前地`
          : nearby && primaryOperation
            ? `${resourceKindLabel(resourceKind)} · 可互动`
            : distance !== undefined
              ? `${resourceKindLabel(resourceKind)} · ${distance} 格`
              : resourceKindLabel(resourceKind)}</small>
      </span>
      {manualOperations.map(({ event, activity }) => (
        <button
          key={event.id}
          type="button"
          disabled={!activity?.available || !nearby}
          title={!nearby && distance !== undefined
            ? `接近地标后可互动 · 距离 ${distance} 格`
            : activity?.lockedReason ?? event.lockedHint ?? ""}
          onClick={() => activity && onInput({ type: "doActivity", id: activity.id })}
        >
          {event.label ?? activity?.title ?? event.id}
        </button>
      ))}
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

function placementDisplayName(placement: MapPlacementDef): string {
  return formatResourceName(placement.resource?.id ?? placement.id);
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
