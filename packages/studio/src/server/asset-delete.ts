import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildProjectResourceGraph, type AssetKind, type AssetSpec, type Game } from "@rpg-harness/engine";

export class AssetDeleteError extends Error {
  constructor(
    message: string,
    public status = 400,
    public blockers: string[] = [],
  ) {
    super(message);
  }
}

export interface AssetTrashEntry {
  trashPath: string;
  sourcePath: string;
  deletedAt: string;
  kind: AssetKind;
  path: string;
  label: string;
}

export async function trashAsset(
  gameDir: string,
  game: Game,
  assetPath: string,
  reload: () => Promise<Game>,
  now = () => new Date(),
): Promise<{ game: Game; asset: AssetSpec; trashPath: string }> {
  const asset = (game.assets ?? []).find((candidate) => candidate.path === assetPath);
  if (!asset) throw new AssetDeleteError(`asset not found: ${assetPath}`, 404);

  const blockers = buildProjectResourceGraph(game).backlinks[`asset:${assetPath}`] ?? [];
  if (blockers.length > 0) {
    throw new AssetDeleteError(
      `${assetPath} is still used by ${blockers.join(", ")}`,
      409,
      blockers,
    );
  }

  const sourceAbsolute = safeProjectPath(gameDir, assetPath);
  const deletedAt = now().toISOString();
  const timestamp = deletedAt.replace(/[:.]/g, "-");
  const batchPath = await createAssetTrashBatch(gameDir, timestamp);
  const trashPath = path.posix.join(batchPath, assetPath);
  const trashAbsolute = safeProjectPath(gameDir, trashPath);
  const sidecar = `${trashAbsolute}.asset.studio.json`;
  await mkdir(path.dirname(trashAbsolute), { recursive: true });
  await rename(sourceAbsolute, trashAbsolute);

  try {
    await writeFile(sidecar, JSON.stringify({
      version: 1,
      trashPath,
      sourcePath: assetPath,
      deletedAt,
      kind: asset.kind,
      path: asset.path,
      label: asset.placeholder,
    }, null, 2), { encoding: "utf-8", flag: "wx" });
    const updated = await reload();
    if ((updated.assets ?? []).some((candidate) => candidate.path === assetPath)) {
      throw new Error(`trashed asset still loaded: ${assetPath}`);
    }
    return { game: updated, asset, trashPath };
  } catch (error) {
    await unlink(sidecar).catch(() => {});
    await mkdir(path.dirname(sourceAbsolute), { recursive: true });
    try {
      await rename(trashAbsolute, sourceAbsolute);
    } catch (rollbackError) {
      throw new Error(`${(error as Error).message}\nRollback failed: ${(rollbackError as Error).message}`);
    }
    throw error;
  }
}

export async function readAssetTrash(gameDir: string): Promise<AssetTrashEntry[]> {
  const root = safeProjectPath(gameDir, ".studio-trash");
  const sidecars = await collectAssetTrashSidecars(root).catch(() => []);
  const entries = await Promise.all(sidecars.map(async (absolute) => {
    try {
      const parsed = JSON.parse(await readFile(absolute, "utf-8")) as Partial<AssetTrashEntry> & { version?: number };
      if (
        parsed.version !== 1 ||
        typeof parsed.trashPath !== "string" ||
        typeof parsed.sourcePath !== "string" ||
        typeof parsed.deletedAt !== "string" ||
        !isAssetKind(parsed.kind) ||
        typeof parsed.path !== "string" ||
        typeof parsed.label !== "string"
      ) return null;
      if (path.resolve(absolute) !== path.resolve(`${safeProjectPath(gameDir, parsed.trashPath)}.asset.studio.json`)) return null;
      await access(safeProjectPath(gameDir, parsed.trashPath));
      safeProjectPath(gameDir, parsed.sourcePath);
      return parsed as AssetTrashEntry;
    } catch {
      return null;
    }
  }));
  return entries
    .filter((entry): entry is AssetTrashEntry => entry !== null)
    .sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
}

export async function restoreAssetTrashEntry(
  gameDir: string,
  trashPath: string,
  reload: () => Promise<Game>,
): Promise<{ game: Game; asset: AssetSpec; entry: AssetTrashEntry }> {
  const entry = (await readAssetTrash(gameDir)).find((candidate) => candidate.trashPath === trashPath);
  if (!entry) throw new AssetDeleteError(`asset trash entry not found: ${trashPath}`, 404);
  const trashAbsolute = safeProjectPath(gameDir, entry.trashPath);
  const sourceAbsolute = safeProjectPath(gameDir, entry.sourcePath);
  try {
    await access(sourceAbsolute);
    throw new AssetDeleteError(`${entry.sourcePath} already exists`, 409);
  } catch (error) {
    if (error instanceof AssetDeleteError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(path.dirname(sourceAbsolute), { recursive: true });
  await rename(trashAbsolute, sourceAbsolute);
  try {
    const game = await reload();
    const asset = (game.assets ?? []).find((candidate) => candidate.path === entry.path);
    if (!asset) throw new Error(`restored asset did not load: ${entry.path}`);
    await unlink(`${trashAbsolute}.asset.studio.json`);
    return { game, asset, entry };
  } catch (error) {
    await mkdir(path.dirname(trashAbsolute), { recursive: true });
    try {
      await rename(sourceAbsolute, trashAbsolute);
    } catch (rollbackError) {
      throw new Error(`${(error as Error).message}\nRollback failed: ${(rollbackError as Error).message}`);
    }
    throw error;
  }
}

async function createAssetTrashBatch(gameDir: string, timestamp: string): Promise<string> {
  await mkdir(safeProjectPath(gameDir, ".studio-trash"), { recursive: true });
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const name = suffix === 0 ? timestamp : `${timestamp}-${suffix}`;
    const relative = path.posix.join(".studio-trash", name);
    try {
      await mkdir(safeProjectPath(gameDir, relative));
      return relative;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new AssetDeleteError("could not allocate a unique asset trash entry");
}

async function collectAssetTrashSidecars(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectAssetTrashSidecars(absolute);
    return entry.isFile() && entry.name.endsWith(".asset.studio.json") ? [absolute] : [];
  }));
  return nested.flat();
}

function isAssetKind(value: unknown): value is AssetKind {
  return value === "portrait" || value === "bg" || value === "cg" || value === "sheet" || value === "sprite" || value === "tileset";
}

function safeProjectPath(gameDir: string, relative: string): string {
  const root = path.resolve(gameDir);
  const absolute = path.resolve(root, relative);
  const rel = path.relative(root, absolute);
  if (!relative || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new AssetDeleteError(`asset source escapes the game directory: ${relative}`);
  }
  return absolute;
}
