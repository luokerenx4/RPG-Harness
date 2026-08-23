import { describe, expect, test } from "bun:test";
import type { Game } from "./types";
import {
  buildProjectResourceRegistry,
  buildProjectResourceGraph,
  mapPlacementEventKey,
  mapPlacementKey,
  projectResourceKey,
  resolveProjectResource,
} from "./resources";

function game(overrides: Partial<Game> = {}): Game {
  return {
    title: "registry",
    characters: [{ id: "hero", name: "Hero" }],
    scripts: [{ id: "intro", title: "Intro", beats: [] }],
    maps: [{ id: "town", name: "Town", description: "" }],
    actions: [{ id: "rest", title: "Rest", cost: 0 }],
    ...overrides,
  };
}

describe("project resource registry", () => {
  test("indexes standard resources under stable namespaced keys", () => {
    const registry = buildProjectResourceRegistry(game());
    expect(registry.get("manifest:game")?.label).toBe("registry");
    expect(registry.get("character:hero")?.label).toBe("Hero");
    expect(registry.get("map:town")?.label).toBe("Town");
    expect(registry.get("script:intro")?.label).toBe("Intro");
    expect(registry.get("action:rest")?.label).toBe("Rest");
    expect(resolveProjectResource(registry, { kind: "map", id: "town" })?.id)
      .toBe("town");
  });

  test("provides canonical placement and event coordinates", () => {
    expect(projectResourceKey({ kind: "enemy", id: "oni" })).toBe("enemy:oni");
    expect(mapPlacementKey("shrine", "kagari")).toBe(
      "map:shrine/placement:kagari",
    );
    expect(mapPlacementEventKey("shrine", "kagari", "talk")).toBe(
      "map:shrine/placement:kagari/event:talk",
    );
  });

  test("rejects duplicate identities inside a resource kind", () => {
    expect(() => buildProjectResourceRegistry(game({
      maps: [
        { id: "town", name: "Town", description: "" },
        { id: "town", name: "Other", description: "" },
      ],
    }))).toThrow(/duplicate project resource "map:town"/);
  });

  test("builds forward refs, backlinks, missing refs, and source coordinates", () => {
    const graph = buildProjectResourceGraph(game({
      characters: [{
        id: "hero",
        name: "Hero",
        portraits: { default: "assets/portraits/hero" },
      }],
      maps: [{
        id: "town",
        name: "Town",
        description: "",
        placements: [{
          id: "intro",
          at: { x: 0, y: 0 },
          z: 0,
          footprint: { width: 1, height: 1 },
          collision: "none",
          visible: false,
          events: [{
            id: "run",
            trigger: "autorun",
            order: 0,
            run: { kind: "script", id: "intro" },
          }],
        }],
      }],
    }));
    expect(graph.resources.find((node) => node.key === "map:town")).toMatchObject({
      source: "maps/town.yaml",
      refs: ["script:intro"],
    });
    expect(graph.resources.find((node) => node.key === "manifest:game")).toMatchObject({
      source: "game.yaml",
    });
    expect(graph.backlinks["script:intro"]).toContain("map:town");
    expect(graph.missing).toEqual([{
      key: "asset:assets/portraits/hero",
      referencedBy: ["character:hero"],
    }]);
    expect(graph.unreferenced).toContain("character:hero");
  });
});
