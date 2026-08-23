import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isMap, isNode, isScalar, isSeq, parseDocument, stringify } from "yaml";
import type {
  Game,
  MapArrivalDef,
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

export interface MapTopologyPatch {
  chain: string | null;
  isEntry: boolean;
}

export interface MapPlacementRefactorPatch {
  sourceMapId: string;
  targetMapId: string;
  placementId: string;
  newPlacementId: string;
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
    const content = serializeScalarFields(original, doc, [
      ["name", properties.name],
      ["description", properties.description],
      ["difficulty", properties.difficulty],
      ["bg", properties.bg],
      ["is_extract", properties.isExtract],
    ]);
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

/**
 * Append one placement without rebuilding the authored placements sequence.
 *
 * Reciprocal-route creation is additive: existing placement nodes, including
 * their comments, anchors, and flow/block style, are not part of the
 * requested edit. Mutating the existing YAML sequence keeps that source trivia
 * intact while still running the result through the canonical map parser.
 */
export function serializeMapPlacementAppend(
  original: string,
  placement: MapPlacementDef,
  source?: string,
): { content: string; map: MapDef } {
  const doc = parseDocument(original);
  if (doc.errors.length > 0) {
    throw new Error(
      `${source ?? "map"}: existing YAML has parse errors — ${doc.errors[0]!.message}`,
    );
  }
  if (!isMap(doc.contents)) throw new Error("map: existing YAML root must be an object");

  const placements = doc.get("placements", true);
  if (placements === undefined) {
    doc.set("placements", [encodePlacement(placement)]);
  } else {
    if (!isSeq(placements)) throw new Error("map: existing placements must be an array");
    placements.add(encodePlacement(placement));
  }

  const content = doc.toString();
  return { content, map: parseMap(content, source) };
}

export function serializeMapTopologyPatch(
  original: string,
  patch: MapTopologyPatch,
  source?: string,
): { content: string; map: MapDef } {
  const doc = parseDocument(original);
  if (doc.errors.length > 0) {
    throw new Error(
      `${source ?? "map"}: existing YAML has parse errors — ${doc.errors[0]!.message}`,
    );
  }
  const content = serializeScalarFields(original, doc, [
    ["chain", patch.chain],
    ["is_entry", patch.isEntry],
  ]);
  return { content, map: parseMap(content, source) };
}

/**
 * Rewrite one stable placement definition and every contextual arrival that
 * targets it without reserializing unrelated YAML or source comments.
 */
export function serializeMapPlacementRefactor(
  original: string,
  patch: MapPlacementRefactorPatch,
  source?: string,
): { content: string; map: MapDef } {
  const doc = parseDocument(original, { keepSourceTokens: true });
  if (doc.errors.length > 0) {
    throw new Error(
      `${source ?? "map"}: existing YAML has parse errors — ${doc.errors[0]!.message}`,
    );
  }
  if (!isMap(doc.contents)) throw new Error("map: existing YAML root must be an object");
  const root = doc.toJS() as Record<string, unknown>;
  const paths: Array<Array<string | number>> = [];
  const placements = Array.isArray(root.placements) ? root.placements : [];

  if (patch.sourceMapId === patch.targetMapId) {
    for (let index = 0; index < placements.length; index += 1) {
      const placement = objectRecord(placements[index]);
      if (placement?.id === patch.placementId) paths.push(["placements", index, "id"]);
    }
  }

  const connections = Array.isArray(root.connections) ? root.connections : [];
  for (let index = 0; index < connections.length; index += 1) {
    const connection = objectRecord(connections[index]);
    const arrival = objectRecord(connection?.arrival);
    if (
      connection?.target === patch.targetMapId &&
      arrival?.placement === patch.placementId
    ) {
      paths.push(["connections", index, "arrival", "placement"]);
    }
  }

  for (let placementIndex = 0; placementIndex < placements.length; placementIndex += 1) {
    const placement = objectRecord(placements[placementIndex]);
    const placementTarget = mapResourceId(placement?.resource);
    const events = Array.isArray(placement?.events) ? placement.events : [];
    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      const event = objectRecord(events[eventIndex]);
      const target = event?.run === undefined
        ? placementTarget
        : mapResourceId(event.run);
      const arrival = objectRecord(event?.arrival);
      if (target === patch.targetMapId && arrival?.placement === patch.placementId) {
        paths.push([
          "placements",
          placementIndex,
          "events",
          eventIndex,
          "arrival",
          "placement",
        ]);
      }
    }
  }

  if (paths.length === 0) {
    throw new Error(
      `map ${patch.sourceMapId}: no placement definition or arrival reference matched ${patch.targetMapId}/${patch.placementId}`,
    );
  }
  const edits = paths.map((path) => {
    const node = doc.getIn(path, true);
    if (!isScalar(node) || node.value !== patch.placementId || !node.range) {
      throw new Error(`map: cannot locate placement refactor source range: ${path.join(".")}`);
    }
    const raw = original.slice(node.range[0], node.range[1]);
    if (raw.startsWith("|") || raw.startsWith(">")) {
      throw new Error(
        `map: placement refactor does not rewrite block scalar ids: ${path.join(".")}`,
      );
    }
    const replacement = raw.startsWith('"')
      ? JSON.stringify(patch.newPlacementId)
      : raw.startsWith("'")
        ? `'${patch.newPlacementId.replace(/'/g, "''")}'`
        : encodeTopLevelScalar(patch.newPlacementId);
    return { start: node.range[0], end: node.range[1], replacement };
  }).sort((left, right) => right.start - left.start);

  let content = original;
  for (const edit of edits) {
    content = content.slice(0, edit.start) + edit.replacement + content.slice(edit.end);
  }
  return { content, map: parseMap(content, source) };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function mapResourceId(value: unknown): string | undefined {
  const ref = objectRecord(value);
  return ref?.kind === "map" && typeof ref.id === "string" ? ref.id : undefined;
}

type MapScalarFieldValue = string | number | boolean | null | undefined;

function serializeScalarFields(
  original: string,
  doc: ReturnType<typeof parseDocument>,
  values: Array<[string, MapScalarFieldValue]>,
): string {
  if (!isMap(doc.contents)) throw new Error("map: existing YAML root must be an object");
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

/**
 * Acquire every affected map source in a stable order. This lets project-wide
 * topology transactions compose with ordinary one-map authoring saves without
 * deadlocking or allowing an older rollback to erase a later write.
 */
export async function withMapWriteLocks<T>(
  keys: string[],
  operation: () => Promise<T>,
): Promise<T> {
  const ordered = [...new Set(keys)].sort();
  const acquire = (index: number): Promise<T> => {
    const key = ordered[index];
    return key === undefined
      ? operation()
      : withMapWriteLock(key, () => acquire(index + 1));
  };
  return acquire(0);
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
      ...(event.label !== undefined ? { label: event.label } : {}),
      ...(event.run ? { run: event.run } : {}),
      ...(event.arrival ? { arrival: encodeMapArrival(event.arrival) } : {}),
      ...(event.chance !== undefined ? { chance: event.chance } : {}),
      ...(event.requires ? { requires: event.requires } : {}),
      ...(event.lockedHint !== undefined ? { locked_hint: event.lockedHint } : {}),
      order: event.order,
    })),
  };
}

function encodeMapArrival(arrival: MapArrivalDef): Record<string, unknown> {
  if (arrival.placementId !== undefined) return { placement: arrival.placementId };
  if (arrival.at !== undefined) return { at: [arrival.at.x, arrival.at.y] };
  return {};
}
