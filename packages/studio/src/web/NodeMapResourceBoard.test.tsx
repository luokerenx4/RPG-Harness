import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MapDef, MapPlacementDef } from "@rpg-harness/engine";
import {
  NodeMapResourceBoard,
  buildNodeMapResourceBoardModel,
} from "./NodeMapResourceBoard";

function placement(
  id: string,
  extra: Partial<MapPlacementDef> = {},
): MapPlacementDef {
  return {
    id,
    at: { x: 0, y: 0 },
    z: 0,
    footprint: { width: 1, height: 1 },
    collision: "trigger",
    visible: true,
    events: [],
    ...extra,
  };
}

function map(extra: Partial<MapDef> = {}): MapDef {
  return {
    id: "crossroads",
    name: "Crossroads",
    description: "A compact node map.",
    ...extra,
  };
}

const populatedMap = map({
  connections: [{ dir: "Legacy only", target: "must-not-appear" }],
  placements: [
    placement("north-gate", {
      at: { x: 7, y: 2 },
      resource: { kind: "map", id: "snow-field" },
      requires: { switch: { name: "gate-open" } },
      events: [
        {
          id: "touch-route",
          trigger: "player_touch",
          label: "North passage",
          chance: 0.5,
          lockedHint: "The gate is shut.",
          arrival: { placementId: "south-gate" },
          order: 20,
        },
        {
          id: "inspect",
          trigger: "interact",
          run: { kind: "script", id: "inspect-gate" },
          order: 5,
        },
      ],
    }),
    placement("travel-ledger", {
      at: { x: -3, y: 11 },
      resource: { kind: "item", id: "ledger" },
      visible: false,
      events: [
        {
          id: "ledger-route",
          trigger: "custom:depart",
          label: "Leave <unsafe>",
          run: { kind: "map", id: "harbour" },
          arrival: { at: { x: 3, y: 4 } },
          requires: { switch: { name: "fare-paid" } },
          order: 0,
        },
      ],
    }),
    placement("silent-marker", {
      at: { x: 99, y: 99 },
      resource: { kind: "custom", id: "marker" },
    }),
  ],
});

describe("Studio folded node-map resource board", () => {
  test("projects placements and ordered event pages without importing legacy connections", () => {
    const before = structuredClone(populatedMap);
    const model = buildNodeMapResourceBoardModel(populatedMap);

    expect(model.placementCount).toBe(3);
    expect(model.eventPageCount).toBe(3);
    expect(model.routeCount).toBe(2);
    expect(model.placements.map((row) => row.id)).toEqual([
      "north-gate",
      "travel-ledger",
      "silent-marker",
    ]);
    expect(model.placements[0]?.pages.map((page) => page.id)).toEqual([
      "inspect",
      "touch-route",
    ]);
    expect(model.placements[0]?.pages[1]).toMatchObject({
      key: "placement:north-gate:event:touch-route",
      command: "Transfer → map:snow-field",
      arrivalLabel: "ARRIVE · placement:south-gate",
      route: true,
      targetInherited: true,
      probabilistic: true,
      lockedHint: true,
    });
    expect(model.placements[1]?.pages[0]).toMatchObject({
      command: "Transfer → map:harbour",
      arrivalLabel: "ARRIVE · 3,4",
      route: true,
      targetInherited: false,
      conditional: true,
    });
    expect(model.placements.flatMap((row) => row.pages).some((page) => page.command.includes("must-not-appear"))).toBe(false);
    expect(populatedMap).toEqual(before);
  });

  test("renders route pages prominently while preserving stable placement and event identities", () => {
    const html = renderToStaticMarkup(<NodeMapResourceBoard
      map={populatedMap}
      selectedPlacementId="north-gate"
      onSelectPlacement={() => {}}
    />);

    expect(html).toContain("Resources &amp; Event Pages");
    expect(html).toContain("Objects</dt><dd>3");
    expect(html).toContain("Routes</dt><dd>2");
    expect(html).toContain('data-placement-id="north-gate"');
    expect(html).toContain('data-event-id="touch-route"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Transfer → map:snow-field");
    expect(html).toContain("Transfer → map:harbour");
    expect(html).toContain("ARRIVE · placement:south-gate");
    expect(html).toContain("ARRIVE · 3,4");
    expect(html).toContain("MAP ROUTE");
    expect(html).toContain("PLACEMENT TARGET");
    expect(html).toContain("No event pages on this placement.");
    expect(html).toContain("Leave &lt;unsafe&gt;");
    expect(html).not.toContain("must-not-appear");
  });

  test("invokes placement selection from the corresponding authoring row", () => {
    const selected: string[] = [];
    const tree = NodeMapResourceBoard({
      map: populatedMap,
      selectedPlacementId: null,
      onSelectPlacement: (placementId) => selected.push(placementId),
    });
    const buttons = collectElements(tree, (element) => element.props.className === "node-map-resource-select");

    expect(buttons).toHaveLength(3);
    expect(buttons[1]?.props["aria-label"]).toContain("travel-ledger");
    const click = buttons[1]?.props.onClick;
    expect(typeof click).toBe("function");
    if (typeof click === "function") click();
    expect(selected).toEqual(["travel-ledger"]);
  });

  test("renders preview boards as read-only controls", () => {
    const html = renderToStaticMarkup(<NodeMapResourceBoard
      map={populatedMap}
      interactive={false}
      onSelectPlacement={() => {}}
    />);

    expect(html).toContain('class="node-map-resource-select" disabled=""');
    expect(html).toContain('aria-label="Placement north-gate');
  });

  test("has an explicit empty state when the map owns no placements", () => {
    const html = renderToStaticMarkup(<NodeMapResourceBoard
      map={map({ placements: [], connections: [{ dir: "Old", target: "elsewhere" }] })}
      onSelectPlacement={() => {}}
    />);

    expect(html).toContain("No placed resources");
    expect(html).toContain("no placements or event pages");
    expect(html).toContain("Objects</dt><dd>0");
    expect(html).not.toContain('class="node-map-resource-card');
    expect(html).not.toContain("elsewhere");
  });

  test("ships scoped route, focus, narrow-screen, and reduced-motion styles", async () => {
    const css = await Bun.file(new URL("./NodeMapResourceBoard.css", import.meta.url)).text();

    expect(css).toContain(".node-map-resource-card.selected");
    expect(css).toContain(".node-map-resource-select:focus-visible");
    expect(css).toContain(".node-map-event-pages > li.route");
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toContain("grid-template-columns: minmax(0,1fr)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

interface TraversedElementProps {
  children?: React.ReactNode;
  className?: string;
  onClick?: unknown;
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
