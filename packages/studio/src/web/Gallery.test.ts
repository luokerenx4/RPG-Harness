import { describe, expect, test } from "bun:test";
import type { AssetRow } from "./api";
import { assetAtlasSummary, matchesAssetQuery, nextAssetCardIndex } from "./pages/Gallery";

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

  test("summarizes tileset capacity and id range", () => {
    expect(assetAtlasSummary({ kind: "tileset", tileGrid: { columns: 4, rows: 4, firstId: 1 } }))
      .toBe("4×4 atlas · 16 tiles · IDs 1–16");
    expect(assetAtlasSummary({ kind: "tileset" })).toBe("atlas metadata missing");
    expect(assetAtlasSummary({ kind: "portrait" })).toBeUndefined();
  });
});
