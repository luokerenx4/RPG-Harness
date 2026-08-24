import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MapDef } from "@rpg-harness/engine";
import { MapSurfacePreviews } from "./pages/Project";

const map = {
  id: "town",
  name: "Town",
  description: "",
  layout: {
    width: 4,
    height: 3,
    tileWidth: 32,
    tileHeight: 32,
    layers: [],
    regions: [],
  },
  placements: [],
} satisfies MapDef;

describe("Studio map surface preview status", () => {
  test("labels every surface as a projection of the active draft", () => {
    const html = renderToStaticMarkup(<MapSurfacePreviews savedMap={map} map={map} draftActive />);
    expect(html).toContain("BUILDING DRAFT PREVIEW");
    expect(html).toContain("same in-memory Map v2 resource");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("2D");
    expect(html).toContain("Hub");
    expect(html).toContain("TUI");
    expect(html).toContain("Headless");
  });

  test("distinguishes an unchanged authoritative map", () => {
    const html = renderToStaticMarkup(<MapSurfacePreviews savedMap={map} map={map} draftActive={false} />);
    expect(html).toContain("BUILDING SAVED PREVIEW");
    expect(html).not.toContain("DRAFT PREVIEW");
  });

  test("projects authored facing into the visual 2D row", () => {
    const facedMap: MapDef = {
      ...map,
      placements: [{
        id: "keeper",
        at: { x: 2, y: 1 },
        z: 0,
        footprint: { width: 1, height: 1 },
        collision: "none",
        facing: "west",
        visible: true,
        events: [],
      }],
    };
    const html = renderToStaticMarkup(<MapSurfacePreviews savedMap={facedMap} map={facedMap} draftActive />);

    expect(html).toContain('class="projection-placement-position"');
    expect(html).toContain('class="projection-placement-facing" title="Face west"');
    expect(html).toContain("← W");
  });
});
