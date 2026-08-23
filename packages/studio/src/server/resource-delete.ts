import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildProjectResourceGraph,
  type Game,
  type ProjectResourceNode,
} from "@rpg-harness/engine";
import {
  CREATABLE_RESOURCE_KINDS,
  type CreatableResourceKind,
} from "./resource-create";
import { readResourceSource } from "./resource-source";

export class ResourceDeleteError extends Error {
  constructor(
    message: string,
    public status = 400,
    public blockers: string[] = [],
  ) {
    super(message);
  }
}

export interface StudioTrashEntry {
  trashPath: string;
  sourcePath: string;
  deletedAt: string;
  kind: CreatableResourceKind;
  id: string;
  key: string;
  label: string;
}

export async function trashProjectResource(
  gameDir: string,
  game: Game,
  kind: CreatableResourceKind,
  id: string,
  reload: () => Promise<Game>,
  now = () => new Date(),
  additionalBlockers: string[] = [],
): Promise<{
  game: Game;
  resource: ProjectResourceNode;
  sourcePath: string;
  trashPath: string;
}> {
  if (!(CREATABLE_RESOURCE_KINDS as readonly string[]).includes(kind)) {
    throw new ResourceDeleteError(`unsupported resource kind: ${kind}`);
  }
  if (!id) throw new ResourceDeleteError("resource id is required");

  const graph = buildProjectResourceGraph(game);
  const resource = graph.resources.find(
    (candidate) => candidate.kind === kind && candidate.id === id,
  );
  if (!resource) throw new ResourceDeleteError(`project resource not found: ${kind}:${id}`, 404);

  const blockers = [...new Set([
    ...(graph.backlinks[resource.key] ?? []),
    ...additionalBlockers,
  ])].sort();
  if (blockers.length > 0) {
    throw new ResourceDeleteError(
      `${resource.key} is still used by ${blockers.join(", ")}`,
      409,
      blockers,
    );
  }

  const sourcePath = (await readResourceSource(gameDir, game, kind, id)).path;
  const sourceAbsolute = safeProjectPath(gameDir, sourcePath);
  const deletedAt = now().toISOString();
  const timestamp = deletedAt.replace(/[:.]/g, "-");
  const batchPath = await createTrashBatch(gameDir, timestamp);
  const trashPath = path.posix.join(batchPath, sourcePath);
  const trashAbsolute = safeProjectPath(gameDir, trashPath);
  await mkdir(path.dirname(trashAbsolute), { recursive: true });
  await rename(sourceAbsolute, trashAbsolute);

  try {
    await writeFile(`${trashAbsolute}.studio.json`, JSON.stringify({
      version: 1,
      trashPath,
      sourcePath,
      deletedAt,
      kind,
      id,
      key: resource.key,
      label: resource.label,
    }, null, 2), { encoding: "utf-8", flag: "wx" });
    const updated = await reload();
    const stillPresent = buildProjectResourceGraph(updated).resources.some(
      (candidate) => candidate.kind === kind && candidate.id === id,
    );
    if (stillPresent) throw new Error(`trashed resource still loaded: ${resource.key}`);
    return { game: updated, resource, sourcePath, trashPath };
  } catch (error) {
    await unlink(`${trashAbsolute}.studio.json`).catch(() => {});
    await mkdir(path.dirname(sourceAbsolute), { recursive: true });
    try {
      await rename(trashAbsolute, sourceAbsolute);
    } catch (rollbackError) {
      throw new Error(
        `${(error as Error).message}\nRollback failed: ${(rollbackError as Error).message}`,
      );
    }
    throw error;
  }
}

export async function readStudioTrash(gameDir: string): Promise<StudioTrashEntry[]> {
  const root = safeProjectPath(gameDir, ".studio-trash");
  const sidecars = await collectTrashSidecars(root).catch(() => []);
  const entries = await Promise.all(sidecars.map(async (absolute) => {
    try {
      const parsed = JSON.parse(await readFile(absolute, "utf-8")) as Partial<StudioTrashEntry> & { version?: number };
      if (
        parsed.version !== 1 ||
        typeof parsed.trashPath !== "string" ||
        typeof parsed.sourcePath !== "string" ||
        typeof parsed.deletedAt !== "string" ||
        typeof parsed.kind !== "string" ||
        !(CREATABLE_RESOURCE_KINDS as readonly string[]).includes(parsed.kind) ||
        typeof parsed.id !== "string" ||
        typeof parsed.key !== "string" ||
        typeof parsed.label !== "string"
      ) return null;
      const expectedSidecar = `${safeProjectPath(gameDir, parsed.trashPath)}.studio.json`;
      if (path.resolve(absolute) !== path.resolve(expectedSidecar)) return null;
      await access(safeProjectPath(gameDir, parsed.trashPath));
      safeProjectPath(gameDir, parsed.sourcePath);
      return {
        trashPath: parsed.trashPath,
        sourcePath: parsed.sourcePath,
        deletedAt: parsed.deletedAt,
        kind: parsed.kind as CreatableResourceKind,
        id: parsed.id,
        key: parsed.key,
        label: parsed.label,
      };
    } catch {
      return null;
    }
  }));
  return entries
    .filter((entry): entry is StudioTrashEntry => entry !== null)
    .sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
}

export async function restoreStudioTrashEntry(
  gameDir: string,
  trashPath: string,
  reload: () => Promise<Game>,
): Promise<{ game: Game; resource: ProjectResourceNode; entry: StudioTrashEntry }> {
  const entry = (await readStudioTrash(gameDir)).find((candidate) => candidate.trashPath === trashPath);
  if (!entry) throw new ResourceDeleteError(`Studio Trash entry not found: ${trashPath}`, 404);
  const trashAbsolute = safeProjectPath(gameDir, entry.trashPath);
  const sourceAbsolute = safeProjectPath(gameDir, entry.sourcePath);
  try {
    await access(sourceAbsolute);
    throw new ResourceDeleteError(`${entry.sourcePath} already exists`, 409);
  } catch (error) {
    if (error instanceof ResourceDeleteError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(path.dirname(sourceAbsolute), { recursive: true });
  await rename(trashAbsolute, sourceAbsolute);
  try {
    const game = await reload();
    const resource = buildProjectResourceGraph(game).resources.find(
      (candidate) => candidate.kind === entry.kind && candidate.id === entry.id,
    );
    if (!resource) throw new Error(`restored resource did not load: ${entry.key}`);
    await unlink(`${trashAbsolute}.studio.json`);
    return { game, resource, entry };
  } catch (error) {
    await mkdir(path.dirname(trashAbsolute), { recursive: true });
    try {
      await rename(sourceAbsolute, trashAbsolute);
    } catch (rollbackError) {
      throw new Error(
        `${(error as Error).message}\nRollback failed: ${(rollbackError as Error).message}`,
      );
    }
    throw error;
  }
}

async function createTrashBatch(gameDir: string, timestamp: string): Promise<string> {
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
  throw new ResourceDeleteError("could not allocate a unique Studio Trash entry");
}

async function collectTrashSidecars(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTrashSidecars(absolute);
    return entry.isFile() && entry.name.endsWith(".studio.json") ? [absolute] : [];
  }));
  return nested.flat();
}

function safeProjectPath(gameDir: string, relative: string): string {
  const root = path.resolve(gameDir);
  const absolute = path.resolve(root, relative);
  const rel = path.relative(root, absolute);
  if (!relative || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ResourceDeleteError(`resource source escapes the game directory: ${relative}`);
  }
  return absolute;
}
