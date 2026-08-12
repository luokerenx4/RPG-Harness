import { parse as parseYaml } from "yaml";
import type {
  Beat,
  ChoiceOption,
  Script,
  StateDelta,
} from "@rpg-harness/engine";
import { splitFrontmatter } from "./frontmatter";
import { parseCondition } from "./condition";
import { parseInlineEffects } from "./inline-effects";

export class ScriptParseError extends Error {
  constructor(message: string, public source?: string) {
    super(message);
  }
}

export function parseScript(content: string, source?: string): Script {
  const { meta, body } = splitFrontmatter(content);
  const id = readString(meta, "id", source);
  const title = readString(meta, "title", source);
  const requires = parseCondition(meta.requires);
  const characters = readStringArray(meta, "characters");

  const beats = parseBody(body, source);

  // Frontmatter `bg:` + `defaultPortraits:` produce synthetic
  // setBg/setPortrait beats prepended to the script. Inserted BEFORE
  // any labels so a `goto` jump still lands after the visual seed
  // has been applied.
  const seedBeats: Beat[] = [];
  if (meta.bg !== undefined) {
    if (typeof meta.bg !== "string" || meta.bg.length === 0) {
      throw new ScriptParseError("`bg` frontmatter must be a non-empty string", source);
    }
    seedBeats.push({ type: "setBg", assetPath: meta.bg });
  }
  if (meta.defaultPortraits !== undefined) {
    seedBeats.push(...parseDefaultPortraits(meta.defaultPortraits, source));
  }
  const finalBeats = seedBeats.length > 0 ? [...seedBeats, ...beats] : beats;

  // cost: calendar slots consumed when this script completes. Default
  // 1 (set by the run loop when undefined); 0 hides intro/cutscene
  // scripts from the slot budget. Negative and non-finite rejected.
  let cost: number | undefined;
  if (meta.cost !== undefined) {
    if (typeof meta.cost !== "number" || !Number.isFinite(meta.cost) || meta.cost < 0) {
      throw new ScriptParseError(
        "`cost` must be a non-negative finite number",
        source,
      );
    }
    cost = meta.cost;
  }

  return {
    id,
    title,
    ...(requires !== undefined ? { requires } : {}),
    ...(characters !== undefined ? { characters } : {}),
    beats: finalBeats,
    ...(cost !== undefined ? { cost } : {}),
  };
}

// Two accepted shapes:
//   map  — { center: { characterId: kagari, emotion: smile } }
//          explicit slot per entry, author controls placement
//   list — [ { characterId: kagari, emotion: smile }, ... ]
//          slots are auto-assigned by cast size (single portrait is
//          just the 1-person case): 1 → center; 2 → left, right;
//          3 → left, center, right; 4+ → pos-1..pos-N in list order
function parseDefaultPortraits(raw: unknown, source: string | undefined): Beat[] {
  if (!raw || typeof raw !== "object") {
    throw new ScriptParseError(
      "`defaultPortraits` must be a { slot: { characterId, emotion } } map or a [{ characterId, emotion }] list",
      source,
    );
  }
  const entries: Array<[string, unknown]> = Array.isArray(raw)
    ? raw.map((val, i) => [autoSlots(raw.length)[i] ?? `pos-${i + 1}`, val])
    : Object.entries(raw as Record<string, unknown>);
  const out: Beat[] = [];
  for (const [slot, val] of entries) {
    if (!val || typeof val !== "object" || Array.isArray(val)) {
      throw new ScriptParseError(
        `defaultPortraits.${slot} must be an object`,
        source,
      );
    }
    const obj = val as Record<string, unknown>;
    const characterId = obj.characterId;
    const emotion = obj.emotion;
    if (typeof characterId !== "string" || characterId.length === 0) {
      throw new ScriptParseError(
        `defaultPortraits.${slot}.characterId must be a non-empty string`,
        source,
      );
    }
    if (typeof emotion !== "string" || emotion.length === 0) {
      throw new ScriptParseError(
        `defaultPortraits.${slot}.emotion must be a non-empty string`,
        source,
      );
    }
    out.push({ type: "setPortrait", slot, characterId, emotion });
  }
  return out;
}

function autoSlots(n: number): string[] {
  if (n === 1) return ["center"];
  if (n === 2) return ["left", "right"];
  if (n === 3) return ["left", "center", "right"];
  return Array.from({ length: n }, (_, i) => `pos-${i + 1}`);
}

function readString(
  meta: Record<string, unknown>,
  key: string,
  source?: string,
): string {
  const v = meta[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ScriptParseError(
      `Missing or invalid \`${key}\` in frontmatter`,
      source,
    );
  }
  return v;
}

function readStringArray(
  meta: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const v = meta[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new ScriptParseError(`\`${key}\` must be an array of strings`);
  }
  return v as string[];
}

interface BlockSpan {
  startLine: number;
  endLine: number;
  text: string;
}

function parseBody(body: string, source?: string): Beat[] {
  const lines = body.split(/\r?\n/);
  const beats: Beat[] = [];
  let i = 0;

  while (i < lines.length) {
    while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
    if (i >= lines.length) break;

    const fence = matchFenceOpen(lines[i]);
    if (fence !== null) {
      const fenceStart = i + 1;
      let fenceEnd = fenceStart;
      while (fenceEnd < lines.length && !matchFenceClose(lines[fenceEnd])) {
        fenceEnd++;
      }
      const fenceContent = lines.slice(fenceStart, fenceEnd).join("\n");
      beats.push(parseFenceBeat(fenceContent, source));
      i = fenceEnd + 1;
      continue;
    }

    const block = collectBlock(lines, i);
    beats.push(...parseTextBlock(block, source));
    i = block.endLine + 1;
  }
  return beats;
}

function collectBlock(lines: string[], start: number): BlockSpan {
  let end = start;
  while (end < lines.length && (lines[end] ?? "").trim() !== "") end++;
  return {
    startLine: start,
    endLine: end - 1,
    text: lines.slice(start, end).join("\n"),
  };
}

function parseTextBlock(block: BlockSpan, source?: string): Beat[] {
  const first = (block.text.split("\n")[0] ?? "").trim();

  if (first === "[end]") {
    return [{ type: "endScript" }];
  }
  if (first.startsWith("?")) {
    return [parseChoiceBlock(block, source)];
  }
  if (first.startsWith("@")) {
    return parseDialogueBlock(block, source);
  }
  if (first.startsWith(":")) {
    return [parseDirectiveBlock(block, source)];
  }
  if (first.startsWith("#") && /^#\s*[a-zA-Z_][\w-]*\s*$/.test(first)) {
    return [{ type: "label", name: first.replace(/^#\s*/, "").trim() }];
  }
  return [{ type: "narration", text: block.text.trim() }];
}

// `@speaker [emotion] text...` — emotion token is optional. Matched
// when the second whitespace-separated token is a lowercase
// identifier (letters/digits/underscore/hyphen, must lead with a
// letter). Whether that token is *actually* an emotion (vs. the first
// word of the dialogue) is decided at runtime by the engine: it
// consults the character's portraits map; unknown emotion → drops
// the setPortrait beat's effect and restores the token to the
// dialogue text. We tag the beat as `pendingEmotion` so the engine
// can do that restoration. Parser stays free of cross-file lookups.
const DIALOGUE_LINE = /^@(\S+)(?:\s+([a-z][\w-]*))?\s*(.*)$/;

function parseDialogueBlock(block: BlockSpan, source?: string): Beat[] {
  const lines = block.text.split("\n");
  const first = lines[0] ?? "";
  const match = first.match(DIALOGUE_LINE);
  if (!match || !match[1]) {
    throw new ScriptParseError(`Malformed dialogue line: ${first}`, source);
  }
  const speaker = match[1];
  const emotion = match[2];
  const firstText = match[3] ?? "";
  const rest = lines.slice(1).join("\n");
  const text = firstText
    ? rest
      ? `${firstText}\n${rest}`
      : firstText
    : rest;

  const beat: Beat = { type: "dialogue", speaker, text: text.trim() };
  if (emotion !== undefined && emotion.length > 0) {
    beat.candidateEmotion = emotion;
  }
  return [beat];
}

// Directive lines: single-line beats starting with `:`. Supported:
//   :bg <path>           → setBg
//   :bg none             → setBg null (explicit clear)
//   :cg <path>           → showCg
//   :hide-cg             → hideCg
//   :portrait <slot> <path?>  → setPortrait (empty path clears the slot)
//   :clear-visuals       → clearVisuals
//
// The block must be a single line — multi-line `:` blocks are an
// authoring error because every directive's semantics fit on one
// line. Authors separate consecutive directives with a blank line
// (same convention as every other beat).
function parseDirectiveBlock(block: BlockSpan, source?: string): Beat {
  const lines = block.text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    throw new ScriptParseError(
      `Directive block must be a single line; got ${lines.length}. Separate directives with a blank line.`,
      source,
    );
  }
  const line = (lines[0] ?? "").trim();
  const [head, ...rest] = line.split(/\s+/);
  switch (head) {
    case ":bg": {
      if (rest.length === 0) {
        throw new ScriptParseError(":bg requires an asset path or `none`", source);
      }
      const path = rest.join(" ").trim();
      const asset = path === "none" || path === "null" ? null : path;
      return { type: "setBg", assetPath: asset };
    }
    case ":cg": {
      if (rest.length === 0) {
        throw new ScriptParseError(":cg requires an asset path", source);
      }
      return { type: "showCg", assetPath: rest.join(" ").trim() };
    }
    case ":hide-cg":
      if (rest.length > 0) {
        throw new ScriptParseError(":hide-cg takes no arguments", source);
      }
      return { type: "hideCg" };
    case ":portrait": {
      const slot = rest[0];
      if (!slot) {
        throw new ScriptParseError(":portrait requires a slot name", source);
      }
      const path = rest.slice(1).join(" ").trim();
      const asset =
        path.length === 0 || path === "none" || path === "null" ? null : path;
      return { type: "setPortrait", slot, assetPath: asset };
    }
    case ":clear-visuals":
      if (rest.length > 0) {
        throw new ScriptParseError(
          ":clear-visuals takes no arguments",
          source,
        );
      }
      return { type: "clearVisuals" };
    default:
      throw new ScriptParseError(`Unknown directive: ${head}`, source);
  }
}

function parseChoiceBlock(block: BlockSpan, source?: string): Beat {
  const lines = block.text.split("\n");
  const first = lines[0] ?? "";
  const rawPrompt = first.replace(/^\?\s*/, "").trim();
  const { prompt, view } = parsePromptAnnotations(rawPrompt, source);
  const options: ChoiceOption[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("-")) {
      throw new ScriptParseError(
        `Choice block has non-option line: "${trimmed}"`,
        source,
      );
    }
    const rest = trimmed.slice(1).trim();
    const arrowIdx = rest.indexOf("->");
    let text = rest;
    let effects: StateDelta | undefined;
    let goto: string | undefined;
    if (arrowIdx >= 0) {
      text = rest.slice(0, arrowIdx).trim();
      const tail = rest.slice(arrowIdx + 2).trim();
      const parsed = parseChoiceTail(tail);
      effects = parsed.effects;
      goto = parsed.goto;
    }
    options.push({
      text,
      ...(effects !== undefined ? { effects } : {}),
      ...(goto !== undefined ? { goto } : {}),
    });
  }
  return {
    type: "choice",
    ...(prompt ? { prompt } : {}),
    ...(view !== undefined ? { view } : {}),
    options,
  };
}

// Trailing `{key: value, key2: value2}` annotation on a prompt line.
// Currently only `view` is recognized; unknown keys throw so typos
// fail loud instead of silently disabling the presenter. The brace
// group must sit at the very end of the prompt — anything before it
// becomes the literal prompt text.
function parsePromptAnnotations(
  raw: string,
  source: string | undefined,
): { prompt: string; view?: string } {
  const match = raw.match(/^(.*?)\s*\{([^}]*)\}\s*$/);
  if (!match) return { prompt: raw };
  const prompt = (match[1] ?? "").trim();
  const inner = (match[2] ?? "").trim();
  if (inner.length === 0) return { prompt };
  let view: string | undefined;
  for (const pair of inner.split(",")) {
    const colon = pair.indexOf(":");
    if (colon < 0) {
      throw new ScriptParseError(
        `Prompt annotation segment "${pair.trim()}" must be \`key: value\``,
        source,
      );
    }
    const key = pair.slice(0, colon).trim();
    const value = pair.slice(colon + 1).trim();
    if (key === "view") {
      if (value.length === 0) {
        throw new ScriptParseError(`Prompt annotation \`view\` is empty`, source);
      }
      view = value;
      continue;
    }
    throw new ScriptParseError(
      `Unknown prompt annotation key "${key}"`,
      source,
    );
  }
  return { prompt, ...(view !== undefined ? { view } : {}) };
}

function parseChoiceTail(tail: string): {
  effects?: StateDelta;
  goto?: string;
} {
  const segments = tail.split("|").map((s) => s.trim()).filter(Boolean);
  let effects: StateDelta | undefined;
  let goto: string | undefined;
  for (const seg of segments) {
    if (seg.startsWith("goto ")) {
      goto = seg.slice(5).trim();
      continue;
    }
    const e = parseInlineEffects(seg);
    if (e) effects = effects ? mergeDeltas(effects, e) : e;
  }
  return {
    ...(effects !== undefined ? { effects } : {}),
    ...(goto !== undefined ? { goto } : {}),
  };
}

function mergeDeltas(a: StateDelta, b: StateDelta): StateDelta {
  const merged: StateDelta = {};
  if (a.characterStats || b.characterStats) {
    merged.characterStats = mergeCharacterStats(
      a.characterStats,
      b.characterStats,
    );
  }
  if (a.switches || b.switches) {
    merged.switches = { ...(a.switches ?? {}), ...(b.switches ?? {}) };
  }
  if (a.variables || b.variables) {
    merged.variables = { ...(a.variables ?? {}), ...(b.variables ?? {}) };
  }
  return merged;
}

// `affection: { alice: 2 }` → `{ alice: { affection: 2 } }`. Reusable
// at every effects-parsing site.
export function desugarAffectionMap(
  map: Record<string, number>,
  existing?: Record<string, Record<string, number>>,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = existing ?? {};
  for (const [charId, value] of Object.entries(map)) {
    if (typeof value !== "number") continue;
    const slot = (out[charId] = out[charId] ?? {});
    slot.affection = (slot.affection ?? 0) + value;
  }
  return out;
}

export function mergeCharacterStats(
  a: Record<string, Record<string, number>> | undefined,
  b: Record<string, Record<string, number>> | undefined,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [charId, stats] of Object.entries(a ?? {})) {
    out[charId] = { ...stats };
  }
  for (const [charId, stats] of Object.entries(b ?? {})) {
    const into = (out[charId] = out[charId] ?? {});
    for (const [name, v] of Object.entries(stats)) {
      into[name] = (into[name] ?? 0) + v;
    }
  }
  return out;
}

function parseFenceBeat(content: string, source?: string): Beat {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    throw new ScriptParseError(
      `Invalid YAML in fenced block: ${(err as Error).message}`,
      source,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new ScriptParseError("Fenced block must be a YAML object", source);
  }
  const obj = parsed as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== "string") {
    throw new ScriptParseError(
      "Fenced block must have a `type` field",
      source,
    );
  }
  switch (type) {
    case "choice":
      return parseFenceChoice(obj, source);
    case "effects":
      return parseFenceEffects(obj, source);
    case "clear":
      return { type: "clear" };
    default:
      throw new ScriptParseError(`Unknown fenced beat type: ${type}`, source);
  }
}

function parseFenceChoice(
  obj: Record<string, unknown>,
  source?: string,
): Beat {
  const prompt = typeof obj.prompt === "string" ? obj.prompt : undefined;
  const view = typeof obj.view === "string" && obj.view.length > 0 ? obj.view : undefined;
  const rawOptions = obj.options;
  if (!Array.isArray(rawOptions)) {
    throw new ScriptParseError(
      "Choice fence must have an `options` array",
      source,
    );
  }
  const options: ChoiceOption[] = rawOptions.map((o, idx) => {
    if (!o || typeof o !== "object") {
      throw new ScriptParseError(
        `Choice option ${idx} must be an object`,
        source,
      );
    }
    const opt = o as Record<string, unknown>;
    if (typeof opt.text !== "string") {
      throw new ScriptParseError(
        `Choice option ${idx} missing \`text\``,
        source,
      );
    }
    const requires = parseCondition(opt.requires);
    const effects = parseEffectsObject(opt.effects, source, idx);
    const goto = typeof opt.goto === "string" ? opt.goto : undefined;
    return {
      text: opt.text,
      ...(requires !== undefined ? { requires } : {}),
      ...(effects !== undefined ? { effects } : {}),
      ...(goto !== undefined ? { goto } : {}),
    };
  });
  return {
    type: "choice",
    ...(prompt ? { prompt } : {}),
    ...(view !== undefined ? { view } : {}),
    options,
  };
}

function parseFenceEffects(
  obj: Record<string, unknown>,
  source?: string,
): Beat {
  const effects = parseEffectsObject(obj.effects, source);
  if (!effects) {
    throw new ScriptParseError(
      "Effects fence requires an `effects` field",
      source,
    );
  }
  return { type: "effects", effects };
}

function parseEffectsObject(
  raw: unknown,
  source?: string,
  optionIdx?: number,
): StateDelta | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") {
    throw new ScriptParseError(
      `Effects must be an object${
        optionIdx !== undefined ? ` (option ${optionIdx})` : ""
      }`,
      source,
    );
  }
  const obj = raw as Record<string, unknown>;
  const delta: StateDelta = {};
  if (obj.affection !== undefined) {
    // Sugar: `affection: { alice: 2 }` → characterStats.alice.affection.
    if (typeof obj.affection !== "object" || obj.affection === null) {
      throw new ScriptParseError("`affection` must be an object", source);
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
      throw new ScriptParseError("`characterStats` must be an object", source);
    }
    delta.characterStats = mergeCharacterStats(
      delta.characterStats,
      obj.characterStats as Record<string, Record<string, number>>,
    );
  }
  if (obj.switches !== undefined) {
    if (typeof obj.switches !== "object" || obj.switches === null) {
      throw new ScriptParseError("`switches` must be an object", source);
    }
    delta.switches = obj.switches as Record<string, boolean>;
  }
  if (obj.variables !== undefined) {
    if (typeof obj.variables !== "object" || obj.variables === null) {
      throw new ScriptParseError("`variables` must be an object", source);
    }
    delta.variables = obj.variables as Record<string, number | string>;
  }
  if (obj.stats !== undefined) {
    if (typeof obj.stats !== "object" || obj.stats === null) {
      throw new ScriptParseError("`stats` must be an object", source);
    }
    delta.stats = obj.stats as Record<string, number>;
  }
  if (obj.statMax !== undefined) {
    if (typeof obj.statMax !== "object" || obj.statMax === null) {
      throw new ScriptParseError("`statMax` must be an object", source);
    }
    delta.statMax = obj.statMax as Record<string, number>;
  }
  if (obj.inventory !== undefined) {
    if (typeof obj.inventory !== "object" || obj.inventory === null) {
      throw new ScriptParseError("`inventory` must be an object", source);
    }
    delta.inventory = obj.inventory as Record<string, number>;
  }
  if (obj.weapons !== undefined) {
    if (typeof obj.weapons !== "object" || obj.weapons === null) {
      throw new ScriptParseError("`weapons` must be an object", source);
    }
    delta.weapons = obj.weapons as Record<string, { power?: number }>;
  }
  if (obj.skills !== undefined) {
    if (typeof obj.skills !== "object" || obj.skills === null) {
      throw new ScriptParseError("`skills` must be an object", source);
    }
    delta.skills = obj.skills as { learn?: string[]; forget?: string[] };
  }
  return delta;
}

const FENCE_OPEN = /^```(?:yaml|yml)?\s*$/;
const FENCE_CLOSE = /^```\s*$/;

function matchFenceOpen(line: string | undefined): true | null {
  if (line === undefined) return null;
  return FENCE_OPEN.test(line) ? true : null;
}

function matchFenceClose(line: string | undefined): boolean {
  if (line === undefined) return false;
  return FENCE_CLOSE.test(line);
}
