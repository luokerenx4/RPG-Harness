import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MapFacing } from "@rpg-harness/engine";
import {
  MapFacingControl,
  mapFacingPresentation,
} from "./MapFacingControl";

describe("Studio map facing control", () => {
  test("provides stable presentation metadata for every direction and None", () => {
    expect((["north", "east", "south", "west"] as const).map((facing) =>
      mapFacingPresentation(facing)
    )).toEqual([
      expect.objectContaining({ value: "north", key: "north", label: "North", shortLabel: "N", glyph: "↑" }),
      expect.objectContaining({ value: "east", key: "east", label: "East", shortLabel: "E", glyph: "→" }),
      expect.objectContaining({ value: "south", key: "south", label: "South", shortLabel: "S", glyph: "↓" }),
      expect.objectContaining({ value: "west", key: "west", label: "West", shortLabel: "W", glyph: "←" }),
    ]);
    expect(mapFacingPresentation()).toEqual(expect.objectContaining({
      value: undefined,
      key: "none",
      label: "None",
      shortLabel: "—",
      title: "Clear authored facing",
    }));
  });

  test("renders an accessible five-button D-pad and current direction", () => {
    const html = renderToStaticMarkup(<MapFacingControl value="east" onChange={() => {}} />);

    expect(html).toContain("<fieldset");
    expect(html).toContain("<legend>Facing direction</legend>");
    expect(html).toContain('data-facing="east"');
    expect(html.match(/type="button"/g)).toHaveLength(5);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(4);
    expect(html).toContain('aria-label="Face north"');
    expect(html).toContain('aria-label="Face east"');
    expect(html).toContain('aria-label="Face south"');
    expect(html).toContain('aria-label="Face west"');
    expect(html).toContain('aria-label="Clear authored facing"');
    expect(html.match(/title="(?:Face (?:north|east|south|west)|Clear authored facing)"/g)).toHaveLength(5);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("CURRENT DIRECTION");
    expect(html).toContain("East");
    expect(html).toContain("Right on the map");
  });

  test("emits every authored direction and undefined for the center button", () => {
    const emitted: Array<MapFacing | undefined> = [];
    const tree = MapFacingControl({ onChange: (value) => emitted.push(value) });
    const buttons = collectElements(tree, (element) => element.type === "button");

    expect(buttons).toHaveLength(5);
    for (const button of buttons) invokeClick(button);
    expect(emitted).toEqual(["north", "west", undefined, "east", "south"]);
  });

  test("marks None as the controlled default without inventing a direction", () => {
    const html = renderToStaticMarkup(<MapFacingControl onChange={() => {}} />);

    expect(html).toContain('class="map-facing-control" data-facing="none"');
    expect(html).toContain('class="map-facing-option direction-none selected"');
    expect(html).toContain('aria-label="Clear authored facing" aria-pressed="true"');
    expect(html).toContain("Use the renderer default");
  });

  test("ships scoped dark, focus, responsive, and reduced-motion styles", async () => {
    const css = await Bun.file(new URL("./MapFacingControl.css", import.meta.url)).text();

    expect(css).toContain(".map-facing-control");
    expect(css).toContain(".map-facing-control .map-facing-option {");
    expect(css).toContain(".map-facing-option:focus-visible");
    expect(css).toContain(".map-facing-option.selected");
    expect(css).toContain("var(--studio-accent,#50c7d9)");
    expect(css).toContain("@container (max-width: 270px)");
    expect(css).toContain("@media (max-width: 520px)");
    expect(css).toContain("grid-template-columns: minmax(0,1fr)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

interface TraversedElementProps {
  children?: React.ReactNode;
  onClick?: unknown;
  type?: unknown;
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

function invokeClick(element: React.ReactElement<TraversedElementProps> | undefined): void {
  const handler = element?.props.onClick;
  expect(typeof handler).toBe("function");
  if (typeof handler === "function") handler();
}
