import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AssetSpriteGridEditor,
  RPG_MAKER_3X4_SPRITE_GRID,
  assetSpriteGridDraft,
  parseAssetSpriteGridDraft,
  rpgMakerSpriteGridDraft,
} from "./AssetSpriteGridEditor";

describe("Studio directional sprite atlas authoring", () => {
  test("keeps legacy sprites in single-image mode until the contract is enabled", () => {
    const draft = assetSpriteGridDraft(undefined);
    expect(draft.enabled).toBe(false);
    expect(parseAssetSpriteGridDraft(draft)).toEqual({ value: null });

    const html = renderToStaticMarkup(
      <AssetSpriteGridEditor draft={draft} onChange={() => {}} />,
    );
    expect(html).toContain("Single-image sprite");
    expect(html).not.toContain('aria-label="North frame index"');
  });

  test("provides an explicit RPG Maker 3x4 idle-frame preset", () => {
    expect(RPG_MAKER_3X4_SPRITE_GRID).toEqual({
      columns: 3,
      rows: 4,
      defaultFacing: "south",
      frames: { north: 10, east: 7, south: 1, west: 4 },
    });
    expect(parseAssetSpriteGridDraft(rpgMakerSpriteGridDraft())).toEqual({
      value: RPG_MAKER_3X4_SPRITE_GRID,
    });
  });

  test("requires every in-range frame but permits intentional aliases", () => {
    const draft = rpgMakerSpriteGridDraft();
    draft.columns = "2";
    draft.rows = "2";
    draft.frames = { north: "0", east: "1", south: "1", west: "0" };
    expect(parseAssetSpriteGridDraft(draft)).toEqual({
      value: {
        columns: 2,
        rows: 2,
        defaultFacing: "south",
        frames: { north: 0, east: 1, south: 1, west: 0 },
      },
    });
    expect(parseAssetSpriteGridDraft({ ...draft, frames: { ...draft.frames, west: "" } })).toEqual({
      error: "West frame must be a whole number from 0 to 3.",
    });
    expect(parseAssetSpriteGridDraft({ ...draft, frames: { ...draft.frames, north: "4" } })).toEqual({
      error: "North frame must be a whole number from 0 to 3.",
    });
    expect(parseAssetSpriteGridDraft({
      ...draft,
      columns: String(Number.MAX_SAFE_INTEGER),
      rows: "2",
    })).toEqual({ error: "Directional sprite cell count is too large." });
  });

  test("renders complete accessible controls and four authored previews", () => {
    const html = renderToStaticMarkup(
      <AssetSpriteGridEditor
        draft={rpgMakerSpriteGridDraft()}
        imageUrl="/sprite.webp"
        onChange={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Directional sprite atlas"');
    expect(html).toContain('aria-label="Directional sprite default facing"');
    expect(html).toContain('aria-label="North frame index"');
    expect(html).toContain('aria-label="East frame index"');
    expect(html).toContain('aria-label="South frame index"');
    expect(html).toContain('aria-label="West frame index"');
    expect(html).toContain("12 cells · indexes 0–11");
    expect(html.match(/<canvas/g)?.length).toBe(4);
    expect(html).toContain('data-sprite-facing="north"');
    expect(html).toContain('data-sprite-frame="10"');
    expect(html).toContain('data-sprite-facing="east"');
    expect(html).not.toContain("background-size:");
    expect(html).toContain("DEFAULT");
  });
});
