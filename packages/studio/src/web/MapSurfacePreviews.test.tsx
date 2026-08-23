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
    const html = renderToStaticMarkup(<MapSurfacePreviews map={map} draftActive />);
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
    const html = renderToStaticMarkup(<MapSurfacePreviews map={map} draftActive={false} />);
    expect(html).toContain("BUILDING SAVED PREVIEW");
    expect(html).not.toContain("DRAFT PREVIEW");
  });
});
