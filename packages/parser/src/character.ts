import type { CharacterDef, CharacterStatDef } from "@rpg-harness/engine";
import { extractCustom, splitFrontmatter } from "./frontmatter";

export class CharacterParseError extends Error {}

const KNOWN_KEYS = [
  "id",
  "name",
  "defaultAffection",
  "stats",
  "portraits",
  "defaultPortrait",
  "map_sprite",
] as const;

export function parseCharacter(content: string): CharacterDef {
  const { meta } = splitFrontmatter(content);
  if (typeof meta.id !== "string" || meta.id.length === 0) {
    throw new CharacterParseError("Character missing `id`");
  }
  if (typeof meta.name !== "string" || meta.name.length === 0) {
    throw new CharacterParseError(`Character ${meta.id} missing \`name\``);
  }
  const def: CharacterDef = { id: meta.id, name: meta.name };

  const stats: Record<string, CharacterStatDef> = {};
  // Legacy shorthand: `defaultAffection: N` is sugar for
  // `stats: { affection: { initial: N } }`. Author-facing pre-Phase-3
  // character files keep working.
  if (typeof meta.defaultAffection === "number") {
    stats.affection = { initial: meta.defaultAffection };
  }
  if (meta.stats && typeof meta.stats === "object" && !Array.isArray(meta.stats)) {
    for (const [name, raw] of Object.entries(
      meta.stats as Record<string, unknown>,
    )) {
      stats[name] = parseStat(meta.id, name, raw);
    }
  }
  if (Object.keys(stats).length > 0) def.stats = stats;

  if (meta.portraits !== undefined) {
    def.portraits = parsePortraits(meta.id, meta.portraits);
  }
  if (meta.defaultPortrait !== undefined) {
    if (typeof meta.defaultPortrait !== "string" || meta.defaultPortrait.length === 0) {
      throw new CharacterParseError(
        `Character ${meta.id}.defaultPortrait must be a non-empty string`,
      );
    }
    def.defaultPortrait = meta.defaultPortrait;
  }
  if (meta.map_sprite !== undefined) {
    if (typeof meta.map_sprite !== "string" || meta.map_sprite.length === 0) {
      throw new CharacterParseError(
        `Character ${meta.id}.map_sprite must be a non-empty asset path string`,
      );
    }
    def.mapSprite = meta.map_sprite;
  }

  const custom = extractCustom(meta, KNOWN_KEYS);
  if (custom) def.custom = custom;
  return def;
}

function parsePortraits(
  charId: string,
  raw: unknown,
): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CharacterParseError(
      `Character ${charId}.portraits must be an object map`,
    );
  }
  const out: Record<string, string> = {};
  for (const [emotion, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val !== "string" || val.length === 0) {
      throw new CharacterParseError(
        `Character ${charId}.portraits.${emotion} must be a non-empty asset path string`,
      );
    }
    out[emotion] = val;
  }
  return out;
}

function parseStat(
  charId: string,
  statName: string,
  raw: unknown,
): CharacterStatDef {
  // Shorthand: `affection: 2` → { initial: 2 }
  if (typeof raw === "number") return { initial: raw };
  if (!raw || typeof raw !== "object") {
    throw new CharacterParseError(
      `Character ${charId}.stats.${statName} must be a number or object`,
    );
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.initial !== "number") {
    throw new CharacterParseError(
      `Character ${charId}.stats.${statName}.initial must be a number`,
    );
  }
  const def: CharacterStatDef = { initial: obj.initial };
  if (typeof obj.min === "number") def.min = obj.min;
  if (typeof obj.max === "number") def.max = obj.max;
  if (typeof obj.label === "string") def.label = obj.label;
  if (typeof obj.description === "string") def.description = obj.description;
  return def;
}
