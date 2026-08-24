import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveAssetSpriteFrame } from "@rpg-harness/engine";
import type { ProjectAssetPreview } from "./api";
import {
  StudioSpriteFrame,
  drawStudioSpriteFrame,
  studioAssetBackgroundStyle,
  studioDirectionalSpriteAsset,
} from "./SpriteFrame";

const directional: ProjectAssetPreview = {
  path: "assets/sprites/hero-field",
  kind: "sprite",
  placeholder: "Hero field atlas",
  spriteGrid: {
    columns: 3,
    rows: 4,
    defaultFacing: "south",
    frames: { north: 10, east: 7, south: 1, west: 4 },
  },
  renderings: {
    source: true,
    sourceQuality: true,
    sourceCompressed: true,
    tuiTxt: false,
    tuiAns: false,
    web: true,
  },
};

describe("Studio directional sprite projection", () => {
  test("renders the explicit asset default and placement override as canvas metadata", () => {
    const defaultHtml = renderToStaticMarkup(React.createElement(StudioSpriteFrame, {
      asset: directional,
      className: "sprite-preview",
    }));
    expect(defaultHtml).toContain('<canvas class="sprite-preview"');
    expect(defaultHtml).toContain('data-sprite-facing="south"');
    expect(defaultHtml).toContain('data-sprite-frame="1"');

    const overrideHtml = renderToStaticMarkup(React.createElement(StudioSpriteFrame, {
      asset: directional,
      facing: "north",
    }));
    expect(overrideHtml).toContain('data-sprite-facing="north"');
    expect(overrideHtml).toContain('data-sprite-frame="10"');
  });

  test("draws at device resolution while containing the intrinsic cell", () => {
    const canvas = { width: 0, height: 0 };
    const calls: Array<{ method: string; args: number[] }> = [];
    const context = {
      setTransform: (...args: number[]) => calls.push({ method: "setTransform", args }),
      clearRect: (...args: number[]) => calls.push({ method: "clearRect", args }),
      drawImage: (_image: CanvasImageSource, ...args: number[]) => calls.push({ method: "drawImage", args }),
    };
    const frame = resolveAssetSpriteFrame(directional, "west")!;
    const plan = drawStudioSpriteFrame(
      canvas,
      context,
      {} as CanvasImageSource,
      frame,
      { width: 600, height: 1200 },
      { width: 38, height: 46 },
      2,
    );

    expect(canvas).toEqual({ width: 76, height: 92 });
    expect(plan?.source).toEqual({ x: 200, y: 300, width: 200, height: 300 });
    expect(plan?.destination.height).toBe(46);
    expect(plan?.destination.width).toBeCloseTo(30.6666666667);
    expect(plan?.destination.x).toBeCloseTo(3.6666666667);
    expect(calls[0]).toEqual({ method: "setTransform", args: [2, 0, 0, 2, 0, 0] });
    expect(calls.at(-1)?.method).toBe("drawImage");
  });

  test("preserves the legacy whole-image style for ordinary assets", () => {
    const ordinary = {
      ...directional,
      path: "assets/sprites/static",
      spriteGrid: undefined,
    };
    expect(studioAssetBackgroundStyle(ordinary.path, [ordinary])).toEqual({
      backgroundImage: 'url("/files/source/assets/sprites/static")',
    });
    expect(studioDirectionalSpriteAsset(ordinary.path, [ordinary])).toBeUndefined();
    expect(renderToStaticMarkup(React.createElement(StudioSpriteFrame, { asset: ordinary }))).toBe("");
  });

  test("leaves directional backgrounds empty for the shared canvas", () => {
    expect(studioAssetBackgroundStyle(directional.path, [directional], "east")).toBeUndefined();
    expect(studioDirectionalSpriteAsset(directional.path, [directional], "east")).toBe(directional);
  });
});
