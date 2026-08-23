import React, { useMemo, useState } from "react";
import {
  collectMapRoutes,
  type MapArrivalDef,
  type MapDef,
  type MapEventTrigger,
  type MapRouteSource,
  type ProjectResourceNode,
} from "@rpg-harness/engine";
import {
  sourceCompressedImageUrl,
  sourceImageUrl,
  type ProjectAssetPreview,
} from "./api";
import {
  compareMapCatalogChainKeys,
  mapCatalogChainKey,
  mapCatalogChainLabelFromKey,
  STANDALONE_MAP_CHAIN,
} from "./MapCatalog";

export type WorldAtlasConnectionState = "resolved" | "missing" | "ambiguous";
export type WorldAtlasRouteActivation = "menu" | "automatic" | "touch" | "interact" | "extension";

export interface WorldAtlasConnection {
  key: string;
  source: MapRouteSource;
  placementId?: string;
  eventId?: string;
  trigger?: MapEventTrigger;
  chance?: number;
  arrival?: MapArrivalDef;
  activation: WorldAtlasRouteActivation;
  label: string;
  targetId: string;
  targetName: string;
  state: WorldAtlasConnectionState;
  crossChain: boolean;
  selfLoop: boolean;
  conditional: boolean;
}

export interface WorldAtlasMapNode {
  map: MapDef;
  resourceKey: string;
  chainKey: string;
  incomingCount: number;
  connections: WorldAtlasConnection[];
}

export interface WorldAtlasChain {
  key: string;
  label: string;
  maps: WorldAtlasMapNode[];
  spatialCount: number;
  entryCount: number;
  extractCount: number;
  connectionCount: number;
}

export interface WorldAtlasModel {
  chains: WorldAtlasChain[];
  mapCount: number;
  spatialCount: number;
  connectionCount: number;
  missingTargetCount: number;
  duplicateIds: string[];
}

function atlasChainKey(map: Pick<MapDef, "chain">): string {
  return mapCatalogChainKey(map);
}

function atlasChainLabel(key: string): string {
  return mapCatalogChainLabelFromKey(key);
}

function routeActivation(trigger?: MapEventTrigger): WorldAtlasRouteActivation {
  if (trigger === "map_enter" || trigger === "autorun") return "automatic";
  if (trigger === "player_touch") return "touch";
  if (trigger === "interact" || trigger === "manual") return "interact";
  if (trigger !== undefined) return "extension";
  return "menu";
}

function routeActivationLabel(activation: WorldAtlasRouteActivation): string {
  return {
    menu: "MENU",
    automatic: "AUTO",
    touch: "TOUCH",
    interact: "USE",
    extension: "EXT",
  }[activation];
}

function routeActivationDescription(activation: WorldAtlasRouteActivation): string {
  return {
    menu: "menu route",
    automatic: "automatic trigger",
    touch: "player-touch trigger",
    interact: "nearby interaction",
    extension: "module-scheduled trigger",
  }[activation];
}

function orderAtlasChainMaps(
  maps: MapDef[],
  connectionsByMap: Map<string, WorldAtlasConnection[]>,
): MapDef[] {
  if (maps.length <= 1 || maps.every((map) => !map.chain?.trim())) return maps;
  const allowed = new Set(maps.map((map) => map.id));
  const mapsById = new Map(maps.map((map) => [map.id, map]));
  const seen = new Set<string>();
  const ordered: MapDef[] = [];
  const queue = maps.filter((map) => map.isEntry);
  if (queue.length === 0 && maps[0]) queue.push(maps[0]);
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const map = queue[queueIndex++]!;
    if (seen.has(map.id)) continue;
    seen.add(map.id);
    ordered.push(map);
    for (const connection of connectionsByMap.get(map.id) ?? []) {
      if (!allowed.has(connection.targetId) || seen.has(connection.targetId)) continue;
      const target = mapsById.get(connection.targetId);
      if (target) queue.push(target);
    }
  }

  for (const map of maps) {
    if (!seen.has(map.id)) ordered.push(map);
  }
  return ordered;
}

export function worldAtlasMapKey(mapId: string): string {
  return `map:${mapId}`;
}

function worldAtlasChainDomId(key: string): string {
  return key === STANDALONE_MAP_CHAIN
    ? "world-atlas-chain-unassigned-root"
    : `world-atlas-chain-authored-${encodeURIComponent(key)}`;
}

export function buildWorldAtlasModel(maps: MapDef[]): WorldAtlasModel {
  const idCounts = new Map<string, number>();
  for (const map of maps) idCounts.set(map.id, (idCounts.get(map.id) ?? 0) + 1);
  const duplicateIds = [...idCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();

  // Invalid duplicate ids cannot occur in a loaded authoritative project. If a
  // malformed projection reaches the view, retain the first record and report
  // the identity collision instead of silently overwriting it in a Map.
  const uniqueMaps: MapDef[] = [];
  const seenIds = new Set<string>();
  for (const map of maps) {
    if (seenIds.has(map.id)) continue;
    seenIds.add(map.id);
    uniqueMaps.push(map);
  }

  const mapsById = new Map(uniqueMaps.map((map) => [map.id, map]));
  const connectionsByMap = new Map<string, WorldAtlasConnection[]>();
  let missingTargetCount = 0;
  for (const map of uniqueMaps) {
    const sourceChain = atlasChainKey(map);
    const connections = collectMapRoutes(map).map((connection) => {
      const targetCount = idCounts.get(connection.target) ?? 0;
      const target = targetCount === 1 ? mapsById.get(connection.target) : undefined;
      const state: WorldAtlasConnectionState = targetCount === 0
        ? "missing"
        : targetCount > 1
          ? "ambiguous"
          : "resolved";
      if (state !== "resolved") missingTargetCount += 1;
      return {
        key: connection.key,
        source: connection.source,
        ...(connection.placementId ? { placementId: connection.placementId } : {}),
        ...(connection.eventId ? { eventId: connection.eventId } : {}),
        ...(connection.trigger ? { trigger: connection.trigger } : {}),
        ...(connection.chance !== undefined ? { chance: connection.chance } : {}),
        ...(connection.arrival ? { arrival: connection.arrival } : {}),
        activation: routeActivation(connection.trigger),
        label: connection.dir,
        targetId: connection.target,
        targetName: target?.name ?? connection.target,
        state,
        crossChain: Boolean(target && atlasChainKey(target) !== sourceChain),
        selfLoop: connection.target === map.id,
        conditional: Boolean(connection.requires),
      };
    });
    connectionsByMap.set(map.id, connections);
  }

  const incomingByMap = new Map(uniqueMaps.map((map) => [map.id, 0]));
  for (const connections of connectionsByMap.values()) {
    for (const connection of connections) {
      if (connection.state !== "resolved") continue;
      incomingByMap.set(connection.targetId, (incomingByMap.get(connection.targetId) ?? 0) + 1);
    }
  }

  const groupMaps = new Map<string, MapDef[]>();
  for (const map of uniqueMaps) {
    const key = atlasChainKey(map);
    const group = groupMaps.get(key) ?? [];
    group.push(map);
    groupMaps.set(key, group);
  }

  const chains = [...groupMaps.entries()].map(([key, chainMaps]) => {
    const orderedMaps = orderAtlasChainMaps(chainMaps, connectionsByMap);
    return {
      key,
      label: atlasChainLabel(key),
      maps: orderedMaps.map((map) => ({
        map,
        resourceKey: worldAtlasMapKey(map.id),
        chainKey: key,
        incomingCount: incomingByMap.get(map.id) ?? 0,
        connections: connectionsByMap.get(map.id) ?? [],
      })),
      spatialCount: chainMaps.filter((map) => map.layout !== undefined).length,
      entryCount: chainMaps.filter((map) => map.isEntry).length,
      extractCount: chainMaps.filter((map) => map.isExtract).length,
      connectionCount: chainMaps.reduce(
        (count, map) => count + (connectionsByMap.get(map.id)?.length ?? 0),
        0,
      ),
    } satisfies WorldAtlasChain;
  }).sort((left, right) => {
    return compareMapCatalogChainKeys(left.key, right.key);
  });

  return {
    chains,
    mapCount: uniqueMaps.length,
    spatialCount: uniqueMaps.filter((map) => map.layout !== undefined).length,
    connectionCount: [...connectionsByMap.values()].reduce((count, rows) => count + rows.length, 0),
    missingTargetCount,
    duplicateIds,
  };
}

export interface WorldAtlasCardPosition {
  left: number;
  top: number;
}

export function nextWorldAtlasCardIndex(
  positions: WorldAtlasCardPosition[],
  current: number,
  key: string,
): number {
  if (positions.length === 0) return -1;
  if (current < 0 || current >= positions.length) return 0;
  if (key === "Home") return 0;
  if (key === "End") return positions.length - 1;
  if (key === "ArrowLeft") return Math.max(0, current - 1);
  if (key === "ArrowRight") return Math.min(positions.length - 1, current + 1);
  if (key !== "ArrowUp" && key !== "ArrowDown") return current;

  const origin = positions[current]!;
  const direction = key === "ArrowDown" ? 1 : -1;
  const candidates = positions
    .map((position, index) => ({ position, index }))
    .filter(({ position }) => direction > 0 ? position.top > origin.top : position.top < origin.top)
    .sort((left, right) => {
      const leftVertical = Math.abs(left.position.top - origin.top);
      const rightVertical = Math.abs(right.position.top - origin.top);
      if (leftVertical !== rightVertical) return leftVertical - rightVertical;
      return Math.abs(left.position.left - origin.left) - Math.abs(right.position.left - origin.left);
    });
  return candidates[0]?.index ?? current;
}

function mapCardAriaLabel(node: WorldAtlasMapNode): string {
  const { map, connections } = node;
  const kind = map.layout ? `${map.layout.width} by ${map.layout.height} 2D map` : "node map";
  const roles = [map.isEntry ? "entry" : "", map.isExtract ? "extract" : ""].filter(Boolean).join(", ");
  const routes = connections.length === 0
    ? "no outgoing routes"
    : `${connections.length} outgoing ${connections.length === 1 ? "route" : "routes"}: ${connections.map((connection) => connection.targetName).join(", ")}`;
  return `Open ${map.name}, id ${map.id}, ${kind}${roles ? `, ${roles}` : ""}, ${routes}`;
}

function MapCardVisual({ map, backgroundUrl }: { map: MapDef; backgroundUrl?: string }) {
  const hasBackground = Boolean(backgroundUrl);
  if (!map.layout) {
    return <span className={`world-atlas-node-visual${hasBackground ? " has-background" : ""}`} aria-hidden="true">
      {backgroundUrl && <img src={backgroundUrl} alt="" loading="lazy" decoding="async" />}
      <i>◇</i>
      {(map.placements ?? []).slice(0, 5).map((placement, index) => <b key={placement.id} style={{ transform: `rotate(${index * 72}deg) translateY(-18px)` }} />)}
      <small>SEMANTIC NODE</small>
    </span>;
  }
  const { width, height } = map.layout;
  const gridStyle = {
    aspectRatio: `${Math.max(1, width)} / ${Math.max(1, height)}`,
  };
  return <span className={`world-atlas-grid-visual${hasBackground ? " has-background" : ""}`} style={gridStyle} aria-hidden="true">
    {backgroundUrl && <img src={backgroundUrl} alt="" loading="lazy" decoding="async" />}
    {(map.placements ?? []).slice(0, 12).map((placement) => (
      <i
        key={placement.id}
        className={`collision-${placement.collision}`}
        style={{
          left: `${((placement.at.x + .5) / Math.max(1, width)) * 100}%`,
          top: `${((placement.at.y + .5) / Math.max(1, height)) * 100}%`,
        }}
      />
    ))}
    <small>{width}×{height}</small>
  </span>;
}

export function WorldAtlas({
  maps,
  resources,
  assets,
  onOpenMap,
  onCreateMap,
}: {
  maps: MapDef[];
  resources: ProjectResourceNode[];
  assets: ProjectAssetPreview[];
  onOpenMap: (mapId: string) => void;
  onCreateMap: () => void;
}) {
  const model = useMemo(() => buildWorldAtlasModel(maps), [maps]);
  const mapResourceIds = useMemo(
    () => new Set(resources.filter((resource) => resource.kind === "map").map((resource) => resource.id)),
    [resources],
  );
  const assetsByPath = useMemo(() => new Map(assets.map((asset) => [asset.path, asset])), [assets]);
  const navigableMapKeys = useMemo(
    () => model.chains.flatMap((chain) => chain.maps)
      .filter((node) => mapResourceIds.has(node.map.id))
      .map((node) => node.resourceKey),
    [mapResourceIds, model],
  );
  const [activeMapKey, setActiveMapKey] = useState<string | null>(null);
  const rovingMapKey = activeMapKey && navigableMapKeys.includes(activeMapKey)
    ? activeMapKey
    : navigableMapKeys[0] ?? null;

  const navigateAtlas = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const cards = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button.world-atlas-map-card:not(:disabled)"));
    const target = event.target instanceof HTMLButtonElement ? event.target : null;
    if (!target || !cards.includes(target)) return;
    event.preventDefault();
    const lane = target.closest(".world-atlas-map-flow");
    const laneCards = Array.from(lane?.querySelectorAll<HTMLButtonElement>("button.world-atlas-map-card:not(:disabled)") ?? []);
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const laneIndex = laneCards.indexOf(target);
      const direction = event.key === "ArrowRight" ? 1 : -1;
      laneCards[Math.max(0, Math.min(laneCards.length - 1, laneIndex + direction))]?.focus();
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      const scope = event.ctrlKey || event.metaKey ? cards : laneCards;
      scope[event.key === "Home" ? 0 : scope.length - 1]?.focus();
      return;
    }
    const positions = cards.map((card) => {
      const rect = card.getBoundingClientRect();
      return { left: rect.left, top: rect.top };
    });
    cards[nextWorldAtlasCardIndex(positions, cards.indexOf(target), event.key)]?.focus();
  };

  if (maps.length === 0) {
    return <section className="world-atlas world-atlas-empty" aria-labelledby="world-atlas-title">
      <div className="world-atlas-empty-mark" aria-hidden="true">▦</div>
      <span>AUTHORITATIVE WORLD CATALOG</span>
      <h1 id="world-atlas-title">World Atlas</h1>
      <strong>No maps yet</strong>
      <p>Create the first map as a semantic location or a two-dimensional RPG field.</p>
      <button type="button" onClick={onCreateMap}>＋ Create first map</button>
    </section>;
  }

  return (
    <section className="world-atlas" aria-labelledby="world-atlas-title" onKeyDown={navigateAtlas}>
      <header className="world-atlas-hero">
        <div className="world-atlas-mark" aria-hidden="true"><i>◇</i><b>◇</b><em>◇</em></div>
        <div className="world-atlas-title">
          <span>AUTHORITATIVE WORLD CATALOG</span>
          <h1 id="world-atlas-title">World Atlas</h1>
          <p>Browse authored locations and routes. Two-dimensional fields and node maps share one catalog.</p>
          <small className="world-atlas-static-note">AUTHORED ROUTE EVENTS · MODULE-ONLY TRAVEL IS NOT DRAWN</small>
        </div>
        <dl>
          <div><dt>Maps</dt><dd>{model.mapCount}</dd></div>
          <div><dt>Sections</dt><dd>{model.chains.length}</dd></div>
          <div><dt>2D fields</dt><dd>{model.spatialCount}</dd></div>
          <div><dt>Routes</dt><dd>{model.connectionCount}</dd></div>
        </dl>
        <button type="button" className="world-atlas-create" onClick={onCreateMap}>＋ New Map</button>
      </header>

      {(model.duplicateIds.length > 0 || model.missingTargetCount > 0) && (
        <div className="world-atlas-warning" role="status">
          <strong>Atlas integrity warning</strong>
          {model.duplicateIds.length > 0 && <span>Duplicate map IDs: {model.duplicateIds.join(", ")}</span>}
          {model.missingTargetCount > 0 && <span>{model.missingTargetCount} route target{model.missingTargetCount === 1 ? " is" : "s are"} missing or ambiguous.</span>}
        </div>
      )}

      <div className="world-atlas-chains">
        {model.chains.map((chain) => (
          <section
            className="world-atlas-chain"
            aria-labelledby={worldAtlasChainDomId(chain.key)}
            key={chain.key === STANDALONE_MAP_CHAIN ? "root:standalone" : `chain:${chain.key}`}
          >
            <header>
              <div>
                <span>{chain.key ? "MAP CHAIN" : "ROOT MAPS"}</span>
                <h2 id={worldAtlasChainDomId(chain.key)}>{chain.label}</h2>
              </div>
              <dl>
                <div><dt>Maps</dt><dd>{chain.maps.length}</dd></div>
                <div><dt>2D</dt><dd>{chain.spatialCount}</dd></div>
                <div><dt>Entries</dt><dd>{chain.entryCount}</dd></div>
                <div><dt>Extracts</dt><dd>{chain.extractCount}</dd></div>
                <div><dt>Routes</dt><dd>{chain.connectionCount}</dd></div>
              </dl>
            </header>
            <ol className="world-atlas-map-flow">
              {chain.maps.map((node) => {
                const { map, connections } = node;
                const resourceAvailable = mapResourceIds.has(map.id);
                const backgroundAsset = map.bg ? assetsByPath.get(map.bg) : undefined;
                const backgroundUrl = backgroundAsset && map.bg
                  ? backgroundAsset.renderings.sourceCompressed
                    ? sourceCompressedImageUrl(map.bg)
                    : sourceImageUrl(map.bg)
                  : undefined;
                return <li key={node.resourceKey}>
                  <article className={`world-atlas-map-card-shell${map.layout ? " spatial" : " node"}${map.isEntry ? " entry" : ""}${map.isExtract ? " extract" : ""}`}>
                    <button
                      type="button"
                      className="world-atlas-map-card"
                      aria-label={mapCardAriaLabel(node)}
                      disabled={!resourceAvailable}
                      data-resource-key={node.resourceKey}
                      tabIndex={resourceAvailable && node.resourceKey === rovingMapKey ? 0 : -1}
                      onFocus={() => setActiveMapKey(node.resourceKey)}
                      onClick={() => onOpenMap(map.id)}
                    >
                      <span className="world-atlas-card-heading">
                        <small>{map.isEntry ? "ENTRY · " : ""}{map.layout ? "2D FIELD" : "NODE MAP"}</small>
                        <strong>{map.name}</strong>
                        <code>{map.id}</code>
                        {map.isExtract && <b>EXTRACT</b>}
                      </span>
                      <MapCardVisual map={map} backgroundUrl={backgroundUrl} />
                      <span className="world-atlas-card-stats">
                        {map.layout
                          ? <><i>{map.layout.regions.length} regions</i><i>{map.placements?.length ?? 0} objects</i></>
                          : <><i>{map.placements?.length ?? 0} resources</i><i>{map.actions?.length ?? 0} actions</i></>}
                        <i>{node.incomingCount} in · {connections.length} out</i>
                      </span>
                    </button>
                    <ul className={`world-atlas-card-routes${connections.length === 0 ? " empty" : ""}`} aria-label={`Routes from ${map.name}`}>
                      <li className="world-atlas-route-heading"><small>{connections.length === 0 ? "NO OUTGOING ROUTES" : `${connections.length} OUTGOING ${connections.length === 1 ? "ROUTE" : "ROUTES"}`}</small></li>
                      {connections.map((connection) => {
                        const targetAvailable = connection.state === "resolved" && mapResourceIds.has(connection.targetId);
                        const routeQualifiers = [
                          routeActivationDescription(connection.activation),
                          connection.crossChain ? "cross-chain" : "",
                          connection.conditional ? "conditional" : "",
                          connection.chance !== undefined ? `${Math.round(connection.chance * 100)} percent chance` : "",
                          connection.arrival ? "explicit arrival" : "",
                        ].filter(Boolean).join(", ");
                        const availability = connection.state === "resolved"
                          ? targetAvailable ? "" : "missing project resource"
                          : connection.state;
                        const accessibleStatus = [routeQualifiers, availability].filter(Boolean).join(", ");
                        return <li key={connection.key}>
                          <button
                            type="button"
                            className={`world-atlas-route route-${connection.state} activation-${connection.activation}${connection.crossChain ? " cross-chain" : ""}`}
                            data-route-key={connection.key}
                            title={`Authored source: ${connection.key}`}
                            aria-label={targetAvailable
                              ? `Open ${connection.targetName} via ${connection.label}${accessibleStatus ? `, ${accessibleStatus}` : ""}`
                              : `${connection.label} route target ${connection.targetId}, ${accessibleStatus}`}
                            disabled={!targetAvailable}
                            onClick={() => onOpenMap(connection.targetId)}
                          >
                            <i aria-hidden="true">{connection.selfLoop ? "↻" : connection.crossChain ? "↗" : "→"}</i>
                            <b>{connection.label}</b>
                            <em>{connection.targetName}</em>
                            <span className="world-atlas-route-flags">
                              <small className={`activation activation-${connection.activation}`}>{routeActivationLabel(connection.activation)}</small>
                              {connection.conditional && <small>IF</small>}
                              {connection.chance !== undefined && <small>RNG {Math.round(connection.chance * 100)}%</small>}
                              {connection.arrival && <small>AT</small>}
                              {availability && <small className="issue">{availability.toUpperCase()}</small>}
                            </span>
                          </button>
                        </li>;
                      })}
                    </ul>
                  </article>
                </li>;
              })}
            </ol>
          </section>
        ))}
      </div>
      <footer className="world-atlas-footer">
        <span>On map cards:</span>
        <span><kbd>←→</kbd> Along chain</span>
        <span><kbd>↑↓</kbd> Between chains</span>
        <span><kbd>Home</kbd><kbd>End</kbd> Chain ends</span>
        <span><kbd>Enter</kbd> Open</span>
        <span><i /> 2D and node maps share one engine identity</span>
      </footer>
    </section>
  );
}
