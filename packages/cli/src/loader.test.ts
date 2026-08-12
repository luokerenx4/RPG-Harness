import { describe, expect, test } from "bun:test";
import type { AssetSpec, Game } from "@rpg-harness/engine";
import { collectDanglingRefs } from "./loader";

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
