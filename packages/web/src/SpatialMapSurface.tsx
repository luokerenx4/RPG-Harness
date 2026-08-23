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

  return (
    <section className="spatial-map-surface" aria-label={`${map.name} 二维地图`}>
      <header className="spatial-map-head">
        <div>
          <span className="spatial-map-kicker">MAP · {layout.width} × {layout.height}</span>
          <strong>{map.name}</strong>
        </div>
        <span>{map.placements?.length ?? 0} PLACEMENTS</span>
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
        {(map.placements ?? []).map((placement) => (
          <Placement
            key={placement.id}
            map={map}
            placement={placement}
            activities={byId}
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
      <div className="spatial-map-controls" aria-label="二维地图移动">
        <button type="button" aria-label="向北移动" onClick={() => onInput({ type: "moveMap", direction: "north" })}>↑</button>
        <span>
          <button type="button" aria-label="向西移动" onClick={() => onInput({ type: "moveMap", direction: "west" })}>←</button>
          <button type="button" aria-label="向南移动" onClick={() => onInput({ type: "moveMap", direction: "south" })}>↓</button>
          <button type="button" aria-label="向东移动" onClick={() => onInput({ type: "moveMap", direction: "east" })}>→</button>
        </span>
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
  onInput,
}: {
  map: MapDef;
  placement: MapPlacementDef;
  activities: Map<string, HubActivity>;
  onInput: (input: Input) => void;
}) {
  const layout = map.layout!;
  const operations = resolveSpatialPlacementOperations(map, placement, activities);
  const label = placement.resource?.id ?? placement.id;
  const position = {
    left: `${placement.at.x / layout.width * 100}%`,
    top: `${placement.at.y / layout.height * 100}%`,
    width: `${placement.footprint.width / layout.width * 100}%`,
    height: `${placement.footprint.height / layout.height * 100}%`,
    zIndex: Math.round(placement.z + 100),
  };

  return (
    <div
      className={`spatial-placement collision-${placement.collision}${placement.visible ? "" : " placement-hidden"}`}
      style={position}
      title={`${placement.id} · ${placement.resource?.kind ?? "event"}:${placement.resource?.id ?? ""}`}
    >
      <span className="spatial-placement-label">{label}</span>
      {operations.filter(({ event }) => event.trigger === "interact" || event.trigger === "manual").map(({ event, activity }) => (
        <button
          key={event.id}
          type="button"
          disabled={!activity?.available}
          title={activity?.lockedReason ?? event.lockedHint ?? ""}
          onClick={() => activity && onInput({ type: "doActivity", id: activity.id })}
        >
          {event.label ?? activity?.title ?? event.id}
        </button>
      ))}
    </div>
  );
}
