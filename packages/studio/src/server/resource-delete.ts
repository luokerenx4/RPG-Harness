import { mkdir, rename } from "node:fs/promises";
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
  const timestamp = now().toISOString().replace(/[:.]/g, "-");
  const trashPath = path.posix.join(".studio-trash", timestamp, sourcePath);
  const trashAbsolute = safeProjectPath(gameDir, trashPath);
  await mkdir(path.dirname(trashAbsolute), { recursive: true });
  await rename(sourceAbsolute, trashAbsolute);

  try {
    const updated = await reload();
    const stillPresent = buildProjectResourceGraph(updated).resources.some(
      (candidate) => candidate.kind === kind && candidate.id === id,
    );
    if (stillPresent) throw new Error(`trashed resource still loaded: ${resource.key}`);
    return { game: updated, resource, sourcePath, trashPath };
  } catch (error) {
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

function safeProjectPath(gameDir: string, relative: string): string {
  const root = path.resolve(gameDir);
  const absolute = path.resolve(root, relative);
  const rel = path.relative(root, absolute);
  if (!relative || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ResourceDeleteError(`resource source escapes the game directory: ${relative}`);
  }
  return absolute;
}
