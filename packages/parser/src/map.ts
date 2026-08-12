import { parse as parseYaml } from "yaml";
import type {
  Action,
  CharacterSpawnRule,
  Condition,
  MapConnection,
  MapDef,
} from "@rpg-harness/engine";
import { parseActionSpec } from "./action";

export class MapParseError extends Error {}

const KNOWN_KEYS = [
  "id",
  "name",
  "description",
  "difficulty",
  "bg",
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
// flat — they declare their own connections / actions / bg / encounter
// tables / on_enter directly. Movement is map-to-map (no coordinate axis
// inside a map). snake_case in YAML normalizes to camelCase on the
// engine side.
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
    if (co.requires !== undefined) {
      conn.requires = co.requires as Condition;
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
