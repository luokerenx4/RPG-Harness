import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  MapDef,
  MapPlacementDef,
  ProjectResourceNode,
} from "@rpg-harness/engine";
import {
  canActivateMapEventNavigatorResult,
  isMapEventNavigatorCommandShortcut,
  MapEventNavigator,
  mapEventNavigatorKeyIntent,
  mapEventNavigatorProblemMessage,
  mapEventNavigatorRowActivation,
} from "./MapEventNavigator";
import { buildMapEventNavigatorIndex } from "./MapEventNavigatorModel";

const resources = [{
  key: "script:opening",
  kind: "script",
  id: "opening",
  label: "Opening cutscene",
}] as ProjectResourceNode[];

describe("Studio Map Event Navigator", () => {
  test("renders a modal combobox over a bounded current-draft listbox", () => {
    const html = renderToStaticMarkup(<MapEventNavigator
      draft={map([
        { ...placement("keeper", 2, 3, [{
          id: "talk",
          trigger: "interact",
          label: "Speak with the keeper",
          run: { kind: "script", id: "opening" },
          order: 0,
        }]), facing: "south" },
      ])}
      resources={resources}
      diagnosticCounts={new Map([["keeper", 2]])}
      onActivate={() => ({ ok: true })}
      onClose={() => {}}
    />);

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-activedescendant="map-event-navigator-');
    expect(html).toContain('role="listbox"');
    expect(html.match(/role="option"/g)).toHaveLength(2);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("Search the current map draft");
    expect(html).toContain("Speak with the keeper");
    expect(html).toContain("Opening cutscene");
    expect(html).toContain("script:opening");
    expect(html).toContain("⌖ 2,3");
    expect(html).toContain("FACING · ↓ South");
    expect(html).toContain("! 2");
    expect(html).toContain("READ-ONLY INDEX · CURRENT UNSAVED DRAFT");
  });

  test("caps rendered rows at one hundred and reports truncation", () => {
    const draft = map(Array.from({ length: 101 }, (_, index) =>
      placement(`event_${index}`, index % 12, Math.floor(index / 12), [])));
    const html = renderToStaticMarkup(<MapEventNavigator
      draft={draft}
      resources={[]}
      onActivate={() => ({ ok: true })}
      onClose={() => {}}
    />);

    expect(html.match(/role="option"/g)).toHaveLength(100);
    expect(html).toContain("101 MATCHES");
    expect(html).toContain("Showing the first 100 of 101");
    expect(html).toContain("event_99");
    expect(html).not.toContain("event_100");
  });

  test("keeps invalid rows visible while failing closed or opening only their placement", () => {
    const draft = map([
      placement("keeper", 1, 1, [{
        id: "",
        trigger: "interact",
        label: "Broken page",
        order: 0,
      }]),
      placement("", 3, 2, []),
    ]);
    const index = buildMapEventNavigatorIndex(draft, []);
    const page = index.rows.find((row) => row.kind === "event")!;
    const missingPlacement = index.rows.find((row) => row.kind === "placement" && row.placementId === "")!;

    expect(mapEventNavigatorRowActivation(page)).toEqual({
      ok: true,
      locator: { kind: "placement", placementId: "keeper" },
      precision: "placement-only",
    });
    expect(mapEventNavigatorRowActivation(missingPlacement)).toEqual({
      ok: false,
      message: mapEventNavigatorProblemMessage("placement-id-empty"),
    });

    const html = renderToStaticMarkup(<MapEventNavigator
      draft={draft}
      resources={[]}
      onActivate={() => ({ ok: false, message: "stale" })}
      onClose={() => {}}
    />);
    expect(html).toContain("Broken page");
    expect(html).toContain("OPEN OBJECT");
    expect(html).toContain("Enter · repair page ID");
    expect(html).toContain("REPAIR ID");
    expect(html).toContain('aria-disabled="true"');
  });

  test("owns list navigation, close, activation, and IME composition semantics", () => {
    expect(mapEventNavigatorKeyIntent("ArrowDown", 2, 3)).toEqual({ kind: "move", index: 0 });
    expect(mapEventNavigatorKeyIntent("ArrowUp", 0, 3)).toEqual({ kind: "move", index: 2 });
    expect(mapEventNavigatorKeyIntent("Home", 2, 3)).toEqual({ kind: "move", index: 0 });
    expect(mapEventNavigatorKeyIntent("End", 0, 3)).toEqual({ kind: "move", index: 2 });
    expect(mapEventNavigatorKeyIntent("Enter", 0, 3)).toEqual({ kind: "activate" });
    expect(mapEventNavigatorKeyIntent("Escape", 0, 3)).toEqual({ kind: "close" });
    expect(mapEventNavigatorKeyIntent("Enter", 0, 3, true)).toEqual({ kind: "none" });
    expect(mapEventNavigatorKeyIntent("Escape", 0, 3, true)).toEqual({ kind: "none" });
    expect(mapEventNavigatorKeyIntent("Enter", -1, 0)).toEqual({ kind: "none" });
  });

  test("captures browser and parent map-editor command shortcuts", () => {
    for (const key of ["s", "S", "z", "y", "f"]) {
      expect(isMapEventNavigatorCommandShortcut({ key, metaKey: true, ctrlKey: false })).toBe(true);
      expect(isMapEventNavigatorCommandShortcut({ key, metaKey: false, ctrlKey: true })).toBe(true);
    }
    expect(isMapEventNavigatorCommandShortcut({ key: "a", metaKey: true, ctrlKey: false })).toBe(false);
    expect(isMapEventNavigatorCommandShortcut({ key: "f", metaKey: false, ctrlKey: false })).toBe(false);
    expect(canActivateMapEventNavigatorResult(false, false)).toBe(true);
    expect(canActivateMapEventNavigatorResult(false, true)).toBe(false);
    expect(canActivateMapEventNavigatorResult(true, false)).toBe(false);
  });

  test("keeps the modal above map authoring surfaces without exposing its backdrop to focus", async () => {
    const css = await Bun.file(new URL("./MapEventNavigator.css", import.meta.url)).text();
    expect(css).toContain(".map-event-navigator-layer {");
    expect(css).toContain("z-index: 7350;");
    expect(css).toContain(".map-event-navigator-results {");
    expect(css).toContain("overflow: auto;");

    const html = renderToStaticMarkup(<MapEventNavigator
      draft={map([])}
      resources={[]}
      onActivate={() => ({ ok: true })}
      onClose={() => {}}
    />);
    expect(html).toContain('class="map-event-navigator-backdrop" aria-hidden="true" tabindex="-1"');
  });

  test("marks every control busy while an activation is being saved", () => {
    const html = renderToStaticMarkup(<MapEventNavigator
      draft={map([placement("gate", 0, 0, [])])}
      resources={[]}
      saving
      onActivate={() => ({ ok: true })}
      onClose={() => {}}
    />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('disabled=""');
    expect(html).toContain("SAVING MAP DRAFT…");
  });
});

function map(placements: MapPlacementDef[]): MapDef {
  return {
    id: "field",
    name: "Field",
    description: "",
    layout: {
      width: 12,
      height: 10,
      tileWidth: 32,
      tileHeight: 32,
      layers: [{ id: "events", kind: "object", z: 10, visible: true }],
      regions: [],
    },
    placements,
  };
}

function placement(
  id: string,
  x: number,
  y: number,
  events: MapPlacementDef["events"],
): MapPlacementDef {
  return {
    id,
    at: { x, y },
    layer: "events",
    z: 0,
    footprint: { width: 1, height: 1 },
    collision: "trigger",
    visible: true,
    events,
  };
}
