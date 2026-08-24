import React, { useEffect, useRef } from "react";
import {
  assetSpriteFrameDrawPlan,
  resolveAssetSpriteFrame,
  type AssetSpriteFrame,
  type AssetSpriteFrameDrawPlan,
  type MapFacing,
} from "@rpg-harness/engine";
import {
  sourceImageUrl,
  type ProjectAssetPreview,
} from "./api";

export type StudioSpriteAsset = Pick<
  ProjectAssetPreview,
  "path" | "kind" | "spriteGrid"
>;

export interface StudioSpriteCanvasContext {
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  drawImage(
    image: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
}

/** Paint one authored atlas cell into a canvas without changing its aspect ratio. */
export function drawStudioSpriteFrame(
  canvas: Pick<HTMLCanvasElement, "width" | "height">,
  context: StudioSpriteCanvasContext,
  image: CanvasImageSource,
  frame: AssetSpriteFrame,
  imageSize: { width: number; height: number },
  viewport: { width: number; height: number },
  devicePixelRatio = 1,
): AssetSpriteFrameDrawPlan | undefined {
  const plan = assetSpriteFrameDrawPlan(frame, imageSize, viewport);
  if (!plan) return undefined;
  const scale = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
  canvas.width = Math.max(1, Math.round(viewport.width * scale));
  canvas.height = Math.max(1, Math.round(viewport.height * scale));
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, viewport.width, viewport.height);
  context.drawImage(
    image,
    plan.source.x,
    plan.source.y,
    plan.source.width,
    plan.source.height,
    plan.destination.x,
    plan.destination.y,
    plan.destination.width,
    plan.destination.height,
  );
  return plan;
}

/**
 * Shared Studio projection for an explicit directional sprite. Generic images
 * deliberately return null so their existing background / img fallback stays
 * authoritative at each call site.
 */
export function StudioSpriteFrame({
  asset,
  facing,
  imageUrl,
  className,
}: {
  asset: StudioSpriteAsset | undefined;
  facing?: MapFacing;
  imageUrl?: string;
  className?: string;
}) {
  const frame = resolveAssetSpriteFrame(asset, facing);
  const resolvedImageUrl = imageUrl ?? (asset ? sourceImageUrl(asset.path) : undefined);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame || !resolvedImageUrl) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    let animationFrame = 0;
    const image = new Image();
    const draw = () => {
      if (disposed || !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      drawStudioSpriteFrame(
        canvas,
        context,
        image,
        frame,
        { width: image.naturalWidth, height: image.naturalHeight },
        { width: bounds.width, height: bounds.height },
        window.devicePixelRatio,
      );
    };
    const scheduleDraw = () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        animationFrame = 0;
        draw();
      });
    };
    image.onload = scheduleDraw;
    image.src = resolvedImageUrl;
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(scheduleDraw);
      resizeObserver.observe(canvas);
    } else {
      window.addEventListener("resize", scheduleDraw);
    }
    scheduleDraw();
    return () => {
      disposed = true;
      image.onload = null;
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleDraw);
      if (animationFrame) cancelAnimationFrame(animationFrame);
    };
  }, [
    resolvedImageUrl,
    frame?.facing,
    frame?.index,
    frame?.column,
    frame?.row,
    frame?.columns,
    frame?.rows,
  ]);

  if (!frame || !resolvedImageUrl) return null;
  return <canvas
    ref={canvasRef}
    className={className}
    data-sprite-facing={frame.facing}
    data-sprite-frame={frame.index}
    aria-hidden="true"
  />;
}

/** Find an asset only when it owns a valid frame for the requested facing. */
export function studioDirectionalSpriteAsset(
  path: string | undefined,
  assets: ProjectAssetPreview[],
  facing?: MapFacing,
): ProjectAssetPreview | undefined {
  if (!path) return undefined;
  const asset = assets.find((candidate) => candidate.path === path);
  return resolveAssetSpriteFrame(asset, facing) ? asset : undefined;
}

/** Preserve the legacy whole-image background for every non-directional asset. */
export function studioAssetBackgroundStyle(
  path: string | undefined,
  assets: ProjectAssetPreview[],
  facing?: MapFacing,
): React.CSSProperties | undefined {
  if (!path) return undefined;
  if (studioDirectionalSpriteAsset(path, assets, facing)) return undefined;
  return { backgroundImage: `url(${JSON.stringify(sourceImageUrl(path))})` };
}
