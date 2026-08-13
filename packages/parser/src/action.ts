import { parse as parseYaml } from "yaml";
import type { Action, StateDelta } from "@rpg-harness/engine";
import { parseCondition } from "./condition";
import { desugarAffectionMap, mergeCharacterStats } from "./script";

export class ActionParseError extends Error {}

export function parseAction(content: string, source?: string): Action {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (err) {
    throw new ActionParseError(
      `${source ?? "action"}: invalid YAML — ${(err as Error).message}`,
    );
  }
  if (!raw || typeof raw !== "object") {
    throw new ActionParseError(`${source ?? "action"}: must be a YAML object`);
  }
  return parseActionSpec(raw as Record<string, unknown>, source);
}

// Parse an Action from an already-decoded YAML object. Lets parsers
// that read actions as inline children of another structure (e.g. a
// MapDef's `actions:` array) reuse the same shape rules and error
// messages as standalone `actions/<id>.yaml` files.
export function parseActionSpec(
  obj: Record<string, unknown>,
  source?: string,
): Action {
  if (typeof obj.id !== "string" || obj.id.length === 0) {
    throw new ActionParseError(`${source ?? "action"}: missing \`id\``);
  }
  if (typeof obj.title !== "string" || obj.title.length === 0) {
    throw new ActionParseError(`${source ?? "action"}: missing \`title\``);
  }
  const action: Action = {
    id: obj.id,
    title: obj.title,
    cost: typeof obj.cost === "number" ? obj.cost : 1,
  };
  if (typeof obj.description === "string") {
    action.description = obj.description;
  }
  if (typeof obj.category === "string") {
    action.category = obj.category;
  }
  const rawAiTags = obj.aiTags ?? obj.ai_tags;
  if (rawAiTags !== undefined) {
    if (!Array.isArray(rawAiTags) || rawAiTags.length === 0) {
      throw new ActionParseError(
        `${source ?? action.id}: \`ai_tags\` must be a non-empty array of stable tag strings`,
      );
    }
    const tags = rawAiTags.map((tag, index) => {
      if (
        typeof tag !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(tag)
      ) {
        throw new ActionParseError(
          `${source ?? action.id}: \`ai_tags[${index}]\` must be a non-empty stable tag`,
        );
      }
      return tag;
    });
    if (new Set(tags).size !== tags.length) {
      throw new ActionParseError(
        `${source ?? action.id}: \`ai_tags\` must not contain duplicates`,
      );
    }
    action.aiTags = tags;
  }
  if (obj.slot === "any" || obj.slot === "day" || obj.slot === "night") {
    action.slot = obj.slot;
  }
  if (typeof obj.kind === "string" && obj.kind.length > 0) {
    action.kind = obj.kind as Action["kind"];
  }
  if (typeof obj.itemId === "string") {
    action.itemId = obj.itemId;
  }
  if (typeof obj.enemyId === "string") {
    action.enemyId = obj.enemyId;
  }
  if (typeof obj.skillId === "string") {
    action.skillId = obj.skillId;
  }
  if (typeof obj.mapId === "string") {
    action.mapId = obj.mapId;
  }
  if (Array.isArray(obj.whenIn)) {
    const ids = obj.whenIn.filter((v): v is string => typeof v === "string");
    if (ids.length !== obj.whenIn.length) {
      throw new ActionParseError(
        `${source ?? action.id}: \`whenIn\` must be an array of map id strings`,
      );
    }
    if (ids.length > 0) action.whenIn = ids;
  }
  if (action.kind === "useItem" && !action.itemId) {
    throw new ActionParseError(
      `${source ?? action.id}: kind=useItem requires an \`itemId\` field`,
    );
  }
  if (action.kind === "useSkill" && !action.skillId) {
    throw new ActionParseError(
      `${source ?? action.id}: kind=useSkill requires a \`skillId\` field`,
    );
  }
  const requires = parseCondition(obj.requires);
  if (requires) action.requires = requires;
  const effects = parseEffectsObject(obj.effects, source);
  if (effects) action.effects = effects;
  if (Array.isArray(obj.narrations)) {
    const lines = obj.narrations.filter(
      (v): v is string => typeof v === "string",
    );
    if (lines.length !== obj.narrations.length) {
      throw new ActionParseError(
        `${source ?? action.id}: \`narrations\` must be an array of strings`,
      );
    }
    if (lines.length > 0) action.narrations = lines;
  }
  return action;
}

function parseEffectsObject(
  raw: unknown,
  source: string | undefined,
): StateDelta | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") {
    throw new ActionParseError(
      `${source ?? "action"}: effects must be an object`,
    );
  }
  const obj = raw as Record<string, unknown>;
  const delta: StateDelta = {};
  if (obj.affection !== undefined) {
    if (typeof obj.affection !== "object" || obj.affection === null) {
      throw new ActionParseError(
        `${source ?? "action"}: effects.affection must be an object`,
      );
    }
    delta.characterStats = desugarAffectionMap(
      obj.affection as Record<string, number>,
      delta.characterStats,
    );
  }
  if (obj.characterStats !== undefined) {
    if (
      typeof obj.characterStats !== "object" ||
      obj.characterStats === null
    ) {
      throw new ActionParseError(
        `${source ?? "action"}: effects.characterStats must be an object`,
      );
    }
    delta.characterStats = mergeCharacterStats(
      delta.characterStats,
      obj.characterStats as Record<string, Record<string, number>>,
    );
  }
  if (obj.switches !== undefined) {
    if (typeof obj.switches !== "object" || obj.switches === null) {
      throw new ActionParseError(
        `${source ?? "action"}: effects.switches must be an object`,
      );
    }
    delta.switches = obj.switches as Record<string, boolean>;
  }
  if (obj.variables !== undefined) {
    if (typeof obj.variables !== "object" || obj.variables === null) {
      throw new ActionParseError(
        `${source ?? "action"}: effects.variables must be an object`,
      );
    }
    delta.variables = obj.variables as Record<string, number | string>;
  }
  if (obj.stats !== undefined) {
    if (typeof obj.stats !== "object" || obj.stats === null) {
      throw new ActionParseError(
        `${source ?? "action"}: effects.stats must be an object`,
      );
    }
    delta.stats = obj.stats as Record<string, number>;
  }
  if (obj.statMax !== undefined) {
    if (typeof obj.statMax !== "object" || obj.statMax === null) {
      throw new ActionParseError(
        `${source ?? "action"}: effects.statMax must be an object`,
      );
    }
    delta.statMax = obj.statMax as Record<string, number>;
  }
  if (obj.inventory !== undefined) {
    if (typeof obj.inventory !== "object" || obj.inventory === null) {
      throw new ActionParseError(
        `${source ?? "action"}: effects.inventory must be an object`,
      );
    }
    delta.inventory = obj.inventory as Record<string, number>;
  }
  if (obj.weapons !== undefined) {
    if (typeof obj.weapons !== "object" || obj.weapons === null) {
      throw new ActionParseError(
        `${source ?? "action"}: effects.weapons must be an object`,
      );
    }
    delta.weapons = obj.weapons as Record<string, { power?: number }>;
  }
  if (obj.skills !== undefined) {
    if (typeof obj.skills !== "object" || obj.skills === null) {
      throw new ActionParseError(
        `${source ?? "action"}: effects.skills must be an object`,
      );
    }
    delta.skills = obj.skills as { learn?: string[]; forget?: string[] };
  }
  return delta;
}
