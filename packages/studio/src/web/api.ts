// Typed fetchers for the studio API. Shapes mirror the server's
// projection in handlers.ts — kept in this single file so a type
// drift between server and client is one diff to spot.

import type {
  HubActivity,
  MapDef,
  MapAvailableResource,
  ProjectResourceKind,
  ProjectResourceNode,
  ProjectResourceGraph,
  SwitchDef,
  VariableDef,
} from "@rpg-harness/engine";

export interface GameSummary {
  id: string;
  title: string;
  counts: {
    characters: number;
    scripts: number;
    assets: number;
    maps: number;
    actions: number;
    items: number;
    enemies: number;
    weapons: number;
    skills: number;
  };
  gameDir: string;
}

export type AssetKind = "portrait" | "bg" | "cg" | "sheet" | "sprite" | "tileset";

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
  tileGrid?: {
    columns: number;
    rows: number;
    firstId: number;
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

export type ProjectAssetPreview = Pick<
  AssetRow,
  "path" | "kind" | "placeholder" | "tileGrid" | "renderings"
>;

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
  tileGrid?: AssetRow["tileGrid"] | null;
  tags?: string[];
  tuiRender?: TuiRenderPrefs;
}

export interface CreateAssetInput {
  kind: AssetKind;
  id: string;
  description: string;
  prompt: string;
  placeholder: string;
  tileGrid?: NonNullable<AssetRow["tileGrid"]>;
}

export async function fetchGame(): Promise<GameSummary> {
  const r = await fetch("/api/game");
  if (!r.ok) throw new Error(`/api/game: ${r.status}`);
  return r.json();
}

export interface ProjectResponse {
  graph: ProjectResourceGraph;
  maps: MapDef[];
  switches: SwitchDef[];
  variables: VariableDef[];
  assets: ProjectAssetPreview[];
}

export async function fetchProject(): Promise<ProjectResponse> {
  const r = await fetch("/api/project");
  if (!r.ok) throw new Error(`/api/project: ${r.status}`);
  return r.json();
}

export interface ResourceSourceResponse {
  path: string;
  source: string;
}

function resourceSourceUrl(kind: ProjectResourceKind, id: string): string {
  const query = new URLSearchParams({ kind, id });
  return `/api/resource-source?${query.toString()}`;
}

export async function fetchResourceSource(
  kind: ProjectResourceKind,
  id: string,
): Promise<ResourceSourceResponse> {
  const response = await fetch(resourceSourceUrl(kind, id));
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
  }
  return response.json();
}

export async function saveResourceSource(
  kind: ProjectResourceKind,
  id: string,
  source: string,
): Promise<ResourceSourceResponse & { project: ProjectResponse }> {
  const response = await fetch(resourceSourceUrl(kind, id), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
  }
  return response.json();
}

export interface CreateProjectResourceResponse {
  resource: ProjectResourceNode;
  source: ResourceSourceResponse;
  project: ProjectResponse;
}

export async function createProjectResource(
  kind: ProjectResourceKind,
  id: string,
  label: string,
  options: { mapLayout?: { width: number; height: number; tileset?: string } } = {},
): Promise<CreateProjectResourceResponse> {
  const response = await fetch("/api/resources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, id, label, options }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
  }
  return response.json();
}

export async function duplicateProjectResource(
  kind: ProjectResourceKind,
  id: string,
  newId: string,
  label: string,
): Promise<CreateProjectResourceResponse> {
  const response = await fetch("/api/resources/duplicate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, id, newId, label }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
  }
  return response.json();
}

export interface TrashProjectResourceResponse {
  resource: ProjectResourceNode;
  sourcePath: string;
  trashPath: string;
  project: ProjectResponse;
}

export interface StudioTrashEntry {
  trashPath: string;
  sourcePath: string;
  deletedAt: string;
  kind: ProjectResourceKind;
  id: string;
  key: string;
  label: string;
}

export async function fetchStudioTrash(): Promise<StudioTrashEntry[]> {
  const response = await fetch("/api/trash");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json() as { entries?: StudioTrashEntry[] };
  return body.entries ?? [];
}

export interface RestoreStudioTrashResponse {
  entry: StudioTrashEntry;
  resource: ProjectResourceNode;
  project: ProjectResponse;
}

export async function restoreStudioTrashEntry(
  trashPath: string,
): Promise<RestoreStudioTrashResponse> {
  const response = await fetch("/api/trash/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trashPath }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
  }
  return response.json();
}

export async function trashProjectResource(
  kind: ProjectResourceKind,
  id: string,
): Promise<TrashProjectResourceResponse> {
  const response = await fetch(`/api/resources?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
  }
  return response.json();
}

export interface ResourceRenamePlan {
  target: { kind: ProjectResourceKind; id: string; newId: string };
  resource: ProjectResourceNode;
  files: Array<{
    key: string;
    label: string;
    kind: string;
    path: string;
    destinationPath?: string;
    changes: number;
  }>;
  blockers: Array<{ key: string; reason: string }>;
  totalChanges: number;
}

export async function planResourceRename(
  kind: ProjectResourceKind,
  id: string,
  newId: string,
): Promise<ResourceRenamePlan> {
  const response = await fetch("/api/resources/rename-plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, id, newId }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
  }
  return response.json();
}

export interface RenameProjectResourceResponse {
  plan: ResourceRenamePlan;
  resource: ProjectResourceNode;
  project: ProjectResponse;
}

export async function renameProjectResource(
  kind: ProjectResourceKind,
  id: string,
  newId: string,
): Promise<RenameProjectResourceResponse> {
  const response = await fetch("/api/resources/rename", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, id, newId }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
  }
  return response.json();
}

export interface MapPropertiesPatch {
  name?: string;
  description?: string | null;
  difficulty?: number;
  bg?: string | null;
  isExtract?: boolean;
}

export interface MapAuthoringPatch {
  layout?: MapDef["layout"] | null;
  placements?: NonNullable<MapDef["placements"]>;
  properties?: MapPropertiesPatch;
}

/**
 * Build the exact source patch for a map draft. Spatial authoring is sent as
 * a complete value; scalar properties are differences only so an implicit
 * parser default (notably difficulty=1) is never materialized by an unrelated
 * save.
 */
export function buildMapAuthoringPatch(saved: MapDef, draft: MapDef): MapAuthoringPatch {
  const properties: MapPropertiesPatch = {};
  if (saved.name !== draft.name) properties.name = draft.name;
  if (saved.description !== draft.description) {
    properties.description = draft.description.length > 0 ? draft.description : null;
  }
  if (saved.difficulty !== draft.difficulty && draft.difficulty !== undefined) {
    properties.difficulty = draft.difficulty;
  }
  if (saved.bg !== draft.bg) properties.bg = draft.bg ?? null;
  if (Boolean(saved.isExtract) !== Boolean(draft.isExtract)) properties.isExtract = Boolean(draft.isExtract);

  return {
    ...(JSON.stringify(saved.layout ?? null) !== JSON.stringify(draft.layout ?? null)
      ? { layout: draft.layout ?? null }
      : {}),
    ...(JSON.stringify(saved.placements ?? []) !== JSON.stringify(draft.placements ?? [])
      ? { placements: draft.placements ?? [] }
      : {}),
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
  };
}

export async function saveMapDraft(
  saved: MapDef,
  draft: MapDef,
): Promise<ProjectResponse> {
  const response = await fetch(`/api/maps/${encodeURIComponent(saved.id)}/authoring`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildMapAuthoringPatch(saved, draft)),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
  }
  return response.json();
}

export interface MapPreviewResponse {
  mapId: string;
  state: "deterministic-initial";
  source: "saved" | "draft";
  readOnly: true;
  hub: HubActivity[];
  headless: MapAvailableResource[];
  tui: string[];
}

export class MapPreviewRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "MapPreviewRequestError";
  }
}

export async function fetchSavedMapPreview(
  mapId: string,
  signal?: AbortSignal,
): Promise<MapPreviewResponse> {
  return readMapPreviewResponse(fetch(`/api/maps/${encodeURIComponent(mapId)}/preview`, { signal }));
}

export async function fetchMapPreview(
  saved: MapDef,
  draft: MapDef,
  signal?: AbortSignal,
): Promise<MapPreviewResponse> {
  return readMapPreviewResponse(fetch(`/api/maps/${encodeURIComponent(saved.id)}/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildMapAuthoringPatch(saved, draft)),
    signal,
  }));
}

async function readMapPreviewResponse(
  request: Promise<Response>,
): Promise<MapPreviewResponse> {
  const response = await request;
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as {
      error?: unknown;
      code?: unknown;
    };
    throw new MapPreviewRequestError(
      typeof body.error === "string" ? body.error : `HTTP ${response.status}`,
      response.status,
      typeof body.code === "string" ? body.code : undefined,
    );
  }
  return response.json();
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

export async function createAsset(input: CreateAssetInput): Promise<AssetRow> {
  const r = await fetch("/api/assets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(typeof body === "object" && body && "error" in body ? String((body as { error: string }).error) : r.statusText);
  }
  return r.json();
}

export interface AssetTrashEntry {
  trashPath: string;
  sourcePath: string;
  deletedAt: string;
  kind: AssetKind;
  path: string;
  label: string;
}

export async function fetchAssetTrash(): Promise<AssetTrashEntry[]> {
  const response = await fetch("/api/asset-trash");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json() as { entries?: AssetTrashEntry[] };
  return body.entries ?? [];
}

export async function trashAsset(assetPath: string): Promise<{ asset: AssetRow; trashPath: string }> {
  const response = await fetch(`/api/assets?path=${encodeURIComponent(assetPath)}`, { method: "DELETE" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    const error = new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
    (error as Error & { blockers?: string[] }).blockers = Array.isArray(body.blockers) ? body.blockers : [];
    throw error;
  }
  return response.json();
}

export async function restoreAssetTrashEntry(trashPath: string): Promise<{ entry: AssetTrashEntry; asset: AssetRow }> {
  const response = await fetch("/api/asset-trash/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trashPath }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
  }
  return response.json();
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
