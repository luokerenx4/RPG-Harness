import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  Game,
  ProjectResourceKind,
  ProjectResourceNode,
} from "@rpg-harness/engine";
import { buildProjectResourceGraph } from "@rpg-harness/engine";

export interface ResourceSource {
  path: string;
  source: string;
}

export async function readResourceSource(
  gameDir: string,
  game: Game,
  kind: ProjectResourceKind,
  id: string,
): Promise<ResourceSource> {
  const node = findNode(game, kind, id);
  const relative = await resolveResourceSourcePath(gameDir, node);
  return { path: relative, source: await readFile(safeAbsolute(gameDir, relative), "utf-8") };
}

export async function updateResourceSource(
  gameDir: string,
  game: Game,
  kind: ProjectResourceKind,
  id: string,
  source: string,
  reload: () => Promise<Game>,
): Promise<{ path: string; game: Game }> {
  const node = findNode(game, kind, id);
  const relative = await resolveResourceSourcePath(gameDir, node);
  const absolute = safeAbsolute(gameDir, relative);
  const original = await readFile(absolute, "utf-8");
  if (source === original) return { path: relative, game };

  const temporary = `${absolute}.studio.tmp`;
  await writeFile(temporary, source, "utf-8");
  await rename(temporary, absolute).catch(async (error) => {
    await unlink(temporary).catch(() => {});
    throw error;
  });

  try {
    const updated = await reload();
    findNode(updated, kind, id);
    return { path: relative, game: updated };
  } catch (error) {
    const rollback = `${absolute}.studio.rollback.tmp`;
    await writeFile(rollback, original, "utf-8");
    await rename(rollback, absolute).catch(async (rollbackError) => {
      await unlink(rollback).catch(() => {});
      throw new Error(
        `${(error as Error).message}\nRollback failed: ${(rollbackError as Error).message}`,
      );
    });
    throw error;
  }
}

function findNode(
  game: Game,
  kind: ProjectResourceKind,
  id: string,
): ProjectResourceNode {
  const node = buildProjectResourceGraph(game).resources.find(
    (candidate) => candidate.kind === kind && candidate.id === id,
  );
  if (!node) throw new Error(`project resource not found: ${kind}:${id}`);
  if (!node.source) throw new Error(`project resource has no editable source: ${kind}:${id}`);
  return node;
}

async function resolveResourceSourcePath(
  gameDir: string,
  node: ProjectResourceNode,
): Promise<string> {
  const source = node.source;
  if (!source) throw new Error(`project resource has no editable source: ${node.key}`);
  const candidates = [source];
  if (node.kind === "map" || node.kind === "action") {
    const base = source.replace(/\.yaml$/, "");
    candidates.push(`${base}.yml`);
  }
  for (const candidate of candidates) {
    try {
      const absolute = safeAbsolute(gameDir, candidate);
      await readFile(absolute, "utf-8");
      return path.relative(path.resolve(gameDir), absolute).split(path.sep).join("/");
    } catch {
      continue;
    }
  }
  throw new Error(`source file not found for ${node.key}`);
}

function safeAbsolute(gameDir: string, relative: string): string {
  const absolute = path.resolve(gameDir, relative);
  const rel = path.relative(path.resolve(gameDir), absolute);
  if (!relative || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`resource source escapes the game directory: ${relative}`);
  }
  return absolute;
}
