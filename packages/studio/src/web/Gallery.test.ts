import { describe, expect, test } from "bun:test";
import type { AssetRow } from "./api";
import { matchesAssetQuery, nextAssetCardIndex } from "./pages/Gallery";

const asset = {
  path: "assets/portraits/kagari/calm",
  kind: "portrait",
  description: "篝の通常立ち絵",
  prompt: "Sengoku spear wielder",
  placeholder: "篝・平静",
  tags: ["master", "night"],
  refs: { characters: ["kagari"], emotion: "calm" },
  renderings: {},
} as AssetRow;

describe("Studio asset library navigation", () => {
  test("searches authored asset metadata and references", () => {
    expect(matchesAssetQuery(asset, "kagari")).toBe(true);
    expect(matchesAssetQuery(asset, "平静")).toBe(true);
    expect(matchesAssetQuery(asset, "night")).toBe(true);
    expect(matchesAssetQuery(asset, "missing")).toBe(false);
  });

  test("moves through a responsive card grid without leaving its bounds", () => {
    expect(nextAssetCardIndex(1, 8, 3, "ArrowDown")).toBe(4);
    expect(nextAssetCardIndex(7, 8, 3, "ArrowDown")).toBe(7);
    expect(nextAssetCardIndex(4, 8, 3, "ArrowUp")).toBe(1);
    expect(nextAssetCardIndex(2, 8, 3, "Home")).toBe(0);
    expect(nextAssetCardIndex(2, 8, 3, "End")).toBe(7);
  });
});
