// spec.yaml editor. Two callers today: PATCH /api/assets/:path/spec
// (full field edits from the form) and POST .../render-tui (auto-
// persist used render options). Both go through `updateSpec` so the
// YAML round-trip rules — comment preservation, snake_case naming,
// atomic writes — live in one place.
//
// The yaml@2.9.0 Document API is what makes this safe: parseDocument
// retains the AST including comments, key ordering, and quoting
// style, and a setIn → toString round-trip preserves all of that.
// A naive parseYaml → JS edit → stringify path would lose comments
// and re-serialize keys in whatever order JS objects happened to
// have, which would make spec.yaml diffs unreviewable.

import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument, type Document } from "yaml";
import type { AssetSpec, TuiRenderPrefs } from "@rpg-harness/engine";

// Subset of AssetSpec the studio is allowed to mutate. `kind`, `path`,
// `custom`, `renderings` deliberately excluded — they're either
// derived from the directory layout or carry "everything else" and
// shouldn't be editable through this surface.
export type EditableSpecFields = Partial<{
  description: string;
  prompt: string;
  placeholder: string;
  styleRef: string | null; // null to remove
  refs: AssetSpec["refs"];
  sizeHint: AssetSpec["sizeHint"];
  tileGrid: AssetSpec["tileGrid"] | null;
  tags: string[];
  tuiRender: TuiRenderPrefs;
}>;

// camelCase (engine/studio internal) → snake_case (YAML on-disk).
// Only the keys that have a snake_case form go through translation;
// fields with no underscore (description / prompt / placeholder /
// tags / refs) are pass-through.
const KEY_TRANSLATIONS: Record<string, string> = {
  styleRef: "style_ref",
  sizeHint: "size_hint",
  tileGrid: "tile_grid",
  tuiRender: "tui_render",
};
function yamlKey(camel: string): string {
  return KEY_TRANSLATIONS[camel] ?? camel;
}

// Update a spec.yaml on disk by merging `patch` into the existing
// document. Atomic: writes to `<path>.tmp` first then renames; a
// crashed mid-write leaves the original intact.
//
// Returns the YAML text that was written so callers can re-parse it
// or display a diff. The caller is responsible for re-loading the
// game (loadGame) after this — we don't trigger reloads from here
// to avoid coupling.
export async function updateSpec(
  absPath: string,
  patch: EditableSpecFields,
): Promise<string> {
  const original = await readFile(absPath, "utf-8");
  const doc = parseDocument(original);
  if (doc.errors.length > 0) {
    throw new Error(
      `cannot edit ${absPath}: existing YAML has parse errors — ${doc.errors[0]!.message}`,
    );
  }
  applyPatch(doc, patch);
  const next = doc.toString();
  // No-op writes are still atomic-safe but skip the disk churn if
  // the document round-trip produced byte-identical output.
  if (next === original) return next;

  const tmp = absPath + ".tmp";
  await writeFile(tmp, next);
  await rename(tmp, absPath).catch(async (err) => {
    await unlink(tmp).catch(() => {});
    throw err;
  });
  return next;
}

// Walk the patch in declaration order. Each top-level key either sets
// a scalar/string or recurses into a nested object (refs, sizeHint,
// tuiRender). When a value is null/undefined we delete the key — this
// lets callers explicitly unset a field (e.g. `styleRef: null`).
function applyPatch(doc: Document, patch: EditableSpecFields): void {
  for (const [camelKey, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const key = yamlKey(camelKey);
    if (value === null) {
      doc.delete(key);
      continue;
    }

    if (camelKey === "tileGrid") {
      const grid = value as NonNullable<AssetSpec["tileGrid"]>;
      doc.setIn([key], { columns: grid.columns, rows: grid.rows, first_id: grid.firstId });
      continue;
    }

    if (camelKey === "refs" || camelKey === "sizeHint" || camelKey === "tuiRender") {
      // Nested objects: merge field-by-field so untouched sub-keys
      // (and their comments) stay where they are.
      const nested = value as Record<string, unknown>;
      for (const [subKey, subValue] of Object.entries(nested)) {
        if (subValue === undefined) continue;
        if (subValue === null) {
          doc.deleteIn([key, subKey]);
          continue;
        }
        if (
          (camelKey === "sizeHint" && (subKey === "tui" || subKey === "web")) ||
          camelKey === "refs"
        ) {
          // refs is open-shape; sizeHint.tui/web are { cols, rows } /
          // { aspect } objects. Set the whole sub-object as one node
          // — partial merging here would require knowing the schema.
          doc.setIn([key, subKey], subValue);
        } else {
          doc.setIn([key, subKey], subValue);
        }
      }
      continue;
    }

    // Scalar fields (description / prompt / placeholder / styleRef /
    // tags). `tags` is an array; setIn handles arrays correctly via
    // the Document API.
    doc.setIn([key], value);
  }
}

// Resolve the spec.yaml path for an asset given the game dir and the
// asset's path (e.g. "assets/portraits/kagari-smile"). The asset
// directory always contains a `spec.yaml`; loader-discovered specs
// always live at that location.
export function specYamlPath(gameDir: string, assetPath: string): string {
  return path.join(gameDir, ...assetPath.split("/"), "spec.yaml");
}

// Allowed camelCase keys on the patch body. Immutable fields (kind,
// path, custom, renderings) are deliberately absent — kind would
// invalidate the directory layout, path is derived, custom is a
// passthrough bag, renderings are discovered on disk. Patches that
// include any of these get rejected with a 400.
const EDITABLE_KEYS = [
  "description",
  "prompt",
  "placeholder",
  "styleRef",
  "refs",
  "sizeHint",
  "tileGrid",
  "tags",
  "tuiRender",
] as const;
type EditableKey = (typeof EDITABLE_KEYS)[number];

// Whitelist mirrored from asset.ts. Duplicated to keep packages
// independent (studio depends on engine, not parser).
const TUI_RENDER_SYMBOLS = new Set([
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
]);
const TUI_RENDER_DITHER = new Set(["none", "ordered", "diffusion"]);
const TUI_RENDER_COLORS = new Set(["none", "16", "256", "full"]);

// Validate a parsed JSON body for the PATCH spec endpoint. Returns
// either a normalized EditableSpecFields object OR a string error
// suitable for a 400 response. Same shape as parseRenderOptions in
// render.ts.
export function parsePatchBody(
  raw: unknown,
): { fields: EditableSpecFields } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "body must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;

  // Reject any non-editable keys explicitly so callers can't silently
  // try to change `kind` or `path` and have it ignored.
  for (const k of Object.keys(obj)) {
    if (!(EDITABLE_KEYS as readonly string[]).includes(k)) {
      return { error: `field "${k}" is not editable through this endpoint` };
    }
  }

  const out: EditableSpecFields = {};

  if (obj.description !== undefined) {
    if (typeof obj.description !== "string" || obj.description.length === 0) {
      return { error: "description must be a non-empty string" };
    }
    out.description = obj.description;
  }
  if (obj.prompt !== undefined) {
    if (typeof obj.prompt !== "string" || obj.prompt.length === 0) {
      return { error: "prompt must be a non-empty string" };
    }
    out.prompt = obj.prompt;
  }
  if (obj.placeholder !== undefined) {
    if (typeof obj.placeholder !== "string" || obj.placeholder.length === 0) {
      return { error: "placeholder must be a non-empty string" };
    }
    out.placeholder = obj.placeholder;
  }
  if (obj.styleRef !== undefined) {
    if (obj.styleRef !== null && typeof obj.styleRef !== "string") {
      return { error: "styleRef must be a string or null (to remove)" };
    }
    out.styleRef = obj.styleRef as string | null;
  }
  if (obj.refs !== undefined) {
    if (!obj.refs || typeof obj.refs !== "object" || Array.isArray(obj.refs)) {
      return { error: "refs must be an object" };
    }
    out.refs = obj.refs as AssetSpec["refs"];
  }
  if (obj.sizeHint !== undefined) {
    if (!obj.sizeHint || typeof obj.sizeHint !== "object" || Array.isArray(obj.sizeHint)) {
      return { error: "sizeHint must be an object" };
    }
    out.sizeHint = obj.sizeHint as AssetSpec["sizeHint"];
  }
  if (obj.tileGrid !== undefined) {
    if (obj.tileGrid === null) {
      out.tileGrid = null;
    } else {
      if (!obj.tileGrid || typeof obj.tileGrid !== "object" || Array.isArray(obj.tileGrid)) {
        return { error: "tileGrid must be an object or null" };
      }
      const grid = obj.tileGrid as Record<string, unknown>;
      if (!Number.isInteger(grid.columns) || (grid.columns as number) <= 0) {
        return { error: "tileGrid.columns must be a positive integer" };
      }
      if (!Number.isInteger(grid.rows) || (grid.rows as number) <= 0) {
        return { error: "tileGrid.rows must be a positive integer" };
      }
      if (!Number.isInteger(grid.firstId) || (grid.firstId as number) < 0) {
        return { error: "tileGrid.firstId must be a non-negative integer" };
      }
      out.tileGrid = {
        columns: grid.columns as number,
        rows: grid.rows as number,
        firstId: grid.firstId as number,
      };
    }
  }
  if (obj.tags !== undefined) {
    if (!Array.isArray(obj.tags) || obj.tags.some((t) => typeof t !== "string")) {
      return { error: "tags must be an array of strings" };
    }
    out.tags = obj.tags as string[];
  }
  if (obj.tuiRender !== undefined) {
    const tr = obj.tuiRender;
    if (!tr || typeof tr !== "object" || Array.isArray(tr)) {
      return { error: "tuiRender must be an object" };
    }
    const tro = tr as Record<string, unknown>;
    const normalized: TuiRenderPrefs = {};
    if (tro.symbols !== undefined) {
      if (typeof tro.symbols !== "string" || !TUI_RENDER_SYMBOLS.has(tro.symbols)) {
        return { error: `tuiRender.symbols must be one of: ${[...TUI_RENDER_SYMBOLS].join(", ")}` };
      }
      normalized.symbols = tro.symbols;
    }
    if (tro.dither !== undefined) {
      if (typeof tro.dither !== "string" || !TUI_RENDER_DITHER.has(tro.dither)) {
        return { error: `tuiRender.dither must be one of: ${[...TUI_RENDER_DITHER].join(", ")}` };
      }
      normalized.dither = tro.dither;
    }
    if (tro.colors !== undefined) {
      const c = typeof tro.colors === "number" ? String(tro.colors) : tro.colors;
      if (typeof c !== "string" || !TUI_RENDER_COLORS.has(c)) {
        return { error: `tuiRender.colors must be one of: ${[...TUI_RENDER_COLORS].join(", ")}` };
      }
      normalized.colors = c;
    }
    if (tro.cols !== undefined) {
      if (typeof tro.cols !== "number" || !Number.isInteger(tro.cols) || tro.cols < 1 || tro.cols > 500) {
        return { error: "tuiRender.cols must be an integer 1..500" };
      }
      normalized.cols = tro.cols;
    }
    if (tro.rows !== undefined) {
      if (typeof tro.rows !== "number" || !Number.isInteger(tro.rows) || tro.rows < 1 || tro.rows > 500) {
        return { error: "tuiRender.rows must be an integer 1..500" };
      }
      normalized.rows = tro.rows;
    }
    out.tuiRender = normalized;
  }

  return { fields: out };
}
