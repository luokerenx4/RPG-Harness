import React, { useEffect, useState } from "react";
import { isMapEventPlayerAction, mapPlacementEventKey, mapPointBlocker } from "@rpg-harness/engine";
import type {
  AssetSpec,
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

export interface SpatialLandmark {
  placement: MapPlacementDef;
  distance: number;
  operations: SpatialPlacementOperation[];
}

export interface SpatialContextOperation extends SpatialPlacementOperation {
  placement: MapPlacementDef;
  distance: number;
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

export function collectSpatialLandmarks(
  map: MapDef,
  activities: ReadonlyMap<string, HubActivity>,
  playerPosition: MapPoint,
): SpatialLandmark[] {
  return (map.placements ?? [])
    .filter((placement) => placement.visible)
    .map((placement, index) => ({
      placement,
      distance: mapPlacementDistance(playerPosition, placement),
      operations: resolveSpatialPlacementOperations(map, placement, activities),
      index,
    }))
    .sort((left, right) => {
      if (left.distance !== right.distance) return left.distance - right.distance;
      const leftActionable = left.operations.some(({ activity }) => activity?.available) ? 1 : 0;
      const rightActionable = right.operations.some(({ activity }) => activity?.available) ? 1 : 0;
      if (leftActionable !== rightActionable) return rightActionable - leftActionable;
      return left.index - right.index;
    })
    .map(({ index: _index, ...landmark }) => landmark);
}

export function collectSpatialContextOperations(
  landmarks: SpatialLandmark[],
): SpatialContextOperation[] {
  return landmarks
    .filter(({ distance }) => distance <= 1)
    .flatMap(({ placement, distance, operations }) => operations
      .filter(({ event }) => event.trigger === "interact" || event.trigger === "manual")
      .map((operation) => ({ ...operation, placement, distance })))
    .sort((left, right) => {
      const leftAvailable = left.activity?.available ? 1 : 0;
      const rightAvailable = right.activity?.available ? 1 : 0;
      return rightAvailable - leftAvailable || left.distance - right.distance;
    });
}

/**
 * Activities owned by visible spatial placements belong to the field surface,
 * not the ordinary Hub command list. Headless still receives the unchanged
 * activity array; only the Web player projection moves these commands behind
 * proximity, touch, and map controls.
 */
export function collectSpatialPlacementActivityIds(
  map: MapDef,
  activities: ReadonlyMap<string, HubActivity>,
): Set<string> {
  return new Set(
    (map.placements ?? [])
      .filter((placement) => placement.visible)
      .flatMap((placement) => resolveSpatialPlacementOperations(map, placement, activities))
      .flatMap(({ activity }) => activity ? [activity.id] : []),
  );
}

export function SpatialMapSurface({
  map,
  activities,
  backgroundUrl,
  tileset,
  tilesetUrl,
  playerPosition,
  resourceLabels,
  onInput,
}: {
  map: MapDef;
  activities: HubActivity[];
  backgroundUrl?: string;
  tileset?: AssetSpec;
  tilesetUrl?: string;
  playerPosition?: MapPoint;
  resourceLabels?: SpatialResourceLabels;
  onInput: (input: Input) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showPathing, setShowPathing] = useState(false);
  const layout = map.layout;
  if (!layout) return null;
  const byId = new Map(activities.map((activity) => [activity.id, activity]));
  const visiblePlacements = (map.placements ?? []).filter((placement) => placement.visible);
  const landmarks = playerPosition ? collectSpatialLandmarks(map, byId, playerPosition) : [];
  const nearestLandmark = landmarks[0];
  const nearbyLandmarks = landmarks.filter(({ distance }) => distance <= 1);
  const contextOperations = collectSpatialContextOperations(landmarks);
  const nearestName = nearestLandmark
    ? placementDisplayName(nearestLandmark.placement, resourceLabels)
    : undefined;
  const moveAvailability = mapMoveAvailability(map, playerPosition);
  const stepTargets = collectSpatialStepTargets(map, playerPosition);
  const visibleTiles = collectSpatialTiles(map);

  useEffect(() => {
    const available = contextOperations.filter(({ activity }) => activity?.available);
    if (available.length === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const tag = event.target instanceof HTMLElement ? event.target.tagName : "";
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(tag)) return;
      const numericIndex = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1;
      const operation = isSpatialInteractKey(event.key) ? available[0] : available[numericIndex];
      if (!operation?.activity) return;
      event.preventDefault();
      onInput({ type: "doActivity", id: operation.activity.id });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [contextOperations, onInput]);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [expanded]);

  return (
    <section className={`spatial-map-surface${expanded ? " expanded" : ""}`} aria-label={`${map.name} 二维地图`}>
      <header className="spatial-map-head">
        <div>
          <span className="spatial-map-kicker">MAP · {layout.width} × {layout.height}</span>
          <strong>{map.name}</strong>
        </div>
        <div className="spatial-map-head-actions">
          <div className="spatial-map-meta">
            <span>{visiblePlacements.length} LANDMARKS</span>
            <small>{playerPosition ? `POSITION ${playerPosition.x},${playerPosition.y}` : "POSITION —"}</small>
          </div>
          {expanded && <button type="button" className={`spatial-map-pathing${showPathing ? " selected" : ""}`} aria-label={showPathing ? "隐藏通行图层" : "显示通行图层"} aria-pressed={showPathing} onClick={() => setShowPathing((current) => !current)}><span aria-hidden="true">▧</span><small>PATHING</small></button>}
          <button type="button" className="spatial-map-expand" aria-label={expanded ? "收起地图" : "展开地图"} aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}><span aria-hidden="true">{expanded ? "↙" : "↗"}</span><small>{expanded ? "CLOSE" : "EXPAND"}</small></button>
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
        {visibleTiles.map((tile) => {
          if (tile.kind === "collision" && !(expanded && showPathing)) return null;
          const atlasStyle = tile.kind === "tile"
            ? spatialTileAtlasStyle(tile.tile, tileset, tilesetUrl)
            : undefined;
          return (
          <i
            aria-hidden="true"
            className={`spatial-map-tile kind-${tile.kind}${atlasStyle ? " atlas" : ""}`}
            key={`${tile.layerId}:${tile.x}:${tile.y}`}
            style={{
              left: `${tile.x / layout.width * 100}%`,
              top: `${tile.y / layout.height * 100}%`,
              width: `${100 / layout.width}%`,
              height: `${100 / layout.height}%`,
              zIndex: Math.round(tile.z + 1),
              "--tile-id": tile.tile,
              ...atlasStyle,
            } as React.CSSProperties}
          />
          );
        })}
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
        {stepTargets.map((target) => (
          <button
            type="button"
            className="spatial-map-step-cell"
            aria-label={`${target.label}移动到 ${target.point.x},${target.point.y}`}
            disabled={!target.available}
            key={target.direction}
            onClick={() => onInput({ type: "moveMap", direction: target.direction })}
            style={{
              left: `${target.point.x / layout.width * 100}%`,
              top: `${target.point.y / layout.height * 100}%`,
              width: `${100 / layout.width}%`,
              height: `${100 / layout.height}%`,
            }}
          ><span aria-hidden="true">{target.arrow}</span></button>
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
            {nearestLandmark?.placement.resource?.kind === "map" ? "↗" : nearestLandmark ? "◇" : "·"}
          </span>
          <span className="spatial-map-awareness-copy">
            <small>NEARBY · {playerPosition ? `座標 ${playerPosition.x}, ${playerPosition.y}` : "座標 —"}</small>
            <strong>{nearestName ?? "可见地标なし"}{nearbyLandmarks.length > 1 && <b> +{nearbyLandmarks.length - 1}</b>}</strong>
            <em>{nearbyLandmarks.length > 1
                ? `${nearbyLandmarks.length} 个对象在行动范围内 · ${contextOperations.length} 个事件`
              : nearestLandmark && playerPosition
                ? describePlacementApproach(
                  playerPosition,
                  nearestLandmark.placement,
                  nearestLandmark.distance,
                  nearestLandmark.operations.some(({ event }) => event.trigger === "interact" || event.trigger === "manual")
                    ? "manual"
                    : nearestLandmark.operations.some(({ event }) => event.trigger === "player_touch" || event.trigger === "event_touch")
                      ? "touch"
                      : undefined,
                )
              : "地图上没有已显露的资源"}</em>
          </span>
          {contextOperations.length > 0 && (
            <div className={`spatial-map-context-actions${contextOperations.length > 1 ? " multiple" : ""}`} aria-label="附近可执行事件">
              {contextOperations.map((operation, index) => (
                <button
                  className="spatial-map-interact"
                  type="button"
                  key={`${operation.placement.id}:${operation.event.id}`}
                  aria-keyshortcuts={index === 0
                    ? "E Enter Digit1"
                    : index < 9 ? `Digit${index + 1}` : undefined}
                  disabled={!operation.activity?.available}
                  title={operation.activity?.lockedReason ?? operation.event.lockedHint ?? ""}
                  onClick={() => operation.activity && onInput({ type: "doActivity", id: operation.activity.id })}
                >
                  <small><kbd>{index === 0 ? "E" : index + 1}</kbd>{contextOperations.length > 1 ? placementDisplayName(operation.placement, resourceLabels) : "ACTION"}</small>
                  <strong>{operation.event.label ?? operation.activity?.title ?? "调查"}</strong>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="spatial-map-controls" aria-label="二维地图移动">
          <button type="button" aria-label="向北移动" aria-keyshortcuts="ArrowUp W" disabled={!moveAvailability.north} onClick={() => onInput({ type: "moveMap", direction: "north" })}><small>N</small>↑</button>
          <span>
            <button type="button" aria-label="向西移动" aria-keyshortcuts="ArrowLeft A" disabled={!moveAvailability.west} onClick={() => onInput({ type: "moveMap", direction: "west" })}><small>W</small>←</button>
            <button type="button" aria-label="向南移动" aria-keyshortcuts="ArrowDown S" disabled={!moveAvailability.south} onClick={() => onInput({ type: "moveMap", direction: "south" })}><small>S</small>↓</button>
            <button type="button" aria-label="向东移动" aria-keyshortcuts="ArrowRight D" disabled={!moveAvailability.east} onClick={() => onInput({ type: "moveMap", direction: "east" })}><small>E</small>→</button>
          </span>
        </div>
      </div>
      {landmarks.length > 0 && (
        <div className="spatial-map-radar" aria-label="附近地标雷达">
          <span className="spatial-map-radar-title"><i aria-hidden="true">⌖</i> FIELD RADAR</span>
          {landmarks.slice(0, 4).map(({ placement, distance, operations }) => (
            <span
              className={`spatial-map-radar-entry resource-${placement.resource?.kind ?? "event"}${distance <= 1 ? " nearby" : ""}${operations.some(({ activity }) => activity?.available) ? " actionable" : ""}`}
              key={placement.id}
            >
              <i aria-hidden="true">{resourceKindIcon(placement.resource?.kind ?? "event")}</i>
              <strong>{placementDisplayName(placement, resourceLabels)}</strong>
              <small>{distance === 0 ? "HERE" : `${distance} 格`}</small>
            </span>
          ))}
          {landmarks.length > 4 && <span className="spatial-map-radar-more">+{landmarks.length - 4}</span>}
        </div>
      )}
      <p className="spatial-map-footnote">
        点击相邻格或用 <kbd>方向键</kbd> / <kbd>WASD</kbd> 移动 · <kbd>E</kbd> 主要互动 · 同格事件可用 <kbd>1–9</kbd> 选择
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

export function mapMoveAvailability(map: MapDef, point?: MapPoint) {
  if (!map.layout || !point) return { north: true, east: true, south: true, west: true };
  return {
    north: !mapPointBlocker(map, { x: point.x, y: point.y - 1 }),
    east: !mapPointBlocker(map, { x: point.x + 1, y: point.y }),
    south: !mapPointBlocker(map, { x: point.x, y: point.y + 1 }),
    west: !mapPointBlocker(map, { x: point.x - 1, y: point.y }),
  };
}

export interface SpatialStepTarget {
  direction: "north" | "east" | "south" | "west";
  point: MapPoint;
  available: boolean;
  label: string;
  arrow: string;
}

export function collectSpatialStepTargets(map: MapDef, point?: MapPoint): SpatialStepTarget[] {
  if (!map.layout || !point) return [];
  const availability = mapMoveAvailability(map, point);
  const candidates: SpatialStepTarget[] = [
    { direction: "north", point: { x: point.x, y: point.y - 1 }, available: availability.north, label: "向北", arrow: "↑" },
    { direction: "east", point: { x: point.x + 1, y: point.y }, available: availability.east, label: "向东", arrow: "→" },
    { direction: "south", point: { x: point.x, y: point.y + 1 }, available: availability.south, label: "向南", arrow: "↓" },
    { direction: "west", point: { x: point.x - 1, y: point.y }, available: availability.west, label: "向西", arrow: "←" },
  ];
  return candidates.filter(({ point: candidate }) => (
    candidate.x >= 0 && candidate.y >= 0 && candidate.x < map.layout!.width && candidate.y < map.layout!.height
  ));
}

export function collectSpatialTiles(map: MapDef): Array<{
  layerId: string;
  kind: "tile" | "collision";
  tile: number;
  x: number;
  y: number;
  z: number;
}> {
  return (map.layout?.layers ?? []).flatMap((layer) => {
    if (!layer.visible || (layer.kind !== "tile" && layer.kind !== "collision") || !layer.tiles) return [];
    const kind: "tile" | "collision" = layer.kind;
    return layer.tiles.flatMap((row, y) => row.flatMap((tile, x) => tile === 0 ? [] : [{
      layerId: layer.id,
      kind,
      tile,
      x,
      y,
      z: layer.z,
    }]));
  });
}

export function spatialTileAtlasStyle(
  tile: number,
  tileset?: Pick<AssetSpec, "tileGrid">,
  tilesetUrl?: string,
): React.CSSProperties | undefined {
  const grid = tileset?.tileGrid;
  if (!grid || !tilesetUrl) return undefined;
  const index = tile - grid.firstId;
  if (index < 0 || index >= grid.columns * grid.rows) return undefined;
  const column = index % grid.columns;
  const row = Math.floor(index / grid.columns);
  return {
    backgroundImage: `url(${JSON.stringify(tilesetUrl)})`,
    backgroundPosition: `${grid.columns === 1 ? 0 : column / (grid.columns - 1) * 100}% ${grid.rows === 1 ? 0 : row / (grid.rows - 1) * 100}%`,
    backgroundRepeat: "no-repeat",
    backgroundSize: `${grid.columns * 100}% ${grid.rows * 100}%`,
  };
}

export function describePlacementApproach(
  point: MapPoint,
  placement: MapPlacementDef,
  distance = mapPlacementDistance(point, placement),
  interactionMode?: "manual" | "touch",
): string {
  if (distance === 0) {
    if (placement.resource?.kind !== "map") return "目前地 · 可以调查";
    return interactionMode === "manual" ? "目前地 · 可以前往" : "脚下是区域出口";
  }
  const right = placement.at.x + placement.footprint.width - 1;
  const bottom = placement.at.y + placement.footprint.height - 1;
  const vertical = point.y < placement.at.y ? "向南" : point.y > bottom ? "向北" : "";
  const horizontal = point.x < placement.at.x ? "向东" : point.x > right ? "向西" : "";
  const direction = [vertical, horizontal].filter(Boolean).join("再");
  const triggerHint = placement.resource?.kind === "map" && distance === 1
    ? interactionMode === "manual" ? " · 可互动" : " · 接触后移动"
    : "";
  return `${direction || "附近"} ${distance} 格${triggerHint}`;
}

export function isSpatialInteractKey(key: string): boolean {
  return key === "Enter" || key === "e" || key === "E";
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
