import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { sourceImageUrl, type AssetKind, type ProjectAssetPreview } from "./api";

const ASSET_KIND_ORDER: AssetKind[] = ["sprite", "bg", "cg", "portrait", "sheet", "tileset"];

const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  sprite: "Sprites",
  bg: "Backgrounds",
  cg: "CG",
  portrait: "Portraits",
  sheet: "Sheets",
  tileset: "Tilesets",
};

export type AssetKindFilter = AssetKind | "all";
type AssetPickerArrowKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End";

export function matchesMapAssetQuery(asset: ProjectAssetPreview, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [asset.placeholder, asset.path, asset.kind]
    .some((field) => field.toLowerCase().includes(normalized));
}

export function filterMapAssets(
  assets: ProjectAssetPreview[],
  query: string,
  kind: AssetKindFilter,
): ProjectAssetPreview[] {
  return assets.filter((asset) =>
    (kind === "all" || asset.kind === kind) && matchesMapAssetQuery(asset, query)
  );
}

export function initialMapAssetKind(
  assets: ProjectAssetPreview[],
  preferredKind: AssetKind,
): AssetKindFilter {
  return assets.some((asset) => asset.kind === preferredKind) ? preferredKind : "all";
}

export function nextMapAssetPickerIndex(
  current: number,
  count: number,
  key: AssetPickerArrowKey,
): number {
  if (count <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowUp" || key === "ArrowLeft") return current <= 0 ? count - 1 : current - 1;
  return current < 0 || current >= count - 1 ? 0 : current + 1;
}

export function mapAssetRenderingAvailability(asset: ProjectAssetPreview): { source: boolean; web: boolean } {
  return {
    source: asset.renderings.source || asset.renderings.sourceQuality || asset.renderings.sourceCompressed,
    web: asset.renderings.web,
  };
}

function hasSourceImage(asset: ProjectAssetPreview): boolean {
  const availability = mapAssetRenderingAvailability(asset);
  return availability.source || availability.web;
}

export function MapAssetPicker({
  assets,
  value,
  preferredKind,
  emptyLabel,
  label,
  title,
  description,
  onChange,
  defaultOpen = false,
}: {
  assets: ProjectAssetPreview[];
  value?: string;
  preferredKind: AssetKind;
  emptyLabel: string;
  label: string;
  title: string;
  description: string;
  onChange: (assetPath: string | undefined) => void;
  defaultOpen?: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const listboxId = useId();
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<AssetKindFilter>(() => initialMapAssetKind(assets, preferredKind));
  const [pendingValue, setPendingValue] = useState<string | undefined>(value);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectedAsset = assets.find((asset) => asset.path === value);
  const pendingAsset = assets.find((asset) => asset.path === pendingValue);
  const visibleAssets = useMemo(
    () => filterMapAssets(assets, query, kind),
    [assets, kind, query],
  );
  const optionValues = useMemo<Array<string | undefined>>(
    () => [undefined, ...visibleAssets.map((asset) => asset.path)],
    [visibleAssets],
  );
  const availableKinds = useMemo(
    () => ASSET_KIND_ORDER.filter((candidate) => assets.some((asset) => asset.kind === candidate)),
    [assets],
  );

  const restoreTriggerFocus = useCallback(() => {
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const closePicker = useCallback(() => {
    setOpen(false);
    restoreTriggerFocus();
  }, [restoreTriggerFocus]);

  const openPicker = () => {
    setQuery("");
    setKind(initialMapAssetKind(assets, preferredKind));
    setPendingValue(value);
    setActiveIndex(0);
    setOpen(true);
  };

  const commitValue = useCallback((assetPath: string | undefined) => {
    if (assetPath !== value) onChange(assetPath);
    setOpen(false);
    restoreTriggerFocus();
  }, [onChange, restoreTriggerFocus, value]);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = optionValues.findIndex((candidate) => candidate === pendingValue);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [kind, open, optionValues, pendingValue, query]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
  }, [open]);

  const focusOption = (index: number) => {
    setActiveIndex(index);
    requestAnimationFrame(() => optionRefs.current[index]?.focus());
  };

  const handleOptionNavigation = (event: React.KeyboardEvent, key: AssetPickerArrowKey) => {
    event.preventDefault();
    event.stopPropagation();
    focusOption(nextMapAssetPickerIndex(activeIndex, optionValues.length, key));
  };

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePicker();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const renderAssetArt = (asset: ProjectAssetPreview | undefined) => {
    if (asset && hasSourceImage(asset)) {
      return <img src={sourceImageUrl(asset.path)} alt="" loading="lazy" />;
    }
    return <span aria-hidden="true">{asset ? asset.kind.slice(0, 2).toUpperCase() : "∅"}</span>;
  };

  return (
    <div className="map-asset-picker">
      <span className="map-asset-picker-label">{label}</span>
      <button
        ref={triggerRef}
        type="button"
        className="map-asset-picker-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${selectedAsset?.placeholder ?? (value ?? emptyLabel)}`}
        onClick={openPicker}
      >
        <i>{renderAssetArt(selectedAsset)}</i>
        <span>
          <strong>{selectedAsset?.placeholder ?? (value ?? emptyLabel)}</strong>
          <small>{selectedAsset ? `${selectedAsset.kind} · ${selectedAsset.path}` : value ? "missing asset" : "project default"}</small>
        </span>
        <b aria-hidden="true">Choose…</b>
      </button>
      {open && (
        <div className="map-asset-picker-layer" role="presentation">
          <button type="button" className="map-asset-picker-backdrop" aria-hidden="true" tabIndex={-1} onClick={closePicker} />
          <section
            ref={dialogRef}
            className="map-asset-picker-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            onKeyDown={handleDialogKeyDown}
          >
            <header>
              <div>
                <span>MAP VISUAL RESOURCE</span>
                <strong id={titleId}>{title}</strong>
                <small id={descriptionId}>{description}</small>
              </div>
              <button type="button" aria-label="Close asset picker" onClick={closePicker}>×</button>
            </header>
            <div className="map-asset-picker-tools">
              <label>
                <span>Search project assets</span>
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  placeholder="Name, path, or kind…"
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                      handleOptionNavigation(event, event.key as AssetPickerArrowKey);
                    }
                  }}
                />
              </label>
              <div className="map-asset-kind-chips" aria-label="Asset kind filter">
                <button type="button" aria-pressed={kind === "all"} className={kind === "all" ? "selected" : ""} onClick={() => setKind("all")}>All <small>{assets.length}</small></button>
                {availableKinds.map((candidate) => (
                  <button
                    type="button"
                    key={candidate}
                    aria-pressed={kind === candidate}
                    className={kind === candidate ? "selected" : ""}
                    onClick={() => setKind(candidate)}
                  >
                    {ASSET_KIND_LABELS[candidate]} <small>{assets.filter((asset) => asset.kind === candidate).length}</small>
                  </button>
                ))}
              </div>
            </div>
            <div className="map-asset-picker-current">
              <span>CURRENT</span>
              <strong>{selectedAsset?.placeholder ?? (value ?? emptyLabel)}</strong>
              <code>{selectedAsset?.path ?? value ?? "default"}</code>
              {selectedAsset && kind !== "all" && kind !== selectedAsset.kind && (
                <button type="button" onClick={() => { setQuery(""); setKind(selectedAsset.kind); }}>Show current · {selectedAsset.kind}</button>
              )}
            </div>
            <div className="map-asset-picker-results-meta">
              <span>{visibleAssets.length} visual {visibleAssets.length === 1 ? "resource" : "resources"}</span>
              <small>Arrow keys navigate · Enter chooses · Esc closes</small>
            </div>
            <div id={listboxId} className="map-asset-picker-grid" role="listbox" aria-label="Available visual resources">
              <button
                ref={(node) => { optionRefs.current[0] = node; }}
                type="button"
                role="option"
                aria-selected={pendingValue === undefined}
                tabIndex={activeIndex === 0 ? 0 : -1}
                className={`map-asset-option default${pendingValue === undefined ? " selected" : ""}${value === undefined ? " current" : ""}`}
                onFocus={() => setActiveIndex(0)}
                onClick={() => setPendingValue(undefined)}
                onDoubleClick={() => commitValue(undefined)}
                onKeyDown={(event) => {
                  if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) handleOptionNavigation(event, event.key as AssetPickerArrowKey);
                  else if (event.key === "Enter") { event.preventDefault(); commitValue(undefined); }
                }}
              >
                <i><span aria-hidden="true">∅</span></i>
                <span><strong>{emptyLabel}</strong><code>default</code></span>
                <b>{value === undefined ? "CURRENT" : pendingValue === undefined ? "SELECTED" : "DEFAULT"}</b>
              </button>
              {visibleAssets.map((asset, index) => {
                const optionIndex = index + 1;
                const selected = pendingValue === asset.path;
                const current = value === asset.path;
                const availability = mapAssetRenderingAvailability(asset);
                return (
                  <button
                    ref={(node) => { optionRefs.current[optionIndex] = node; }}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    tabIndex={activeIndex === optionIndex ? 0 : -1}
                    className={`map-asset-option${selected ? " selected" : ""}${current ? " current" : ""}`}
                    key={asset.path}
                    onFocus={() => setActiveIndex(optionIndex)}
                    onClick={() => setPendingValue(asset.path)}
                    onDoubleClick={() => commitValue(asset.path)}
                    onKeyDown={(event) => {
                      if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) handleOptionNavigation(event, event.key as AssetPickerArrowKey);
                      else if (event.key === "Enter") { event.preventDefault(); commitValue(asset.path); }
                    }}
                  >
                    <i>{renderAssetArt(asset)}</i>
                    <span>
                      <strong>{asset.placeholder}</strong>
                      <code>{asset.path}</code>
                      <small className="map-asset-rendering-flags" aria-label={`Renderings: source ${availability.source ? "available" : "missing"}, web ${availability.web ? "available" : "missing"}`}>
                        <em className={availability.source ? "present" : "missing"} title={`Source ${availability.source ? "available" : "missing"}`}>SRC</em>
                        <em className={availability.web ? "present" : "missing"} title={`Web ${availability.web ? "available" : "missing"}`}>WEB</em>
                      </small>
                    </span>
                    <b>{current ? "CURRENT" : selected ? "SELECTED" : asset.kind.toUpperCase()}</b>
                  </button>
                );
              })}
              {visibleAssets.length === 0 && (
                <div className="map-asset-picker-empty" role="status">
                  <span aria-hidden="true">⌕</span>
                  <strong>No matching visual resources</strong>
                  <small>Try another kind chip or clear the search.</small>
                </div>
              )}
            </div>
            <footer>
              <div>
                <span>SELECTION</span>
                <strong>{pendingAsset?.placeholder ?? (pendingValue ?? emptyLabel)}</strong>
                <code>{pendingAsset?.path ?? pendingValue ?? "default"}</code>
              </div>
              <button type="button" onClick={closePicker}>Cancel <kbd>Esc</kbd></button>
              <button type="button" className="primary" onClick={() => commitValue(pendingValue)}>Use selected</button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
