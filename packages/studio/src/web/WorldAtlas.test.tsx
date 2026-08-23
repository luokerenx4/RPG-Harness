import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MapDef, MapPlacementEventDef, ProjectResourceNode } from "@rpg-harness/engine";
import {
  WorldAtlas,
  buildWorldAtlasModel,
  nextWorldAtlasCardIndex,
  worldAtlasMapKey,
} from "./WorldAtlas";

function map(id: string, extra: Partial<MapDef> = {}): MapDef {
  return {
    id,
    name: extra.name ?? id,
    description: "",
    ...extra,
  };
}

function placementExit(
  id: string,
  target: string,
  label: string,
  extra: Partial<MapPlacementEventDef> = {},
) {
  return {
    id,
    at: { x: 1, y: 1 },
    z: 0,
    footprint: { width: 1, height: 1 },
    collision: "trigger" as const,
    visible: true,
    resource: { kind: "map" as const, id: target },
    events: [{ id: "move", trigger: "player_touch" as const, label, order: 0, ...extra }],
  };
}

const maps: MapDef[] = [
  map("root", { name: "Same name", placements: [] }),
  map("branch", {
    name: "Same name",
    chain: "alpha",
    connections: [
      { dir: "East", target: "loop", requires: { switch: { name: "gate" } } },
      { dir: "Broken", target: "missing" },
      { dir: "Leap", target: "other" },
    ],
    placements: [placementExit("north-door", "field", "North", {
      chance: 0.35,
      arrival: { at: { x: 2, y: 3 } },
    })],
  }),
  map("entry", {
    name: "Entry <img onerror=boom>",
    chain: "alpha",
    isEntry: true,
    connections: [
      { dir: "Begin", target: "branch" },
      { dir: "Alternate", target: "branch" },
    ],
  }),
  map("loop", {
    chain: "alpha",
    isExtract: true,
    connections: [
      { dir: "Back", target: "entry" },
      { dir: "Wait", target: "loop" },
    ],
  }),
  map("field", {
    chain: "alpha",
    layout: {
      width: 8,
      height: 6,
      tileWidth: 32,
      tileHeight: 32,
      layers: [],
      regions: [],
    },
    connections: [{ dir: "Portal", target: "other" }],
    placements: [],
  }),
  map("other", { chain: "beta", isEntry: true, placements: [placementExit("self", "other", "Again")] }),
];

function resource(id: string): ProjectResourceNode {
  return { key: worldAtlasMapKey(id), kind: "map", id, label: id, refs: [] };
}

describe("Studio World Atlas", () => {
  test("builds deterministic entry-first lanes from canonical legacy and placement-backed routes", () => {
    const before = structuredClone(maps);
    const model = buildWorldAtlasModel(maps);
    expect(model.chains.map((chain) => chain.key)).toEqual(["", "alpha", "beta"]);
    expect(model.chains.find((chain) => chain.key === "alpha")?.maps.map((node) => node.map.id)).toEqual([
      "entry",
      "branch",
      "loop",
      "field",
    ]);
    expect(model.spatialCount).toBe(1);
    expect(model.connectionCount).toBe(10);
    expect(model.missingTargetCount).toBe(1);

    const alpha = model.chains.find((chain) => chain.key === "alpha")!;
    const branch = alpha.maps.find((node) => node.map.id === "branch")!;
    expect(branch.connections.map(({ label, targetId }) => [label, targetId])).toEqual([
      ["East", "loop"],
      ["Broken", "missing"],
      ["Leap", "other"],
      ["North", "field"],
    ]);
    expect(branch.connections[0]?.conditional).toBe(true);
    expect(branch.connections[0]).toMatchObject({
      key: "map:branch/legacy-connection:0",
      source: "legacy-connection",
      activation: "menu",
    });
    expect(branch.connections[3]).toMatchObject({
      key: "map:branch/placement:north-door/event:move",
      source: "placement-event",
      placementId: "north-door",
      eventId: "move",
      trigger: "player_touch",
      activation: "touch",
      chance: 0.35,
      arrival: { at: { x: 2, y: 3 } },
    });
    expect(alpha.maps.find((node) => node.map.id === "loop")?.connections.some((connection) => connection.selfLoop)).toBe(true);
    expect(alpha.maps.find((node) => node.map.id === "field")?.connections[0]?.crossChain).toBe(true);
    expect(branch.incomingCount).toBe(2);
    expect(maps).toEqual(before);
  });

  test("keeps map identity independent from labels and reports duplicate ids instead of overwriting silently", () => {
    expect(worldAtlasMapKey("entry")).toBe("map:entry");
    const model = buildWorldAtlasModel([
      map("same", { name: "First" }),
      map("same", { name: "Second", chain: "other" }),
    ]);
    expect(model.duplicateIds).toEqual(["same"]);
    expect(model.mapCount).toBe(1);
    expect(model.chains[0]?.maps[0]?.resourceKey).toBe("map:same");
  });

  test("keeps authored chain identities byte-exact instead of merging whitespace variants", () => {
    const model = buildWorldAtlasModel([
      map("plain", { chain: "raid", isEntry: true }),
      map("spaced", { chain: " raid ", isEntry: true }),
    ]);
    expect(model.chains.map(({ key, label }) => [key, label])).toEqual([
      [" raid ", '" raid "'],
      ["raid", "raid"],
    ]);
  });

  test("renders readable map surfaces, routes, integrity warnings and safe authored text", () => {
    const html = renderToStaticMarkup(<WorldAtlas
      maps={maps}
      resources={maps.filter((candidate) => candidate.id !== "field").map((candidate) => resource(candidate.id))}
      assets={[]}
      onOpenMap={() => {}}
      onCreateMap={() => {}}
    />);
    expect(html).toContain("World Atlas");
    expect(html).toContain("AUTHORITATIVE WORLD CATALOG");
    expect(html).toContain("SEMANTIC NODE");
    expect(html).toContain("2D FIELD");
    expect(html).toContain("ENTRY · NODE MAP");
    expect(html).toContain("EXTRACT");
    expect(html).toContain("North");
    expect(html).toContain("field");
    expect(html).toContain("MENU");
    expect(html).toContain("TOUCH");
    expect(html).toContain("RNG 35%");
    expect(html).toContain("AT");
    expect(html).toContain('data-route-key="map:branch/placement:north-door/event:move"');
    expect(html).toContain('title="Authored source: map:branch/placement:north-door/event:move"');
    expect(html).toContain("Atlas diagnostics");
    expect(html).toContain("route-missing");
    expect(html).toContain('data-resource-key="map:entry"');
    expect(html).toContain('aria-label="Open Entry &lt;img onerror=boom&gt;, id entry');
    expect(html).toContain('aria-label="Open Same name via Begin, menu route"');
    expect(html).toContain('aria-label="Open other via Leap, menu route, cross-chain"');
    expect(html).toContain('aria-label="North route target field, player-touch trigger, 35 percent chance, explicit arrival, missing project resource"');
    expect(html).toContain('disabled="" data-resource-key="map:field"');
    expect(html.match(/tabindex="0"/g)?.length).toBe(1);
    expect(html).not.toContain("<img onerror=boom>");
  });

  test("keeps standalone DOM identity separate from authored root and standalone chain ids", () => {
    const sentinelMaps = [
      map("unassigned"),
      map("authored-root", { chain: "root", isEntry: true }),
      map("authored-standalone", { chain: "standalone", isEntry: true }),
    ];
    const html = renderToStaticMarkup(<WorldAtlas
      maps={sentinelMaps}
      resources={sentinelMaps.map((candidate) => resource(candidate.id))}
      assets={[]}
      onOpenMap={() => {}}
      onCreateMap={() => {}}
    />);
    expect(html).toContain('id="world-atlas-chain-unassigned-root"');
    expect(html).toContain('id="world-atlas-chain-authored-root"');
    expect(html).toContain('id="world-atlas-chain-authored-standalone"');
  });

  test("uses a lazy compressed background thumbnail when the asset provides one", () => {
    const backgroundMap = map("painted", { bg: "assets/backgrounds/painted" });
    const html = renderToStaticMarkup(<WorldAtlas
      maps={[backgroundMap]}
      resources={[resource("painted")]}
      assets={[{
        path: "assets/backgrounds/painted",
        kind: "bg",
        placeholder: "Painted field",
        renderings: {
          source: true,
          sourceQuality: true,
          sourceCompressed: true,
          tuiTxt: false,
          tuiAns: false,
          web: false,
        },
      }]}
      onOpenMap={() => {}}
      onCreateMap={() => {}}
    />);
    expect(html).toContain('src="/files/source-compressed/assets/backgrounds/painted"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
  });

  test("surfaces advisory spatial warnings without invalidating authored maps", () => {
    const blockedExit = {
      ...placementExit("sealed-exit", "target", "Leave"),
      collision: "block" as const,
    };
    const warningMaps = [
      map("field", {
        layout: {
          width: 2,
          height: 2,
          tileWidth: 32,
          tileHeight: 32,
          playerStart: { x: 0, y: 0 },
          layers: [],
          regions: [],
        },
        placements: [blockedExit],
      }),
      map("target"),
    ];
    const model = buildWorldAtlasModel(warningMaps);
    const field = model.chains[0]!.maps.find((node) => node.map.id === "field")!;

    expect(model.warningCount).toBe(1);
    expect(model.diagnostics[0]).toMatchObject({
      mapId: "field",
      placementId: "sealed-exit",
      code: "player-touch-no-walkable-entry",
      severity: "warning",
    });
    expect(field.connections[0]?.diagnostics).toHaveLength(1);
    expect(field.diagnostics).toHaveLength(1);

    const html = renderToStaticMarkup(<WorldAtlas
      maps={warningMaps}
      resources={warningMaps.map((candidate) => resource(candidate.id))}
      assets={[]}
      onOpenMap={() => {}}
      onCreateMap={() => {}}
    />);
    expect(html).toContain("1 spatial playability warning");
    expect(html).toContain("Maps remain authorable for Headless, custom renderers, and scripted scenes.");
    expect(html).toContain("⚠ 1");
    expect(html).toContain("<span>WARN</span><b>1</b>");
    expect(html).toContain('aria-label="Open target via Leave, player-touch trigger, 1 spatial warning"');
    expect(html).toContain('aria-label="Review 1 spatial warning in source map field"');
    expect(html).toContain('data-warning-source-map="field"');
  });

  test("counts cross-chain arrival warnings in both affected and authored lanes", () => {
    const warningMaps = [
      map("source", {
        name: "Source Gate",
        chain: "alpha",
        placements: [placementExit("door", "target", "Cross", {
          arrival: { placementId: "blocked-entry" },
        })],
      }),
      map("target", {
        chain: "beta",
        layout: {
          width: 2,
          height: 1,
          tileWidth: 32,
          tileHeight: 32,
          playerStart: { x: 0, y: 0 },
          layers: [],
          regions: [],
        },
        placements: [{
          id: "blocked-entry",
          at: { x: 1, y: 0 },
          z: 0,
          footprint: { width: 1, height: 1 },
          collision: "block",
          visible: true,
          events: [],
        }],
      }),
    ];
    const model = buildWorldAtlasModel(warningMaps);
    const alpha = model.chains.find((chain) => chain.key === "alpha")!;
    const beta = model.chains.find((chain) => chain.key === "beta")!;

    expect(model.warningCount).toBe(1);
    expect(alpha.warningCount).toBe(1);
    expect(beta.warningCount).toBe(1);
    expect(alpha.maps[0]?.connections[0]?.diagnostics[0]).toMatchObject({
      mapId: "target",
      sourceMapId: "source",
      placementId: "door",
      eventId: "move",
      code: "blocked-route-arrival",
    });

    const html = renderToStaticMarkup(<WorldAtlas
      maps={warningMaps}
      resources={warningMaps.map((candidate) => resource(candidate.id))}
      assets={[]}
      onOpenMap={() => {}}
      onCreateMap={() => {}}
    />);
    expect(html).toContain('aria-label="Review 1 spatial warning in source map Source Gate"');
    expect(html).toContain('data-warning-source-map="source"');
    expect(html).toContain('data-warning-source-key="map:source/placement:door/event:move"');
  });

  test("renders an explicit creation target when the project has no maps", () => {
    const html = renderToStaticMarkup(<WorldAtlas maps={[]} resources={[]} assets={[]} onOpenMap={() => {}} onCreateMap={() => {}} />);
    expect(html).toContain("No maps yet");
    expect(html).toContain("Create first map");
  });

  test("moves between responsive route lanes while clamping every edge", () => {
    const positions = [
      { left: 0, top: 0 },
      { left: 100, top: 0 },
      { left: 0, top: 100 },
      { left: 100, top: 100 },
      { left: 0, top: 200 },
    ];
    expect(nextWorldAtlasCardIndex([], 0, "ArrowRight")).toBe(-1);
    expect(nextWorldAtlasCardIndex(positions, 1, "ArrowLeft")).toBe(0);
    expect(nextWorldAtlasCardIndex(positions, 1, "ArrowRight")).toBe(2);
    expect(nextWorldAtlasCardIndex(positions, 1, "ArrowDown")).toBe(3);
    expect(nextWorldAtlasCardIndex(positions, 3, "ArrowUp")).toBe(1);
    expect(nextWorldAtlasCardIndex(positions, 4, "ArrowDown")).toBe(4);
    expect(nextWorldAtlasCardIndex(positions, 2, "Home")).toBe(0);
    expect(nextWorldAtlasCardIndex(positions, 2, "End")).toBe(4);
  });
});
