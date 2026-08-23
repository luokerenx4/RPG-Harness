import React from "react";
import type {
  MapDef,
  MapEventTrigger,
  MapPlacementDef,
  MapPlacementEventDef,
  ProjectResourceRef,
} from "@rpg-harness/engine";
import "./NodeMapResourceBoard.css";

export interface NodeMapResourceBoardProps {
  map: MapDef;
  selectedPlacementId?: string | null;
  interactive?: boolean;
  onSelectPlacement: (placementId: string) => void;
}

export interface NodeMapEventPageRow {
  key: string;
  id: string;
  order: number;
  trigger: MapEventTrigger;
  triggerLabel: string;
  label: string;
  command: string;
  target: ProjectResourceRef | null;
  targetInherited: boolean;
  route: boolean;
  conditional: boolean;
  probabilistic: boolean;
  lockedHint: boolean;
}

export interface NodeMapPlacementRow {
  key: string;
  id: string;
  resource: ProjectResourceRef | null;
  resourceLabel: string;
  at: { x: number; y: number };
  visible: boolean;
  conditional: boolean;
  pages: NodeMapEventPageRow[];
  routeCount: number;
}

export interface NodeMapResourceBoardModel {
  placements: NodeMapPlacementRow[];
  placementCount: number;
  eventPageCount: number;
  routeCount: number;
}

/**
 * Build an authoring projection with stable placement/event provenance.
 *
 * Deliberately reads only MapDef.placements. Legacy MapDef.connections are a
 * runtime compatibility shape and must never be flattened back into an
 * editable placement board.
 */
export function buildNodeMapResourceBoardModel(
  map: Pick<MapDef, "placements">,
): NodeMapResourceBoardModel {
  const placements = (map.placements ?? []).map((placement) => {
    const pages = orderedEventPages(placement).map(({ event }) => {
      const target = event.run ?? placement.resource ?? null;
      const route = target?.kind === "map";
      return {
        key: `placement:${placement.id}:event:${event.id}`,
        id: event.id,
        order: event.order,
        trigger: event.trigger,
        triggerLabel: nodeMapTriggerLabel(event.trigger),
        label: event.label || nodeMapTriggerLabel(event.trigger),
        command: nodeMapEventCommand(target),
        target,
        targetInherited: event.run === undefined && placement.resource !== undefined,
        route,
        conditional: event.requires !== undefined,
        probabilistic: event.chance !== undefined && event.chance < 1,
        lockedHint: Boolean(event.lockedHint),
      } satisfies NodeMapEventPageRow;
    });
    return {
      key: `placement:${placement.id}`,
      id: placement.id,
      resource: placement.resource ?? null,
      resourceLabel: placement.resource
        ? `${placement.resource.kind}:${placement.resource.id}`
        : "event-only",
      at: { ...placement.at },
      visible: placement.visible,
      conditional: placement.requires !== undefined,
      pages,
      routeCount: pages.filter((page) => page.route).length,
    } satisfies NodeMapPlacementRow;
  });

  return {
    placements,
    placementCount: placements.length,
    eventPageCount: placements.reduce((count, placement) => count + placement.pages.length, 0),
    routeCount: placements.reduce((count, placement) => count + placement.routeCount, 0),
  };
}

export function NodeMapResourceBoard({
  map,
  selectedPlacementId = null,
  interactive = true,
  onSelectPlacement,
}: NodeMapResourceBoardProps) {
  const model = buildNodeMapResourceBoardModel(map);
  const titleId = `node-map-resource-board-${safeDomSegment(map.id)}`;

  return (
    <section className="node-map-resource-board" aria-labelledby={titleId}>
      <header className="node-map-resource-board-heading">
        <span className="node-map-resource-board-mark" aria-hidden="true">◇</span>
        <div>
          <span>FOLDED NODE MAP</span>
          <h3 id={titleId}>Resources &amp; Event Pages</h3>
          <small>{map.name} · <code>map:{map.id}</code></small>
        </div>
        <dl aria-label="Node map resource counts">
          <div><dt>Objects</dt><dd>{model.placementCount}</dd></div>
          <div><dt>Pages</dt><dd>{model.eventPageCount}</dd></div>
          <div className="routes"><dt>Routes</dt><dd>{model.routeCount}</dd></div>
        </dl>
      </header>

      {model.placements.length === 0 ? (
        <div className="node-map-resource-board-empty">
          <span aria-hidden="true">◇</span>
          <strong>No placed resources</strong>
          <p>This folded node has no placements or event pages. Add an object or event to expose actions, routes, and automatic processes.</p>
        </div>
      ) : (
        <div className="node-map-resource-grid" role="list" aria-label={`Placed resources in ${map.name}`}>
          {model.placements.map((placement, index) => {
            const selected = placement.id === selectedPlacementId;
            return (
              <article
                className={`node-map-resource-card${selected ? " selected" : ""}${placement.routeCount > 0 ? " has-routes" : ""}`}
                data-placement-id={placement.id}
                key={placement.key}
                role="listitem"
              >
                <button
                  type="button"
                  className="node-map-resource-select"
                  disabled={!interactive}
                  aria-pressed={selected}
                  aria-label={`${interactive ? "Select" : "Placement"} ${placement.id}, ${placement.pages.length} event ${placement.pages.length === 1 ? "page" : "pages"}${placement.routeCount > 0 ? `, ${placement.routeCount} map ${placement.routeCount === 1 ? "route" : "routes"}` : ""}`}
                  onClick={() => onSelectPlacement(placement.id)}
                >
                  <span className="node-map-resource-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                  <span className="node-map-resource-identity">
                    <strong>{placement.resourceLabel}</strong>
                    <code>{placement.id}</code>
                  </span>
                  <span className="node-map-resource-badges">
                    {!placement.visible && <small>HIDDEN</small>}
                    {placement.conditional && <small>IF</small>}
                    {placement.routeCount > 0 && <small className="route">{placement.routeCount} ROUTE{placement.routeCount === 1 ? "" : "S"}</small>}
                  </span>
                  <i aria-hidden="true">›</i>
                </button>

                <div className="node-map-resource-origin">
                  <span>FOLDED SLOT</span>
                  <code>{placement.at.x},{placement.at.y}</code>
                  <small>{placement.pages.length} page{placement.pages.length === 1 ? "" : "s"}</small>
                </div>

                {placement.pages.length === 0 ? (
                  <div className="node-map-event-pages-empty">No event pages on this placement.</div>
                ) : (
                  <ol className="node-map-event-pages" aria-label={`Event pages for ${placement.id}`}>
                    {placement.pages.map((page, pageIndex) => (
                      <li className={page.route ? "route" : ""} data-event-id={page.id} key={page.key}>
                        <span className="node-map-event-page-number" aria-hidden="true">{pageIndex + 1}</span>
                        <span className="node-map-event-page-copy">
                          <span><strong>{page.label}</strong><code>{page.id}</code></span>
                          <small>{page.triggerLabel} · order {page.order}</small>
                        </span>
                        <span className="node-map-event-command">
                          {page.route && <i aria-hidden="true">→</i>}
                          <strong>{page.command}</strong>
                          {page.targetInherited && <small>PLACEMENT TARGET</small>}
                        </span>
                        <span className="node-map-event-flags">
                          {page.conditional && <small>IF</small>}
                          {page.probabilistic && <small>CHANCE</small>}
                          {page.lockedHint && <small>LOCKED TEXT</small>}
                          {page.route && <small className="route">MAP ROUTE</small>}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function orderedEventPages(
  placement: Pick<MapPlacementDef, "events">,
): Array<{ event: MapPlacementEventDef; sourceIndex: number }> {
  return placement.events
    .map((event, sourceIndex) => ({ event, sourceIndex }))
    .sort((left, right) => left.event.order - right.event.order || left.sourceIndex - right.sourceIndex);
}

function nodeMapEventCommand(target: ProjectResourceRef | null): string {
  if (!target) return "No resource command";
  if (target.kind === "map") return `Transfer → map:${target.id}`;
  if (target.kind === "script") return `Run → script:${target.id}`;
  if (target.kind === "action") return `Dispatch → action:${target.id}`;
  return `Activate → ${target.kind}:${target.id}`;
}

function nodeMapTriggerLabel(trigger: MapEventTrigger): string {
  const known: Partial<Record<MapEventTrigger, string>> = {
    interact: "Action Button",
    player_touch: "Player Touch",
    event_touch: "Event Touch",
    manual: "Explicit Call",
    map_enter: "Map Enter",
    autorun: "Autorun",
    parallel: "Parallel Process",
  };
  return known[trigger] ?? trigger
    .split(":")
    .map((segment) => segment.replace(/[_-]+/g, " "))
    .join(" · ");
}

function safeDomSegment(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "-");
}
