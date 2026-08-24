import React from "react";
import type { MapFacing } from "@rpg-harness/engine";
import type { AssetRow } from "./api";
import { StudioSpriteFrame } from "./SpriteFrame";

export type AssetSpriteGrid = NonNullable<AssetRow["spriteGrid"]>;

export interface AssetSpriteGridDraft {
  enabled: boolean;
  columns: string;
  rows: string;
  defaultFacing: MapFacing;
  frames: Record<MapFacing, string>;
}

export const SPRITE_FACINGS = ["north", "east", "south", "west"] as const;

const FACING_LABELS: Record<MapFacing, { label: string; arrow: string }> = {
  north: { label: "North", arrow: "↑" },
  east: { label: "East", arrow: "→" },
  south: { label: "South", arrow: "↓" },
  west: { label: "West", arrow: "←" },
};

/** RPG Maker's common 3 columns × 4 direction rows, using each idle centre cell. */
export const RPG_MAKER_3X4_SPRITE_GRID: AssetSpriteGrid = {
  columns: 3,
  rows: 4,
  defaultFacing: "south",
  frames: { north: 10, east: 7, south: 1, west: 4 },
};

export function assetSpriteGridDraft(
  grid: AssetRow["spriteGrid"],
): AssetSpriteGridDraft {
  const value = grid ?? RPG_MAKER_3X4_SPRITE_GRID;
  return {
    enabled: grid !== undefined,
    columns: String(value.columns),
    rows: String(value.rows),
    defaultFacing: value.defaultFacing,
    frames: {
      north: String(value.frames.north),
      east: String(value.frames.east),
      south: String(value.frames.south),
      west: String(value.frames.west),
    },
  };
}

export function rpgMakerSpriteGridDraft(): AssetSpriteGridDraft {
  return assetSpriteGridDraft(RPG_MAKER_3X4_SPRITE_GRID);
}

export function parseAssetSpriteGridDraft(
  draft: AssetSpriteGridDraft,
): { value: AssetSpriteGrid | null } | { error: string } {
  if (!draft.enabled) return { value: null };
  const columns = parseWholeNumber(draft.columns);
  const rows = parseWholeNumber(draft.rows);
  if (columns === undefined || columns < 1) {
    return { error: "Directional sprite columns must be a positive whole number." };
  }
  if (rows === undefined || rows < 1) {
    return { error: "Directional sprite rows must be a positive whole number." };
  }
  const capacity = columns * rows;
  if (!Number.isSafeInteger(capacity)) {
    return { error: "Directional sprite cell count is too large." };
  }
  const frames = {} as Record<MapFacing, number>;
  for (const facing of SPRITE_FACINGS) {
    const frame = parseWholeNumber(draft.frames[facing]);
    if (frame === undefined || frame < 0 || frame >= capacity) {
      return { error: `${FACING_LABELS[facing].label} frame must be a whole number from 0 to ${capacity - 1}.` };
    }
    frames[facing] = frame;
  }
  return {
    value: { columns, rows, defaultFacing: draft.defaultFacing, frames },
  };
}

export function AssetSpriteGridEditor({
  draft,
  imageUrl,
  onChange,
}: {
  draft: AssetSpriteGridDraft;
  imageUrl?: string;
  onChange: (draft: AssetSpriteGridDraft) => void;
}) {
  const parsed = parseAssetSpriteGridDraft(draft);
  const previewGrid = "value" in parsed && parsed.value ? parsed.value : undefined;
  const capacity = Number(draft.columns) * Number(draft.rows);
  const setFrame = (facing: MapFacing, value: string) => onChange({
    ...draft,
    frames: { ...draft.frames, [facing]: value },
  });

  return (
    <section className={`asset-sprite-grid-editor${draft.enabled ? " enabled" : ""}`} aria-label="Directional sprite atlas">
      <header>
        <label>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
          />
          <span><strong>Directional atlas</strong><small>Map facing selects one authored frame. Gameplay and Headless remain unchanged.</small></span>
        </label>
        <button type="button" onClick={() => onChange(rpgMakerSpriteGridDraft())}>RPG Maker 3×4 preset</button>
      </header>
      {!draft.enabled ? (
        <p>Single-image sprite · renderers keep using the complete bitmap.</p>
      ) : (
        <>
          <div className="asset-sprite-grid-controls">
            <label><span>columns</span><input aria-label="Directional sprite columns" type="number" min={1} value={draft.columns} onChange={(event) => onChange({ ...draft, columns: event.target.value })} /></label>
            <label><span>rows</span><input aria-label="Directional sprite rows" type="number" min={1} value={draft.rows} onChange={(event) => onChange({ ...draft, rows: event.target.value })} /></label>
            <label><span>default facing</span><select aria-label="Directional sprite default facing" value={draft.defaultFacing} onChange={(event) => onChange({ ...draft, defaultFacing: event.target.value as MapFacing })}>{SPRITE_FACINGS.map((facing) => <option key={facing} value={facing}>{FACING_LABELS[facing].label}</option>)}</select></label>
            <output>{Number.isInteger(capacity) && capacity > 0 ? `${capacity} cells · indexes 0–${capacity - 1}` : "complete the grid size"}</output>
          </div>
          <div className="asset-sprite-frame-grid">
            {SPRITE_FACINGS.map((facing) => {
              const presentation = FACING_LABELS[facing];
              return (
                <label className={draft.defaultFacing === facing ? "default" : ""} key={facing}>
                  {previewGrid && imageUrl ? (
                    <StudioSpriteFrame
                      asset={{ path: "asset-editor-preview", kind: "sprite", spriteGrid: previewGrid }}
                      facing={facing}
                      imageUrl={imageUrl}
                      className="asset-sprite-frame-preview"
                    />
                  ) : (
                    <span className="asset-sprite-frame-preview" aria-hidden="true">{presentation.arrow}</span>
                  )}
                  <span><strong>{presentation.arrow} {presentation.label}</strong><small>{draft.defaultFacing === facing ? "DEFAULT" : "FRAME"}</small></span>
                  <input aria-label={`${presentation.label} frame index`} type="number" min={0} max={Number.isInteger(capacity) && capacity > 0 ? capacity - 1 : undefined} value={draft.frames[facing]} onChange={(event) => setFrame(facing, event.target.value)} />
                </label>
              );
            })}
          </div>
          {"error" in parsed && <p className="asset-sprite-grid-error" role="alert">{parsed.error}</p>}
        </>
      )}
    </section>
  );
}

function parseWholeNumber(value: string): number | undefined {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
