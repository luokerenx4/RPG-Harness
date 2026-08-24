import type { AssetSpec, MapFacing } from "./types";

export interface AssetSpriteFrame {
  facing: MapFacing;
  /** Zero-based row-major cell index. */
  index: number;
  column: number;
  row: number;
  columns: number;
  rows: number;
}

export interface AssetSpriteFrameDrawPlan {
  source: { x: number; y: number; width: number; height: number };
  destination: { x: number; y: number; width: number; height: number };
}

const MAP_FACINGS: readonly MapFacing[] = ["north", "east", "south", "west"];

/**
 * Resolve renderer-neutral atlas coordinates for a directional sprite.
 *
 * The helper deliberately returns undefined for generic images, non-sprite
 * assets, and malformed runtime data. Callers can therefore preserve their
 * existing full-image fallback without guessing a sheet convention. The
 * parser is stricter and rejects malformed authored specs before they reach
 * this boundary.
 */
export function resolveAssetSpriteFrame(
  asset: Pick<AssetSpec, "kind" | "spriteGrid"> | undefined,
  facing?: MapFacing,
): AssetSpriteFrame | undefined {
  if (!asset || asset.kind !== "sprite" || !asset.spriteGrid) return undefined;
  const grid = asset.spriteGrid;
  if (!Number.isSafeInteger(grid.columns) || grid.columns <= 0) return undefined;
  if (!Number.isSafeInteger(grid.rows) || grid.rows <= 0) return undefined;
  if (!Number.isSafeInteger(grid.columns * grid.rows)) return undefined;
  const effectiveFacing = facing ?? grid.defaultFacing;
  if (!MAP_FACINGS.includes(effectiveFacing)) return undefined;
  const index = grid.frames?.[effectiveFacing];
  if (!Number.isSafeInteger(index) || index < 0 || index >= grid.columns * grid.rows) {
    return undefined;
  }
  return {
    facing: effectiveFacing,
    index,
    column: index % grid.columns,
    row: Math.floor(index / grid.columns),
    columns: grid.columns,
    rows: grid.rows,
  };
}

/**
 * Build a renderer-neutral `drawImage` plan that contains one atlas cell in a
 * viewport without changing the cell's intrinsic aspect ratio. Browser
 * renderers use the source bitmap dimensions after it loads; other frontends
 * can consume the same geometry without depending on DOM or CSS behavior.
 */
export function assetSpriteFrameDrawPlan(
  frame: AssetSpriteFrame,
  image: { width: number; height: number },
  viewport: { width: number; height: number },
): AssetSpriteFrameDrawPlan | undefined {
  if (
    !Number.isFinite(image.width) || image.width <= 0
    || !Number.isFinite(image.height) || image.height <= 0
    || !Number.isFinite(viewport.width) || viewport.width <= 0
    || !Number.isFinite(viewport.height) || viewport.height <= 0
    || !Number.isSafeInteger(frame.columns) || frame.columns <= 0
    || !Number.isSafeInteger(frame.rows) || frame.rows <= 0
    || !Number.isSafeInteger(frame.column) || frame.column < 0 || frame.column >= frame.columns
    || !Number.isSafeInteger(frame.row) || frame.row < 0 || frame.row >= frame.rows
  ) return undefined;
  const sourceWidth = image.width / frame.columns;
  const sourceHeight = image.height / frame.rows;
  const scale = Math.min(
    viewport.width / sourceWidth,
    viewport.height / sourceHeight,
  );
  const destinationWidth = sourceWidth * scale;
  const destinationHeight = sourceHeight * scale;
  return {
    source: {
      x: frame.column * sourceWidth,
      y: frame.row * sourceHeight,
      width: sourceWidth,
      height: sourceHeight,
    },
    destination: {
      x: (viewport.width - destinationWidth) / 2,
      y: (viewport.height - destinationHeight) / 2,
      width: destinationWidth,
      height: destinationHeight,
    },
  };
}
