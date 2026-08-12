import { parse as parseYaml } from "yaml";
import type {
  AssetKind,
  AssetRefs,
  AssetSize,
  AssetSpec,
  TuiRenderPrefs,
} from "@rpg-harness/engine";
import { extractCustom } from "./frontmatter";

// Whitelists for tui_render. Mirrored from packages/studio/src/server/
// render.ts — the engine layer can't import from studio (one-way
// dependency: studio depends on engine, not the reverse). Bumping
// either side requires updating both; the symmetry is documented in
// each file.
const TUI_RENDER_SYMBOLS = [
  "block",
  "half",
  "vhalf",
  "hhalf",
  "quad",
  "sextant",
  "braille",
  "octant",
  "ascii",
  "all",
] as const;
const TUI_RENDER_DITHER = ["none", "ordered", "diffusion"] as const;
const TUI_RENDER_COLORS = ["none", "16", "256", "full"] as const;

export class AssetParseError extends Error {
  constructor(message: string, public source?: string) {
    super(message);
  }
}

const VALID_KINDS: ReadonlyArray<AssetKind> = ["portrait", "bg", "cg", "sheet"];

// Spec.yaml keys consumed directly. Anything else lands in `custom`
// via extractCustom, preserving forward-compat for fields a future
// rendering pipeline might add (mood, palette_ref, license, etc.).
const KNOWN_KEYS = [
  "kind",
  "description",
  "prompt",
  "placeholder",
  "style_ref",
  "refs",
  "size_hint",
  "tags",
  "tui_render",
] as const;

// Parse the contents of a single asset's spec.yaml. `relPath` is the
// asset's directory path relative to the game dir, written with
// forward slashes (e.g. "assets/portraits/kagari-smile"). It becomes
// `AssetSpec.path` — the key scripts use to reference this asset.
//
// Renderings (tui.txt/tui.ans/source.{quality,compressed}.*/web.*) are NOT discovered
// here — the loader walks the directory and fills them in. This
// parser is pure: content in, spec out, no fs access.
export function parseAssetSpec(
  content: string,
  relPath: string,
): Omit<AssetSpec, "renderings"> {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (err) {
    throw new AssetParseError(
      `Invalid YAML in asset spec: ${(err as Error).message}`,
      relPath,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AssetParseError("Asset spec must be a YAML object", relPath);
  }
  const obj = raw as Record<string, unknown>;

  const kind = obj.kind;
  if (typeof kind !== "string" || !VALID_KINDS.includes(kind as AssetKind)) {
    throw new AssetParseError(
      `\`kind\` must be one of ${VALID_KINDS.join(" / ")}, got ${JSON.stringify(kind)}`,
      relPath,
    );
  }

  const description = requireString(obj, "description", relPath);
  const prompt = requireString(obj, "prompt", relPath);
  const placeholder = requireString(obj, "placeholder", relPath);

  const spec: Omit<AssetSpec, "renderings"> = {
    path: relPath,
    kind: kind as AssetKind,
    description,
    prompt,
    placeholder,
  };

  if (obj.style_ref !== undefined) {
    if (typeof obj.style_ref !== "string" || obj.style_ref.length === 0) {
      throw new AssetParseError("`style_ref` must be a non-empty string", relPath);
    }
    spec.styleRef = obj.style_ref;
  }

  if (obj.refs !== undefined) spec.refs = parseRefs(obj.refs, relPath);
  if (obj.size_hint !== undefined) {
    spec.sizeHint = parseSizeHint(obj.size_hint, relPath);
  }
  if (obj.tags !== undefined) spec.tags = parseTags(obj.tags, relPath);
  if (obj.tui_render !== undefined) {
    spec.tuiRender = parseTuiRender(obj.tui_render, relPath);
  }

  const custom = extractCustom(obj, KNOWN_KEYS);
  if (custom) spec.custom = custom;

  return spec;
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  source: string,
): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new AssetParseError(
      `\`${key}\` must be a non-empty string`,
      source,
    );
  }
  return v;
}

function parseRefs(raw: unknown, source: string): AssetRefs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AssetParseError("`refs` must be an object", source);
  }
  const obj = raw as Record<string, unknown>;
  const refs: AssetRefs = {};
  if (obj.characters !== undefined) {
    if (
      !Array.isArray(obj.characters) ||
      obj.characters.some((c) => typeof c !== "string")
    ) {
      throw new AssetParseError(
        "`refs.characters` must be an array of strings",
        source,
      );
    }
    refs.characters = obj.characters as string[];
  }
  if (obj.emotion !== undefined) {
    if (typeof obj.emotion !== "string") {
      throw new AssetParseError("`refs.emotion` must be a string", source);
    }
    refs.emotion = obj.emotion;
  }
  // Pass through unknown ref keys verbatim — refs is intentionally
  // open-ended (location, time, weather, mood, ...).
  for (const [k, v] of Object.entries(obj)) {
    if (k !== "characters" && k !== "emotion") refs[k] = v;
  }
  return refs;
}

function parseSizeHint(raw: unknown, source: string): AssetSize {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AssetParseError("`size_hint` must be an object", source);
  }
  const obj = raw as Record<string, unknown>;
  const size: AssetSize = {};
  if (obj.tui !== undefined) {
    if (!obj.tui || typeof obj.tui !== "object" || Array.isArray(obj.tui)) {
      throw new AssetParseError("`size_hint.tui` must be an object", source);
    }
    const t = obj.tui as Record<string, unknown>;
    if (typeof t.cols !== "number" || typeof t.rows !== "number") {
      throw new AssetParseError(
        "`size_hint.tui` requires numeric `cols` and `rows`",
        source,
      );
    }
    size.tui = { cols: t.cols, rows: t.rows };
  }
  if (obj.web !== undefined) {
    if (!obj.web || typeof obj.web !== "object" || Array.isArray(obj.web)) {
      throw new AssetParseError("`size_hint.web` must be an object", source);
    }
    const w = obj.web as Record<string, unknown>;
    if (typeof w.aspect !== "string" || w.aspect.length === 0) {
      throw new AssetParseError(
        "`size_hint.web.aspect` must be a non-empty string",
        source,
      );
    }
    size.web = { aspect: w.aspect };
  }
  return size;
}

function parseTags(raw: unknown, source: string): string[] {
  if (!Array.isArray(raw) || raw.some((t) => typeof t !== "string")) {
    throw new AssetParseError("`tags` must be an array of strings", source);
  }
  return raw as string[];
}

function parseTuiRender(raw: unknown, source: string): TuiRenderPrefs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AssetParseError("`tui_render` must be an object", source);
  }
  const obj = raw as Record<string, unknown>;
  const out: TuiRenderPrefs = {};

  if (obj.symbols !== undefined) {
    if (
      typeof obj.symbols !== "string" ||
      !(TUI_RENDER_SYMBOLS as readonly string[]).includes(obj.symbols)
    ) {
      throw new AssetParseError(
        `\`tui_render.symbols\` must be one of: ${TUI_RENDER_SYMBOLS.join(", ")}`,
        source,
      );
    }
    out.symbols = obj.symbols;
  }
  if (obj.dither !== undefined) {
    if (
      typeof obj.dither !== "string" ||
      !(TUI_RENDER_DITHER as readonly string[]).includes(obj.dither)
    ) {
      throw new AssetParseError(
        `\`tui_render.dither\` must be one of: ${TUI_RENDER_DITHER.join(", ")}`,
        source,
      );
    }
    out.dither = obj.dither;
  }
  if (obj.colors !== undefined) {
    // YAML reads `256` as a number and `'256'` as a string. Accept
    // both — normalize to string. The whitelist matches the stringified
    // form so author-side spec.yaml doesn't have to be quote-pedantic.
    const colors =
      typeof obj.colors === "number" ? String(obj.colors) : obj.colors;
    if (
      typeof colors !== "string" ||
      !(TUI_RENDER_COLORS as readonly string[]).includes(colors)
    ) {
      throw new AssetParseError(
        `\`tui_render.colors\` must be one of: ${TUI_RENDER_COLORS.join(", ")}`,
        source,
      );
    }
    out.colors = colors;
  }
  if (obj.cols !== undefined) {
    if (
      typeof obj.cols !== "number" ||
      !Number.isInteger(obj.cols) ||
      obj.cols < 1 ||
      obj.cols > 500
    ) {
      throw new AssetParseError(
        "`tui_render.cols` must be an integer 1..500",
        source,
      );
    }
    out.cols = obj.cols;
  }
  if (obj.rows !== undefined) {
    if (
      typeof obj.rows !== "number" ||
      !Number.isInteger(obj.rows) ||
      obj.rows < 1 ||
      obj.rows > 500
    ) {
      throw new AssetParseError(
        "`tui_render.rows` must be an integer 1..500",
        source,
      );
    }
    out.rows = obj.rows;
  }
  return out;
}
