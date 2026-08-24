import type {
  MapDef,
  MapEventTrigger,
  MapPlacementDef,
  MapPoint,
  ProjectResourceNode,
} from "@rpg-harness/engine";

export const MAP_EVENT_NAVIGATOR_RESULT_LIMIT = 100;

export type MapEventNavigatorLocator =
  | { kind: "placement"; placementId: string }
  | { kind: "event"; placementId: string; eventId: string };

export type MapEventNavigatorProblem =
  | "placement-id-empty"
  | "placement-id-duplicate"
  | "event-id-empty"
  | "event-id-duplicate";

export type MapEventNavigatorDestination =
  | { mode: "exact"; locator: MapEventNavigatorLocator }
  | {
    mode: "placement-only";
    locator: Extract<MapEventNavigatorLocator, { kind: "placement" }>;
    problem: Extract<MapEventNavigatorProblem, "event-id-empty" | "event-id-duplicate">;
  }
  | { mode: "disabled"; problem: MapEventNavigatorProblem };

export interface MapEventNavigatorRow {
  /** Ephemeral authored-array identity for React; never a canonical deep link. */
  key: string;
  kind: "placement" | "event";
  placementId: string;
  eventId?: string;
  label: string;
  placementLabel: string;
  canonicalPath?: string;
  at: MapPoint;
  layer?: string;
  trigger?: MapEventTrigger;
  targetKey?: string;
  targetLabel?: string;
  diagnosticCount: number;
  destination: MapEventNavigatorDestination;
  /** NFKC-normalized, lower-case search projection. */
  searchText: string;
}

export interface MapEventNavigatorIndex {
  mapId: string;
  rows: readonly MapEventNavigatorRow[];
  placementCount: number;
  eventCount: number;
}

export interface MapEventNavigatorSearchResult {
  rows: readonly MapEventNavigatorRow[];
  total: number;
  truncated: boolean;
}

export type MapEventNavigatorResolveErrorCode =
  | "placement-id-empty"
  | "placement-not-found"
  | "placement-id-duplicate"
  | "event-id-empty"
  | "event-not-found"
  | "event-id-duplicate";

export type MapEventNavigatorResolution =
  | { ok: true; placement: MapPlacementDef; eventId?: string }
  | {
    ok: false;
    code: MapEventNavigatorResolveErrorCode;
    message: string;
  };

type NavigableMap = Pick<MapDef, "id" | "layout" | "placements">;

/**
 * Project the current map draft into a stable, searchable authoring index.
 *
 * Rows preserve placement and event array order. Invalid local IDs remain
 * visible for repair, but never receive an ambiguous exact destination.
 */
export function buildMapEventNavigatorIndex(
  map: NavigableMap,
  resources: readonly ProjectResourceNode[],
  diagnosticCounts: ReadonlyMap<string, number> = new Map(),
): MapEventNavigatorIndex {
  const placements = map.placements ?? [];
  const resourceByKey = new Map(resources.map((resource) => [resource.key, resource]));
  const placementIdCounts = countIds(placements.map((placement) => placement.id));
  const rows: MapEventNavigatorRow[] = [];
  let eventCount = 0;

  placements.forEach((placement, placementIndex) => {
    const placementProblem = localIdProblem(
      placement.id,
      placementIdCounts.get(placement.id) ?? 0,
      "placement",
    );
    const placementLabel = placementResourceLabel(placement, resourceByKey);
    const placementResourceKey = placement.resource
      ? resourceKey(placement.resource.kind, placement.resource.id)
      : undefined;
    const canonicalPlacementPath = placementProblem
      ? undefined
      : `map:${map.id}/placement:${placement.id}`;
    const diagnosticCount = normalizedDiagnosticCount(diagnosticCounts.get(placement.id));
    const placementSearchParts = [
      map.id,
      `map:${map.id}`,
      placement.id,
      placementLabel,
      placementResourceKey,
      placement.resource?.kind,
      placement.resource?.id,
      placement.at.x,
      placement.at.y,
      `${placement.at.x},${placement.at.y}`,
      placement.layer,
      placement.collision,
      placement.visible ? "visible" : "hidden",
      canonicalPlacementPath,
      placementProblem ? problemSearchLabel(placementProblem) : undefined,
    ];

    rows.push({
      key: `placement:${placementIndex}`,
      kind: "placement",
      placementId: placement.id,
      label: placementLabel,
      placementLabel,
      ...(canonicalPlacementPath ? { canonicalPath: canonicalPlacementPath } : {}),
      at: { ...placement.at },
      ...(placement.layer ? { layer: placement.layer } : {}),
      diagnosticCount,
      destination: placementProblem
        ? { mode: "disabled", problem: placementProblem }
        : {
          mode: "exact",
          locator: { kind: "placement", placementId: placement.id },
        },
      searchText: searchableText(placementSearchParts),
    });

    const eventIdCounts = countIds(placement.events.map((event) => event.id));
    placement.events.forEach((event, eventIndex) => {
      eventCount += 1;
      const eventProblem = localIdProblem(
        event.id,
        eventIdCounts.get(event.id) ?? 0,
        "event",
      );
      const target = event.run ?? placement.resource;
      const targetKey = target ? resourceKey(target.kind, target.id) : undefined;
      const targetLabel = target
        ? resourceByKey.get(targetKey!)?.label ?? target.id
        : undefined;
      const triggerLabel = humanizeTrigger(event.trigger);
      const eventLabel = event.label || triggerLabel;
      const canonicalEventPath = !placementProblem && !eventProblem
        ? `${canonicalPlacementPath}/event:${event.id}`
        : undefined;
      const destination: MapEventNavigatorDestination = placementProblem
        ? { mode: "disabled", problem: placementProblem }
        : eventProblem
          ? {
            mode: "placement-only",
            locator: { kind: "placement", placementId: placement.id },
            problem: eventProblem,
          }
          : {
            mode: "exact",
            locator: {
              kind: "event",
              placementId: placement.id,
              eventId: event.id,
            },
          };

      rows.push({
        key: `placement:${placementIndex}:event:${eventIndex}`,
        kind: "event",
        placementId: placement.id,
        eventId: event.id,
        label: eventLabel,
        placementLabel,
        ...(canonicalEventPath ? { canonicalPath: canonicalEventPath } : {}),
        at: { ...placement.at },
        ...(placement.layer ? { layer: placement.layer } : {}),
        trigger: event.trigger,
        ...(targetKey ? { targetKey } : {}),
        ...(targetLabel ? { targetLabel } : {}),
        diagnosticCount,
        destination,
        searchText: searchableText([
          ...placementSearchParts,
          event.id,
          eventLabel,
          event.trigger,
          triggerLabel,
          event.order,
          targetKey,
          targetLabel,
          target?.kind,
          target?.id,
          event.run ? "explicit target" : target ? "placement target" : "no target",
          event.arrival?.placementId,
          event.arrival?.at?.x,
          event.arrival?.at?.y,
          event.arrival?.at ? `${event.arrival.at.x},${event.arrival.at.y}` : undefined,
          canonicalEventPath,
          eventProblem ? problemSearchLabel(eventProblem) : undefined,
        ]),
      });
    });
  });

  return {
    mapId: map.id,
    rows,
    placementCount: placements.length,
    eventCount,
  };
}

/** Search an index with normalized AND tokens and a hard DOM-safety cap. */
export function searchMapEventNavigatorIndex(
  index: MapEventNavigatorIndex,
  query: string,
  limit = MAP_EVENT_NAVIGATOR_RESULT_LIMIT,
): MapEventNavigatorSearchResult {
  const normalizedQuery = normalizeMapEventNavigatorText(query).trim();
  const tokens = normalizedQuery ? normalizedQuery.split(/\s+/u) : [];
  const matches = tokens.length === 0
    ? index.rows
    : index.rows.filter((row) => tokens.every((token) => row.searchText.includes(token)));
  const requestedLimit = Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : MAP_EVENT_NAVIGATOR_RESULT_LIMIT;
  const effectiveLimit = Math.min(requestedLimit, MAP_EVENT_NAVIGATOR_RESULT_LIMIT);
  const rows = matches.slice(0, effectiveLimit);
  return {
    rows,
    total: matches.length,
    truncated: matches.length > rows.length,
  };
}

/**
 * Re-resolve a rendered locator against the latest draft before selection.
 * This deliberately fails closed if an undo/delete or concurrent edit made the
 * once-valid identity absent or ambiguous.
 */
export function resolveMapEventNavigatorTarget(
  map: Pick<MapDef, "placements">,
  locator: MapEventNavigatorLocator,
): MapEventNavigatorResolution {
  if (locator.placementId.trim().length === 0) {
    return resolutionError(
      "placement-id-empty",
      "This placement has no stable ID and cannot be selected safely.",
    );
  }
  const placements = (map.placements ?? []).filter(
    (placement) => placement.id === locator.placementId,
  );
  if (placements.length === 0) {
    return resolutionError(
      "placement-not-found",
      `Placement ${locator.placementId} no longer exists in the current map draft.`,
    );
  }
  if (placements.length > 1) {
    return resolutionError(
      "placement-id-duplicate",
      `Placement ID ${locator.placementId} is duplicated and cannot be selected safely.`,
    );
  }
  const placement = placements[0]!;
  if (locator.kind === "placement") return { ok: true, placement };

  if (locator.eventId.trim().length === 0) {
    return resolutionError(
      "event-id-empty",
      `An event page on placement ${locator.placementId} has no stable ID.`,
    );
  }
  const events = placement.events.filter((event) => event.id === locator.eventId);
  if (events.length === 0) {
    return resolutionError(
      "event-not-found",
      `Event ${locator.eventId} no longer exists on placement ${locator.placementId}.`,
    );
  }
  if (events.length > 1) {
    return resolutionError(
      "event-id-duplicate",
      `Event ID ${locator.eventId} is duplicated on placement ${locator.placementId}.`,
    );
  }
  return { ok: true, placement, eventId: events[0]!.id };
}

export function normalizeMapEventNavigatorText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function countIds(ids: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

function localIdProblem(
  id: string,
  count: number,
  kind: "placement",
): Extract<MapEventNavigatorProblem, "placement-id-empty" | "placement-id-duplicate"> | undefined;
function localIdProblem(
  id: string,
  count: number,
  kind: "event",
): Extract<MapEventNavigatorProblem, "event-id-empty" | "event-id-duplicate"> | undefined;
function localIdProblem(
  id: string,
  count: number,
  kind: "placement" | "event",
): MapEventNavigatorProblem | undefined {
  if (id.trim().length === 0) return `${kind}-id-empty`;
  if (count > 1) return `${kind}-id-duplicate`;
  return undefined;
}

function resourceKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function placementResourceLabel(
  placement: MapPlacementDef,
  resourceByKey: ReadonlyMap<string, ProjectResourceNode>,
): string {
  if (!placement.resource) return placement.id || "Event-only placement";
  const key = resourceKey(placement.resource.kind, placement.resource.id);
  return resourceByKey.get(key)?.label ?? placement.resource.id;
}

function humanizeTrigger(trigger: MapEventTrigger): string {
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

function searchableText(parts: readonly unknown[]): string {
  return normalizeMapEventNavigatorText(
    parts.filter((part) => part !== undefined && part !== null).join(" "),
  );
}

function problemSearchLabel(problem: MapEventNavigatorProblem): string {
  return problem.replace(/-/g, " ");
}

function normalizedDiagnosticCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function resolutionError(
  code: MapEventNavigatorResolveErrorCode,
  message: string,
): MapEventNavigatorResolution {
  return { ok: false, code, message };
}
