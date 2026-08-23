import React from "react";
import type { MapArrivalDef, MapDef, MapPlacementDef, MapPoint } from "@rpg-harness/engine";
import "./RouteArrivalEditor.css";

export type RouteArrivalMode = "map-start" | "placement" | "coordinate";

export interface RouteArrivalEditorProps {
  targetMap: MapDef;
  value?: MapArrivalDef;
  onChange: (value: MapArrivalDef | undefined) => void;
}

/** Resolve the visible editor mode without mutating an unsupported draft. */
export function routeArrivalMode(
  targetMap: Pick<MapDef, "layout">,
  value?: MapArrivalDef,
): RouteArrivalMode {
  if (value?.placementId) return "placement";
  if (value?.at && targetMap.layout) return "coordinate";
  return "map-start";
}

/** Clamp an authored point to integer cells owned by the target layout. */
export function clampRouteArrivalPoint(
  targetMap: Pick<MapDef, "layout">,
  point: MapPoint,
): MapPoint | undefined {
  const layout = targetMap.layout;
  if (!layout) return undefined;
  return {
    x: clampGridCoordinate(point.x, Math.max(0, layout.width - 1)),
    y: clampGridCoordinate(point.y, Math.max(0, layout.height - 1)),
  };
}

/** Build the canonical value emitted when an author changes arrival mode. */
export function routeArrivalValueForMode(
  targetMap: Pick<MapDef, "layout" | "placements">,
  mode: RouteArrivalMode,
  current?: MapArrivalDef,
): MapArrivalDef | undefined {
  if (mode === "map-start") return undefined;
  if (mode === "placement") {
    const placementId = current?.placementId || targetMap.placements?.[0]?.id;
    return placementId ? { placementId } : undefined;
  }
  if (!targetMap.layout) return undefined;
  const point = current?.at ?? targetMap.layout.playerStart ?? { x: 0, y: 0 };
  const at = clampRouteArrivalPoint(targetMap, point);
  return at ? { at } : undefined;
}

export function routeArrivalValueForCoordinate(
  targetMap: Pick<MapDef, "layout">,
  current: MapArrivalDef | undefined,
  axis: "x" | "y",
  value: number,
): MapArrivalDef | undefined {
  if (!targetMap.layout) return undefined;
  const fallback = clampRouteArrivalPoint(
    targetMap,
    current?.at ?? targetMap.layout.playerStart ?? { x: 0, y: 0 },
  ) ?? { x: 0, y: 0 };
  const at = clampRouteArrivalPoint(targetMap, {
    ...fallback,
    [axis]: Number.isFinite(value) ? value : fallback[axis],
  });
  return at ? { at } : undefined;
}

export function RouteArrivalEditor({
  targetMap,
  value,
  onChange,
}: RouteArrivalEditorProps) {
  const mode = routeArrivalMode(targetMap, value);
  const placements = targetMap.placements ?? [];
  const selectedPlacement = value?.placementId
    ? placements.find((placement) => placement.id === value.placementId)
    : undefined;
  const missingPlacementId = value?.placementId && !selectedPlacement
    ? value.placementId
    : null;
  const mapStart = targetMap.layout?.playerStart ?? { x: 0, y: 0 };
  const coordinate = targetMap.layout
    ? clampRouteArrivalPoint(targetMap, value?.at ?? mapStart) ?? mapStart
    : null;
  const unsupportedCoordinate = Boolean(value?.at && !targetMap.layout);
  const adjustedCoordinate = Boolean(
    value?.at && coordinate &&
    (value.at.x !== coordinate.x || value.at.y !== coordinate.y),
  );
  const groupName = `route-arrival-${safeDomSegment(targetMap.id)}`;

  const chooseMode = (next: RouteArrivalMode) => {
    onChange(routeArrivalValueForMode(targetMap, next, value));
  };

  const chooseCoordinate = (axis: "x" | "y", next: number) => {
    onChange(routeArrivalValueForCoordinate(targetMap, value, axis, next));
  };

  return (
    <section
      className={`route-arrival-editor mode-${mode}`}
      aria-label={`Arrival point in ${targetMap.name}`}
    >
      <header className="route-arrival-heading">
        <span aria-hidden="true">↳</span>
        <div>
          <small>TRANSFER DESTINATION</small>
          <strong>Arrival point</strong>
          <code>{targetMap.name} · map:{targetMap.id}</code>
        </div>
        <i>{targetMap.layout ? `${targetMap.layout.width}×${targetMap.layout.height}` : "NODE"}</i>
      </header>

      <fieldset className="route-arrival-modes">
        <legend>Arrival mode</legend>
        <label className={mode === "map-start" ? "selected" : ""}>
          <input
            type="radio"
            name={groupName}
            value="map-start"
            checked={mode === "map-start"}
            onChange={() => chooseMode("map-start")}
          />
          <span aria-hidden="true">◆</span>
          <strong>Map start</strong>
          <small>Use the map default</small>
        </label>
        <label className={mode === "placement" ? "selected" : ""}>
          <input
            type="radio"
            name={groupName}
            value="placement"
            checked={mode === "placement"}
            disabled={placements.length === 0 && !missingPlacementId}
            onChange={() => chooseMode("placement")}
          />
          <span aria-hidden="true">◇</span>
          <strong>Destination placement</strong>
          <small>{placements.length} stable object{placements.length === 1 ? "" : "s"}</small>
        </label>
        <label className={mode === "coordinate" ? "selected" : ""}>
          <input
            type="radio"
            name={groupName}
            value="coordinate"
            checked={mode === "coordinate"}
            disabled={!targetMap.layout}
            onChange={() => chooseMode("coordinate")}
          />
          <span aria-hidden="true">▦</span>
          <strong>Coordinate</strong>
          <small>{targetMap.layout ? "Choose an exact cell" : "Requires a 2D layout"}</small>
        </label>
      </fieldset>

      <div className="route-arrival-detail">
        {mode === "map-start" && (
          <section className="route-arrival-start" aria-label="Map start arrival">
            <span className="route-arrival-emblem" aria-hidden="true">◆</span>
            <div>
              <small>{targetMap.layout?.playerStart ? "AUTHORED PLAYER START" : targetMap.layout ? "DEFAULT PLAYER START" : "FOLDED NODE ORIGIN"}</small>
              <strong>{mapStart.x}, {mapStart.y}</strong>
              <p>{targetMap.layout
                ? "Entering this map uses its player start and remains valid if that start moves later."
                : "Headless and node-map play enter the folded origin; no two-dimensional coordinate is required."}</p>
            </div>
          </section>
        )}

        {mode === "placement" && (
          <section className="route-arrival-placement" aria-label="Destination placement arrival">
            <label>
              <span>Destination placement</span>
              <select
                aria-label="Destination placement"
                value={value?.placementId ?? ""}
                onChange={(event) => onChange({ placementId: event.currentTarget.value })}
              >
                {missingPlacementId && <option value={missingPlacementId}>{missingPlacementId} · missing from target map</option>}
                {placements.map((placement) => (
                  <option value={placement.id} key={placement.id}>{placementOptionLabel(placement)}</option>
                ))}
              </select>
            </label>
            {selectedPlacement ? (
              <div className="route-arrival-placement-summary" role="status">
                <span aria-hidden="true">◇</span>
                <div><small>STABLE PLACEMENT ID</small><code>{selectedPlacement.id}</code></div>
                <dl>
                  <div><dt>Coordinate</dt><dd>{selectedPlacement.at.x}, {selectedPlacement.at.y}</dd></div>
                  <div><dt>Collision</dt><dd>{selectedPlacement.collision}</dd></div>
                  <div><dt>Resource</dt><dd>{selectedPlacement.resource ? `${selectedPlacement.resource.kind}:${selectedPlacement.resource.id}` : "event-only"}</dd></div>
                </dl>
              </div>
            ) : (
              <div className="route-arrival-warning" role="alert">
                <strong>Placement is missing</strong>
                <span>Choose an object that still belongs to map:{targetMap.id}.</span>
              </div>
            )}
          </section>
        )}

        {mode === "coordinate" && targetMap.layout && coordinate && (
          <section className="route-arrival-coordinate" aria-label="Coordinate arrival">
            <div className="route-arrival-coordinate-fields">
              <label>
                <span>X coordinate</span>
                <input
                  type="number"
                  min={0}
                  max={Math.max(0, targetMap.layout.width - 1)}
                  step={1}
                  value={coordinate.x}
                  onChange={(event) => chooseCoordinate("x", event.currentTarget.valueAsNumber)}
                />
                <small>0–{Math.max(0, targetMap.layout.width - 1)}</small>
              </label>
              <label>
                <span>Y coordinate</span>
                <input
                  type="number"
                  min={0}
                  max={Math.max(0, targetMap.layout.height - 1)}
                  step={1}
                  value={coordinate.y}
                  onChange={(event) => chooseCoordinate("y", event.currentTarget.valueAsNumber)}
                />
                <small>0–{Math.max(0, targetMap.layout.height - 1)}</small>
              </label>
            </div>
            <div
              className="route-arrival-coordinate-preview"
              aria-label={`Selected arrival cell ${coordinate.x}, ${coordinate.y} in a ${targetMap.layout.width} by ${targetMap.layout.height} map`}
            >
              <span style={{
                left: `${((coordinate.x + .5) / Math.max(1, targetMap.layout.width)) * 100}%`,
                top: `${((coordinate.y + .5) / Math.max(1, targetMap.layout.height)) * 100}%`,
              }}><i aria-hidden="true">◆</i><small>{coordinate.x},{coordinate.y}</small></span>
            </div>
          </section>
        )}

        {unsupportedCoordinate && (
          <div className="route-arrival-warning" role="status">
            <strong>Coordinate unavailable on a node map</strong>
            <span>Map start is shown as the safe fallback. Choose it to remove the unsupported coordinate draft.</span>
          </div>
        )}
        {adjustedCoordinate && value?.at && coordinate && (
          <div className="route-arrival-warning" role="alert">
            <strong>Stored coordinate needs repair</strong>
            <span>
              Authored {value.at.x},{value.at.y} is outside this layout. The editor previews the nearest
              cell {coordinate.x},{coordinate.y}; change either coordinate or choose another mode before saving.
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

function placementOptionLabel(placement: MapPlacementDef): string {
  const resource = placement.resource
    ? `${placement.resource.kind}:${placement.resource.id}`
    : "event-only";
  return `${placement.id} · ${placement.at.x},${placement.at.y} · ${placement.collision} · ${resource}`;
}

function clampGridCoordinate(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, Math.trunc(value)));
}

function safeDomSegment(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "-");
}
