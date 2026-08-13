import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectAiPersonaSummaries } from "./personas";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true })
  ));
});

describe("AI persona discovery", () => {
  test("lists module-owned policies before generic built-ins", async () => {
    const gameDir = await mkdtemp(path.join(tmpdir(), "rpgh-personas-"));
    temporaryDirectories.push(gameDir);
    await mkdir(path.join(gameDir, "modules"));
    await writeFile(path.join(gameDir, "game.yaml"), [
      "title: Persona fixture",
      "modules:",
      "  - ./modules/custom.ts",
      "",
    ].join("\n"), "utf-8");
    await writeFile(path.join(gameDir, "modules", "custom.ts"), [
      'export default { id: "custom", aiPersonas: {',
      '  planner: { description: "Project planner", deterministic: true,',
      '    decide: async () => ({ type: "quit" }) },',
      '} };',
      "",
    ].join("\n"), "utf-8");

    const personas = await collectAiPersonaSummaries(gameDir);
    expect(personas[0]).toEqual({
      name: "planner",
      description: "Project planner",
      deterministic: true,
      source: "module:custom",
    });
    expect(personas).toContainEqual(expect.objectContaining({
      name: "random",
      deterministic: false,
      source: "builtin",
    }));
    expect(personas.every((persona) => !("decide" in persona))).toBe(true);
  });
});
