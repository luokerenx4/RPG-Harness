import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Game } from "@rpg-harness/engine";
import { duplicateProjectResource } from "./resource-duplicate";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function game(ids: string[]): Game {
  return {
    title: "Duplicate test",
    characters: [],
    scripts: ids.map((id) => ({
      id,
      title: id === "intro" ? "Intro" : "Intro Copy",
      requires: { selfSwitch: { scriptId: id, name: "A" } },
      beats: [],
    })),
  };
}

describe("Studio resource duplication", () => {
  test("copies a record with a new identity, label, filename, and self references", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "autogal-duplicate-"));
    created.push(directory);
    await mkdir(path.join(directory, "scripts"));
    const original = `---
id: intro
title: Intro # keep this authored note
requires: { selfSwitch: { scriptId: intro, name: A } }
---

[end]
`;
    await writeFile(path.join(directory, "scripts/intro.md"), original);
    const result = await duplicateProjectResource(
      directory,
      game(["intro"]),
      "script",
      "intro",
      "intro_copy",
      "Intro Copy",
      async () => game(["intro", "intro_copy"]),
    );

    expect(result.resource.key).toBe("script:intro_copy");
    expect(result.path).toBe("scripts/intro_copy.md");
    expect(await readFile(path.join(directory, "scripts/intro.md"), "utf-8")).toBe(original);
    const copy = await readFile(path.join(directory, "scripts/intro_copy.md"), "utf-8");
    expect(copy).toContain("id: intro_copy");
    expect(copy).toContain('title: "Intro Copy" # keep this authored note');
    expect(copy).toContain("scriptId: intro_copy");
  });

  test("removes the copied source when authoritative reload fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "autogal-duplicate-"));
    created.push(directory);
    await mkdir(path.join(directory, "characters"));
    await writeFile(path.join(directory, "characters/hero.md"), "---\nid: hero\nname: Hero\n---\n");
    const sourceGame: Game = { title: "Duplicate test", characters: [{ id: "hero", name: "Hero" }], scripts: [] };
    await expect(duplicateProjectResource(
      directory,
      sourceGame,
      "character",
      "hero",
      "hero_copy",
      "Hero Copy",
      async () => { throw new Error("validation failed"); },
    )).rejects.toThrow("validation failed");
    await expect(readFile(path.join(directory, "characters/hero_copy.md"), "utf-8")).rejects.toThrow();
  });
});
