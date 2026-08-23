import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  analyzeMapPlayability,
  type MapDef,
  type MapPlacementDef,
} from "@rpg-harness/engine";
import {
  applyMapPlayabilityQuickFix,
  groupMapPlayabilityPointDiagnostics,
  MapPlayabilityPanel,
  mapPlayabilityDiagnosticKey,
  mapPlayabilityDiagnosticLocation,
  mapPlayabilityDiagnosticSource,
  resolveMapPlayabilityQuickFix,
  resolveMapPlayabilityQuickFixes,
} from "./MapPlayabilityPanel";

describe("Studio map playability diagnostics", () => {
  test("keeps an affected arrival cell separate from its authored source object", () => {
    const target = field("target", [placement("gate", 1, 0, { collision: "block" })]);
    const source: MapDef = {
      id: "source",
      name: "Source",
      description: "",
      placements: [{
        ...placement("gate", 0, 0, {
          resource: { kind: "map", id: target.id },
        }),
        events: [{
          id: "move",
          trigger: "interact",
          arrival: { placementId: "gate" },
          order: 0,
        }],
      }],
    };

    const diagnostic = analyzeMapPlayability([source, target]).find(
      (candidate) => candidate.code === "blocked-route-arrival",
    )!;

    expect(diagnostic).toMatchObject({
      mapId: "target",
      focus: { kind: "point", role: "route-arrival", at: { x: 1, y: 0 } },
      blocker: { kind: "placement", placementId: "gate" },
      sourceMapId: "source",
      sourcePlacementId: "gate",
      sourceEventId: "move",
    });
    expect(diagnostic.placementId).toBeUndefined();
    expect(mapPlayabilityDiagnosticLocation(diagnostic)).toBe("ARRIVAL · 1,0");
    expect(mapPlayabilityDiagnosticSource(diagnostic))
      .toBe("source · object gate · event move");
  });

  test("shows a placement visibility fix only when it clears the warning", () => {
    const map = field("field", [placement("keeper", 1, 0, {
      visible: false,
      events: [{ id: "talk", trigger: "interact", order: 0 }],
      custom: { portrait: "keeper" },
    })]);
    const diagnostic = analyzeMapPlayability([map]).find(
      (candidate) => candidate.code === "interaction-hidden",
    )!;
    const fix = resolveMapPlayabilityQuickFix([map], map, diagnostic)!;

    expect(fix).toMatchObject({ kind: "show-placement", placementId: "keeper" });
    const changed = applyMapPlayabilityQuickFix(map, fix);
    expect(changed.placements?.[0]).toMatchObject({
      visible: true,
      custom: { portrait: "keeper" },
      events: [{ id: "talk", trigger: "interact", order: 0 }],
    });
    expect(analyzeMapPlayability([changed]).some(
      (candidate) => candidate.code === "interaction-hidden",
    )).toBe(false);
  });

  test("does not expose a broad hidden-layer fix", () => {
    const map = field("field", [placement("keeper", 1, 0, {
      layer: "hidden",
      events: [{ id: "talk", trigger: "interact", order: 0 }],
    })], [{ id: "hidden", kind: "object", z: 1, visible: false }]);
    const diagnostic = analyzeMapPlayability([map]).find(
      (candidate) => candidate.code === "interaction-hidden",
    )!;

    expect(resolveMapPlayabilityQuickFix([map], map, diagnostic)).toBeUndefined();
  });

  test("batches visibility fixes without re-analyzing the project catalog", () => {
    const map = field("field", [
      placement("keeper-a", 0, 0, {
        visible: false,
        events: [{ id: "talk", trigger: "interact", order: 0 }],
      }),
      placement("keeper-b", 1, 0, {
        visible: false,
        events: [{ id: "talk", trigger: "interact", order: 0 }],
      }),
    ]);
    const diagnostics = analyzeMapPlayability([map]).filter(
      (candidate) => candidate.code === "interaction-hidden",
    );
    let analysisCalls = 0;
    const fixes = resolveMapPlayabilityQuickFixes(
      [map],
      map,
      diagnostics,
      () => {
        analysisCalls += 1;
        return [];
      },
    );

    expect(diagnostics).toHaveLength(2);
    expect(fixes.size).toBe(2);
    expect(analysisCalls).toBe(0);
  });

  test("analyzes one target field once for duplicate event-page fixes", () => {
    const map = field("field", [placement("touch", 1, 0, {
      collision: "block",
      events: [
        { id: "step-a", trigger: "player_touch", order: 0 },
        { id: "step-b", trigger: "player_touch", order: 1 },
      ],
    })]);
    const unrelated = {
      ...field("large-unrelated-field", []),
      layout: {
        ...field("large-unrelated-field", []).layout!,
        width: 200,
        height: 200,
      },
    };
    const maps = [unrelated, map];
    const diagnostics = analyzeMapPlayability(maps).filter(
      (candidate) => candidate.mapId === map.id &&
        candidate.code === "player-touch-no-walkable-entry",
    );
    let analysisCalls = 0;
    let analyzedUnrelatedWidth: number | undefined;
    const fixes = resolveMapPlayabilityQuickFixes(
      maps,
      map,
      diagnostics,
      (catalog) => {
        analysisCalls += 1;
        analyzedUnrelatedWidth = catalog.find(
          (candidate) => candidate.id === unrelated.id,
        )?.layout?.width;
        return analyzeMapPlayability(catalog);
      },
    );

    expect(diagnostics).toHaveLength(2);
    expect(fixes.size).toBe(2);
    expect(analysisCalls).toBe(1);
    expect(analyzedUnrelatedWidth).toBe(0);
  });

  test("distinguishes diagnostics whose authored event keys collide", () => {
    const map = field("field", [
      placement("a/event:b", 0, 0, {
        visible: false,
        events: [{ id: "c", trigger: "interact", order: 0 }],
      }),
      placement("a", 1, 0, {
        visible: false,
        events: [{ id: "b/event:c", trigger: "interact", order: 0 }],
      }),
    ]);
    const diagnostics = analyzeMapPlayability([map]).filter(
      (candidate) => candidate.code === "interaction-hidden",
    );

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]?.sourceKey).toBe(diagnostics[1]?.sourceKey);
    expect(mapPlayabilityDiagnosticKey(diagnostics[0]!))
      .not.toBe(mapPlayabilityDiagnosticKey(diagnostics[1]!));
    expect(diagnostics.map((diagnostic) =>
      resolveMapPlayabilityQuickFix([map], map, diagnostic)?.placementId
    )).toEqual(["a/event:b", "a"]);
  });

  test("offers block to trigger only when the full projected analysis gains no warning", () => {
    const passable = field("passable", [placement("touch", 1, 0, {
      collision: "block",
      events: [{ id: "step", trigger: "player_touch", order: 0 }],
    })]);
    const passableWarning = analyzeMapPlayability([passable]).find(
      (candidate) => candidate.code === "player-touch-no-walkable-entry",
    )!;
    const fix = resolveMapPlayabilityQuickFix([passable], passable, passableWarning)!;
    expect(fix.kind).toBe("make-touch-passable");
    expect(applyMapPlayabilityQuickFix(passable, fix).placements?.[0]?.collision)
      .toBe("trigger");

    const layerBlocked = field("layer-blocked", [placement("touch", 1, 0, {
      collision: "block",
      events: [{ id: "step", trigger: "player_touch", order: 0 }],
    })], [{
      id: "collision",
      kind: "collision",
      z: 0,
      visible: false,
      tiles: [[0, 1]],
    }]);
    const layerWarning = analyzeMapPlayability([layerBlocked]).find(
      (candidate) => candidate.code === "player-touch-no-walkable-entry",
    )!;
    expect(resolveMapPlayabilityQuickFix([layerBlocked], layerBlocked, layerWarning))
      .toBeUndefined();

    const isolated = {
      ...field("isolated", [placement("touch", 0, 0, {
        collision: "block",
        events: [{ id: "step", trigger: "player_touch", order: 0 }],
      })]),
      layout: {
        ...field("isolated", []).layout!,
        width: 1,
      },
    };
    const isolatedWarning = analyzeMapPlayability([isolated]).find(
      (candidate) => candidate.code === "player-touch-no-walkable-entry",
    )!;
    expect(resolveMapPlayabilityQuickFix([isolated], isolated, isolatedWarning))
      .toBeUndefined();
  });

  test("groups exact point markers without mixing placement diagnostics", () => {
    const target = field("target", [placement("landing", 1, 0, { collision: "block" })]);
    const sources: MapDef[] = ["west", "east"].map((id) => ({
      id,
      name: id,
      description: "",
      connections: [{ dir: id, target: target.id, arrival: { at: { x: 1, y: 0 } } }],
    }));
    const diagnostics = analyzeMapPlayability([...sources, target]);
    const groups = groupMapPlayabilityPointDiagnostics(diagnostics);

    expect(groups.find((group) => group.key === "1,0")?.diagnostics).toHaveLength(2);
  });

  test("renders advisory, focus, blocker, source, and draft-fix actions accessibly", () => {
    const hidden = field("hidden", [placement("keeper", 1, 0, {
      visible: false,
      events: [{ id: "talk", trigger: "interact", order: 0 }],
    })]);
    const source: MapDef = {
      id: "source",
      name: "Source",
      description: "",
      connections: [{ dir: "Enter", target: hidden.id, arrival: { at: { x: 0, y: 0 } } }],
    };
    hidden.placements = [
      ...hidden.placements!,
      placement("wall", 0, 0, { collision: "block" }),
    ];
    const maps = [source, hidden];
    const diagnostics = analyzeMapPlayability(maps).filter(
      (diagnostic) => diagnostic.mapId === hidden.id,
    );
    const html = renderToStaticMarkup(<MapPlayabilityPanel
      map={hidden}
      maps={maps}
      diagnostics={diagnostics}
      onLocate={() => {}}
      onInspectBlocker={() => {}}
      onOpenSource={() => {}}
      onOpenAffected={() => {}}
      onQuickFix={() => {}}
    />);

    expect(html).toContain("Headless, node-map and custom-script play remain valid");
    expect(html).toContain(">Locate<");
    expect(html).toContain(">Inspect blocker<");
    expect(html).toContain(">Open source<");
    expect(html).toContain("Draft fix · Show object");
  });

  test("renders cross-map route warnings in their authored map without target/source ambiguity", () => {
    const target = field("target", [placement("landing", 1, 0, { collision: "block" })]);
    const source: MapDef = {
      id: "source",
      name: "Source",
      description: "",
      connections: [{ dir: "Enter", target: target.id, arrival: { at: { x: 1, y: 0 } } }],
    };
    const maps = [source, target];
    const diagnostic = analyzeMapPlayability(maps).find(
      (candidate) => candidate.code === "blocked-route-arrival",
    )!;
    const html = renderToStaticMarkup(<MapPlayabilityPanel
      map={source}
      maps={maps}
      diagnostics={[]}
      authoredDiagnostics={[diagnostic]}
      onLocate={() => {}}
      onInspectBlocker={() => {}}
      onOpenSource={() => {}}
      onOpenAffected={() => {}}
      onQuickFix={() => {}}
    />);

    expect(html).toContain("AUTHORED ON THIS MAP · AFFECTS ANOTHER FIELD");
    expect(html).toContain("AFFECTS target · ARRIVAL · 1,0");
    expect(html).toContain("Review source");
    expect(html).toContain("Open affected map");
    expect(html).not.toContain(">Locate<");
  });

  test("confines canvas diagnostics below fixed modal layers", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const canvasRule = styles.match(/\.map-canvas\s*\{[^}]*\}/)?.[0] ?? "";
    const markerRule = styles.match(/\.map-playability-point\s*\{[^}]*\}/)?.[0] ?? "";

    expect(canvasRule).toContain("isolation: isolate");
    expect(markerRule).toContain("position: absolute");
  });
});

function field(
  id: string,
  placements: MapPlacementDef[],
  layers: NonNullable<MapDef["layout"]>["layers"] = [],
): MapDef {
  return {
    id,
    name: id,
    description: "",
    layout: {
      width: 2,
      height: 1,
      tileWidth: 32,
      tileHeight: 32,
      playerStart: { x: 0, y: 0 },
      layers,
      regions: [],
    },
    placements,
  };
}

function placement(
  id: string,
  x: number,
  y: number,
  overrides: Partial<Omit<MapPlacementDef, "id" | "at">> = {},
): MapPlacementDef {
  return {
    id,
    at: { x, y },
    z: 0,
    footprint: { width: 1, height: 1 },
    collision: "none",
    visible: true,
    events: [],
    ...overrides,
  };
}
