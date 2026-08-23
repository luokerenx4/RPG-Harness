import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Game } from "@rpg-harness/engine";
import { readResourceSource, updateResourceSource } from "./resource-source";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function project(title = "Original"): Game {
  return {
    title,
    characters: [{ id: "hero", name: "Hero" }],
    scripts: [],
  };
}

describe("resource source round-trip", () => {
  test("reads and atomically accepts a source that reloads to the same resource", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "autogal-source-"));
    created.push(directory);
    await writeFile(path.join(directory, "game.yaml"), "title: Original\n");

    expect(await readResourceSource(directory, project(), "manifest", "game")).toEqual({
      path: "game.yaml",
      source: "title: Original\n",
    });
    const result = await updateResourceSource(
      directory,
      project(),
      "manifest",
      "game",
      "title: Updated\n",
      async () => project("Updated"),
    );
    expect(result.game.title).toBe("Updated");
    expect(await readFile(path.join(directory, "game.yaml"), "utf-8")).toBe("title: Updated\n");
  });

  test("rolls a broken source back when project validation fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "autogal-source-"));
    created.push(directory);
    await writeFile(path.join(directory, "game.yaml"), "title: Original\n");

    await expect(updateResourceSource(
      directory,
      project(),
      "manifest",
      "game",
      "not valid",
      async () => { throw new Error("game.yaml: invalid manifest"); },
    )).rejects.toThrow("invalid manifest");
    expect(await readFile(path.join(directory, "game.yaml"), "utf-8")).toBe("title: Original\n");
  });

  test("normalizes loader-provided absolute script sources to project-relative paths", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "autogal-source-"));
    created.push(directory);
    await mkdir(path.join(directory, "scripts"));
    const absolute = path.join(directory, "scripts/intro.md");
    await writeFile(absolute, "---\nid: intro\ntitle: Intro\n---\n\n[end]\n");
    const game: Game = {
      title: "Original",
      characters: [],
      scripts: [{ id: "intro", title: "Intro", source: absolute, beats: [] }],
    };

    expect((await readResourceSource(directory, game, "script", "intro")).path)
      .toBe("scripts/intro.md");
  });
});
