import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MapDef, MapPlacementDef } from "@rpg-harness/engine";
import {
  RouteArrivalEditor,
  clampRouteArrivalPoint,
  routeArrivalMode,
  routeArrivalValueForCoordinate,
  routeArrivalValueForMode,
} from "./RouteArrivalEditor";

function placement(
  id: string,
  x: number,
  y: number,
  collision: MapPlacementDef["collision"],
  resource?: MapPlacementDef["resource"],
): MapPlacementDef {
  return {
    id,
    at: { x, y },
    ...(resource ? { resource } : {}),
    z: 0,
    footprint: { width: 1, height: 1 },
    collision,
    visible: true,
    events: [],
  };
}

const spatialMap: MapDef = {
  id: "snow-field",
  name: "Snow Field",
  description: "A spatial destination.",
  layout: {
    width: 8,
    height: 6,
    tileWidth: 32,
    tileHeight: 32,
    playerStart: { x: 2, y: 3 },
    layers: [],
    regions: [],
  },
  placements: [
    placement("south-gate", 4, 5, "trigger", { kind: "map", id: "crossroads" }),
    placement("stone-idol", 1, 1, "block", { kind: "custom", id: "idol" }),
  ],
};

const nodeMap: MapDef = {
  id: "dream-node",
  name: "Dream Node",
  description: "A folded destination.",
  placements: [placement("memory-door", 0, 0, "trigger")],
};

describe("Studio route arrival editor", () => {
  test("derives modes and clamps coordinates to integer target-map cells", () => {
    expect(routeArrivalMode(spatialMap, undefined)).toBe("map-start");
    expect(routeArrivalMode(spatialMap, { placementId: "south-gate" })).toBe("placement");
    expect(routeArrivalMode(spatialMap, { at: { x: 4, y: 3 } })).toBe("coordinate");
    expect(routeArrivalMode(nodeMap, { at: { x: 4, y: 3 } })).toBe("map-start");

    expect(clampRouteArrivalPoint(spatialMap, { x: -3, y: 99 })).toEqual({ x: 0, y: 5 });
    expect(clampRouteArrivalPoint(spatialMap, { x: 6.9, y: 2.2 })).toEqual({ x: 6, y: 2 });
    expect(clampRouteArrivalPoint(nodeMap, { x: 0, y: 0 })).toBeUndefined();
  });

  test("builds canonical values for map start, placement, and coordinate modes", () => {
    expect(routeArrivalValueForMode(spatialMap, "map-start", { at: { x: 1, y: 1 } })).toBeUndefined();
    expect(routeArrivalValueForMode(spatialMap, "placement", undefined)).toEqual({
      placementId: "south-gate",
    });
    expect(routeArrivalValueForMode(spatialMap, "coordinate", undefined)).toEqual({
      at: { x: 2, y: 3 },
    });
    expect(routeArrivalValueForMode(nodeMap, "coordinate", undefined)).toBeUndefined();
    expect(routeArrivalValueForCoordinate(
      spatialMap,
      { at: { x: 1, y: 4 } },
      "x",
      99,
    )).toEqual({ at: { x: 7, y: 4 } });
    expect(routeArrivalValueForCoordinate(
      spatialMap,
      { at: { x: 1, y: 4 } },
      "y",
      Number.NaN,
    )).toEqual({ at: { x: 1, y: 4 } });
  });

  test("renders stable placement identity, coordinates, collision, and resource", () => {
    const html = renderToStaticMarkup(<RouteArrivalEditor
      targetMap={spatialMap}
      value={{ placementId: "south-gate" }}
      onChange={() => {}}
    />);

    expect(html).toContain('aria-label="Arrival point in Snow Field"');
    expect(html).toContain("map:snow-field");
    expect(html).toContain("Map start");
    expect(html).toContain("Destination placement");
    expect(html).toContain("Coordinate");
    expect(html).toContain("south-gate · 4,5 · trigger · map:crossroads");
    expect(html).toContain("stone-idol · 1,1 · block · custom:idol");
    expect(html).toContain("STABLE PLACEMENT ID");
    expect(html).toContain("map:crossroads");
    expect(html).toContain("Collision</dt><dd>trigger");
  });

  test("emits controlled mode, placement, and clamped coordinate changes", () => {
    const emitted: unknown[] = [];
    const startTree = RouteArrivalEditor({
      targetMap: spatialMap,
      onChange: (value) => emitted.push(value),
    });
    const coordinateRadio = collectElements(startTree, (element) =>
      element.type === "input" && element.props.value === "coordinate"
    )[0];
    invokeChange(coordinateRadio);
    expect(emitted.pop()).toEqual({ at: { x: 2, y: 3 } });

    const placementTree = RouteArrivalEditor({
      targetMap: spatialMap,
      value: { placementId: "south-gate" },
      onChange: (value) => emitted.push(value),
    });
    const select = collectElements(placementTree, (element) => element.type === "select")[0];
    invokeChange(select, { currentTarget: { value: "stone-idol" } });
    expect(emitted.pop()).toEqual({ placementId: "stone-idol" });

    const coordinateTree = RouteArrivalEditor({
      targetMap: spatialMap,
      value: { at: { x: 1, y: 4 } },
      onChange: (value) => emitted.push(value),
    });
    const coordinateInputs = collectElements(coordinateTree, (element) =>
      element.type === "input" && element.props.type === "number"
    );
    invokeChange(coordinateInputs[0], { currentTarget: { valueAsNumber: 42 } });
    expect(emitted.pop()).toEqual({ at: { x: 7, y: 4 } });

    const mapStartRadio = collectElements(coordinateTree, (element) =>
      element.type === "input" && element.props.value === "map-start"
    )[0];
    invokeChange(mapStartRadio);
    expect(emitted.pop()).toBeUndefined();
  });

  test("disables coordinate authoring on node maps and exposes a safe fallback", () => {
    const html = renderToStaticMarkup(<RouteArrivalEditor
      targetMap={nodeMap}
      value={{ at: { x: 9, y: 9 } }}
      onChange={() => {}}
    />);

    expect(html).toContain("NODE");
    expect(html).toContain("FOLDED NODE ORIGIN");
    expect(html).toContain("Requires a 2D layout");
    expect(html).toContain("Coordinate unavailable on a node map");
    expect(html).toContain("1 stable object");
    expect(html).not.toContain("X coordinate");

    const placementHtml = renderToStaticMarkup(<RouteArrivalEditor
      targetMap={nodeMap}
      value={{ placementId: "memory-door" }}
      onChange={() => {}}
    />);
    expect(placementHtml).toContain("memory-door · 0,0 · trigger · event-only");
  });

  test("keeps a missing stable placement visible until the author replaces it", () => {
    const html = renderToStaticMarkup(<RouteArrivalEditor
      targetMap={spatialMap}
      value={{ placementId: "removed-door" }}
      onChange={() => {}}
    />);

    expect(html).toContain("removed-door · missing from target map");
    expect(html).toContain("Placement is missing");
    expect(html).toContain("Choose an object that still belongs to map:snow-field");
  });

  test("does not present an invalid stored coordinate as silently valid", () => {
    const html = renderToStaticMarkup(<RouteArrivalEditor
      targetMap={spatialMap}
      value={{ at: { x: 99, y: -2 } }}
      onChange={() => {}}
    />);

    expect(html).toContain("Stored coordinate needs repair");
    expect(html).toContain("Authored 99,-2 is outside this layout");
    expect(html).toContain("nearest cell 7,0");
    expect(html).toContain("Selected arrival cell 7, 0");
  });

  test("ships scoped focus, narrow-screen, and reduced-motion styles", async () => {
    const css = await Bun.file(new URL("./RouteArrivalEditor.css", import.meta.url)).text();

    expect(css).toContain(".route-arrival-editor");
    expect(css).toContain(".route-arrival-modes > label:has(input:focus-visible)");
    expect(css).toContain(".route-arrival-coordinate input:focus-visible");
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toContain("grid-template-columns: minmax(0,1fr)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

interface TraversedElementProps {
  children?: React.ReactNode;
  onChange?: unknown;
  type?: unknown;
  value?: unknown;
  [key: string]: unknown;
}

function collectElements(
  node: React.ReactNode,
  predicate: (element: React.ReactElement<TraversedElementProps>) => boolean,
): Array<React.ReactElement<TraversedElementProps>> {
  const matches: Array<React.ReactElement<TraversedElementProps>> = [];
  React.Children.forEach(node, (child) => {
    if (!React.isValidElement(child)) return;
    const element = child as React.ReactElement<TraversedElementProps>;
    if (predicate(element)) matches.push(element);
    matches.push(...collectElements(element.props.children, predicate));
  });
  return matches;
}

function invokeChange(
  element: React.ReactElement<TraversedElementProps> | undefined,
  event: unknown = {},
): void {
  const handler = element?.props.onChange;
  expect(typeof handler).toBe("function");
  if (typeof handler === "function") handler(event);
}
