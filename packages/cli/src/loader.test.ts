import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AssetSpec, Game } from "@rpg-harness/engine";
import { collectDanglingRefs, loadGame } from "./loader";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("project code loading", () => {
  test("discovers first-class map sprites from the canonical asset directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rpgh-loader-sprite-"));
    temporaryDirectories.push(dir);
    const spriteDir = path.join(dir, "assets", "sprites", "shrine-keeper");
    await mkdir(spriteDir, { recursive: true });
    await writeFile(path.join(dir, "game.yaml"), "title: Sprite registry\n", "utf-8");
    await writeFile(path.join(spriteDir, "spec.yaml"), [
      "kind: sprite",
      "description: A map-scale shrine keeper.",
      "prompt: Paint a transparent RPG map sprite.",
      "placeholder: Shrine keeper map sprite",
      "",
    ].join("\n"), "utf-8");

    const loaded = await loadGame(dir);
    expect(loaded.assets).toEqual([expect.objectContaining({
      path: "assets/sprites/shrine-keeper",
      kind: "sprite",
    })]);
  });

  test("reloads an edited module and ejected preset in the same process", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rpgh-loader-revision-"));
    temporaryDirectories.push(dir);
    await mkdir(path.join(dir, "modules"), { recursive: true });
    await writeFile(path.join(dir, "game.yaml"), [
      "title: Loader revision",
      "preset: ./modules/run.ts",
      "modules:",
      "  - ./modules/actions.ts",
      "",
    ].join("\n"), "utf-8");
    await writeFile(path.join(dir, "modules", "run.ts"), [
      'import type { RunFunction } from "@rpg-harness/engine";',
      'const run: RunFunction = async function* () { yield { type: "gameEnd", endingId: "first" }; };',
      "export default run;",
      "",
    ].join("\n"), "utf-8");
    await writeFile(path.join(dir, "modules", "actions.ts"), [
      'import type { Module } from "@rpg-harness/engine";',
      'import { version } from "./version.ts";',
      'const module: Module = { id: "revision-module", version };',
      "export default module;",
      "",
    ].join("\n"), "utf-8");
    await writeVersion(path.join(dir, "modules", "version.ts"), "first");

    const first = await loadGame(dir);
    expect(first.runSource).toBe("modules/run.ts");
    expect(first.modules?.find(({ id }) => id === "revision-module")?.version).toBe("first");
    expect((await first.runFn!({} as never).next()).value).toMatchObject({
      type: "gameEnd",
      endingId: "first",
    });

    await writeFile(path.join(dir, "modules", "run.ts"), [
      'import type { RunFunction } from "@rpg-harness/engine";',
      'const run: RunFunction = async function* () { yield { type: "gameEnd", endingId: "second" }; };',
      "export default run;",
      "",
    ].join("\n"), "utf-8");
    await writeVersion(path.join(dir, "modules", "version.ts"), "second");

    const second = await loadGame(dir);
    expect(second.runSource).toBe("modules/run.ts");
    expect(second.modules?.find(({ id }) => id === "revision-module")?.version).toBe("second");
    expect((await second.runFn!({} as never).next()).value).toMatchObject({
      type: "gameEnd",
      endingId: "second",
    });
  });
});

async function writeVersion(file: string, version: string): Promise<void> {
  await writeFile(file, [
    `export const version = "${version}";`,
    "",
  ].join("\n"), "utf-8");
}

function makeAsset(path: string): AssetSpec {
  return {
    path,
    kind: "portrait",
    description: "d",
    prompt: "p",
    placeholder: "ph",
    renderings: {},
  };
}

// Minimal Game shape — collectDanglingRefs only reads characters and
// scripts, so the rest of the Game surface is irrelevant here.
function makeGame(partial: Pick<Game, "characters" | "scripts">): Game {
  return partial as Game;
}

describe("collectDanglingRefs", () => {
  test("resolved refs produce nothing", () => {
    const game = makeGame({
      characters: [
        {
          id: "a",
          name: "a",
          portraits: { default: "assets/portraits/a-default" },
        },
      ],
      scripts: [
        {
          id: "s1",
          title: "t",
          beats: [
            { type: "setBg", assetPath: "assets/backgrounds/inn" },
            { type: "setPortrait", slot: "center", characterId: "a", emotion: "default" },
            { type: "showCg", assetPath: "assets/cgs/x" },
          ],
        },
      ],
    });
    const assets = [
      makeAsset("assets/portraits/a-default"),
      makeAsset("assets/backgrounds/inn"),
      makeAsset("assets/cgs/x"),
    ];
    expect(collectDanglingRefs(game, assets)).toEqual({
      missingAssets: [],
      missingEmotions: [],
    });
  });

  test("missing asset paths are grouped with every referencing site", () => {
    const game = makeGame({
      characters: [
        {
          id: "a",
          name: "a",
          portraits: { smile: "assets/portraits/a-smile" },
        },
      ],
      scripts: [
        {
          id: "s1",
          title: "t",
          beats: [
            { type: "showCg", assetPath: "assets/cgs/ghost" },
            { type: "setPortrait", slot: "left", assetPath: "assets/portraits/a-smile" },
          ],
        },
        {
          id: "s2",
          title: "t",
          beats: [{ type: "showCg", assetPath: "assets/cgs/ghost" }],
        },
      ],
    });
    const { missingAssets, missingEmotions } = collectDanglingRefs(game, []);
    expect(missingEmotions).toEqual([]);
    expect(missingAssets).toHaveLength(2);
    const ghost = missingAssets.find((m) => m.assetPath === "assets/cgs/ghost");
    expect(ghost?.referencedBy).toEqual(["script s1 :cg", "script s2 :cg"]);
    const smile = missingAssets.find(
      (m) => m.assetPath === "assets/portraits/a-smile",
    );
    // Referenced from both the character map and the :portrait directive.
    expect(smile?.referencedBy).toEqual([
      "character a portraits.smile",
      "script s1 :portrait left",
    ]);
  });

  test("defaultPortraits emotion missing from the character's map is reported", () => {
    const game = makeGame({
      characters: [
        {
          id: "a",
          name: "a",
          portraits: { default: "assets/portraits/a-default" },
        },
      ],
      scripts: [
        {
          id: "s1",
          title: "t",
          beats: [
            { type: "setPortrait", slot: "center", characterId: "a", emotion: "angry" },
          ],
        },
      ],
    });
    const { missingEmotions } = collectDanglingRefs(game, [
      makeAsset("assets/portraits/a-default"),
    ]);
    expect(missingEmotions).toEqual([
      {
        characterId: "a",
        emotion: "angry",
        referencedBy: ["script s1 defaultPortraits center"],
      },
    ]);
  });
});
