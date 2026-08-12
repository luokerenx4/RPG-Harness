import { describe, expect, test } from "bun:test";
import type { Game } from "@rpg-harness/engine";
import { GameValidationError, validateGame } from "./validate";

// Minimal valid Game scaffold for validator tests. Each test layers on
// the specific shape it wants to validate.
function baseGame(overrides: Partial<Game> = {}): Game {
  return {
    title: "t",
    characters: [{ id: "alice", name: "Alice" }],
    scripts: [{ id: "001", title: "1", beats: [] }],
    ...overrides,
  };
}

describe("validateGame — clean games pass", () => {
  test("minimal game with declared character and one script", () => {
    expect(() => validateGame(baseGame())).not.toThrow();
  });

  test("requires referencing declared script + character", () => {
    expect(() =>
      validateGame(
        baseGame({
          scripts: [
            { id: "001", title: "1", beats: [] },
            {
              id: "002",
              title: "2",
              beats: [],
              requires: {
                all: [
                  { scriptCompleted: "001" },
                  { affection: { character: "alice", min: 2 } },
                ],
              },
            },
          ],
        }),
      ),
    ).not.toThrow();
  });
});

describe("validateGame — choice coverage ids", () => {
  test("rejects missing labels for choice and silent goto branches", () => {
    expect(() => validateGame(baseGame({
      scripts: [{
        id: "story",
        title: "Story",
        beats: [
          { type: "choice", options: [{ text: "go", goto: "missing-choice" }] },
          { type: "goto", target: "missing-silent" },
        ],
      }],
    }))).toThrow(/unknown label `missing-choice`[\s\S]*unknown label `missing-silent`/);
  });

  test("rejects duplicate choice ids within one script", () => {
    const game = baseGame({
      scripts: [{
        id: "branching",
        title: "Branching",
        beats: [
          { type: "choice", id: "route", options: [{ text: "a" }] },
          { type: "choice", id: "route", options: [{ text: "b" }] },
        ],
      }],
    });
    expect(() => validateGame(game)).toThrow(/duplicate choice id `route`/);
  });

  test("rejects duplicate option ids within one choice", () => {
    const game = baseGame({
      scripts: [{
        id: "branching",
        title: "Branching",
        beats: [{
          type: "choice",
          id: "route",
          options: [
            { id: "same", text: "a" },
            { id: "same", text: "b" },
          ],
        }],
      }],
    });
    expect(() => validateGame(game)).toThrow(/duplicate option id `same`/);
  });

  test("requires stable option ids when a choice opts into coverage", () => {
    const game = baseGame({
      scripts: [{
        id: "branching",
        title: "Branching",
        beats: [{
          type: "choice",
          id: "route",
          options: [{ text: "missing id" }],
        }],
      }],
    });
    expect(() => validateGame(game)).toThrow(/requires every option.*stable id/);
  });
});

describe("validateGame — undeclared references throw", () => {
  test("undeclared switch in script requires", () => {
    const game = baseGame({
      switches: [{ id: "real_switch", initial: false }],
      scripts: [
        {
          id: "001",
          title: "1",
          beats: [],
          requires: { switch: { name: "typo_swotch" } },
        },
      ],
    });
    expect(() => validateGame(game)).toThrow(GameValidationError);
    expect(() => validateGame(game)).toThrow(/typo_swotch/);
    expect(() => validateGame(game)).toThrow(/real_switch/);
  });

  test("undeclared variable in choice effects", () => {
    const game = baseGame({
      variables: [{ id: "route", type: "string", initial: "" }],
      scripts: [
        {
          id: "001",
          title: "1",
          beats: [
            {
              type: "choice",
              options: [
                {
                  text: "pick alice",
                  effects: { variables: { rute: "alice" } },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(() => validateGame(game)).toThrow(/rute/);
  });

  test("undeclared character in inline effect's characterStats", () => {
    const game = baseGame({
      scripts: [
        {
          id: "001",
          title: "1",
          beats: [
            {
              type: "effects",
              effects: { characterStats: { ghost: { affection: 1 } } },
            },
          ],
        },
      ],
    });
    expect(() => validateGame(game)).toThrow(/ghost/);
  });

  test("undeclared dialogue speaker is rejected", () => {
    const game = baseGame({
      scripts: [
        {
          id: "001",
          title: "1",
          beats: [{ type: "dialogue", speaker: "alcie", text: "hello" }],
        },
      ],
    });
    expect(() => validateGame(game)).toThrow(/alcie/);
    expect(() => validateGame(game)).toThrow(/alice/);
  });

  test("@narrator misuse gets an actionable plain-text hint", () => {
    const game = baseGame({
      scripts: [
        {
          id: "001",
          title: "1",
          beats: [{ type: "dialogue", speaker: "narrator", text: "scene" }],
        },
      ],
    });
    expect(() => validateGame(game)).toThrow(/remove the @narrator prefix/);
  });

  test("undeclared script in scriptCompleted", () => {
    const game = baseGame({
      scripts: [
        {
          id: "001",
          title: "1",
          beats: [],
          requires: { scriptCompleted: "999_missing" },
        },
      ],
    });
    expect(() => validateGame(game)).toThrow(/999_missing/);
  });

  test("undeclared training stat in end condition", () => {
    const game = baseGame({
      training: {
        slotsPerDay: 1,
        slotNames: ["only"],
        startDay: 1,
        maxDay: 5,
        decayPerDay: 0,
        decayStatId: "",
        sleepActionId: "sleep",
        huntActionId: "",
        stats: [{ id: "trust", name: "trust", min: 0, max: 100, start: 0 }],
        endConditions: [
          {
            reason: "trust hit",
            when: { stat: { name: "trsut", min: 50 } },
            goto: "001",
          },
        ],
      },
    });
    expect(() => validateGame(game)).toThrow(/trsut/);
  });

  test("undeclared script in end condition goto", () => {
    const game = baseGame({
      training: {
        slotsPerDay: 1,
        slotNames: ["only"],
        startDay: 1,
        maxDay: 5,
        decayPerDay: 0,
        decayStatId: "",
        sleepActionId: "sleep",
        huntActionId: "",
        stats: [{ id: "trust", name: "trust", min: 0, max: 100, start: 0 }],
        endConditions: [
          {
            reason: "trust hit",
            when: { stat: { name: "trust", min: 50 } },
            goto: "phantom_end",
          },
        ],
      },
    });
    expect(() => validateGame(game)).toThrow(/phantom_end/);
  });

  test("undeclared item in inventory condition", () => {
    const game = baseGame({
      items: [
        { id: "potion", name: "potion", description: "", kind: "consumable" },
      ],
      scripts: [
        {
          id: "001",
          title: "1",
          beats: [],
          requires: { inventory: { itemId: "elixir", min: 1 } },
        },
      ],
    });
    expect(() => validateGame(game)).toThrow(/elixir/);
  });

  test("aggregates multiple issues in one error", () => {
    const game = baseGame({
      switches: [{ id: "x", initial: false }],
      scripts: [
        {
          id: "001",
          title: "1",
          beats: [
            {
              type: "effects",
              effects: {
                switches: { typo1: true, typo2: false },
                characterStats: { ghost: { affection: 1 } },
              },
            },
          ],
        },
      ],
    });
    try {
      validateGame(game);
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/typo1/);
      expect(msg).toMatch(/typo2/);
      expect(msg).toMatch(/ghost/);
      expect(msg).toMatch(/3 issues/);
    }
  });
});

describe("validateGame — module triggers", () => {
  test("trigger condition validated", () => {
    const game = baseGame({
      switches: [{ id: "real", initial: false }],
      modules: [
        {
          id: "mod",
          triggers: [
            {
              id: "t1",
              when: { switch: { name: "typo_real" } },
              do: () => ({}),
            },
          ],
        },
      ],
    });
    expect(() => validateGame(game)).toThrow(/typo_real/);
  });
});

describe("validateGame — maps", () => {
  test("connection target must reference a declared map", () => {
    const game = baseGame({
      maps: [
        {
          id: "m",
          name: "M",
          description: "",
          difficulty: 1,
          connections: [{ dir: "東", target: "ghost_map" }],
        },
      ],
    });
    expect(() => validateGame(game)).toThrow(/ghost_map/);
  });

  test("encounter_table enemy ids validated", () => {
    const game = baseGame({
      enemies: [
        { id: "ogre", name: "O", description: "", hp: 5 },
      ],
      maps: [
        {
          id: "m",
          name: "M",
          description: "",
          difficulty: 1,
          encounterTable: [{ enemyId: "wraith", weight: 1 }],
        },
      ],
    });
    expect(() => validateGame(game)).toThrow(/wraith/);
  });

  test("loot_table item ids validated", () => {
    const game = baseGame({
      items: [
        { id: "gold", name: "gold", description: "", kind: "consumable" },
      ],
      maps: [
        {
          id: "m",
          name: "M",
          description: "",
          difficulty: 1,
          lootTable: [{ itemId: "phantom_drop", min: 1, max: 1, weight: 1 }],
        },
      ],
    });
    expect(() => validateGame(game)).toThrow(/phantom_drop/);
  });

  test("character_spawns validate character + encounter_script", () => {
    const game = baseGame({
      maps: [
        {
          id: "m",
          name: "M",
          description: "",
          difficulty: 1,
          characterSpawns: [
            {
              characterId: "ghost_char",
              chance: 0.5,
              encounterScriptId: "missing_script",
            },
          ],
        },
      ],
    });
    expect(() => validateGame(game)).toThrow(/ghost_char/);
    expect(() => validateGame(game)).toThrow(/missing_script/);
  });

  test("action.mapId validated against game.maps", () => {
    const game = baseGame({
      maps: [
        {
          id: "real_map",
          name: "R",
          description: "",
          difficulty: 1,
        },
      ],
      actions: [
        {
          id: "depart_typo",
          title: "go",
          cost: 0,
          mapId: "phantom_map",
        },
      ],
    });
    expect(() => validateGame(game)).toThrow(/phantom_map/);
  });

  test("map chains require exactly one explicit entry", () => {
    const game = baseGame({
      maps: [
        {
          id: "road",
          name: "Road",
          description: "",
          difficulty: 1,
          chain: "route",
        },
      ],
    });
    expect(() => validateGame(game)).toThrow(/exactly one is_entry/);
  });

  test("map chains reject content unreachable from their entry", () => {
    const game = baseGame({
      maps: [
        {
          id: "gate",
          name: "Gate",
          description: "",
          difficulty: 1,
          chain: "route",
          isEntry: true,
        },
        {
          id: "orphan",
          name: "Orphan",
          description: "",
          difficulty: 1,
          chain: "route",
        },
      ],
    });
    expect(() => validateGame(game)).toThrow(/orphan.*unreachable|unreachable.*orphan/);
  });

  test("map chains pass when every map is reachable from one entry", () => {
    const game = baseGame({
      maps: [
        {
          id: "gate",
          name: "Gate",
          description: "",
          difficulty: 1,
          chain: "route",
          isEntry: true,
          connections: [{ dir: "奥", target: "depths" }],
        },
        {
          id: "depths",
          name: "Depths",
          description: "",
          difficulty: 1,
          chain: "route",
        },
      ],
    });
    expect(() => validateGame(game)).not.toThrow();
  });
});
