import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectAssetPreview } from "./api";
import {
  filterMapAssets,
  initialMapAssetKind,
  MapAssetPicker,
  mapAssetRenderingAvailability,
  matchesMapAssetQuery,
  nextMapAssetPickerIndex,
} from "./MapAssetPicker";

const assets: ProjectAssetPreview[] = [
  {
    path: "assets/sprites/kagari-field",
    kind: "sprite",
    placeholder: "篝 field sprite",
    renderings: {
      source: true,
      sourceQuality: true,
      sourceCompressed: true,
      tuiTxt: false,
      tuiAns: false,
      web: true,
    },
  },
  {
    path: "assets/bg/water-shrine",
    kind: "bg",
    placeholder: "Water Shrine",
    renderings: {
      source: true,
      sourceQuality: true,
      sourceCompressed: false,
      tuiTxt: false,
      tuiAns: false,
      web: false,
    },
  },
];

describe("Studio map asset picker", () => {
  test("searches authored placeholder, path, and kind while respecting kind chips", () => {
    expect(matchesMapAssetQuery(assets[0]!, "篝")).toBe(true);
    expect(matchesMapAssetQuery(assets[0]!, "kagari-field")).toBe(true);
    expect(matchesMapAssetQuery(assets[0]!, "SPRITE")).toBe(true);
    expect(filterMapAssets(assets, "shrine", "all").map((asset) => asset.path))
      .toEqual(["assets/bg/water-shrine"]);
    expect(filterMapAssets(assets, "", "sprite").map((asset) => asset.path))
      .toEqual(["assets/sprites/kagari-field"]);
  });

  test("opens on the preferred RPG Maker resource kind and falls back when absent", () => {
    expect(initialMapAssetKind(assets, "sprite")).toBe("sprite");
    expect(initialMapAssetKind(assets, "cg")).toBe("all");
  });

  test("wraps arrow navigation and supports Home and End", () => {
    expect(nextMapAssetPickerIndex(0, 4, "ArrowLeft")).toBe(3);
    expect(nextMapAssetPickerIndex(3, 4, "ArrowDown")).toBe(0);
    expect(nextMapAssetPickerIndex(2, 4, "Home")).toBe(0);
    expect(nextMapAssetPickerIndex(1, 4, "End")).toBe(3);
    expect(nextMapAssetPickerIndex(0, 0, "ArrowRight")).toBe(-1);
  });

  test("reports source and Web rendering availability independently", () => {
    expect(mapAssetRenderingAvailability(assets[0]!)).toEqual({ source: true, web: true });
    expect(mapAssetRenderingAvailability(assets[1]!)).toEqual({ source: true, web: false });
  });

  test("renders an accessible dialog with current, selected, and rendering states", () => {
    const html = renderToStaticMarkup(<MapAssetPicker
      assets={assets}
      value="assets/bg/water-shrine"
      preferredKind="sprite"
      emptyLabel="Use system marker"
      label="Map graphic"
      title="Choose map graphic for shrine keeper"
      description="Assign a visual override."
      onChange={() => {}}
      defaultOpen
    />);

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Search project assets");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Sprites");
    expect(html).toContain("Show current · bg");
    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="option"');
    expect(html).toContain("Use system marker");
    expect(html).toContain("SRC");
    expect(html).toContain("WEB");
    expect(html).toContain("Renderings: source available, web available");
    expect(html).toContain("Arrow keys navigate · Enter chooses · Esc closes");
  });
});
