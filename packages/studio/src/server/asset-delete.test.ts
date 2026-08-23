import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssetSpec, Game } from "@rpg-harness/engine";
import {
  AssetDeleteError,
  readAssetTrash,
  restoreAssetTrashEntry,
  trashAsset,
} from "./asset-delete";

const asset: AssetSpec = {
  path: "assets/portraits/draft-hero",
  kind: "portrait",
  description: "Draft hero",
  prompt: "Paint a hero",
  placeholder: "Draft hero",
  renderings: {},
};

function game(
  assets: AssetSpec[],
  scripts: Game["scripts"] = [],
  maps: NonNullable<Game["maps"]> = [],
): Game {
  return { title: "Test", assets, scripts, maps, characters: [] } as unknown as Game;
}

describe("asset trash", () => {
  let gameDir: string;

  beforeEach(async () => {
    gameDir = await mkdtemp(path.join(os.tmpdir(), "autogal-asset-trash-"));
    const dir = path.join(gameDir, ...asset.path.split("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "spec.yaml"), "kind: portrait\n");
  });

  afterEach(async () => {
    await rm(gameDir, { recursive: true, force: true });
  });

  test("moves an unreferenced asset directory into recoverable trash", async () => {
    const trashed = await trashAsset(gameDir, game([asset]), asset.path, async () => game([]), () => new Date("2026-08-24T10:00:00.000Z"));

    await expect(access(path.join(gameDir, ...asset.path.split("/")))).rejects.toThrow();
    expect(await readFile(path.join(gameDir, ...trashed.trashPath.split("/"), "spec.yaml"), "utf8")).toContain("portrait");
    expect(await readAssetTrash(gameDir)).toEqual([expect.objectContaining({ path: asset.path, label: "Draft hero" })]);
  });

  test("blocks deletion while scripts or map layers still reference the asset", async () => {
    const scripts = [{ id: "intro", beats: [{ type: "setPortrait", slot: "center", assetPath: asset.path }] }] as unknown as Game["scripts"];
    const maps = [{ id: "shrine", name: "Shrine", layout: { layers: [{ id: "ground", asset: asset.path }] } }] as unknown as NonNullable<Game["maps"]>;
    try {
      await trashAsset(gameDir, game([asset], scripts, maps), asset.path, async () => game([]));
      throw new Error("expected reference protection");
    } catch (error) {
      expect(error).toBeInstanceOf(AssetDeleteError);
      expect((error as AssetDeleteError).status).toBe(409);
      expect((error as AssetDeleteError).blockers).toEqual(["map:shrine", "script:intro"]);
    }
    await expect(access(path.join(gameDir, ...asset.path.split("/")))).resolves.toBeNull();
  });

  test("restores an asset and rolls failed restores back into trash", async () => {
    const trashed = await trashAsset(gameDir, game([asset]), asset.path, async () => game([]));
    await expect(restoreAssetTrashEntry(gameDir, trashed.trashPath, async () => {
      throw new Error("reload rejected");
    })).rejects.toThrow("reload rejected");
    await expect(access(path.join(gameDir, ...trashed.trashPath.split("/")))).resolves.toBeNull();

    const restored = await restoreAssetTrashEntry(gameDir, trashed.trashPath, async () => game([asset]));
    expect(restored.asset.path).toBe(asset.path);
    await expect(access(path.join(gameDir, ...asset.path.split("/"), "spec.yaml"))).resolves.toBeNull();
    expect(await readAssetTrash(gameDir)).toEqual([]);
  });
});
