import { access, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildProjectResourceGraph, type Game, type ProjectResourceNode } from "@rpg-harness/engine";
import { isMap, isScalar, parseDocument } from "yaml";
import { CREATABLE_RESOURCE_KINDS, type CreatableResourceKind } from "./resource-create";
import { readResourceSource } from "./resource-source";

export class ResourceRenameError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface ResourceRenameTarget {
  kind: CreatableResourceKind;
  id: string;
  newId: string;
}

export interface ResourceRenameFilePreview {
  key: string;
  label: string;
  kind: string;
  path: string;
  destinationPath?: string;
  changes: number;
}

export interface ResourceRenameBlocker {
  key: string;
  reason: string;
}

export interface ResourceRenamePlan {
  target: ResourceRenameTarget;
  resource: ProjectResourceNode;
  files: ResourceRenameFilePreview[];
  blockers: ResourceRenameBlocker[];
  totalChanges: number;
}

interface ResourceRenameMutation extends ResourceRenameFilePreview {
  original: string;
  updated: string;
}

interface InternalResourceRenamePlan {
  public: ResourceRenamePlan;
  mutations: ResourceRenameMutation[];
}

export async function planProjectResourceRename(
  gameDir: string,
  game: Game,
  kind: CreatableResourceKind,
  id: string,
  newId: string,
  externalBlockers: string[] = [],
): Promise<ResourceRenamePlan> {
  return (await buildRenamePlan(gameDir, game, kind, id, newId, externalBlockers)).public;
}

export async function renameProjectResource(
  gameDir: string,
  game: Game,
  kind: CreatableResourceKind,
  id: string,
  newId: string,
  reload: () => Promise<Game>,
  externalBlockers: string[] = [],
): Promise<{ game: Game; resource: ProjectResourceNode; plan: ResourceRenamePlan }> {
  const plan = await buildRenamePlan(gameDir, game, kind, id, newId, externalBlockers);
  if (plan.public.blockers.length > 0) {
    throw new ResourceRenameError(
      `rename is blocked by ${plan.public.blockers.map((blocker) => blocker.key).join(", ")}`,
      409,
    );
  }

  let targetMoved = false;
  const targetMutation = plan.mutations.find((mutation) => mutation.key === `${kind}:${id}`);
  try {
    for (const mutation of plan.mutations) {
      await writeAtomic(safeProjectPath(gameDir, mutation.path), mutation.updated);
    }
    if (targetMutation?.destinationPath && targetMutation.destinationPath !== targetMutation.path) {
      const destination = safeProjectPath(gameDir, targetMutation.destinationPath);
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(safeProjectPath(gameDir, targetMutation.path), destination);
      targetMoved = true;
    }

    const updatedGame = await reload();
    const graph = buildProjectResourceGraph(updatedGame);
    const resource = graph.resources.find((candidate) => candidate.kind === kind && candidate.id === newId);
    if (!resource) throw new Error(`renamed resource did not load: ${kind}:${newId}`);
    if (graph.resources.some((candidate) => candidate.kind === kind && candidate.id === id)) {
      throw new Error(`old resource identity still loaded: ${kind}:${id}`);
    }
    return { game: updatedGame, resource, plan: plan.public };
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (targetMoved && targetMutation?.destinationPath) {
      try {
        await rename(
          safeProjectPath(gameDir, targetMutation.destinationPath),
          safeProjectPath(gameDir, targetMutation.path),
        );
      } catch (rollbackError) {
        rollbackErrors.push(`filename: ${(rollbackError as Error).message}`);
      }
    }
    for (const mutation of plan.mutations) {
      try {
        await writeAtomic(safeProjectPath(gameDir, mutation.path), mutation.original);
      } catch (rollbackError) {
        rollbackErrors.push(`${mutation.path}: ${(rollbackError as Error).message}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`${(error as Error).message}\nRollback failed:\n${rollbackErrors.join("\n")}`);
    }
    throw error;
  }
}

async function buildRenamePlan(
  gameDir: string,
  game: Game,
  kind: CreatableResourceKind,
  id: string,
  newId: string,
  externalBlockers: string[],
): Promise<InternalResourceRenamePlan> {
  assertRenameInput(kind, id, newId);
  const graph = buildProjectResourceGraph(game);
  const resource = graph.resources.find((candidate) => candidate.kind === kind && candidate.id === id);
  if (!resource) throw new ResourceRenameError(`project resource not found: ${kind}:${id}`, 404);
  if (graph.resources.some((candidate) => candidate.kind === kind && candidate.id === newId)) {
    throw new ResourceRenameError(`${kind}:${newId} already exists`, 409);
  }

  const backlinkKeys = graph.backlinks[resource.key] ?? [];
  const involvedKeys = [...new Set([resource.key, ...backlinkKeys])];
  const nodes = involvedKeys.map((key) => graph.resources.find((candidate) => candidate.key === key));
  const blockers: ResourceRenameBlocker[] = externalBlockers.map((key) => ({
    key,
    reason: "This project artifact records the old identity and cannot be rewritten automatically.",
  }));
  const mutations: ResourceRenameMutation[] = [];

  for (const node of nodes) {
    if (!node) continue;
    if (node.editable === false || node.kind === "module") {
      blockers.push({
        key: node.key,
        reason: node.kind === "module"
          ? "Module source may use the identity in executable code; update it manually first."
          : "This source is read-only in Studio.",
      });
      continue;
    }
    try {
      const source = await readResourceSource(gameDir, game, node.kind, node.id);
      const transformed = transformResourceSource(
        node.kind,
        source.source,
        { kind, id, newId },
        node.key === resource.key,
      );
      if (node.key !== resource.key && transformed.changes === 0) {
        blockers.push({
          key: node.key,
          reason: "The engine found a semantic reference, but Studio could not prove a safe source rewrite.",
        });
        continue;
      }
      const destinationPath = node.key === resource.key
        ? renamedDefinitionPath(source.path, id, newId)
        : source.path;
      if (destinationPath !== source.path && await fileExists(safeProjectPath(gameDir, destinationPath))) {
        blockers.push({ key: node.key, reason: `${destinationPath} already exists.` });
        continue;
      }
      mutations.push({
        key: node.key,
        label: node.label,
        kind: node.kind,
        path: source.path,
        ...(destinationPath !== source.path ? { destinationPath } : {}),
        changes: transformed.changes,
        original: source.source,
        updated: transformed.source,
      });
    } catch (error) {
      blockers.push({ key: node.key, reason: (error as Error).message });
    }
  }

  blockers.sort((left, right) => left.key.localeCompare(right.key));
  mutations.sort((left, right) => left.key === resource.key ? -1 : right.key === resource.key ? 1 : left.key.localeCompare(right.key));
  const files = mutations.map(({ original: _original, updated: _updated, ...preview }) => preview);
  return {
    public: {
      target: { kind, id, newId },
      resource,
      files,
      blockers,
      totalChanges: files.reduce((total, file) => total + file.changes, 0),
    },
    mutations,
  };
}

export function transformResourceSource(
  sourceKind: string,
  source: string,
  target: ResourceRenameTarget,
  renameDefinition = false,
): { source: string; changes: number } {
  if (["character", "item", "weapon", "skill", "enemy", "script"].includes(sourceKind)) {
    return transformMarkdownSource(sourceKind, source, target, renameDefinition);
  }
  if (["manifest", "map", "action", "asset"].includes(sourceKind)) {
    return transformYamlSource(source, target, renameDefinition);
  }
  throw new ResourceRenameError(`Studio cannot safely rewrite ${sourceKind} source`);
}

function transformMarkdownSource(
  sourceKind: string,
  source: string,
  target: ResourceRenameTarget,
  renameDefinition: boolean,
): { source: string; changes: number } {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!match || match.index !== 0 || match[1] === undefined) {
    throw new ResourceRenameError("Markdown resource has no parseable YAML frontmatter");
  }
  const header = transformYamlSource(match[1], target, renameDefinition);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const bodyStart = match[0].length;
  let body = source.slice(bodyStart);
  let bodyChanges = 0;

  if (sourceKind === "script") {
    body = body.replace(/(^```(?:ya?ml)?\s*\r?\n)([\s\S]*?)(^```\s*$)/gmi, (whole, open: string, yaml: string, close: string) => {
      const transformed = transformYamlSource(yaml.replace(/\r?\n$/, ""), target, false);
      if (transformed.changes === 0) return whole;
      bodyChanges += transformed.changes;
      return `${open}${transformed.source.trimEnd()}${newline}${close}`;
    });
    if (target.kind === "character") {
      const escaped = escapeRegex(target.id);
      body = body.replace(new RegExp(`^(\\s*@)${escaped}(?=\\s|$)`, "gm"), (_whole, prefix: string) => {
        bodyChanges += 1;
        return `${prefix}${target.newId}`;
      });
      body = body.replace(new RegExp(`(^|\\s)([+-]\\d*)${escaped}(?=\\.|\\s|$)`, "gm"), (_whole, boundary: string, effect: string) => {
        bodyChanges += 1;
        return `${boundary}${effect}${target.newId}`;
      });
    }
  }

  const serializedHeader = header.source.trimEnd().replace(/\n/g, newline);
  return {
    source: `---${newline}${serializedHeader}${newline}---${match[2] ?? newline}${body}`,
    changes: header.changes + bodyChanges,
  };
}

function transformYamlSource(
  source: string,
  target: ResourceRenameTarget,
  renameDefinition: boolean,
): { source: string; changes: number } {
  const doc = parseDocument(source, { keepSourceTokens: true });
  if (doc.errors.length > 0) throw new ResourceRenameError(doc.errors[0]?.message ?? "Invalid YAML source");
  const root = doc.toJS() as unknown;
  const edits = collectStructuredEdits(root, target);
  if (renameDefinition) {
    if (!root || typeof root !== "object" || Array.isArray(root) || (root as Record<string, unknown>).id !== target.id) {
      throw new ResourceRenameError(`resource definition does not declare id: ${target.id}`);
    }
    edits.unshift({ type: "value", path: ["id"] });
  }
  const unique = dedupeEdits(edits);
  return {
    source: unique.length > 0 ? applyStructuredEdits(source, doc, unique, target.id, target.newId) : source,
    changes: unique.length,
  };
}

type StructuredEdit =
  | { type: "value"; path: Array<string | number> }
  | { type: "key"; path: Array<string | number>; oldKey: string };

function collectStructuredEdits(root: unknown, target: ResourceRenameTarget): StructuredEdit[] {
  const edits: StructuredEdit[] = [];
  const walk = (value: unknown, currentPath: Array<string | number>) => {
    if (Array.isArray(value)) {
      const parentKey = currentPath.at(-1);
      value.forEach((entry, index) => {
        if (entry === target.id && arrayFieldMatchesTarget(parentKey, target.kind)) {
          edits.push({ type: "value", path: [...currentPath, index] });
        }
        walk(entry, [...currentPath, index]);
      });
      return;
    }
    if (!value || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (obj.kind === target.kind && obj.id === target.id) {
      edits.push({ type: "value", path: [...currentPath, "id"] });
    }
    for (const field of scalarFieldsForTarget(target.kind, currentPath)) {
      if (obj[field] === target.id) edits.push({ type: "value", path: [...currentPath, field] });
    }
    const keyed = keyedFieldsForTarget(target.kind);
    for (const field of keyed) {
      const record = obj[field];
      if (record && typeof record === "object" && !Array.isArray(record) && target.id in record) {
        if (target.newId in (record as Record<string, unknown>)) {
          throw new ResourceRenameError(`${[...currentPath, field].join(".")} already contains ${target.newId}`);
        }
        edits.push({ type: "key", path: [...currentPath, field], oldKey: target.id });
      }
    }
    for (const [key, child] of Object.entries(obj)) walk(child, [...currentPath, key]);
  };
  walk(root, []);
  return edits;
}

function scalarFieldsForTarget(kind: CreatableResourceKind, currentPath: Array<string | number>): string[] {
  if (kind === "character") return ["character", "characterId"];
  if (kind === "item") return ["itemId"];
  if (kind === "enemy") return ["enemyId"];
  if (kind === "weapon") return ["weaponId"];
  if (kind === "skill") return ["skillId", "knowsSkill"];
  if (kind === "script") return ["scriptCompleted", "scriptId", "onEnter", "encounterScriptId"];
  if (kind === "map") return currentPath.includes("connections") ? ["mapId", "target"] : ["mapId"];
  return [];
}

function arrayFieldMatchesTarget(field: string | number | undefined, kind: CreatableResourceKind): boolean {
  if (kind === "character") return field === "characters";
  if (kind === "map") return field === "whenIn";
  if (kind === "skill") return field === "learn" || field === "forget";
  return false;
}

function keyedFieldsForTarget(kind: CreatableResourceKind): string[] {
  if (kind === "character") return ["characterStats", "affection"];
  if (kind === "item") return ["inventory"];
  if (kind === "weapon") return ["weapons"];
  if (kind === "script") return ["selfSwitches"];
  return [];
}

function dedupeEdits(edits: StructuredEdit[]): StructuredEdit[] {
  const seen = new Set<string>();
  return edits.filter((edit) => {
    const key = JSON.stringify(edit);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function applyStructuredEdits(
  source: string,
  doc: ReturnType<typeof parseDocument>,
  edits: StructuredEdit[],
  oldId: string,
  newId: string,
): string {
  const replacements = edits.map((edit) => {
    if (edit.type === "value") {
      const node = doc.getIn(edit.path, true);
      if (!isScalar(node) || node.value !== oldId || !node.range) {
        throw new ResourceRenameError(`could not locate scalar source range: ${edit.path.join(".")}`);
      }
      return sourceReplacement(source, node.range[0], node.range[1], newId);
    }
    const map = doc.getIn(edit.path, true);
    if (!isMap(map)) {
      throw new ResourceRenameError(`could not locate mapping source range: ${edit.path.join(".")}`);
    }
    const pair = map.items.find((item) => isScalar(item.key) && item.key.value === edit.oldKey);
    if (!pair || !isScalar(pair.key) || !pair.key.range) {
      throw new ResourceRenameError(`could not locate mapping key source range: ${[...edit.path, edit.oldKey].join(".")}`);
    }
    return sourceReplacement(source, pair.key.range[0], pair.key.range[1], newId);
  }).sort((left, right) => right.start - left.start);
  let updated = source;
  for (const replacement of replacements) {
    updated = `${updated.slice(0, replacement.start)}${replacement.text}${updated.slice(replacement.end)}`;
  }
  return updated;
}

function sourceReplacement(source: string, start: number, end: number, newId: string) {
  const original = source.slice(start, end);
  const text = original.startsWith('"')
    ? JSON.stringify(newId)
    : original.startsWith("'")
      ? `'${newId}'`
      : newId;
  return { start, end, text };
}

function renamedDefinitionPath(sourcePath: string, oldId: string, newId: string): string {
  const extension = path.posix.extname(sourcePath);
  const basename = path.posix.basename(sourcePath, extension);
  if (basename !== oldId) return sourcePath;
  return path.posix.join(path.posix.dirname(sourcePath), `${newId}${extension}`);
}

function assertRenameInput(
  kind: string,
  id: string,
  newId: string,
): asserts kind is CreatableResourceKind {
  if (!(CREATABLE_RESOURCE_KINDS as readonly string[]).includes(kind)) {
    throw new ResourceRenameError(`unsupported resource kind: ${kind}`);
  }
  if (!id) throw new ResourceRenameError("resource id is required");
  if (id === newId) throw new ResourceRenameError("new id must be different");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(newId)) {
    throw new ResourceRenameError("new id must be 1-80 stable ASCII letters, numbers, dashes, or underscores");
  }
}

async function writeAtomic(absolute: string, source: string): Promise<void> {
  const temporary = `${absolute}.studio.rename.tmp`;
  await writeFile(temporary, source, "utf-8");
  await rename(temporary, absolute).catch(async (error) => {
    await unlink(temporary).catch(() => {});
    throw error;
  });
}

async function fileExists(absolute: string): Promise<boolean> {
  try {
    await access(absolute);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function safeProjectPath(gameDir: string, relative: string): string {
  const root = path.resolve(gameDir);
  const absolute = path.resolve(root, relative);
  const rel = path.relative(root, absolute);
  if (!relative || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ResourceRenameError(`resource source escapes the game directory: ${relative}`);
  }
  return absolute;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
