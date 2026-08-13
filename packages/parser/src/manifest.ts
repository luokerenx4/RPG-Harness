import { parse as parseYaml } from "yaml";
import type {
  AiAuditConfig,
  EndConditionSpec,
  StatDef,
  StatThreshold,
  SwitchDef,
  TrainingConfig,
  VariableDef,
} from "@rpg-harness/engine";
import { parseCondition } from "./condition";

export interface Manifest {
  title: string;
  /** Optional deterministic-persona diversity acceptance gate. */
  aiAudit?: AiAuditConfig;
  training?: TrainingConfig;
  // Declared boolean switches. Each entry: { initial, description? }.
  switches?: SwitchDef[];
  // Declared typed variables. Each entry: { type, initial, description? }.
  variables?: VariableDef[];
  // Relative paths (from game dir) of ts modules to load at runtime.
  // The loader dynamically imports each path and registers its default
  // export as a Module on the Game object.
  modules?: string[];
  // Optional preset selector. Built-in: "vn" / "training". Path-based:
  // a relative path the loader resolves via dynamic import (the
  // ejected-preset case from `rpgh init --eject`).
  preset?: string;
  // Default-hide from `bun run play` / `rpgh play` interactive
  // picker. Engine fixtures and test-only games set this true so
  // they don't pollute the candidate list. They're still loadable by
  // explicit path; this only affects discovery.
  hidden?: boolean;
}

export class ManifestParseError extends Error {}

export function parseManifest(content: string): Manifest {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (err) {
    throw new ManifestParseError(
      `Invalid YAML in game manifest: ${(err as Error).message}`,
    );
  }
  if (!raw || typeof raw !== "object") {
    throw new ManifestParseError("Manifest must be a YAML object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.title !== "string" || obj.title.length === 0) {
    throw new ManifestParseError("Manifest missing `title`");
  }
  const manifest: Manifest = { title: obj.title };
  if (obj.ai_audit !== undefined) {
    manifest.aiAudit = parseAiAudit(obj.ai_audit);
  }
  if (obj.training !== undefined) {
    manifest.training = parseTraining(obj.training);
  }
  if (obj.modules !== undefined) {
    if (!Array.isArray(obj.modules) || obj.modules.some((m) => typeof m !== "string")) {
      throw new ManifestParseError("`modules` must be an array of strings");
    }
    manifest.modules = obj.modules as string[];
  }
  if (obj.switches !== undefined) {
    manifest.switches = parseSwitches(obj.switches);
  }
  if (obj.variables !== undefined) {
    manifest.variables = parseVariables(obj.variables);
  }
  if (obj.preset !== undefined) {
    if (typeof obj.preset !== "string") {
      throw new ManifestParseError("`preset` must be a string");
    }
    manifest.preset = obj.preset;
  }
  if (obj.hidden !== undefined) {
    if (typeof obj.hidden !== "boolean") {
      throw new ManifestParseError("`hidden` must be a boolean");
    }
    manifest.hidden = obj.hidden;
  }
  return manifest;
}

function parseAiAudit(raw: unknown): AiAuditConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError("`ai_audit` must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const known = new Set([
    "personas",
    "min_unique_endings",
    "min_unique_decision_paths",
    "required_activity_tags",
  ]);
  const unknown = Object.keys(obj).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new ManifestParseError(
      `ai_audit: unknown field(s): ${unknown.join(", ")}`,
    );
  }
  const config: AiAuditConfig = {};
  if (obj.personas !== undefined) {
    if (
      !Array.isArray(obj.personas) ||
      obj.personas.length === 0 ||
      obj.personas.some((persona) => typeof persona !== "string" || persona.trim().length === 0)
    ) {
      throw new ManifestParseError("ai_audit.personas must be a non-empty array of strings");
    }
    const personas = obj.personas.map((persona) => (persona as string).trim());
    if (new Set(personas).size !== personas.length) {
      throw new ManifestParseError("ai_audit.personas must not contain duplicates");
    }
    config.personas = personas;
  }
  if (obj.required_activity_tags !== undefined) {
    if (
      !Array.isArray(obj.required_activity_tags) ||
      obj.required_activity_tags.length === 0 ||
      obj.required_activity_tags.some((tag) =>
        typeof tag !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(tag)
      )
    ) {
      throw new ManifestParseError(
        "ai_audit.required_activity_tags must be a non-empty array of stable tag strings",
      );
    }
    const tags = obj.required_activity_tags as string[];
    if (new Set(tags).size !== tags.length) {
      throw new ManifestParseError(
        "ai_audit.required_activity_tags must not contain duplicates",
      );
    }
    config.requiredActivityTags = [...tags];
  }
  for (const [source, target] of [
    ["min_unique_endings", "minUniqueEndings"],
    ["min_unique_decision_paths", "minUniqueDecisionPaths"],
  ] as const) {
    const value = obj[source];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || (value as number) < 1) {
      throw new ManifestParseError(`ai_audit.${source} must be a positive integer`);
    }
    config[target] = value as number;
  }
  if (config.personas) {
    const impossible = [
      ["min_unique_endings", config.minUniqueEndings],
      ["min_unique_decision_paths", config.minUniqueDecisionPaths],
    ] as const;
    for (const [field, value] of impossible) {
      if (value !== undefined && value > config.personas.length) {
        throw new ManifestParseError(
          `ai_audit.${field} cannot exceed the ${config.personas.length} declared personas`,
        );
      }
    }
  }
  if (
    config.minUniqueEndings === undefined &&
    config.minUniqueDecisionPaths === undefined &&
    config.requiredActivityTags === undefined
  ) {
    throw new ManifestParseError(
      "`ai_audit` must declare min_unique_endings, min_unique_decision_paths, and/or required_activity_tags",
    );
  }
  return config;
}

// Switches block: a map of id → { initial: boolean, description? }.
// Shorthand `{ id: false }` (bare boolean) also accepted; expands to
// { initial: <bool> }.
function parseSwitches(raw: unknown): SwitchDef[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError("`switches` must be an object map");
  }
  const out: SwitchDef[] = [];
  for (const [id, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val === "boolean") {
      out.push({ id, initial: val });
      continue;
    }
    if (!val || typeof val !== "object") {
      throw new ManifestParseError(
        `switches.${id}: expected boolean or { initial, description? }`,
      );
    }
    const obj = val as Record<string, unknown>;
    if (typeof obj.initial !== "boolean") {
      throw new ManifestParseError(
        `switches.${id}.initial must be a boolean`,
      );
    }
    const def: SwitchDef = { id, initial: obj.initial };
    if (typeof obj.description === "string") def.description = obj.description;
    out.push(def);
  }
  return out;
}

// Variables block: a map of id → { type, initial, description? }.
// `type` defaults from `initial` when omitted (number / string).
function parseVariables(raw: unknown): VariableDef[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError("`variables` must be an object map");
  }
  const out: VariableDef[] = [];
  for (const [id, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== "object") {
      throw new ManifestParseError(
        `variables.${id}: expected { type, initial, description? }`,
      );
    }
    const obj = val as Record<string, unknown>;
    const initial = obj.initial;
    if (typeof initial !== "number" && typeof initial !== "string") {
      throw new ManifestParseError(
        `variables.${id}.initial must be a number or string`,
      );
    }
    const declaredType =
      typeof obj.type === "string" ? obj.type : typeof initial;
    if (declaredType !== "number" && declaredType !== "string") {
      throw new ManifestParseError(
        `variables.${id}.type must be "number" or "string"`,
      );
    }
    if (typeof initial !== declaredType) {
      throw new ManifestParseError(
        `variables.${id}.initial type mismatch: declared ${declaredType}, got ${typeof initial}`,
      );
    }
    const def: VariableDef = {
      id,
      type: declaredType,
      initial,
    };
    if (typeof obj.description === "string") def.description = obj.description;
    out.push(def);
  }
  return out;
}

function parseTraining(raw: unknown): TrainingConfig {
  if (!raw || typeof raw !== "object") {
    throw new ManifestParseError("`training` must be an object");
  }
  const t = raw as Record<string, unknown>;
  const slotsPerDay = numberField(t, "slotsPerDay", 3);
  const slotNames = arrayOfStrings(t, "slotNames", ["上午", "下午", "晚上"]);
  const startDay = numberField(t, "startDay", 1);
  const maxDay = numberField(t, "maxDay", 14);
  const decayPerDay = numberField(t, "decayPerDay", 0);
  const decayStatId =
    typeof t.decayStatId === "string" ? t.decayStatId : "";
  const sleepActionId =
    typeof t.sleepActionId === "string" ? t.sleepActionId : "sleep";
  const huntActionId =
    typeof t.huntActionId === "string" ? t.huntActionId : "hunt";

  const statsRaw = t.stats;
  if (!Array.isArray(statsRaw)) {
    throw new ManifestParseError("`training.stats` must be an array");
  }
  const stats: StatDef[] = statsRaw.map((s, i) => {
    if (!s || typeof s !== "object") {
      throw new ManifestParseError(`stats[${i}] must be an object`);
    }
    const obj = s as Record<string, unknown>;
    if (typeof obj.id !== "string") {
      throw new ManifestParseError(`stats[${i}].id must be a string`);
    }
    const stat: StatDef = {
      id: obj.id,
      name: typeof obj.name === "string" ? obj.name : obj.id,
      min: typeof obj.min === "number" ? obj.min : 0,
      max: typeof obj.max === "number" ? obj.max : 100,
      start: typeof obj.start === "number" ? obj.start : 0,
    };
    if (Array.isArray(obj.thresholds)) {
      stat.thresholds = obj.thresholds.map((tr, j) => parseThreshold(tr, i, j));
    }
    return stat;
  });

  const endRaw = t.endConditions;
  if (!Array.isArray(endRaw)) {
    throw new ManifestParseError(
      "`training.endConditions` must be an array",
    );
  }
  const endConditions: EndConditionSpec[] = endRaw.map((e, i) => {
    if (!e || typeof e !== "object") {
      throw new ManifestParseError(`endConditions[${i}] must be an object`);
    }
    const obj = e as Record<string, unknown>;
    const when = parseCondition(obj.when);
    if (!when) {
      throw new ManifestParseError(`endConditions[${i}].when is required`);
    }
    return {
      when,
      reason:
        typeof obj.reason === "string" ? obj.reason : `end-${i}`,
      ...(typeof obj.goto === "string" ? { goto: obj.goto } : {}),
    };
  });

  return {
    slotsPerDay,
    slotNames,
    startDay,
    maxDay,
    stats,
    decayPerDay,
    decayStatId,
    sleepActionId,
    huntActionId,
    endConditions,
  };
}

function parseThreshold(raw: unknown, statIdx: number, thrIdx: number): StatThreshold {
  if (!raw || typeof raw !== "object") {
    throw new ManifestParseError(
      `stats[${statIdx}].thresholds[${thrIdx}] must be an object`,
    );
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.min !== "number") {
    throw new ManifestParseError(
      `stats[${statIdx}].thresholds[${thrIdx}].min must be a number`,
    );
  }
  if (typeof obj.label !== "string") {
    throw new ManifestParseError(
      `stats[${statIdx}].thresholds[${thrIdx}].label must be a string`,
    );
  }
  const thr: StatThreshold = { min: obj.min, label: obj.label };
  if (typeof obj.color === "string") {
    thr.color = obj.color as StatThreshold["color"];
  }
  return thr;
}

function numberField(
  obj: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const v = obj[key];
  return typeof v === "number" ? v : fallback;
}

function arrayOfStrings(
  obj: Record<string, unknown>,
  key: string,
  fallback: string[],
): string[] {
  const v = obj[key];
  if (!Array.isArray(v)) return fallback;
  if (v.some((x) => typeof x !== "string")) return fallback;
  return v as string[];
}
