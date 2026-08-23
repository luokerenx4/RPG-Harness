import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Game } from "@rpg-harness/engine";
import {
  readStudioTrash,
  ResourceDeleteError,
  restoreStudioTrashEntry,
  trashProjectResource,
} from "./resource-delete";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function project(characters: Game["characters"]): Game {
  return { title: "Test", characters, scripts: [] };
}

describe("Studio resource trash", () => {
  test("moves an unreferenced resource into a timestamped recoverable trash", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "autogal-trash-"));
    created.push(directory);
    await mkdir(path.join(directory, "characters"));
    await writeFile(path.join(directory, "characters/guide.md"), "---\nid: guide\nname: Guide\n---\n");

    const result = await trashProjectResource(
      directory,
      project([{ id: "guide", name: "Guide" }]),
      "character",
      "guide",
      async () => project([]),
      () => new Date("2026-08-23T01:02:03.456Z"),
    );

    expect(result.trashPath).toBe(".studio-trash/2026-08-23T01-02-03-456Z/characters/guide.md");
    expect(await readFile(path.join(directory, result.trashPath), "utf-8")).toContain("name: Guide");
    await expect(readFile(path.join(directory, "characters/guide.md"), "utf-8")).rejects.toThrow();
  });

  test("rejects deleting a referenced resource without moving its file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "autogal-trash-"));
    created.push(directory);
    await mkdir(path.join(directory, "characters"));
    const source = "---\nid: guide\nname: Guide\n---\n";
    await writeFile(path.join(directory, "characters/guide.md"), source);
    const game: Game = {
      ...project([{ id: "guide", name: "Guide" }]),
      maps: [{
        id: "town",
        name: "Town",
        description: "",
        placements: [{
          id: "guide",
          at: { x: 0, y: 0 },
          z: 0,
          footprint: { width: 1, height: 1 },
          collision: "none",
          visible: true,
          resource: { kind: "character", id: "guide" },
          events: [],
        }],
      }],
    };

    const rejection = trashProjectResource(
      directory,
      game,
      "character",
      "guide",
      async () => project([]),
    );
    await expect(rejection).rejects.toBeInstanceOf(ResourceDeleteError);
    await expect(rejection).rejects.toMatchObject({ status: 409, blockers: ["map:town"] });
    expect(await readFile(path.join(directory, "characters/guide.md"), "utf-8")).toBe(source);
  });

  test("restores the authoritative file when project reload fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "autogal-trash-"));
    created.push(directory);
    await mkdir(path.join(directory, "characters"));
    const source = "---\nid: guide\nname: Guide\n---\n";
    await writeFile(path.join(directory, "characters/guide.md"), source);

    await expect(trashProjectResource(
      directory,
      project([{ id: "guide", name: "Guide" }]),
      "character",
      "guide",
      async () => { throw new Error("project validation failed"); },
    )).rejects.toThrow("project validation failed");
    expect(await readFile(path.join(directory, "characters/guide.md"), "utf-8")).toBe(source);
  });

  test("lists metadata and restores a trashed resource through a validated reload", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "autogal-trash-"));
    created.push(directory);
    await mkdir(path.join(directory, "characters"));
    const source = "---\nid: guide\nname: Guide\n---\n";
    await writeFile(path.join(directory, "characters/guide.md"), source);
    const trashed = await trashProjectResource(
      directory,
      project([{ id: "guide", name: "Guide" }]),
      "character",
      "guide",
      async () => project([]),
      () => new Date("2026-08-23T01:02:03.456Z"),
    );

    expect(await readStudioTrash(directory)).toEqual([{
      trashPath: trashed.trashPath,
      sourcePath: "characters/guide.md",
      deletedAt: "2026-08-23T01:02:03.456Z",
      kind: "character",
      id: "guide",
      key: "character:guide",
      label: "Guide",
    }]);
    const restored = await restoreStudioTrashEntry(directory, trashed.trashPath, async () =>
      project([{ id: "guide", name: "Guide" }])
    );
    expect(restored.resource.key).toBe("character:guide");
    expect(await readFile(path.join(directory, "characters/guide.md"), "utf-8")).toBe(source);
    expect(await readStudioTrash(directory)).toEqual([]);
  });

  test("keeps the trash entry when its authoritative source path has been reused", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "autogal-trash-"));
    created.push(directory);
    await mkdir(path.join(directory, "characters"));
    await writeFile(path.join(directory, "characters/guide.md"), "old");
    const trashed = await trashProjectResource(
      directory,
      project([{ id: "guide", name: "Guide" }]),
      "character",
      "guide",
      async () => project([]),
    );
    await writeFile(path.join(directory, "characters/guide.md"), "new");

    await expect(restoreStudioTrashEntry(directory, trashed.trashPath, async () =>
      project([{ id: "guide", name: "Guide" }])
    )).rejects.toMatchObject({ status: 409 });
    expect(await readFile(path.join(directory, "characters/guide.md"), "utf-8")).toBe("new");
    expect(await readStudioTrash(directory)).toHaveLength(1);
  });
});
