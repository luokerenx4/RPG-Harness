import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import type { AssetKind, AssetSpec, AssetTileGrid, Game } from "@rpg-harness/engine";

export interface AssetCreateInput {
  kind: AssetKind;
  id: string;
  description: string;
  prompt: string;
  placeholder: string;
  tileGrid?: AssetTileGrid;
}

const ASSET_DIRS: Record<AssetKind, string> = {
  portrait: "portraits",
  bg: "backgrounds",
  cg: "cgs",
  sheet: "sheets",
  sprite: "sprites",
  tileset: "tilesets",
};

export class AssetCreateError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function validateAssetCreateInput(raw: unknown): AssetCreateInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AssetCreateError("body must be a JSON object");
  }
  const input = raw as Record<string, unknown>;
  if (typeof input.kind !== "string" || !(input.kind in ASSET_DIRS)) {
    throw new AssetCreateError("kind must be portrait, bg, cg, sheet, sprite, or tileset");
  }
  if (typeof input.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.id)) {
    throw new AssetCreateError("id must be a lowercase kebab-case slug");
  }
  for (const key of ["description", "prompt", "placeholder"] as const) {
    if (typeof input[key] !== "string" || input[key].trim().length === 0) {
      throw new AssetCreateError(`${key} must be a non-empty string`);
    }
  }
  const kind = input.kind as AssetKind;
  let tileGrid: AssetTileGrid | undefined;
  if (kind === "tileset") {
    const rawGrid = input.tileGrid ?? { columns: 4, rows: 4, firstId: 1 };
    if (!rawGrid || typeof rawGrid !== "object" || Array.isArray(rawGrid)) {
      throw new AssetCreateError("tileGrid must be an object");
    }
    const grid = rawGrid as Record<string, unknown>;
    if (!Number.isInteger(grid.columns) || (grid.columns as number) <= 0 || !Number.isInteger(grid.rows) || (grid.rows as number) <= 0 || !Number.isInteger(grid.firstId) || (grid.firstId as number) < 0) {
      throw new AssetCreateError("tileGrid needs positive integer columns/rows and a non-negative firstId");
    }
    tileGrid = { columns: grid.columns as number, rows: grid.rows as number, firstId: grid.firstId as number };
  } else if (input.tileGrid !== undefined) {
    throw new AssetCreateError("tileGrid is only valid for tileset assets");
  }
  return {
    kind,
    id: input.id,
    description: (input.description as string).trim(),
    prompt: (input.prompt as string).trim(),
    placeholder: (input.placeholder as string).trim(),
    ...(tileGrid ? { tileGrid } : {}),
  };
}

export async function createAssetSpec(gameDir: string, input: AssetCreateInput): Promise<string> {
  const assetPath = `assets/${ASSET_DIRS[input.kind]}/${input.id}`;
  const parent = path.join(gameDir, "assets", ASSET_DIRS[input.kind]);
  const target = path.join(gameDir, ...assetPath.split("/"));
  await mkdir(parent, { recursive: true });
  try {
    await mkdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new AssetCreateError(`asset already exists: ${assetPath}`, 409);
    }
    throw error;
  }
  try {
    const spec = {
      kind: input.kind,
      description: input.description,
      prompt: input.prompt,
      placeholder: input.placeholder,
      ...(input.tileGrid ? { tile_grid: { columns: input.tileGrid.columns, rows: input.tileGrid.rows, first_id: input.tileGrid.firstId } } : {}),
    };
    await writeFile(path.join(target, "spec.yaml"), stringify(spec), { flag: "wx" });
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
  return assetPath;
}

export async function createAssetRecord(
  gameDir: string,
  input: AssetCreateInput,
  reload: () => Promise<Game>,
): Promise<{ assetPath: string; asset: AssetSpec }> {
  const assetPath = await createAssetSpec(gameDir, input);
  try {
    const game = await reload();
    const asset = (game.assets ?? []).find((candidate) => candidate.path === assetPath);
    if (!asset) throw new Error(`created asset did not load: ${assetPath}`);
    return { assetPath, asset };
  } catch (error) {
    await rm(path.join(gameDir, ...assetPath.split("/")), { recursive: true, force: true });
    throw error;
  }
}
