import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import type {
  Game,
  MapDef,
  MapLayoutDef,
  MapPlacementDef,
} from "@rpg-harness/engine";
import { parseMap, validateGame } from "@rpg-harness/parser";

export interface MapSpatialPatch {
  layout: MapLayoutDef | null;
  placements: MapPlacementDef[];
}

export function serializeSpatialMapPatch(
  original: string,
  patch: MapSpatialPatch,
  source?: string,
): { content: string; map: MapDef } {
  const doc = parseDocument(original);
  if (doc.errors.length > 0) {
    throw new Error(
      `${source ?? "map"}: existing YAML has parse errors — ${doc.errors[0]!.message}`,
    );
  }

  if (patch.layout === null) doc.delete("layout");
  else doc.set("layout", encodeLayout(patch.layout));
  if (patch.placements.length === 0) doc.delete("placements");
  else doc.set("placements", patch.placements.map(encodePlacement));

  const content = doc.toString();
  return { content, map: parseMap(content, source) };
}

export async function updateMapSpatial(
  absPath: string,
  game: Game,
  mapId: string,
  patch: MapSpatialPatch,
): Promise<MapDef> {
  const original = await readFile(absPath, "utf-8");
  const next = serializeSpatialMapPatch(original, patch, absPath);
  if (next.map.id !== mapId) {
    throw new Error(`map id changed from ${mapId} to ${next.map.id}`);
  }
  validateGame({
    ...game,
    maps: (game.maps ?? []).map((map) => map.id === mapId ? next.map : map),
  });
  if (next.content === original) return next.map;

  const temporary = absPath + ".studio.tmp";
  await writeFile(temporary, next.content);
  await rename(temporary, absPath).catch(async (error) => {
    await unlink(temporary).catch(() => {});
    throw error;
  });
  return next.map;
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
