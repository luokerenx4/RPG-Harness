import { parse as parseYaml } from "yaml";
import type {
  Action,
  CharacterSpawnRule,
  Condition,
  MapArrivalDef,
  MapConnection,
  MapDef,
  MapEventTrigger,
  MapLayerDef,
  MapLayoutDef,
  MapPlacementDef,
  MapPlacementEventDef,
  MapRegionDef,
  ProjectResourceKind,
  ProjectResourceRef,
} from "@rpg-harness/engine";
import { parseActionSpec } from "./action";
import { parseCondition } from "./condition";

export class MapParseError extends Error {}

const KNOWN_KEYS = [
  "id",
  "name",
  "description",
  "difficulty",
  "bg",
  "layout",
  "placements",
  "actions",
  "connections",
  "on_enter",
  "is_extract",
  "is_entry",
  "encounter_table",
  "loot_table",
  "character_spawns",
  "chain",
] as const;

// Parse a `maps/<id>.yaml` file into an engine-level MapDef. Maps are
// A map is always an event/resource container. `layout` and `placements`
// optionally add canonical two-dimensional authoring data; Headless and Hub
// consumers can still collapse the map to its available semantic operations.
// snake_case in YAML normalizes to camelCase on the engine side.
export function parseMap(content: string, source?: string): MapDef {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (err) {
    throw new MapParseError(
      `${source ?? "map"}: invalid YAML — ${(err as Error).message}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MapParseError(`${source ?? "map"}: must be a YAML object`);
  }
  const obj = raw as Record<string, unknown>;

  const id = readString(obj, "id", source);
  const name = readString(obj, "name", source ?? id);
  const description =
    typeof obj.description === "string" ? obj.description : "";
  // Omitted difficulty reads as 1 — covers "this map doesn't care about
  // difficulty" without forcing every flat map to declare a value.
  const difficulty =
    typeof obj.difficulty === "number" ? obj.difficulty : 1;

  const def: MapDef = { id, name, description, difficulty };

  if (typeof obj.bg === "string" && obj.bg.length > 0) def.bg = obj.bg;
  if (obj.layout !== undefined) {
    def.layout = parseMapLayout(obj.layout, `${source ?? id}.layout`);
  }
  if (obj.placements !== undefined) {
    def.placements = parseMapPlacements(
      obj.placements,
      `${source ?? id}.placements`,
    );
  }
  if (obj.is_extract === true) def.isExtract = true;
  if (obj.is_entry === true) def.isEntry = true;
  if (typeof obj.chain === "string" && obj.chain.length > 0) {
    def.chain = obj.chain;
  }
  if (typeof obj.on_enter === "string" && obj.on_enter.length > 0) {
    def.onEnter = obj.on_enter;
  }

  if (obj.connections !== undefined) {
    def.connections = parseMapConnections(obj.connections, source ?? id);
  }
  if (obj.actions !== undefined) {
    def.actions = parseMapActions(obj.actions, source ?? id);
  }
  if (obj.encounter_table !== undefined) {
    def.encounterTable = parseEncounterTable(
      obj.encounter_table,
      `${source ?? id}.encounter_table`,
    );
  }
  if (obj.loot_table !== undefined) {
    def.lootTable = parseLootTable(
      obj.loot_table,
      `${source ?? id}.loot_table`,
    );
  }

  const spawnsRaw = obj.character_spawns;
  if (spawnsRaw !== undefined) {
    if (!Array.isArray(spawnsRaw)) {
      throw new MapParseError(
        `${source ?? id}: \`character_spawns\` must be an array`,
      );
    }
    const characterSpawns = spawnsRaw.map((s, i) =>
      parseSpawn(s, source ?? id, i),
    );
    if (characterSpawns.length > 0) def.characterSpawns = characterSpawns;
  }

  const custom = extractCustom(obj, KNOWN_KEYS);
  if (custom) def.custom = custom;
  return def;
}

const RESOURCE_KINDS = new Set<ProjectResourceKind>([
  "character",
  "item",
  "enemy",
  "weapon",
  "skill",
  "map",
  "script",
  "action",
  "asset",
  "module",
  "custom",
]);

const BUILTIN_TRIGGERS = new Set<MapEventTrigger>([
  "autorun",
  "parallel",
  "interact",
  "player_touch",
  "event_touch",
  "map_enter",
  "manual",
]);

function parseMapLayout(raw: unknown, source: string): MapLayoutDef {
  const obj = readObject(raw, source);
  const width = readPositiveInt(obj.width, `${source}.width`);
  const height = readPositiveInt(obj.height, `${source}.height`);
  const tileWidth = obj.tile_width === undefined
    ? 32
    : readPositiveInt(obj.tile_width, `${source}.tile_width`);
  const tileHeight = obj.tile_height === undefined
    ? 32
    : readPositiveInt(obj.tile_height, `${source}.tile_height`);

  const layers = obj.layers === undefined
    ? []
    : parseMapLayers(obj.layers, source, width, height);
  const regions = obj.regions === undefined
    ? []
    : parseMapRegions(obj.regions, source, width, height);

  const def: MapLayoutDef = {
    width,
    height,
    tileWidth,
    tileHeight,
    layers,
    regions,
  };
  if (obj.player_start !== undefined) {
    def.playerStart = readPair(obj.player_start, `${source}.player_start`, false);
    if (def.playerStart.x >= width || def.playerStart.y >= height) {
      throw new MapParseError(
        `${source}.player_start must fit inside ${width}x${height} layout`,
      );
    }
  }
  if (typeof obj.tileset === "string" && obj.tileset.length > 0) {
    def.tileset = obj.tileset;
  }
  return def;
}

function parseMapLayers(
  raw: unknown,
  source: string,
  width: number,
  height: number,
): MapLayerDef[] {
  if (!Array.isArray(raw)) {
    throw new MapParseError(`${source}.layers must be an array`);
  }
  const layers = raw.map((entry, index) => {
    const where = `${source}.layers[${index}]`;
    const obj = readObject(entry, where);
    const id = readString(obj, "id", where);
    const kind = obj.kind;
    if (
      kind !== "tile" && kind !== "image" && kind !== "object" &&
      kind !== "collision" && kind !== "region"
    ) {
      throw new MapParseError(
        `${where}.kind must be tile, image, object, collision, or region`,
      );
    }
    const layer: MapLayerDef = {
      id,
      kind,
      z: obj.z === undefined ? index : readFiniteNumber(obj.z, `${where}.z`),
      visible: obj.visible !== false,
    };
    if (typeof obj.name === "string") layer.name = obj.name;
    if (typeof obj.asset === "string" && obj.asset.length > 0) {
      layer.asset = obj.asset;
    }
    if (obj.tiles !== undefined) {
      layer.tiles = parseTileMatrix(obj.tiles, `${where}.tiles`, width, height);
    }
    const custom = extractCustom(obj, [
      "id", "name", "kind", "z", "visible", "asset", "tiles",
    ]);
    if (custom) layer.custom = custom;
    return layer;
  });
  assertUniqueIds(layers, `${source}.layers`);
  return layers;
}

function parseTileMatrix(
  raw: unknown,
  source: string,
  width: number,
  height: number,
): number[][] {
  if (!Array.isArray(raw)) {
    throw new MapParseError(`${source} must be an array of tile rows`);
  }
  if (raw.length === 0) return [];
  if (raw.length !== height) {
    throw new MapParseError(`${source} must contain exactly ${height} rows`);
  }
  return raw.map((row, y) => {
    if (!Array.isArray(row) || row.length !== width) {
      throw new MapParseError(`${source}[${y}] must contain exactly ${width} tiles`);
    }
    return row.map((tile, x) => {
      if (!Number.isInteger(tile)) {
        throw new MapParseError(`${source}[${y}][${x}] must be an integer tile id`);
      }
      return tile as number;
    });
  });
}

function parseMapRegions(
  raw: unknown,
  source: string,
  mapWidth: number,
  mapHeight: number,
): MapRegionDef[] {
  if (!Array.isArray(raw)) {
    throw new MapParseError(`${source}.regions must be an array`);
  }
  const regions = raw.map((entry, index) => {
    const where = `${source}.regions[${index}]`;
    const obj = readObject(entry, where);
    const region: MapRegionDef = {
      id: readString(obj, "id", where),
      x: readNonNegativeInt(obj.x, `${where}.x`),
      y: readNonNegativeInt(obj.y, `${where}.y`),
      width: readPositiveInt(obj.width, `${where}.width`),
      height: readPositiveInt(obj.height, `${where}.height`),
    };
    if (region.x + region.width > mapWidth || region.y + region.height > mapHeight) {
      throw new MapParseError(`${where} must fit inside ${mapWidth}x${mapHeight} layout`);
    }
    if (typeof obj.name === "string") region.name = obj.name;
    const custom = extractCustom(obj, ["id", "name", "x", "y", "width", "height"]);
    if (custom) region.custom = custom;
    return region;
  });
  assertUniqueIds(regions, `${source}.regions`);
  return regions;
}

function parseMapPlacements(raw: unknown, source: string): MapPlacementDef[] {
  if (!Array.isArray(raw)) {
    throw new MapParseError(`${source} must be an array`);
  }
  const placements = raw.map((entry, index) => {
    const where = `${source}[${index}]`;
    const obj = readObject(entry, where);
    const at = readPair(obj.at, `${where}.at`, false);
    const footprint = obj.footprint === undefined
      ? { x: 1, y: 1 }
      : readPair(obj.footprint, `${where}.footprint`, true);
    const collision = obj.collision ?? "none";
    if (collision !== "none" && collision !== "block" && collision !== "trigger") {
      throw new MapParseError(`${where}.collision must be none, block, or trigger`);
    }
    const placement: MapPlacementDef = {
      id: readString(obj, "id", where),
      at: { x: at.x, y: at.y },
      z: obj.z === undefined ? 0 : readFiniteNumber(obj.z, `${where}.z`),
      footprint: { width: footprint.x, height: footprint.y },
      collision,
      visible: obj.visible !== false,
      events: obj.events === undefined ? [] : parsePlacementEvents(obj.events, `${where}.events`),
    };
    if (obj.resource !== undefined) {
      placement.resource = parseResourceRef(obj.resource, `${where}.resource`);
    }
    if (typeof obj.asset === "string" && obj.asset.length > 0) {
      placement.asset = obj.asset;
    } else if (obj.asset !== undefined) {
      throw new MapParseError(`${where}.asset must be a non-empty asset path string`);
    }
    if (typeof obj.layer === "string" && obj.layer.length > 0) {
      placement.layer = obj.layer;
    }
    if (
      obj.facing === "north" || obj.facing === "east" ||
      obj.facing === "south" || obj.facing === "west"
    ) {
      placement.facing = obj.facing;
    } else if (obj.facing !== undefined) {
      throw new MapParseError(`${where}.facing must be north, east, south, or west`);
    }
    const requires = parseCondition(obj.requires);
    if (requires) placement.requires = requires;
    const custom = extractCustom(obj, [
      "id", "at", "resource", "asset", "layer", "z", "facing", "footprint",
      "collision", "visible", "requires", "events",
    ]);
    if (custom) placement.custom = custom;
    if (!placement.resource && placement.events.length === 0) {
      throw new MapParseError(`${where} must declare a resource or at least one event`);
    }
    return placement;
  });
  assertUniqueIds(placements, source);
  return placements;
}

function parsePlacementEvents(raw: unknown, source: string): MapPlacementEventDef[] {
  if (!Array.isArray(raw)) {
    throw new MapParseError(`${source} must be an array`);
  }
  const events = raw.map((entry, index) => {
    const where = `${source}[${index}]`;
    const obj = readObject(entry, where);
    const trigger = obj.trigger;
    if (
      typeof trigger !== "string" ||
      (!BUILTIN_TRIGGERS.has(trigger as MapEventTrigger) &&
        !/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/.test(trigger))
    ) {
      throw new MapParseError(
        `${where}.trigger must be a built-in trigger or namespaced module trigger`,
      );
    }
    const event: MapPlacementEventDef = {
      id: readString(obj, "id", where),
      trigger: trigger as MapEventTrigger,
      order: obj.order === undefined ? index : readFiniteNumber(obj.order, `${where}.order`),
    };
    if (typeof obj.label === "string") event.label = obj.label;
    if (obj.run !== undefined) event.run = parseResourceRef(obj.run, `${where}.run`);
    if (obj.arrival !== undefined) {
      event.arrival = parseMapArrival(obj.arrival, `${where}.arrival`);
    }
    if (obj.chance !== undefined) {
      if (typeof obj.chance !== "number" || obj.chance < 0 || obj.chance > 1) {
        throw new MapParseError(`${where}.chance must be a number in [0,1]`);
      }
      event.chance = obj.chance;
    }
    const requires = parseCondition(obj.requires);
    if (requires) event.requires = requires;
    if (typeof obj.locked_hint === "string") event.lockedHint = obj.locked_hint;
    const custom = extractCustom(obj, [
      "id", "trigger", "label", "run", "arrival", "chance", "requires", "locked_hint", "order",
    ]);
    if (custom) event.custom = custom;
    return event;
  });
  assertUniqueIds(events, source);
  return events;
}

function parseResourceRef(raw: unknown, source: string): ProjectResourceRef {
  const obj = readObject(raw, source);
  const kind = readString(obj, "kind", source) as ProjectResourceKind;
  if (!RESOURCE_KINDS.has(kind)) {
    throw new MapParseError(`${source}.kind is not a standard project resource kind`);
  }
  return { kind, id: readString(obj, "id", source) };
}

function parseMapArrival(raw: unknown, source: string): MapArrivalDef {
  const obj = readObject(raw, source);
  const unknown = Object.keys(obj).filter((key) => key !== "placement" && key !== "at");
  if (unknown.length > 0) {
    throw new MapParseError(`${source} contains unknown field "${unknown[0]}"`);
  }
  const hasPlacement = obj.placement !== undefined;
  const hasPoint = obj.at !== undefined;
  if (hasPlacement === hasPoint) {
    throw new MapParseError(`${source} must declare exactly one of placement or at`);
  }
  if (hasPlacement) {
    if (typeof obj.placement !== "string" || obj.placement.length === 0) {
      throw new MapParseError(`${source}.placement must be a non-empty string`);
    }
    return { placementId: obj.placement };
  }
  return { at: readPair(obj.at, `${source}.at`, false) };
}

function readPair(
  raw: unknown,
  source: string,
  positive: boolean,
): { x: number; y: number } {
  if (!Array.isArray(raw) || raw.length !== 2) {
    throw new MapParseError(`${source} must be a [x, y] pair`);
  }
  const read = positive ? readPositiveInt : readNonNegativeInt;
  return { x: read(raw[0], `${source}[0]`), y: read(raw[1], `${source}[1]`) };
}

function readObject(raw: unknown, source: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MapParseError(`${source} must be an object`);
  }
  return raw as Record<string, unknown>;
}

function readPositiveInt(raw: unknown, source: string): number {
  if (!Number.isInteger(raw) || (raw as number) <= 0) {
    throw new MapParseError(`${source} must be a positive integer`);
  }
  return raw as number;
}

function readNonNegativeInt(raw: unknown, source: string): number {
  if (!Number.isInteger(raw) || (raw as number) < 0) {
    throw new MapParseError(`${source} must be a non-negative integer`);
  }
  return raw as number;
}

function readFiniteNumber(raw: unknown, source: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new MapParseError(`${source} must be a finite number`);
  }
  return raw;
}

function assertUniqueIds(
  values: ReadonlyArray<{ id: string }>,
  source: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) {
      throw new MapParseError(`${source} contains duplicate id "${value.id}"`);
    }
    seen.add(value.id);
  }
}

function parseMapConnections(
  raw: unknown,
  source: string,
): MapConnection[] {
  if (!Array.isArray(raw)) {
    throw new MapParseError(`${source}.connections must be an array`);
  }
  return raw.map((c, i) => {
    if (!c || typeof c !== "object") {
      throw new MapParseError(`${source}.connections[${i}] must be an object`);
    }
    const co = c as Record<string, unknown>;
    if (typeof co.dir !== "string") {
      throw new MapParseError(
        `${source}.connections[${i}].dir must be a string`,
      );
    }
    if (typeof co.target !== "string") {
      throw new MapParseError(
        `${source}.connections[${i}].target must be a string`,
      );
    }
    const conn: MapConnection = { dir: co.dir, target: co.target };
    if (co.arrival !== undefined) {
      conn.arrival = parseMapArrival(co.arrival, `${source}.connections[${i}].arrival`);
    }
    if (co.requires !== undefined) {
      const requires = parseCondition(co.requires);
      if (requires) conn.requires = requires;
    }
    if (typeof co.locked_hint === "string") {
      conn.lockedHint = co.locked_hint;
    } else if (typeof co.lockedHint === "string") {
      conn.lockedHint = co.lockedHint;
    }
    return conn;
  });
}

function parseMapActions(raw: unknown, source: string): Action[] {
  if (!Array.isArray(raw)) {
    throw new MapParseError(`${source}.actions must be an array`);
  }
  return raw.map((a, i) => {
    if (!a || typeof a !== "object") {
      throw new MapParseError(`${source}.actions[${i}] must be an object`);
    }
    return parseActionSpec(a as Record<string, unknown>, `${source}.actions[${i}]`);
  });
}

function parseEncounterTable(
  raw: unknown,
  source: string,
): { enemyId: string | null; weight: number }[] {
  if (!Array.isArray(raw)) {
    throw new MapParseError(`${source} must be an array`);
  }
  return raw.map((e, ei) => {
    if (!e || typeof e !== "object") {
      throw new MapParseError(`${source}[${ei}] must be an object`);
    }
    const eo = e as Record<string, unknown>;
    const enemyId =
      typeof eo.enemy === "string"
        ? eo.enemy
        : eo.enemy === null
          ? null
          : null;
    const weight = typeof eo.weight === "number" ? eo.weight : 1;
    return { enemyId, weight };
  });
}

function parseLootTable(
  raw: unknown,
  source: string,
): { itemId: string | null; min: number; max: number; weight: number }[] {
  if (!Array.isArray(raw)) {
    throw new MapParseError(`${source} must be an array`);
  }
  return raw.map((l, li) => {
    if (!l || typeof l !== "object") {
      throw new MapParseError(`${source}[${li}] must be an object`);
    }
    const lo = l as Record<string, unknown>;
    const itemId =
      typeof lo.item === "string"
        ? lo.item
        : lo.item === null
          ? null
          : null;
    return {
      itemId,
      min: typeof lo.min === "number" ? lo.min : 0,
      max: typeof lo.max === "number" ? lo.max : 0,
      weight: typeof lo.weight === "number" ? lo.weight : 1,
    };
  });
}

function parseSpawn(
  raw: unknown,
  source: string,
  idx: number,
): CharacterSpawnRule {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MapParseError(
      `${source}: character_spawns[${idx}] must be an object`,
    );
  }
  const obj = raw as Record<string, unknown>;
  const characterId = readString(
    obj,
    "character",
    `${source}.character_spawns[${idx}]`,
  );
  if (typeof obj.chance !== "number" || obj.chance < 0 || obj.chance > 1) {
    throw new MapParseError(
      `${source}.character_spawns[${idx}].chance must be a number in [0,1]`,
    );
  }
  const encounterScriptId = readString(
    obj,
    "encounter_script",
    `${source}.character_spawns[${idx}]`,
  );
  return {
    characterId,
    chance: obj.chance,
    encounterScriptId,
  };
}

function readString(
  obj: Record<string, unknown>,
  key: string,
  source?: string,
): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new MapParseError(
      `${source ?? "map"}: \`${key}\` must be a non-empty string`,
    );
  }
  return v;
}

function extractCustom(
  meta: Record<string, unknown>,
  knownKeys: readonly string[],
): Record<string, unknown> | undefined {
  const skip = new Set(knownKeys);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!skip.has(k)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
