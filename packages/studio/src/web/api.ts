// Typed fetchers for the studio API. Shapes mirror the server's
// projection in handlers.ts — kept in this single file so a type
// drift between server and client is one diff to spot.

export interface GameSummary {
  title: string;
  counts: { characters: number; scripts: number; assets: number };
  gameDir: string;
}

export type AssetKind = "portrait" | "bg" | "cg" | "sheet";

export interface TuiRenderPrefs {
  symbols?: string;
  dither?: string;
  colors?: string;
  cols?: number;
  rows?: number;
}

export interface AssetRow {
  path: string;
  kind: AssetKind;
  description: string;
  prompt: string;
  placeholder: string;
  styleRef?: string;
  refs?: {
    characters?: string[];
    emotion?: string;
    [k: string]: unknown;
  };
  sizeHint?: {
    tui?: { cols: number; rows: number };
    web?: { aspect: string };
  };
  tags?: string[];
  tuiRender?: TuiRenderPrefs;
  renderings: {
    source: boolean;
    sourceQuality: boolean;
    sourceCompressed: boolean;
    tuiTxt: boolean;
    tuiAns: boolean;
    web: boolean;
  };
  // File sizes for source tier slots — used to show compression
  // ratio in studio's dual preview. Undefined when slot empty.
  sourceQualityBytes?: number;
  sourceCompressedBytes?: number;
}

// Subset of AssetRow the studio is allowed to mutate via PATCH.
// Sent as the body of patchSpec; server rejects any other keys
// (kind / path / renderings) with a 400.
export interface PatchableSpecFields {
  description?: string;
  prompt?: string;
  placeholder?: string;
  styleRef?: string | null;
  refs?: AssetRow["refs"];
  sizeHint?: AssetRow["sizeHint"];
  tags?: string[];
  tuiRender?: TuiRenderPrefs;
}

export async function fetchGame(): Promise<GameSummary> {
  const r = await fetch("/api/game");
  if (!r.ok) throw new Error(`/api/game: ${r.status}`);
  return r.json();
}

// Ghost references: paths that scripts/characters point at with no
// spec.yaml behind them, plus defaultPortraits emotions missing from
// a character's portraits map. Mirrors collectDanglingRefs in the
// CLI loader.
export interface DanglingRefs {
  missingAssets: Array<{ assetPath: string; referencedBy: string[] }>;
  missingEmotions: Array<{
    characterId: string;
    emotion: string;
    referencedBy: string[];
  }>;
}

export interface AssetsResponse {
  assets: AssetRow[];
  dangling: DanglingRefs;
}

export async function fetchAssets(): Promise<AssetsResponse> {
  const r = await fetch("/api/assets");
  if (!r.ok) throw new Error(`/api/assets: ${r.status}`);
  return r.json();
}

export async function fetchAsset(assetPath: string): Promise<AssetRow> {
  const r = await fetch(`/api/assets/${assetPath}`);
  if (!r.ok) throw new Error(`/api/assets/${assetPath}: ${r.status}`);
  return r.json();
}

// Resolves to the URL the <img> tag should use for an asset's source
// PNG. The browser's image cache + content-type handling does the
// rest. Returns undefined for assets with no source file (caller
// falls back to a placeholder UI).
//
// `sourceImageUrl` is the "best pick" (quality > compressed) — kept
// for callers that just want one image. The tier-specific helpers
// below are what studio's dual-preview uses.
export function sourceImageUrl(assetPath: string): string {
  return `/files/source/${assetPath}`;
}

export function sourceQualityImageUrl(assetPath: string): string {
  return `/files/source-quality/${assetPath}`;
}

export function sourceCompressedImageUrl(assetPath: string): string {
  return `/files/source-compressed/${assetPath}`;
}

export async function fetchTuiTxt(assetPath: string): Promise<string> {
  const r = await fetch(`/files/tui-txt/${assetPath}`);
  if (!r.ok) throw new Error(`tui-txt missing`);
  return r.text();
}

export async function fetchTuiAns(assetPath: string): Promise<string> {
  const r = await fetch(`/files/tui-ans/${assetPath}`);
  if (!r.ok) throw new Error(`tui-ans missing`);
  return r.text();
}

export interface ToolCheck {
  present: boolean;
  version?: string;
  path?: string;
}

export interface HealthState {
  chafa: ToolCheck;
}

export async function fetchHealth(): Promise<HealthState> {
  const r = await fetch("/api/health");
  if (!r.ok) throw new Error(`/api/health: ${r.status}`);
  return r.json();
}

// Upload a PNG to the asset's source.quality.png slot. The server accepts
// multipart "file" or raw image/* — we use multipart so a future
// helper that posts a Blob from canvas (e.g. paste from clipboard)
// works without changing the contract. Returns the updated AssetRow.
export async function uploadSource(
  assetPath: string,
  file: Blob,
): Promise<AssetRow> {
  const form = new FormData();
  form.append("file", file);
  const r = await fetch(`/api/assets/${assetPath}/source`, {
    method: "POST",
    body: form,
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`upload failed (${r.status}): ${body}`);
  }
  return r.json();
}

// Mirrors the server's whitelist (server/render.ts). When the server
// gains a new symbols option, bump this and the UI dropdown picks it
// up automatically via SYMBOLS_LABELS.
export type SymbolSet =
  | "block"
  | "half"
  | "vhalf"
  | "hhalf"
  | "quad"
  | "sextant"
  | "braille"
  | "octant"
  | "ascii"
  | "all";
export type DitherMode = "none" | "ordered" | "diffusion";
export type ColorMode = "none" | "16" | "256" | "full";

export interface RenderOptions {
  symbols?: SymbolSet;
  cols?: number;
  rows?: number;
  dither?: DitherMode;
  colors?: ColorMode;
}

// Edit one or more mutable spec.yaml fields. Server rejects
// non-editable keys (kind/path/custom/renderings) with 400 and
// whitelist-validates symbol/dither/color enums on tuiRender. The
// returned AssetRow reflects the post-write state, so the caller
// can update local state without a separate fetch.
export async function patchSpec(
  assetPath: string,
  fields: PatchableSpecFields,
): Promise<AssetRow> {
  const r = await fetch(`/api/assets/${assetPath}/spec`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({ error: r.statusText }));
    const e = new Error(
      typeof body === "object" && body && "error" in body
        ? String((body as { error: string }).error)
        : r.statusText,
    );
    (e as Error & { status?: number }).status = r.status;
    throw e;
  }
  return r.json();
}

// Invoke server-side chafa to produce tui.txt from source.quality.png.
// Surfaces server status codes verbatim so the UI can branch:
//   503 → chafa not installed (show install hint)
//   412 → no source.quality.png (prompt to upload first)
//   500 → chafa failed (show stderr-derived message)
export async function renderTui(
  assetPath: string,
  options: RenderOptions = {},
): Promise<AssetRow> {
  const hasOptions = Object.keys(options).length > 0;
  const r = await fetch(`/api/assets/${assetPath}/render-tui`, {
    method: "POST",
    ...(hasOptions
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(options),
        }
      : {}),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({ error: r.statusText }));
    const e = new Error(
      typeof body === "object" && body && "error" in body
        ? String((body as { error: string }).error)
        : r.statusText,
    );
    (e as Error & { status?: number }).status = r.status;
    throw e;
  }
  return r.json();
}
