import { describe, expect, test } from "bun:test";
import { parseMap } from "./map";
import { migrateMapToPlacements } from "./map-migration";

describe("migrateMapToPlacements", () => {
  test("moves legacy connections into stable zero-coordinate placements", () => {
    const source = [
      "# Keep this authored comment.",
      "id: town",
      "name: Town",
      "connections:",
      "  - dir: Lab",
      "    target: lab",
      "    requires: { switch: { name: unlocked, eq: true } }",
      "    locked_hint: Find the key",
    ].join("\n") + "\n";

    const result = migrateMapToPlacements(source, "maps/town.yaml");
    expect(result.changed).toBe(true);
    expect(result.migratedConnections).toBe(1);
    expect(result.migratedOnEnter).toBe(false);
    expect(result.content).toContain("# Keep this authored comment.");
    expect(result.content).not.toContain("connections:");

    expect(parseMap(result.content)).toMatchObject({
      id: "town",
      placements: [{
        id: "exit_lab",
        at: { x: 0, y: 0 },
        resource: { kind: "map", id: "lab" },
        events: [{
          id: "move",
          trigger: "manual",
          label: "Lab",
          requires: { switch: { name: "unlocked", eq: true } },
          lockedHint: "Find the key",
        }],
      }],
    });
  });

  test("is idempotent and does not invent a layout", () => {
    const source = "id: town\nname: Town\nplacements:\n  - { id: npc, at: [0, 0], resource: { kind: character, id: guide } }\n";
    expect(migrateMapToPlacements(source)).toEqual({
      content: source,
      changed: false,
      migratedConnections: 0,
      migratedOnEnter: false,
    });
  });

  test("moves on_enter into an invisible map-enter script placement", () => {
    const result = migrateMapToPlacements(
      "id: town\nname: Town\non_enter: arrive\n",
      "maps/town.yaml",
    );
    expect(result.migratedOnEnter).toBe(true);
    expect(result.content).not.toContain("on_enter:");
    expect(parseMap(result.content).placements).toEqual([{
      id: "on_enter",
      at: { x: 0, y: 0 },
      resource: { kind: "script", id: "arrive" },
      z: 0,
      footprint: { width: 1, height: 1 },
      collision: "none",
      visible: false,
      events: [{ id: "run", trigger: "map_enter", order: -100 }],
    }]);
  });
});
