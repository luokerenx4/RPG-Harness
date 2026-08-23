import { describe, expect, test } from "bun:test";
import { rankWebAssetImage } from "../src/assetImagePolicy";

describe("Web asset image policy", () => {
  test("prefers frontend images over compressed distribution images", () => {
    expect(rankWebAssetImage("web.webp")).toBeGreaterThan(rankWebAssetImage("source.compressed.webp"));
  });

  test("keeps authoring masters and unrelated images out of the runtime bundle", () => {
    expect(rankWebAssetImage("source.quality.png")).toBe(0);
    expect(rankWebAssetImage("reference.png")).toBe(0);
  });
});
