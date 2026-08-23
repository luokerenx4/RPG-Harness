import React from "react";
import {
  analyzeMapPlayability,
  isMapPlacementLayerVisible,
  type MapDef,
  type MapPlayabilityDiagnostic,
} from "@rpg-harness/engine";

const DIAGNOSTIC_TITLES: Record<MapPlayabilityDiagnostic["code"], string> = {
  "blocked-player-start": "Player start is blocked",
  "blocked-route-arrival": "Route arrives on a blocked cell",
  "player-touch-no-walkable-entry": "Touch event has no passable tile",
  "player-touch-unreachable": "Touch event is unreachable",
  "interaction-hidden": "Interactive object is hidden",
  "interaction-unreachable": "Interactive object is unreachable",
  "unscheduled-spatial-trigger": "Trigger is not scheduled by the field runtime",
};

export type MapPlayabilityQuickFixKind = "show-placement" | "make-touch-passable";

export interface MapPlayabilityQuickFix {
  kind: MapPlayabilityQuickFixKind;
  placementId: string;
  label: string;
  description: string;
}

export interface MapPlayabilityPointGroup {
  key: string;
  x: number;
  y: number;
  diagnostics: MapPlayabilityDiagnostic[];
}

export function groupMapPlayabilityPointDiagnostics(
  diagnostics: readonly MapPlayabilityDiagnostic[],
): MapPlayabilityPointGroup[] {
  const groups = new Map<string, MapPlayabilityPointGroup>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.focus.kind !== "point") continue;
    const { x, y } = diagnostic.focus.at;
    const key = `${x},${y}`;
    const group = groups.get(key) ?? { key, x, y, diagnostics: [] };
    group.diagnostics.push(diagnostic);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function mapPlayabilityDiagnosticKey(
  diagnostic: MapPlayabilityDiagnostic,
): string {
  return [
    diagnostic.mapId,
    diagnostic.code,
    diagnostic.path,
    diagnostic.sourceKey ?? "",
  ].join("\u0000");
}

export function mapPlayabilityDiagnosticTitle(
  diagnostic: MapPlayabilityDiagnostic,
): string {
  return DIAGNOSTIC_TITLES[diagnostic.code];
}

export function mapPlayabilityDiagnosticLocation(
  diagnostic: MapPlayabilityDiagnostic,
): string {
  if (diagnostic.focus.kind === "placement") {
    return `OBJECT · ${diagnostic.focus.placementId}`;
  }
  const role = diagnostic.focus.role === "player-start" ? "PLAYER START" : "ARRIVAL";
  return `${role} · ${diagnostic.focus.at.x},${diagnostic.focus.at.y}`;
}

export function mapPlayabilityDiagnosticSource(
  diagnostic: MapPlayabilityDiagnostic,
): string | undefined {
  if (!diagnostic.sourceMapId) return undefined;
  if (diagnostic.sourcePlacementId) {
    return [
      diagnostic.sourceMapId,
      `object ${diagnostic.sourcePlacementId}`,
      diagnostic.sourceEventId ? `event ${diagnostic.sourceEventId}` : undefined,
    ].filter(Boolean).join(" · ");
  }
  if (diagnostic.sourceConnectionIndex !== undefined) {
    return `${diagnostic.sourceMapId} · legacy connection ${diagnostic.sourceConnectionIndex + 1}`;
  }
  return diagnostic.sourceMapId;
}

export function mapPlayabilityDiagnosticBlocker(
  diagnostic: MapPlayabilityDiagnostic,
): string | undefined {
  if (!diagnostic.blocker) return undefined;
  if (diagnostic.blocker.kind === "bounds") return "OUTSIDE MAP BOUNDS";
  if (diagnostic.blocker.kind === "placement") {
    return `BLOCKED BY OBJECT · ${diagnostic.blocker.placementId}`;
  }
  return `BLOCKED BY COLLISION LAYER · ${diagnostic.blocker.layerId}`;
}

export function resolveMapPlayabilityQuickFix(
  maps: readonly MapDef[],
  map: MapDef,
  diagnostic: MapPlayabilityDiagnostic,
): MapPlayabilityQuickFix | undefined {
  const baseline = analyzeMapPlayability(maps).filter(
    (candidate) => candidate.mapId === map.id,
  );
  return resolveMapPlayabilityQuickFixesAgainstBaseline(
    maps,
    map,
    baseline,
    [diagnostic],
  ).get(mapPlayabilityDiagnosticKey(diagnostic));
}

/**
 * Resolve every draft fix shown by one panel as a batch. `diagnostics` must be
 * the complete diagnostic baseline for `map`; this lets the panel reuse the
 * live analysis it already received instead of running a full-catalog before
 * and after analysis for every row.
 */
export function resolveMapPlayabilityQuickFixes(
  maps: readonly MapDef[],
  map: MapDef,
  diagnostics: readonly MapPlayabilityDiagnostic[],
  analyze: (maps: readonly MapDef[]) => MapPlayabilityDiagnostic[] =
    analyzeMapPlayability,
): ReadonlyMap<string, MapPlayabilityQuickFix> {
  return resolveMapPlayabilityQuickFixesAgainstBaseline(
    maps,
    map,
    diagnostics,
    diagnostics,
    analyze,
  );
}

function quickFixCandidate(
  map: MapDef,
  diagnostic: MapPlayabilityDiagnostic,
): MapPlayabilityQuickFix | undefined {
  if (diagnostic.mapId !== map.id || diagnostic.focus.kind !== "placement") {
    return undefined;
  }
  const placementId = diagnostic.focus.placementId;
  const matches = (map.placements ?? []).filter(
    (candidate) => candidate.id === placementId,
  );
  // Applying a fix by id would update every duplicate. Invalid drafts should
  // therefore get a diagnostic, not an ambiguous one-click mutation.
  if (matches.length !== 1) return undefined;
  const placement = matches[0]!;

  if (diagnostic.code === "interaction-hidden" && !placement.visible) {
    return {
      kind: "show-placement",
      placementId: placement.id,
      label: "Show object",
      description: "Set this placement visible without changing its event pages.",
    };
  }

  if (
    diagnostic.code === "player-touch-no-walkable-entry" &&
    placement.collision === "block"
  ) {
    return {
      kind: "make-touch-passable",
      placementId: placement.id,
      label: "Make touch tile passable",
      description: "Change collision from block to trigger so the player can enter it.",
    };
  }

  return undefined;
}

export function applyMapPlayabilityQuickFix(
  map: MapDef,
  fix: MapPlayabilityQuickFix,
): MapDef {
  let changed = false;
  const placements = (map.placements ?? []).map((placement) => {
    if (placement.id !== fix.placementId) return placement;
    if (fix.kind === "show-placement") {
      if (placement.visible) return placement;
      changed = true;
      return { ...placement, visible: true };
    }
    if (placement.collision !== "block") return placement;
    changed = true;
    return { ...placement, collision: "trigger" as const };
  });
  return changed ? { ...map, placements } : map;
}

function resolveMapPlayabilityQuickFixesAgainstBaseline(
  maps: readonly MapDef[],
  map: MapDef,
  baselineDiagnostics: readonly MapPlayabilityDiagnostic[],
  candidateDiagnostics: readonly MapPlayabilityDiagnostic[],
  analyze: (maps: readonly MapDef[]) => MapPlayabilityDiagnostic[] =
    analyzeMapPlayability,
): ReadonlyMap<string, MapPlayabilityQuickFix> {
  const resolved = new Map<string, MapPlayabilityQuickFix>();
  const safetyByFix = new Map<string, boolean>();
  const previousWarnings = new Set(baselineDiagnostics
    .filter((entry) => entry.severity === "warning")
    .map(mapPlayabilityDiagnosticKey));

  for (const diagnostic of candidateDiagnostics) {
    const fix = quickFixCandidate(map, diagnostic);
    if (!fix) continue;
    const fixKey = `${fix.kind}\u0000${fix.placementId}`;
    let safe = safetyByFix.get(fixKey);
    if (safe === undefined) {
      safe = quickFixClearsDiagnostic(
        maps,
        map,
        diagnostic,
        fix,
        previousWarnings,
        analyze,
      );
      safetyByFix.set(fixKey, safe);
    }
    if (safe) resolved.set(mapPlayabilityDiagnosticKey(diagnostic), fix);
  }
  return resolved;
}

function quickFixClearsDiagnostic(
  maps: readonly MapDef[],
  map: MapDef,
  diagnostic: MapPlayabilityDiagnostic,
  fix: MapPlayabilityQuickFix,
  previousWarnings: ReadonlySet<string>,
  analyze: (maps: readonly MapDef[]) => MapPlayabilityDiagnostic[],
): boolean {
  const candidate = applyMapPlayabilityQuickFix(map, fix);
  if (candidate === map) return false;

  if (fix.kind === "show-placement") {
    const placement = candidate.placements?.find(
      (entry) => entry.id === fix.placementId,
    );
    // Visibility is monotonic for playability: it cannot change collision or
    // reachability. The only unsafe case is revealing the placement while its
    // layer remains hidden, which would replace the `.visible` warning with a
    // new `.layer` warning.
    return Boolean(placement && isMapPlacementLayerVisible(candidate, placement));
  }

  const projected = maps.some((entry) => entry.id === candidate.id)
    ? maps.map((entry) => entry.id === candidate.id ? candidate : entry)
    : [...maps, candidate];
  const after = analyze(mapQuickFixAnalysisCatalog(projected, candidate.id))
    .filter((entry) => entry.mapId === candidate.id);
  const targetKey = mapPlayabilityDiagnosticKey(diagnostic);
  const clearsTarget = !after.some((remaining) =>
    mapPlayabilityDiagnosticKey(remaining) === targetKey
  );
  if (!clearsTarget) return false;
  return after
    .filter((entry) => entry.severity === "warning")
    .every((entry) => previousWarnings.has(mapPlayabilityDiagnosticKey(entry)));
}

/**
 * Collision changes can only affect diagnostics on the edited map. Keep every
 * source route and its spatial/source identity, but collapse unrelated fields
 * to empty layouts so an eligibility check never flood-fills the whole world.
 */
function mapQuickFixAnalysisCatalog(
  maps: readonly MapDef[],
  targetMapId: string,
): MapDef[] {
  return maps.map((entry) => {
    if (entry.id === targetMapId || !entry.layout) return entry;
    return {
      ...entry,
      layout: {
        ...entry.layout,
        width: 0,
        height: 0,
      },
    };
  });
}

export function MapPlayabilityPanel({
  map,
  maps,
  diagnostics,
  authoredDiagnostics = [],
  activeKey,
  onLocate,
  onQuickFix,
  onOpenSource,
  onOpenAffected,
  onInspectBlocker,
}: {
  map: MapDef;
  maps: readonly MapDef[];
  diagnostics: MapPlayabilityDiagnostic[];
  authoredDiagnostics?: MapPlayabilityDiagnostic[];
  activeKey?: string | null;
  onLocate: (diagnostic: MapPlayabilityDiagnostic) => void;
  onQuickFix: (diagnostic: MapPlayabilityDiagnostic, fix: MapPlayabilityQuickFix) => void;
  onOpenSource: (diagnostic: MapPlayabilityDiagnostic) => void;
  onOpenAffected: (diagnostic: MapPlayabilityDiagnostic) => void;
  onInspectBlocker: (diagnostic: MapPlayabilityDiagnostic) => void;
}) {
  const quickFixes = React.useMemo(
    () => resolveMapPlayabilityQuickFixes(maps, map, diagnostics),
    [diagnostics, map, maps],
  );
  const total = diagnostics.length + authoredDiagnostics.length;
  if (total === 0) return null;

  return (
    <section className="map-playability-panel" aria-labelledby="map-playability-title">
      <header>
        <span className="map-playability-mark" aria-hidden="true">!</span>
        <div>
          <span>2D FIELD CHECKS</span>
          <strong id="map-playability-title">
            {total} spatial {total === 1 ? "warning" : "warnings"}
          </strong>
          <small>Advisory for the field renderer. Headless, node-map and custom-script play remain valid.</small>
        </div>
        <b>{map.layout?.width ?? 0}×{map.layout?.height ?? 0}</b>
      </header>
      <div className="map-playability-list">
        {diagnostics.length > 0 && <div className="map-playability-section-label"><span>AFFECTS THIS MAP</span><b>{diagnostics.length}</b></div>}
        {diagnostics.map((diagnostic) => {
          const key = mapPlayabilityDiagnosticKey(diagnostic);
          const source = mapPlayabilityDiagnosticSource(diagnostic);
          const blocker = mapPlayabilityDiagnosticBlocker(diagnostic);
          const quickFix = quickFixes.get(key);
          const canOpenSource = Boolean(
            diagnostic.sourceMapId &&
            (diagnostic.sourceMapId !== map.id || diagnostic.sourcePlacementId),
          );
          return (
            <article className={activeKey === key ? "active" : ""} key={key}>
              <i aria-hidden="true">!</i>
              <div className="map-playability-copy">
                <span>{mapPlayabilityDiagnosticLocation(diagnostic)}</span>
                <strong>{mapPlayabilityDiagnosticTitle(diagnostic)}</strong>
                <p>{diagnostic.message}</p>
                <code>{diagnostic.path}</code>
                {blocker && <small>{blocker}</small>}
                {source && <small>AUTHORED SOURCE · {source}</small>}
              </div>
              <div className="map-playability-actions">
                <button type="button" onClick={() => onLocate(diagnostic)}>Locate</button>
                {diagnostic.blocker && diagnostic.blocker.kind !== "bounds" && (
                  <button type="button" onClick={() => onInspectBlocker(diagnostic)}>Inspect blocker</button>
                )}
                {canOpenSource && (
                  <button type="button" onClick={() => onOpenSource(diagnostic)}>Open source</button>
                )}
                {quickFix && (
                  <button
                    type="button"
                    className="primary"
                    title={`Apply to unsaved draft: ${quickFix.description}`}
                    onClick={() => onQuickFix(diagnostic, quickFix)}
                  >Draft fix · {quickFix.label}</button>
                )}
              </div>
            </article>
          );
        })}
        {authoredDiagnostics.length > 0 && <div className="map-playability-section-label authored"><span>AUTHORED ON THIS MAP · AFFECTS ANOTHER FIELD</span><b>{authoredDiagnostics.length}</b></div>}
        {authoredDiagnostics.map((diagnostic) => {
          const key = `authored:${mapPlayabilityDiagnosticKey(diagnostic)}`;
          const source = mapPlayabilityDiagnosticSource(diagnostic);
          const blocker = mapPlayabilityDiagnosticBlocker(diagnostic);
          return (
            <article className="authored" key={key}>
              <i aria-hidden="true">↗</i>
              <div className="map-playability-copy">
                <span>AUTHORED HERE · AFFECTS {diagnostic.mapId} · {mapPlayabilityDiagnosticLocation(diagnostic)}</span>
                <strong>{mapPlayabilityDiagnosticTitle(diagnostic)}</strong>
                <p>{diagnostic.message}</p>
                <code>{diagnostic.path}</code>
                {source && <small>AUTHORED SOURCE · {source}</small>}
                {blocker && <small>TARGET {blocker}</small>}
              </div>
              <div className="map-playability-actions">
                <button type="button" onClick={() => onOpenSource(diagnostic)}>Review source</button>
                <button type="button" onClick={() => onOpenAffected(diagnostic)}>Open affected map</button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
