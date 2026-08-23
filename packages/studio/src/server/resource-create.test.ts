import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Game } from "@rpg-harness/engine";
import {
  parseAction,
  parseCharacter,
  parseEnemy,
  parseItem,
  parseMap,
  parseScript,
  parseSkill,
  parseWeapon,
} from "@rpg-harness/parser";
import {
  createProjectResource,
  projectResourceTemplate,
  type CreatableResourceKind,
} from "./resource-create";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Studio resource creation", () => {
  test("emits minimal parser-valid files for every first-class authoring kind", () => {
    const parsers: Record<CreatableResourceKind, (source: string) => { id: string }> = {
      map: parseMap,
      character: parseCharacter,
      item: parseItem,
      weapon: parseWeapon,
      skill: parseSkill,
      enemy: parseEnemy,
      action: parseAction,
      script: parseScript,
    };
    for (const [kind, parse] of Object.entries(parsers) as Array<[CreatableResourceKind, (source: string) => { id: string }]>) {
      expect(parse(projectResourceTemplate(kind, "new_record", "New Record")).id).toBe("new_record");
    }
    expect(parseScript(projectResourceTemplate("script", "draft_scene", "Draft Scene"))).toMatchObject({
      requires: { switch: { name: "__studio_draft__", eq: true } },
      coverage: { ignore: true },
    });
    expect(parseAction(projectResourceTemplate("action", "draft_action", "Draft Action"))).toMatchObject({
      requires: { switch: { name: "__studio_draft__", eq: true } },
    });
  });

  test("creates a standalone resource and rejects overwriting the same stable id", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "autogal-create-"));
    created.push(directory);
    const game = (characters: Game["characters"]): Game => ({ title: "Test", characters, scripts: [] });
    const result = await createProjectResource(directory, "character", "guide", "Guide", async () =>
      game([{ id: "guide", name: "Guide" }])
    );
    expect(result.resource.key).toBe("character:guide");
    expect(await readFile(path.join(directory, "characters/guide.md"), "utf-8")).toContain("name: Guide");
    await expect(createProjectResource(directory, "character", "guide", "Other", async () => game([])))
      .rejects.toThrow("already exists");
  });

  test("creates a parser-valid RPG map preset with canonical authoring layers", () => {
    expect(parseMap(projectResourceTemplate("map", "river_gate", "River Gate", {
      mapLayout: { width: 14, height: 10, tileset: "assets/tilesets/river" },
    }))).toMatchObject({
      id: "river_gate",
      layout: {
        width: 14,
        height: 10,
        playerStart: { x: 7, y: 5 },
        tileset: "assets/tilesets/river",
        layers: [
          { id: "ground", kind: "tile", z: 0 },
          { id: "collision", kind: "collision", z: 5 },
          { id: "objects", kind: "object", z: 10 },
        ],
      },
    });
  });

  test("removes the new file when authoritative project reload fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "autogal-create-"));
    created.push(directory);
    await expect(createProjectResource(directory, "enemy", "broken", "Broken", async () => {
      throw new Error("project validation failed");
    })).rejects.toThrow("project validation failed");
    await expect(readFile(path.join(directory, "enemies/broken.md"), "utf-8")).rejects.toThrow();
  });
});
