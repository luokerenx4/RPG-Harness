import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isMap, isNode, isScalar, parseDocument, stringify } from "yaml";
import type {
  Game,
  MapDef,
  MapLayoutDef,
  MapPlacementDef,
} from "@rpg-harness/engine";
import { parseMap, validateGame } from "@rpg-harness/parser";

export interface MapPropertiesPatch {
  name?: string;
  description?: string | null;
  difficulty?: number;
  bg?: string | null;
  isExtract?: boolean;
}

export interface MapAuthoringPatch {
  layout?: MapLayoutDef | null;
  placements?: MapPlacementDef[];
  /** Only author-edited keys are present so parser defaults stay implicit. */
  properties?: MapPropertiesPatch;
}

export interface MapAuthoringPatchPreview {
  content: string;
  game: Game;
  map: MapDef;
}

export interface MapAuthoringUpdate {
  map: MapDef;
  game: Game;
}

const mapWriteQueues = new Map<string, Promise<void>>();

export function serializeMapAuthoringPatch(
  original: string,
  patch: MapAuthoringPatch,
  source?: string,
): { content: string; map: MapDef } {
  const doc = parseDocument(original);
  if (doc.errors.length > 0) {
    throw new Error(
      `${source ?? "map"}: existing YAML has parse errors — ${doc.errors[0]!.message}`,
    );
  }

  const properties = patch.properties ?? {};
  if (patch.layout === undefined && patch.placements === undefined) {
    const content = serializeScalarProperties(original, doc, properties);
    return { content, map: parseMap(content, source) };
  }
  if (properties.name !== undefined) doc.set("name", properties.name);
  setOptionalScalar(doc, "description", properties.description);
  if (properties.difficulty !== undefined) doc.set("difficulty", properties.difficulty);
  setOptionalScalar(doc, "bg", properties.bg);
  setOptionalBoolean(doc, "is_extract", properties.isExtract);

  if (patch.layout !== undefined) {
    if (patch.layout === null) doc.delete("layout");
    else doc.set("layout", encodeLayout(patch.layout));
  }
  if (patch.placements !== undefined) {
    if (patch.placements.length === 0) doc.delete("placements");
    else doc.set("placements", patch.placements.map(encodePlacement));
  }

  const content = doc.toString();
  return { content, map: parseMap(content, source) };
}

function serializeScalarProperties(
  original: string,
  doc: ReturnType<typeof parseDocument>,
  properties: MapPropertiesPatch,
): string {
  if (!isMap(doc.contents)) throw new Error("map: existing YAML root must be an object");
  const values: Array<[string, string | number | boolean | null | undefined]> = [
    ["name", properties.name],
    ["description", properties.description],
    ["difficulty", properties.difficulty],
    ["bg", properties.bg],
    ["is_extract", properties.isExtract],
  ];
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  const additions: string[] = [];

  for (const [key, value] of values) {
    if (value === undefined) continue;
    const remove = value === null || value === false;
    const pair = doc.contents.items.find((candidate) =>
      isScalar(candidate.key) && candidate.key.value === key
    );
    if (!pair) {
      if (!remove) additions.push(`${key}: ${encodeTopLevelScalar(value)}`);
      continue;
    }
    const keyRange = isNode(pair.key) ? pair.key.range : undefined;
    const valueRange = isNode(pair.value) ? pair.value.range : undefined;
    if (!keyRange) throw new Error(`map: cannot locate existing ${key} source range`);
    if (remove) {
      edits.push({
        start: original.lastIndexOf("\n", keyRange[0] - 1) + 1,
        end: sourceLineEndAfterNode(original, valueRange?.[1] ?? keyRange[1]),
        replacement: "",
      });
      continue;
    }
    if (!valueRange) throw new Error(`map: cannot locate existing ${key} value range`);
    const raw = original.slice(valueRange[0], valueRange[1]);
    const trailingNewline = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
    const emptyScalar = valueRange[0] === valueRange[1];
    const leadingSpace = emptyScalar && original[valueRange[0] - 1] === ":" ? " " : "";
    const trailingSpace = emptyScalar && original[valueRange[1]] === "#" ? " " : "";
    edits.push({
      start: valueRange[0],
      end: valueRange[1],
      replacement: leadingSpace + encodeTopLevelScalar(value) + trailingSpace + trailingNewline,
    });
  }

  if (additions.length > 0) {
    const insertionPoint = doc.contents.range?.[2] ?? original.length;
    const separator = insertionPoint === 0 || original.slice(0, insertionPoint).endsWith("\n") ? "" : "\n";
    edits.push({
      start: insertionPoint,
      end: insertionPoint,
      replacement: separator + additions.join("\n") + "\n",
    });
  }

  let content = original;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    content = content.slice(0, edit.start) + edit.replacement + content.slice(edit.end);
  }
  return content;
}

function sourceLineEndAfterNode(original: string, nodeEnd: number): number {
  // YAML's third range entry includes comment trivia. For an empty scalar it
  // may even absorb a standalone comment that belongs to the following key,
  // so deletion must stop at the semantic node's own final source line.
  if (nodeEnd > 0 && original[nodeEnd - 1] === "\n") return nodeEnd;
  const newline = original.indexOf("\n", nodeEnd);
  return newline === -1 ? original.length : newline + 1;
}

function encodeTopLevelScalar(value: string | number | boolean): string {
  if (typeof value !== "string") return String(value);
  return value.includes("\n") || value.includes("\r")
    ? JSON.stringify(value)
    : stringify(value).trimEnd();
}

/**
 * Apply and validate a Studio authoring patch entirely in memory.
 *
 * Both draft previews and authoritative saves use this path so the previewed
 * MapDef cannot drift from what Save would parse and validate. This function
 * deliberately performs no filesystem work.
 */
export function previewMapAuthoringPatch(
  original: string,
  game: Game,
  mapId: string,
  patch: MapAuthoringPatch,
  source?: string,
): MapAuthoringPatchPreview {
  const matches = (game.maps ?? []).filter((map) => map.id === mapId);
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `map not found: ${mapId}`
      : `map id is not unique: ${mapId}`);
  }
  validateMapAuthoringProperties(game, patch.properties);
  const next = serializeMapAuthoringPatch(original, patch, source);
  if (next.map.id !== mapId) {
    throw new Error(`map id changed from ${mapId} to ${next.map.id}`);
  }
  const previewGame: Game = {
    ...game,
    maps: (game.maps ?? []).map((map) => map.id === mapId ? next.map : map),
  };
  validateGame(previewGame);
  return { ...next, game: previewGame };
}

function validateMapAuthoringProperties(
  game: Game,
  properties: MapPropertiesPatch | undefined,
): void {
  if (!properties) return;
  if (properties.name !== undefined) {
    if (properties.name.trim().length === 0) throw new Error("map name must not be blank");
    if (properties.name.length > 160) throw new Error("map name must be at most 160 characters");
  }
  if (properties.difficulty !== undefined && !Number.isFinite(properties.difficulty)) {
    throw new Error("map difficulty must be a finite number");
  }
  if (properties.bg !== undefined && properties.bg !== null) {
    const asset = (game.assets ?? []).find((candidate) => candidate.path === properties.bg);
    if (!asset) throw new Error(`map background asset not found: ${properties.bg}`);
    if (asset.kind !== "bg") {
      throw new Error(`map background must reference a bg asset, received ${asset.kind}: ${properties.bg}`);
    }
  }
}

export async function updateMapAuthoring(
  absPath: string,
  game: Game,
  mapId: string,
  patch: MapAuthoringPatch,
  reload: () => Promise<Game>,
): Promise<MapAuthoringUpdate> {
  return withMapWriteLock(absPath, async () => {
    const original = await readFile(absPath, "utf-8");
    const next = previewMapAuthoringPatch(original, game, mapId, patch, absPath);
    if (next.content === original) return { map: next.map, game: next.game };

    const temporary = `${absPath}.studio.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, next.content, "utf-8");
      await rename(temporary, absPath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }

    try {
      const updated = await reload();
      const current = await readFile(absPath, "utf-8");
      if (current !== next.content) {
        throw new Error(`map source changed during authoritative reload: ${mapId}`);
      }
      validateMapAuthoringProperties(updated, patch.properties);
      const matches = (updated.maps ?? []).filter((map) => map.id === mapId);
      if (matches.length !== 1) {
        throw new Error(matches.length === 0
          ? `reloaded map not found: ${mapId}`
          : `reloaded map id is not unique: ${mapId}`);
      }
      if (JSON.stringify(matches[0]) !== JSON.stringify(next.map)) {
        throw new Error(`reloaded map does not match the authored source: ${mapId}`);
      }
      return { map: matches[0]!, game: updated };
    } catch (error) {
      const current = await readFile(absPath, "utf-8").catch(() => undefined);
      if (current !== next.content) {
        throw new Error(
          `${(error as Error).message}\nRollback skipped because the map source changed after this request wrote it.`,
        );
      }
      const rollback = `${absPath}.studio.rollback.${randomUUID()}.tmp`;
      try {
        await writeFile(rollback, original, "utf-8");
        await rename(rollback, absPath);
      } catch (rollbackError) {
        await unlink(rollback).catch(() => {});
        throw new Error(
          `${(error as Error).message}\nRollback failed: ${(rollbackError as Error).message}`,
        );
      }
      throw error;
    }
  });
}

async function withMapWriteLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = mapWriteQueues.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(() => undefined, () => undefined);
  mapWriteQueues.set(key, tail);
  try {
    return await result;
  } finally {
    if (mapWriteQueues.get(key) === tail) mapWriteQueues.delete(key);
  }
}

function setOptionalScalar(
  doc: ReturnType<typeof parseDocument>,
  key: string,
  value: string | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) doc.delete(key);
  else doc.set(key, value);
}

function setOptionalBoolean(
  doc: ReturnType<typeof parseDocument>,
  key: string,
  value: boolean | undefined,
): void {
  if (value === undefined) return;
  if (value) doc.set(key, true);
  else doc.delete(key);
}

function encodeLayout(layout: MapLayoutDef): Record<string, unknown> {
  return {
    width: layout.width,
    height: layout.height,
    tile_width: layout.tileWidth,
    tile_height: layout.tileHeight,
    ...(layout.playerStart ? { player_start: [layout.playerStart.x, layout.playerStart.y] } : {}),
    ...(layout.tileset ? { tileset: layout.tileset } : {}),
    layers: layout.layers.map((layer) => ({
      ...(layer.custom ?? {}),
      id: layer.id,
      ...(layer.name ? { name: layer.name } : {}),
      kind: layer.kind,
      z: layer.z,
      visible: layer.visible,
      ...(layer.asset ? { asset: layer.asset } : {}),
      ...(layer.tiles ? { tiles: layer.tiles } : {}),
    })),
    regions: layout.regions.map((region) => ({
      ...(region.custom ?? {}),
      id: region.id,
      ...(region.name ? { name: region.name } : {}),
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
    })),
  };
}

function encodePlacement(placement: MapPlacementDef): Record<string, unknown> {
  return {
    ...(placement.custom ?? {}),
    id: placement.id,
    at: [placement.at.x, placement.at.y],
    ...(placement.resource ? { resource: placement.resource } : {}),
    ...(placement.asset ? { asset: placement.asset } : {}),
    ...(placement.layer ? { layer: placement.layer } : {}),
    z: placement.z,
    ...(placement.facing ? { facing: placement.facing } : {}),
    footprint: [placement.footprint.width, placement.footprint.height],
    collision: placement.collision,
    visible: placement.visible,
    ...(placement.requires ? { requires: placement.requires } : {}),
    events: placement.events.map((event) => ({
      ...(event.custom ?? {}),
      id: event.id,
      trigger: event.trigger,
      ...(event.label ? { label: event.label } : {}),
      ...(event.run ? { run: event.run } : {}),
      ...(event.chance !== undefined ? { chance: event.chance } : {}),
      ...(event.requires ? { requires: event.requires } : {}),
      ...(event.lockedHint ? { locked_hint: event.lockedHint } : {}),
      order: event.order,
    })),
  };
}
