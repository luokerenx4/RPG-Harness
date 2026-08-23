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
    const registry = buildProjectResourceRegistry(game({
      assets: [{
        path: "assets/portraits/hero",
        kind: "portrait",
        description: "A deliberately long author-facing visual description.",
        prompt: "Hero portrait",
        placeholder: "[Hero] Ready stance",
        renderings: {},
      }],
    }));
    expect(registry.get("manifest:game")?.label).toBe("registry");
    expect(registry.get("character:hero")?.label).toBe("Hero");
    expect(registry.get("map:town")?.label).toBe("Town");
    expect(registry.get("script:intro")?.label).toBe("Intro");
    expect(registry.get("action:rest")?.label).toBe("Rest");
    expect(registry.get("asset:assets/portraits/hero")?.label).toBe("[Hero] Ready stance");
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
        portraits: { default: "assets/portraits/missing" },
      }],
      assets: [{
        path: "assets/sheets/hero-map",
        kind: "sheet",
        description: "Hero map graphic",
        prompt: "Hero on the field",
        placeholder: "Hero map graphic",
        renderings: {},
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
          asset: "assets/sheets/hero-map",
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
      refs: ["asset:assets/sheets/hero-map", "script:intro"],
    });
    expect(graph.resources.find((node) => node.key === "manifest:game")).toMatchObject({
      source: "game.yaml",
    });
    expect(graph.backlinks["script:intro"]).toContain("map:town");
    expect(graph.missing).toEqual([{
      key: "asset:assets/portraits/missing",
      referencedBy: ["character:hero"],
    }]);
    expect(graph.backlinks["asset:assets/sheets/hero-map"]).toContain("map:town");
    expect(graph.unreferenced).toContain("character:hero");
  });

  test("tracks engine-standard condition and state-delta references", () => {
    const graph = buildProjectResourceGraph(game({
      characters: [{ id: "hero", name: "Hero" }],
      items: [{
        id: "tonic",
        name: "Tonic",
        description: "",
        kind: "consumable",
        effects: { characterStats: { hero: { affection: 1 } } },
      }],
      weapons: [{ id: "blade", name: "Blade", description: "", basePower: 1 }],
      skills: [{
        id: "spark",
        name: "Spark",
        description: "",
        requires: { inventory: { itemId: "tonic", min: 1 } },
        effects: { weapons: { blade: { power: 1 } } },
      }],
      scripts: [{
        id: "intro",
        title: "Intro",
        requires: { all: [
          { affection: { character: "hero", min: 1 } },
          { knowsSkill: "spark" },
          { weaponPower: { weaponId: "blade", min: 1 } },
        ] },
        beats: [{
          type: "choice",
          options: [{
            text: "Use tonic",
            requires: { selfSwitch: { scriptId: "intro", name: "A" } },
            effects: {
              inventory: { tonic: -1 },
              skills: { learn: ["spark"] },
              selfSwitches: { intro: { A: true } },
            },
          }],
        }],
      }],
      actions: [{
        id: "practice",
        title: "Practice",
        cost: 0,
        requires: { characterStat: { character: "hero", name: "affection", min: 1 } },
        effects: { inventory: { tonic: 1 } },
      }],
    }));

    expect(graph.resources.find((node) => node.key === "script:intro")?.refs).toEqual([
      "character:hero",
      "item:tonic",
      "script:intro",
      "skill:spark",
      "weapon:blade",
    ]);
    expect(graph.resources.find((node) => node.key === "item:tonic")?.refs)
      .toContain("character:hero");
    expect(graph.resources.find((node) => node.key === "skill:spark")?.refs)
      .toEqual(["item:tonic", "weapon:blade"]);
    expect(graph.resources.find((node) => node.key === "action:practice")?.refs)
      .toEqual(["character:hero", "item:tonic"]);
  });
});
