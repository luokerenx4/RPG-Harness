import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import {
  AssetCreateError,
  createAssetRecord,
  createAssetSpec,
  validateAssetCreateInput,
} from "./asset-create";

describe("asset creation", () => {
  let gameDir: string;

  beforeEach(async () => {
    gameDir = await mkdtemp(path.join(os.tmpdir(), "autogal-asset-create-"));
  });

  afterEach(async () => {
    await rm(gameDir, { recursive: true, force: true });
  });

  test("defaults tilesets to a 4x4 atlas", () => {
    const input = validateAssetCreateInput({
      kind: "tileset",
      id: "flooded-shrine",
      description: "A drowned stone shrine.",
      prompt: "Paint an RPG terrain atlas.",
      placeholder: "Flooded shrine terrain",
    });

    expect(input.tileGrid).toEqual({ columns: 4, rows: 4, firstId: 1 });
  });

  test("rejects unsafe slugs and tile metadata on other asset kinds", () => {
    expect(() => validateAssetCreateInput({
      kind: "bg",
      id: "../shrine",
      description: "Shrine",
      prompt: "Shrine",
      placeholder: "Shrine",
    })).toThrow(AssetCreateError);

    expect(() => validateAssetCreateInput({
      kind: "bg",
      id: "shrine",
      description: "Shrine",
      prompt: "Shrine",
      placeholder: "Shrine",
      tileGrid: { columns: 4, rows: 4, firstId: 1 },
    })).toThrow("tileGrid is only valid for tileset assets");
  });

  test("writes a parser-shaped tileset spec and refuses duplicates", async () => {
    const input = validateAssetCreateInput({
      kind: "tileset",
      id: "flooded-shrine",
      description: "A drowned stone shrine.",
      prompt: "Paint an RPG terrain atlas.",
      placeholder: "Flooded shrine terrain",
      tileGrid: { columns: 6, rows: 3, firstId: 10 },
    });

    const assetPath = await createAssetSpec(gameDir, input);
    expect(assetPath).toBe("assets/tilesets/flooded-shrine");

    const yaml = parse(await readFile(
      path.join(gameDir, "assets/tilesets/flooded-shrine/spec.yaml"),
      "utf8",
    ));
    expect(yaml).toEqual({
      kind: "tileset",
      description: "A drowned stone shrine.",
      prompt: "Paint an RPG terrain atlas.",
      placeholder: "Flooded shrine terrain",
      tile_grid: { columns: 6, rows: 3, first_id: 10 },
    });

    try {
      await createAssetSpec(gameDir, input);
      throw new Error("expected duplicate creation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AssetCreateError);
      expect((error as AssetCreateError).status).toBe(409);
    }
  });

  test("rolls the new directory back when authoritative reload fails", async () => {
    const input = validateAssetCreateInput({
      kind: "portrait",
      id: "draft-hero",
      description: "A draft hero portrait.",
      prompt: "Paint a samurai portrait.",
      placeholder: "Draft hero",
    });

    await expect(createAssetRecord(gameDir, input, async () => {
      throw new Error("project reload failed");
    })).rejects.toThrow("project reload failed");

    await expect(access(path.join(gameDir, "assets/portraits/draft-hero"))).rejects.toThrow();
  });
});
