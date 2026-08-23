import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildProjectResourceGraph, type Game, type ProjectResourceNode } from "@rpg-harness/engine";
import {
  assertCreatableResourceInput,
  ResourceCreateError,
  type CreatableResourceKind,
} from "./resource-create";
import {
  replaceResourceDefinitionLabel,
  transformResourceSource,
} from "./resource-rename";
import { readResourceSource } from "./resource-source";

export async function duplicateProjectResource(
  gameDir: string,
  game: Game,
  kind: CreatableResourceKind,
  id: string,
  newId: string,
  label: string,
  reload: () => Promise<Game>,
): Promise<{
  game: Game;
  resource: ProjectResourceNode;
  path: string;
  source: string;
}> {
  assertCreatableResourceInput(kind, newId, label);
  const graph = buildProjectResourceGraph(game);
  const original = graph.resources.find((candidate) => candidate.kind === kind && candidate.id === id);
  if (!original) throw new ResourceCreateError(`project resource not found: ${kind}:${id}`, 404);
  if (graph.resources.some((candidate) => candidate.kind === kind && candidate.id === newId)) {
    throw new ResourceCreateError(`${kind}:${newId} already exists`, 409);
  }

  const current = await readResourceSource(gameDir, game, kind, id);
  const extension = path.posix.extname(current.path);
  const destinationPath = path.posix.join(path.posix.dirname(current.path), `${newId}${extension}`);
  const destination = safeProjectPath(gameDir, destinationPath);
  const withIdentity = transformResourceSource(kind, current.source, { kind, id, newId }, true).source;
  const source = replaceResourceDefinitionLabel(kind, withIdentity, label.trim());
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await writeFile(destination, source, { encoding: "utf-8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ResourceCreateError(`${destinationPath} already exists`, 409);
    }
    throw error;
  }

  try {
    const updatedGame = await reload();
    const resource = buildProjectResourceGraph(updatedGame).resources.find(
      (candidate) => candidate.kind === kind && candidate.id === newId,
    );
    if (!resource) throw new Error(`duplicated resource did not load: ${kind}:${newId}`);
    return {
      game: updatedGame,
      resource,
      path: destinationPath,
      source: await readFile(destination, "utf-8"),
    };
  } catch (error) {
    await unlink(destination).catch(() => {});
    throw error;
  }
}

function safeProjectPath(gameDir: string, relative: string): string {
  const root = path.resolve(gameDir);
  const absolute = path.resolve(root, relative);
  const rel = path.relative(root, absolute);
  if (!relative || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`resource source escapes the game directory: ${relative}`);
  }
  return absolute;
}
