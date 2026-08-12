import { describe, expect, test } from "bun:test";
import { MapParseError, parseMap } from "./map";

const minimalMap = `id: forest
name: 森
description: a small map
connections:
  - { dir: 奥, target: deep }
`;

describe("parseMap — minimal", () => {
  test("happy path", () => {
    const m = parseMap(minimalMap);
    expect(m.id).toBe("forest");
    expect(m.name).toBe("森");
    expect(m.description).toBe("a small map");
    expect(m.difficulty).toBe(1);
    expect(m.connections).toEqual([{ dir: "奥", target: "deep" }]);
    expect(m.characterSpawns).toBeUndefined();
  });

  test("description defaults to empty", () => {
    const m = parseMap("id: m\nname: M");
    expect(m.description).toBe("");
  });

  test("difficulty defaults to 1", () => {
    const m = parseMap("id: m\nname: M");
    expect(m.difficulty).toBe(1);
  });
});

describe("parseMap — encounter / loot tables", () => {
  test("encounter_table normalizes enemy → enemyId", () => {
    const m = parseMap(`id: m
name: M
encounter_table:
  - { enemy: ogre, weight: 70 }
  - { enemy: null, weight: 30 }
`);
    expect(m.encounterTable).toEqual([
      { enemyId: "ogre", weight: 70 },
      { enemyId: null, weight: 30 },
    ]);
  });

  test("loot_table normalizes item → itemId + carries min/max", () => {
    const m = parseMap(`id: m
name: M
loot_table:
  - { item: gold, min: 5, max: 12, weight: 60 }
  - { item: null, min: 0, max: 0, weight: 40 }
`);
    expect(m.lootTable).toEqual([
      { itemId: "gold", min: 5, max: 12, weight: 60 },
      { itemId: null, min: 0, max: 0, weight: 40 },
    ]);
  });

  test("encounter_table not an array throws", () => {
    expect(() =>
      parseMap(`id: m
name: M
encounter_table: bogus
`),
    ).toThrow(/encounter_table must be an array/);
  });
});

describe("parseMap — character_spawns", () => {
  test("happy path normalizes character/encounter_script", () => {
    const m = parseMap(`id: m
name: M
character_spawns:
  - { character: alice, chance: 0.5, encounter_script: meet_alice }
`);
    expect(m.characterSpawns).toEqual([
      {
        characterId: "alice",
        chance: 0.5,
        encounterScriptId: "meet_alice",
      },
    ]);
  });

  test("chance outside [0,1] throws", () => {
    expect(() =>
      parseMap(`id: m
name: M
character_spawns:
  - { character: alice, chance: 5, encounter_script: meet_alice }
`),
    ).toThrow(/chance must be a number in \[0,1\]/);
  });
});

describe("parseMap — errors", () => {
  test("missing id throws", () => {
    expect(() => parseMap("name: M")).toThrow(MapParseError);
  });

  test("missing name throws", () => {
    expect(() => parseMap("id: m")).toThrow(/`name`/);
  });

  test("invalid YAML throws", () => {
    expect(() => parseMap(":::not yaml::")).toThrow(MapParseError);
  });

  test("preserves unknown frontmatter into custom", () => {
    const m = parseMap(`id: m
name: M
music: theme_a
biome: forest
`);
    expect(m.custom).toEqual({ music: "theme_a", biome: "forest" });
  });
});

describe("parseMap — flat shape", () => {
  test("parses a map with connections + actions + onEnter", () => {
    const m = parseMap(`id: cafe
name: ネカフェ
description: 24時間営業の地下フロア
bg: assets/backgrounds/cafe
on_enter: arrive_cafe
chain: shibuya
connections:
  - { dir: 出口, target: street }
  - { dir: 奥, target: backroom, locked_hint: "店員に見られる" }
actions:
  - id: work_cafe
    title: バイトする
    cost: 1
  - id: infiltrate_cafe
    title: 潜入する
    cost: 1
    whenIn: [cafe]
`);
    expect(m.bg).toBe("assets/backgrounds/cafe");
    expect(m.onEnter).toBe("arrive_cafe");
    expect(m.chain).toBe("shibuya");
    expect(m.connections).toEqual([
      { dir: "出口", target: "street" },
      { dir: "奥", target: "backroom", lockedHint: "店員に見られる" },
    ]);
    expect(m.actions).toHaveLength(2);
    expect(m.actions?.[0]?.id).toBe("work_cafe");
  });

  test("is_extract flag", () => {
    const m = parseMap(`id: shrine
name: 社
is_extract: true
`);
    expect(m.isExtract).toBe(true);
  });

  test("is_entry flag", () => {
    const m = parseMap(`id: gate
name: 門口
chain: hell_gate
is_entry: true
`);
    expect(m.isEntry).toBe(true);
  });
});
