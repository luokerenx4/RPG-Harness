import { describe, expect, test } from "bun:test";
import { assetSpriteFrameDrawPlan, resolveAssetSpriteFrame } from "./assets";
import type { AssetSpriteGrid } from "./types";

const spriteGrid: AssetSpriteGrid = {
  columns: 3,
  rows: 4,
  defaultFacing: "south",
  frames: {
    north: 10,
    east: 7,
    south: 1,
    west: 4,
  },
};

describe("resolveAssetSpriteFrame", () => {
  test("uses the explicit asset fallback without inventing runtime facing", () => {
    expect(resolveAssetSpriteFrame({ kind: "sprite", spriteGrid })).toEqual({
      facing: "south",
      index: 1,
      column: 1,
      row: 0,
      columns: 3,
      rows: 4,
    });
  });

  test("lets authored placement facing select the mapped row-major cell", () => {
    expect(resolveAssetSpriteFrame({ kind: "sprite", spriteGrid }, "north")).toEqual({
      facing: "north",
      index: 10,
      column: 1,
      row: 3,
      columns: 3,
      rows: 4,
    });
  });

  test("keeps generic and non-sprite images on the full-image fallback", () => {
    expect(resolveAssetSpriteFrame({ kind: "sprite" }, "west")).toBeUndefined();
    expect(resolveAssetSpriteFrame({ kind: "portrait", spriteGrid }, "west")).toBeUndefined();
  });

  test("fails closed for malformed runtime atlas data", () => {
    expect(resolveAssetSpriteFrame({
      kind: "sprite",
      spriteGrid: { ...spriteGrid, frames: { ...spriteGrid.frames, east: 99 } },
    }, "east")).toBeUndefined();
  });

  test("contains a non-square source cell without stretching it", () => {
    const frame = resolveAssetSpriteFrame({ kind: "sprite", spriteGrid }, "east")!;
    const plan = assetSpriteFrameDrawPlan(
      frame,
      { width: 600, height: 1200 },
      { width: 100, height: 100 },
    )!;
    expect(plan.source).toEqual({ x: 200, y: 600, width: 200, height: 300 });
    expect(plan.destination.x).toBeCloseTo(100 / 6);
    expect(plan.destination.y).toBe(0);
    expect(plan.destination.width).toBeCloseTo(200 / 3);
    expect(plan.destination.height).toBe(100);
  });

  test("rejects unusable bitmap and viewport dimensions", () => {
    const frame = resolveAssetSpriteFrame({ kind: "sprite", spriteGrid })!;
    expect(assetSpriteFrameDrawPlan(frame, { width: 0, height: 1200 }, { width: 100, height: 100 }))
      .toBeUndefined();
    expect(assetSpriteFrameDrawPlan(frame, { width: 600, height: 1200 }, { width: 100, height: 0 }))
      .toBeUndefined();
  });
});
