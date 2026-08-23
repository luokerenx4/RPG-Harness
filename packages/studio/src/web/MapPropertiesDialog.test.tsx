import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MapDef } from "@rpg-harness/engine";
import { MapPropertiesDialog } from "./pages/Project";

const map = {
  id: "crossroads",
  name: "Crossroads",
  description: "A map used to verify the authoring dialog.",
  difficulty: 1,
  layout: {
    width: 12,
    height: 10,
    tileWidth: 32,
    tileHeight: 32,
    playerStart: { x: 5, y: 8 },
    layers: [{ id: "objects", kind: "object", z: 0, visible: true }],
    regions: [{ id: "north", x: 4, y: 0, width: 4, height: 4 }],
  },
  placements: [],
} satisfies MapDef;

function renderProperties({
  error = null,
  initialSection = "general",
}: {
  error?: string | null;
  initialSection?: "general" | "layout";
} = {}): string {
  return renderToStaticMarkup(<MapPropertiesDialog
    saved={map}
    draft={map}
    maps={[map]}
    assets={[]}
    onChange={() => {}}
    onClose={() => {}}
    onSave={async () => false}
    onChangeTopology={() => {}}
    topologyButtonRef={React.createRef<HTMLButtonElement>()}
    dirty={Boolean(error)}
    saving={false}
    error={error}
    initialSection={initialSection}
  />);
}

describe("Studio Map Properties dialog shell", () => {
  test("keeps validation feedback outside the scrolling tab body", () => {
    const html = renderProperties({ error: "map name must not be blank" });
    const tabs = html.indexOf('class="map-properties-tabs"');
    const errorSlot = html.indexOf('class="map-properties-error-slot"');
    const body = html.indexOf('class="map-properties-dialog-body"');

    expect(tabs).toBeGreaterThan(-1);
    expect(errorSlot).toBeGreaterThan(tabs);
    expect(body).toBeGreaterThan(errorSlot);
    expect(html).toContain('role="alert"');
    expect(html).toContain("map name must not be blank");
    expect(html).toContain("Change topology…");
  });

  test("renders a keyboard-reachable horizontal scrollport for dense layout fields", async () => {
    const html = renderProperties({ initialSection: "layout" });
    expect(html).toContain('class="map-layout-advanced-scroll"');
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Layers and regions editor; scroll horizontally for all fields"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('class="map-layout-advanced-inner"');

    const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
    expect(css).toContain("grid-template-rows: auto auto auto minmax(0,1fr) auto");
    expect(css).toContain(".map-layout-advanced-scroll { width: 100%; max-width: 100%; overflow-x: auto;");
    expect(css).toContain(".map-layout-advanced-inner { min-width: 620px;");
  });

  test("hands dirty topology navigation to the modal guard before editor shortcuts", async () => {
    const source = await Bun.file(new URL("./pages/Project.tsx", import.meta.url)).text();
    const overview = source.slice(
      source.indexOf("function MapOverview("),
      source.indexOf("export function MapPropertiesDialog("),
    );
    const keyboard = overview.slice(
      overview.indexOf("const onKeyDown = (event: KeyboardEvent)"),
      overview.indexOf('window.addEventListener("keydown", onKeyDown)'),
    );

    expect(overview).toContain("setPropertiesOpen(false);\n      setTopologyGuardOpen(true);");
    expect(overview).toContain("setPropertiesOpen(true);\n          requestAnimationFrame(() => requestAnimationFrame(() => topologyButtonRef.current?.focus()));");
    expect(keyboard.indexOf("if (propertiesOpen || topologyOpen || topologyGuardOpen) return;")).toBeLessThan(
      keyboard.indexOf('event.key.toLowerCase() === "s"'),
    );
    expect(overview.indexOf("topologyAfterSaveRef.current = true;")).toBeLessThan(
      overview.indexOf("const saved = await save();"),
    );
  });
});
