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

  test("parses legacy connection gates through the canonical condition DSL", () => {
    const map = parseMap(`id: gate
name: Gate
connections:
  - dir: Inner
    target: inner
    requires: { switch: { name: gate_open, eq: true } }
    locked_hint: The gate is sealed.
`);
    expect(map.connections?.[0]).toEqual({
      dir: "Inner",
      target: "inner",
      requires: { switch: { name: "gate_open", eq: true } },
      lockedHint: "The gate is sealed.",
    });
  });

  test("rejects malformed legacy connection conditions while parsing", () => {
    for (const requires of ["true", "[]", "{ bogus: 1 }"]) {
      expect(() => parseMap(`id: gate
name: Gate
connections:
  - dir: Inner
    target: inner
    requires: ${requires}
`)).toThrow();
    }
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

describe("parseMap — spatial layout and placements", () => {
  test("parses canonical 2D structure and stacked resource events", () => {
    const m = parseMap(`id: shrine
name: 夜之社
layout:
  width: 3
  height: 2
  tile_width: 16
  tile_height: 24
  player_start: [0, 1]
  tileset: assets/tilesets/shrine
  layers:
    - id: ground
      kind: tile
      tiles:
        - [1, 1, 2]
        - [3, 4, 5]
    - { id: actors, kind: object, z: 10 }
  regions:
    - { id: altar, name: 祭坛, x: 1, y: 0, width: 2, height: 1 }
placements:
  - id: kagari
    at: [1, 0]
    asset: assets/sheets/kagari-map
    layer: actors
    z: 2
    facing: south
    footprint: [1, 2]
    collision: block
    resource: { kind: character, id: kagari }
    events:
      - id: talk
        trigger: interact
        label: 与篝交谈
        run: { kind: script, id: shrine_kagari }
        requires: { switch: { name: met_kagari, eq: true } }
      - id: inspect
        trigger: raid:inspect
        chance: 0.25
        order: 20
        run: { kind: action, id: inspect_kagari }
  - id: hidden_cg
    at: [1, 0]
    visible: false
    resource: { kind: script, id: memory_cg }
    events:
      - { id: play, trigger: autorun }
`);

    expect(m.layout).toMatchObject({
      width: 3,
      height: 2,
      tileWidth: 16,
      tileHeight: 24,
      playerStart: { x: 0, y: 1 },
      tileset: "assets/tilesets/shrine",
    });
    expect(m.layout?.layers[0]).toMatchObject({
      id: "ground",
      kind: "tile",
      z: 0,
      visible: true,
      tiles: [[1, 1, 2], [3, 4, 5]],
    });
    expect(m.layout?.regions[0]).toMatchObject({
      id: "altar",
      x: 1,
      y: 0,
      width: 2,
      height: 1,
    });
    expect(m.placements).toHaveLength(2);
    expect(m.placements?.[0]).toMatchObject({
      id: "kagari",
      at: { x: 1, y: 0 },
      asset: "assets/sheets/kagari-map",
      layer: "actors",
      z: 2,
      facing: "south",
      footprint: { width: 1, height: 2 },
      collision: "block",
      visible: true,
      resource: { kind: "character", id: "kagari" },
    });
    expect(m.placements?.[0]?.events[0]).toMatchObject({
      id: "talk",
      trigger: "interact",
      label: "与篝交谈",
      run: { kind: "script", id: "shrine_kagari" },
      order: 0,
    });
    expect(m.placements?.[0]?.events[1]).toMatchObject({
      id: "inspect",
      trigger: "raid:inspect",
      chance: 0.25,
      order: 20,
    });
    expect(m.placements?.[1]).toMatchObject({
      at: { x: 1, y: 0 },
      visible: false,
      footprint: { width: 1, height: 1 },
      collision: "none",
    });
  });

  test("rejects malformed layout and unstable placement identities", () => {
    expect(() => parseMap(`id: m
name: M
layout: { width: 0, height: 2 }
`)).toThrow(/layout.width must be a positive integer/);

    expect(() => parseMap(`id: m
name: M
placements:
  - { id: same, at: [0, 0], resource: { kind: item, id: a } }
  - { id: same, at: [0, 0], resource: { kind: item, id: b } }
`)).toThrow(/duplicate id "same"/);

    expect(() => parseMap(`id: m
name: M
placements:
  - { id: event, at: [0, 0], asset: "", events: [{ id: run, trigger: manual }] }
`)).toThrow(/asset must be a non-empty asset path string/);
  });

  test("rejects wrong tile matrix dimensions and unnamespaced custom triggers", () => {
    expect(() => parseMap(`id: m
name: M
layout:
  width: 2
  height: 1
  layers:
    - { id: ground, kind: tile, tiles: [[1]] }
`)).toThrow(/exactly 2 tiles/);

    expect(() => parseMap(`id: m
name: M
placements:
  - id: e
    at: [0, 0]
    events: [{ id: run, trigger: custom }]
`)).toThrow(/built-in trigger or namespaced module trigger/);

    expect(() => parseMap(`id: m
name: M
placements:
  - id: e
    at: [0, 0]
    events: [{ id: run, trigger: autorun, chance: 2 }]
`)).toThrow(/chance must be a number in \[0,1\]/);
  });
});
