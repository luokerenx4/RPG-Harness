import { readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildPresetContext,
  buildProjectResourceGraph,
  collectMapActivities,
  collectMapAvailableResources,
  createInitialState,
  type AssetSpec,
  type ProjectResourceKind,
  type ProjectResourceNode,
  type TuiRenderPrefs,
} from "@rpg-harness/engine";
import { collectDanglingRefs, loadGame } from "@rpg-harness/cli/loader";
import { GameValidationError } from "@rpg-harness/parser";
import { getHealth } from "./health";
import { parseRenderOptions, renderSourceToTuiTxt } from "./render";
import { parsePatchBody, specYamlPath, updateSpec } from "./spec-write";
import {
  previewMapAuthoringPatch,
  updateMapAuthoring,
  type MapAuthoringPatch,
} from "./map-write";
import { resolveMapSource, resolveMapSourceFile } from "./map-source";
import {
  MapTopologyError,
  mapTopologyRevision,
  planMapTopology,
  updateMapTopology,
  type MapTopologyIntent,
} from "./map-topology";
import {
  planReciprocalMapRoutes,
  updateReciprocalMapRoutes,
  type DirectedMapRouteDraft,
  type ReciprocalMapRouteIntent,
} from "./map-routes";
import {
  planMapPlacementRename,
  updateMapPlacementRename,
  verifyMapPlacementRenameSources,
  type MapPlacementRenameIntent,
} from "./map-placement-refactor";
import { readResourceSource, updateResourceSource } from "./resource-source";
import {
  createProjectResource,
  ResourceCreateError,
  type CreatableResourceKind,
  type ResourceCreateOptions,
} from "./resource-create";
import {
  readStudioTrash,
  ResourceDeleteError,
  restoreStudioTrashEntry,
  trashProjectResource,
} from "./resource-delete";
import {
  planProjectResourceRename,
  renameProjectResource,
  ResourceRenameError,
} from "./resource-rename";
import { duplicateProjectResource } from "./resource-duplicate";
import { AssetCreateError, createAssetRecord, validateAssetCreateInput } from "./asset-create";
import {
  AssetDeleteError,
  readAssetTrash,
  restoreAssetTrashEntry,
  trashAsset,
} from "./asset-delete";
import { withProjectSnapshotLock } from "./project-mutation-lock";
import { recoverMapTopologyTransactions } from "./map-topology-journal";
import { withProjectProcessLock } from "./project-process-lock";

interface Ctx {
  gameDir: string;
}

export async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  if (url.pathname !== "/api/health") {
    // Never hold the project snapshot lock while a client is still streaming
    // its request. A stalled upload must not starve unrelated Studio reads.
    let prepared = req;
    if (method !== "GET" && method !== "HEAD") {
      try {
        prepared = new Request(req, { body: await req.arrayBuffer() });
      } catch (error) {
        return json({ error: `failed to read request body: ${(error as Error).message}` }, 400);
      }
    }
    return withProjectSnapshotLock(ctx.gameDir, async () => {
      try {
        return await withProjectProcessLock(ctx.gameDir, async () => {
          await recoverMapTopologyTransactions(ctx.gameDir);
          return route(prepared, ctx, url, method);
        });
      } catch (error) {
        return mapTopologyErrorResponse(error);
      }
    });
  }
  return route(req, ctx, url, method);
}

// Dispatch by URL path + method. Tiny hand-rolled router — Bun.serve
// doesn't ship with one and adding express/hono for a handful of
// routes is overkill. Project reads and writes pass through one project lock so
// no request can observe a partially replaced multi-map transaction.
async function route(
  req: Request,
  ctx: Ctx,
  url: URL,
  method: string,
): Promise<Response> {
  const { pathname } = url;

  if (method === "GET") {
    if (pathname === "/api/health") return getHealthRoute();
    if (pathname === "/api/game") return getGame(ctx);
    if (pathname === "/api/project") return getProject(ctx);
    if (pathname === "/api/resource-source") return getResourceSource(ctx, url);
    if (pathname === "/api/trash") return getStudioTrash(ctx);
    if (pathname === "/api/asset-trash") return getAssetTrash(ctx);
    if (pathname === "/api/assets") return getAssets(ctx);

    const mapPreviewMatch = pathname.match(/^\/api\/maps\/([^/]+)\/preview$/);
    if (mapPreviewMatch?.[1]) {
      return getMapPreview(ctx, decodeURIComponent(mapPreviewMatch[1]));
    }

    // /api/assets/<asset-path>   (asset-path may itself contain slashes)
    const specMatch = pathname.match(/^\/api\/assets\/(.+)$/);
    if (specMatch && specMatch[1]) return getAssetSpec(ctx, specMatch[1]);

    // Raw bytes for renderings, served straight off disk. Paths in the
    // URL are asset paths (e.g. "assets/portraits/kagari-smile") + a
    // suffix indicating which rendering. We deliberately do NOT accept
    // arbitrary fs paths here — only what an AssetSpec.renderings field
    // resolves to.
    const fileMatch = pathname.match(
      /^\/files\/(source|source-quality|source-compressed|tui-txt|tui-ans|web)\/(.+)$/,
    );
    if (fileMatch && fileMatch[1] && fileMatch[2]) {
      return getFile(ctx, fileMatch[1], fileMatch[2]);
    }
  }

  if (method === "POST") {
    if (pathname === "/api/map-placements/rename/preview") {
      return postMapPlacementRenamePreview(ctx, req);
    }
    if (pathname === "/api/map-routes/reciprocal/preview") {
      return postReciprocalMapRoutesPreview(ctx, req);
    }
    const topologyPreviewMatch = pathname.match(/^\/api\/maps\/([^/]+)\/topology\/preview$/);
    if (topologyPreviewMatch?.[1]) {
      return postMapTopologyPreview(ctx, decodeURIComponent(topologyPreviewMatch[1]), req);
    }
    const mapPreviewMatch = pathname.match(/^\/api\/maps\/([^/]+)\/preview$/);
    if (mapPreviewMatch?.[1]) {
      return postMapDraftPreview(ctx, decodeURIComponent(mapPreviewMatch[1]), req);
    }
    if (pathname === "/api/assets") return postAsset(ctx, req);
    if (pathname === "/api/resources") return postProjectResource(ctx, req);
    if (pathname === "/api/resources/duplicate") return postDuplicateProjectResource(ctx, req);
    if (pathname === "/api/resources/rename-plan") return postResourceRenamePlan(ctx, req);
    if (pathname === "/api/trash/restore") return postRestoreStudioTrash(ctx, req);
    if (pathname === "/api/asset-trash/restore") return postRestoreAssetTrash(ctx, req);
    // /api/assets/<asset-path>/source       — upload source.quality.png
    // /api/assets/<asset-path>/render-tui   — invoke chafa
    const m = pathname.match(/^\/api\/assets\/(.+)\/(source|render-tui)$/);
    if (m && m[1] && m[2]) {
      if (m[2] === "source") return postSource(ctx, m[1], req);
      if (m[2] === "render-tui") return postRenderTui(ctx, m[1], req);
    }
  }

  if (method === "PATCH") {
    if (pathname === "/api/map-placements/rename") {
      return patchMapPlacementRename(ctx, req);
    }
    if (pathname === "/api/map-routes/reciprocal") {
      return patchReciprocalMapRoutes(ctx, req);
    }
    if (pathname === "/api/resource-source") return patchResourceSource(ctx, url, req);
    if (pathname === "/api/resources/rename") return patchResourceRename(ctx, req);
    const topologyMatch = pathname.match(/^\/api\/maps\/([^/]+)\/topology$/);
    if (topologyMatch?.[1]) {
      return patchMapTopology(ctx, decodeURIComponent(topologyMatch[1]), req);
    }
    const mapMatch = pathname.match(/^\/api\/maps\/([^/]+)\/(?:authoring|spatial)$/);
    if (mapMatch?.[1]) return patchMapAuthoring(ctx, decodeURIComponent(mapMatch[1]), req);
    // /api/assets/<asset-path>/spec — edit mutable spec fields
    const m = pathname.match(/^\/api\/assets\/(.+)\/spec$/);
    if (m && m[1]) return patchSpec(ctx, m[1], req);
  }

  if (method === "DELETE") {
    if (pathname === "/api/assets") return deleteAsset(ctx, url);
    if (pathname === "/api/resources") return deleteProjectResource(ctx, url);
  }

  return new Response("not found", { status: 404 });
}

async function postAsset(ctx: Ctx, req: Request): Promise<Response> {
  try {
    const input = validateAssetCreateInput(await req.json());
    const { asset } = await createAssetRecord(ctx.gameDir, input, () => loadGame(ctx.gameDir));
    return json(await projectAsset(asset), 201);
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: `invalid JSON body: ${error.message}` }, 400);
    if (error instanceof AssetCreateError) return json({ error: error.message }, error.status);
    return json({ error: `failed to create asset: ${(error as Error).message}` }, 500);
  }
}

async function postDuplicateProjectResource(ctx: Ctx, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch (error) {
    return json({ error: `invalid JSON body: ${(error as Error).message}` }, 400);
  }
  const input = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  if (
    typeof input.kind !== "string" ||
    typeof input.id !== "string" ||
    typeof input.newId !== "string" ||
    typeof input.label !== "string"
  ) {
    return json({ error: "kind, id, newId, and label must be strings" }, 400);
  }
  try {
    const game = await loadGame(ctx.gameDir);
    const duplicated = await duplicateProjectResource(
      ctx.gameDir,
      game,
      input.kind as CreatableResourceKind,
      input.id,
      input.newId,
      input.label,
      () => loadGame(ctx.gameDir),
    );
    return json({
      resource: duplicated.resource,
      source: { path: duplicated.path, source: duplicated.source },
      project: await projectGame(ctx, duplicated.game),
    }, 201);
  } catch (error) {
    return json(
      { error: (error as Error).message },
      error instanceof ResourceCreateError ? error.status : 400,
    );
  }
}

async function postResourceRenamePlan(ctx: Ctx, req: Request): Promise<Response> {
  const input = await readRenameInput(req);
  if (input instanceof Response) return input;
  try {
    const game = await loadGame(ctx.gameDir);
    return json(await planProjectResourceRename(
      ctx.gameDir,
      game,
      input.kind as CreatableResourceKind,
      input.id,
      input.newId,
      await artifactBacklinks(ctx.gameDir, `${input.kind}:${input.id}`),
    ));
  } catch (error) {
    return json(
      { error: (error as Error).message },
      error instanceof ResourceRenameError ? error.status : 400,
    );
  }
}

async function patchResourceRename(ctx: Ctx, req: Request): Promise<Response> {
  const input = await readRenameInput(req);
  if (input instanceof Response) return input;
  try {
    const game = await loadGame(ctx.gameDir);
    const renamed = await renameProjectResource(
      ctx.gameDir,
      game,
      input.kind as CreatableResourceKind,
      input.id,
      input.newId,
      () => loadGame(ctx.gameDir),
      await artifactBacklinks(ctx.gameDir, `${input.kind}:${input.id}`),
    );
    return json({
      plan: renamed.plan,
      resource: renamed.resource,
      project: await projectGame(ctx, renamed.game),
    });
  } catch (error) {
    return json(
      { error: (error as Error).message },
      error instanceof ResourceRenameError ? error.status : 400,
    );
  }
}

async function readRenameInput(req: Request): Promise<
  { kind: string; id: string; newId: string } | Response
> {
  let body: unknown;
  try {
    body = await req.json();
  } catch (error) {
    return json({ error: `invalid JSON body: ${(error as Error).message}` }, 400);
  }
  const input = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  if (typeof input.kind !== "string" || typeof input.id !== "string" || typeof input.newId !== "string") {
    return json({ error: "kind, id, and newId must be strings" }, 400);
  }
  return { kind: input.kind, id: input.id, newId: input.newId };
}

async function artifactBacklinks(gameDir: string, resourceKey: string): Promise<string[]> {
  return (await scanProjectArtifacts(gameDir))
    .filter((artifact) => artifact.refs.includes(resourceKey))
    .map((artifact) => artifact.key);
}

async function getStudioTrash(ctx: Ctx): Promise<Response> {
  return json({ entries: await readStudioTrash(ctx.gameDir) });
}

async function getAssetTrash(ctx: Ctx): Promise<Response> {
  return json({ entries: await readAssetTrash(ctx.gameDir) });
}

async function postRestoreAssetTrash(ctx: Ctx, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch (error) {
    return json({ error: `invalid JSON body: ${(error as Error).message}` }, 400);
  }
  const trashPath = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).trashPath
    : undefined;
  if (typeof trashPath !== "string") return json({ error: "trashPath must be a string" }, 400);
  try {
    const restored = await restoreAssetTrashEntry(ctx.gameDir, trashPath, () => loadGame(ctx.gameDir));
    return json({ entry: restored.entry, asset: await projectAsset(restored.asset) });
  } catch (error) {
    return json(
      { error: (error as Error).message },
      error instanceof AssetDeleteError ? error.status : 400,
    );
  }
}

async function deleteAsset(ctx: Ctx, url: URL): Promise<Response> {
  const assetPath = url.searchParams.get("path");
  if (!assetPath) return json({ error: "path is required" }, 400);
  try {
    const game = await loadGame(ctx.gameDir);
    const trashed = await trashAsset(ctx.gameDir, game, assetPath, () => loadGame(ctx.gameDir));
    return json({ asset: await projectAsset(trashed.asset), trashPath: trashed.trashPath });
  } catch (error) {
    return json(
      {
        error: (error as Error).message,
        blockers: error instanceof AssetDeleteError ? error.blockers : [],
      },
      error instanceof AssetDeleteError ? error.status : 400,
    );
  }
}

async function postRestoreStudioTrash(ctx: Ctx, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch (error) {
    return json({ error: `invalid JSON body: ${(error as Error).message}` }, 400);
  }
  const trashPath = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).trashPath
    : undefined;
  if (typeof trashPath !== "string") return json({ error: "trashPath must be a string" }, 400);
  try {
    const restored = await restoreStudioTrashEntry(
      ctx.gameDir,
      trashPath,
      () => loadGame(ctx.gameDir),
    );
    return json({
      entry: restored.entry,
      resource: restored.resource,
      project: await projectGame(ctx, restored.game),
    });
  } catch (error) {
    return json(
      { error: (error as Error).message },
      error instanceof ResourceDeleteError ? error.status : 400,
    );
  }
}

async function deleteProjectResource(ctx: Ctx, url: URL): Promise<Response> {
  const identity = readResourceIdentity(url);
  if (identity instanceof Response) return identity;
  try {
    const game = await loadGame(ctx.gameDir);
    const resourceKey = `${identity.kind}:${identity.id}`;
    const artifactBlockers = await artifactBacklinks(ctx.gameDir, resourceKey);
    const trashed = await trashProjectResource(
      ctx.gameDir,
      game,
      identity.kind as CreatableResourceKind,
      identity.id,
      () => loadGame(ctx.gameDir),
      undefined,
      artifactBlockers,
    );
    return json({
      resource: trashed.resource,
      sourcePath: trashed.sourcePath,
      trashPath: trashed.trashPath,
      project: await projectGame(ctx, trashed.game),
    });
  } catch (error) {
    return json(
      {
        error: (error as Error).message,
        blockers: error instanceof ResourceDeleteError ? error.blockers : [],
      },
      error instanceof ResourceDeleteError ? error.status : 400,
    );
  }
}

async function postProjectResource(ctx: Ctx, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch (error) {
    return json({ error: `invalid JSON body: ${(error as Error).message}` }, 400);
  }
  const input = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  if (typeof input.kind !== "string" || typeof input.id !== "string" || typeof input.label !== "string") {
    return json({ error: "kind, id, and label must be strings" }, 400);
  }
  try {
    const created = await createProjectResource(
      ctx.gameDir,
      input.kind as CreatableResourceKind,
      input.id,
      input.label,
      () => loadGame(ctx.gameDir),
      input.options && typeof input.options === "object" && !Array.isArray(input.options)
        ? input.options as ResourceCreateOptions
        : {},
    );
    return json({
      resource: created.resource,
      source: { path: created.path, source: created.source },
      project: await projectGame(ctx, created.game),
    }, 201);
  } catch (error) {
    return json(
      { error: (error as Error).message },
      error instanceof ResourceCreateError ? error.status : 400,
    );
  }
}

async function getMapPreview(ctx: Ctx, mapId: string): Promise<Response> {
  try {
    const game = await loadGame(ctx.gameDir);
    const map = (game.maps ?? []).find((candidate) => candidate.id === mapId);
    if (!map) return json({ error: "map not found" }, 404);
    return json(projectMapPreview(game, mapId, "saved"));
  } catch (error) {
    return json({ error: (error as Error).message }, 400);
  }
}

/**
 * Read-only preview of a Studio map draft. The patch is parsed and validated
 * through the exact same in-memory path as Save, then projected without ever
 * invoking updateMapAuthoring or writing the authored source.
 */
async function postMapDraftPreview(
  ctx: Ctx,
  mapId: string,
  req: Request,
): Promise<Response> {
  let game: Awaited<ReturnType<typeof loadGame>>;
  try {
    game = await loadGame(ctx.gameDir);
  } catch (error) {
    return json({ error: (error as Error).message, code: "preview_unavailable" }, 500);
  }
  const map = (game.maps ?? []).find((candidate) => candidate.id === mapId);
  if (!map) return json({ error: "map not found" }, 404);
  const parsed = await readMapAuthoringPatch(req);
  if (parsed instanceof Response) return parsed;
  const abs = await resolveMapSourceFile(ctx.gameDir, mapId);
  if (!abs) return json({ error: "map source file not found" }, 404);
  let original: string;
  try {
    original = await readFile(abs, "utf-8");
  } catch (error) {
    return json({ error: (error as Error).message, code: "preview_unavailable" }, 500);
  }
  let preview: ReturnType<typeof previewMapAuthoringPatch>;
  try {
    preview = previewMapAuthoringPatch(original, game, mapId, parsed, abs);
  } catch (error) {
    return json({ error: (error as Error).message, code: "invalid_map_draft" }, 400);
  }
  try {
    return json(projectMapPreview(preview.game, mapId, "draft"));
  } catch (error) {
    return json({ error: (error as Error).message, code: "preview_unavailable" }, 500);
  }
}

export function projectMapPreview(
  game: Awaited<ReturnType<typeof loadGame>>,
  mapId: string,
  source: "saved" | "draft",
) {
  const state = createInitialState(game, { seed: 0 });
  state.baseline.currentMapId = mapId;
  const preset = buildPresetContext(game, state, () => 0.5);
  const headless = collectMapAvailableResources(preset);
  const hub = collectMapActivities(preset);
  return {
    mapId,
    state: "deterministic-initial" as const,
    source,
    readOnly: true as const,
    hub,
    headless,
    tui: hub.map((activity, index) =>
      `${index === 0 ? ">" : " "} ${activity.title}${activity.available ? "" : `  [LOCKED: ${activity.lockedReason ?? "condition"}]`}`
    ),
  };
}

async function getResourceSource(ctx: Ctx, url: URL): Promise<Response> {
  const identity = readResourceIdentity(url);
  if (identity instanceof Response) return identity;
  try {
    const game = await loadGame(ctx.gameDir);
    return json(await readResourceSource(
      ctx.gameDir,
      game,
      identity.kind,
      identity.id,
    ));
  } catch (error) {
    return json({ error: (error as Error).message }, 404);
  }
}

async function patchResourceSource(
  ctx: Ctx,
  url: URL,
  req: Request,
): Promise<Response> {
  const identity = readResourceIdentity(url);
  if (identity instanceof Response) return identity;
  let body: unknown;
  try {
    body = await req.json();
  } catch (error) {
    return json({ error: `invalid JSON body: ${(error as Error).message}` }, 400);
  }
  const source = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).source
    : undefined;
  if (typeof source !== "string") return json({ error: "source must be a string" }, 400);

  try {
    const game = await loadGame(ctx.gameDir);
    const updated = await updateResourceSource(
      ctx.gameDir,
      game,
      identity.kind,
      identity.id,
      source,
      () => loadGame(ctx.gameDir),
    );
    return json({
      path: updated.path,
      source,
      project: await projectGame(ctx, updated.game),
    });
  } catch (error) {
    return json({ error: (error as Error).message }, 400);
  }
}

function readResourceIdentity(
  url: URL,
): { kind: ProjectResourceKind; id: string } | Response {
  const kind = url.searchParams.get("kind");
  const id = url.searchParams.get("id");
  if (!kind || !id) return json({ error: "kind and id are required" }, 400);
  return { kind: kind as ProjectResourceKind, id };
}

async function getHealthRoute(): Promise<Response> {
  return json(await getHealth());
}

async function getGame(ctx: Ctx): Promise<Response> {
  const game = await loadGame(ctx.gameDir);
  return json({
    id: path.basename(ctx.gameDir),
    title: game.title,
    counts: {
      characters: game.characters.length,
      scripts: game.scripts.length,
      assets: (game.assets ?? []).length,
      maps: (game.maps ?? []).length,
      actions: (game.actions ?? []).length,
      items: (game.items ?? []).length,
      enemies: (game.enemies ?? []).length,
      weapons: (game.weapons ?? []).length,
      skills: (game.skills ?? []).length,
    },
    gameDir: ctx.gameDir,
  });
}

async function getProject(ctx: Ctx): Promise<Response> {
  const game = await loadGame(ctx.gameDir);
  return json(await projectGame(ctx, game));
}

async function projectGame(ctx: Ctx, game: Awaited<ReturnType<typeof loadGame>>) {
  const graph = buildProjectResourceGraph(game);
  const artifacts = await scanProjectArtifacts(ctx.gameDir);
  graph.resources.push(...artifacts);
  graph.resources.sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)
  );
  const resourceKeys = new Set(graph.resources.map((resource) => resource.key));
  for (const artifact of artifacts) {
    for (const ref of artifact.refs) {
      if (resourceKeys.has(ref)) {
        graph.backlinks[ref] = [...new Set([
          ...(graph.backlinks[ref] ?? []),
          artifact.key,
        ])].sort();
      } else {
        const existing = graph.missing.find((candidate) => candidate.key === ref);
        if (existing) {
          existing.referencedBy = [...new Set([...existing.referencedBy, artifact.key])].sort();
        } else {
          graph.missing.push({ key: ref, referencedBy: [artifact.key] });
        }
      }
    }
  }
  graph.missing.sort((left, right) => left.key.localeCompare(right.key));
  graph.unreferenced.push(...artifacts.map((artifact) => artifact.key));
  graph.unreferenced = graph.unreferenced.filter((key) => graph.backlinks[key] === undefined);
  return {
    graph,
    maps: game.maps ?? [],
    switches: game.switches ?? [],
    variables: game.variables ?? [],
    assets: (game.assets ?? []).map(projectAssetPreview),
  };
}

export function projectAssetPreview(asset: AssetSpec) {
  return {
    path: asset.path,
    kind: asset.kind,
    placeholder: asset.placeholder,
    ...(asset.tileGrid ? { tileGrid: asset.tileGrid } : {}),
    renderings: {
      source: asset.renderings.source !== undefined,
      sourceQuality: asset.renderings.sourceQuality !== undefined,
      sourceCompressed: asset.renderings.sourceCompressed !== undefined,
      tuiTxt: asset.renderings.tuiTxt !== undefined,
      tuiAns: asset.renderings.tuiAns !== undefined,
      web: asset.renderings.web !== undefined,
    },
  };
}

export async function scanProjectArtifacts(gameDir: string): Promise<ProjectResourceNode[]> {
  const tests = await readdir(path.join(gameDir, "tests"), { withFileTypes: true })
    .catch(() => []);
  const testNodes = tests
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      kind: "test" as const,
      id: entry.name.replace(/\.ya?ml$/, ""),
      key: `test:${entry.name.replace(/\.ya?ml$/, "")}`,
      label: entry.name.replace(/\.ya?ml$/, ""),
      source: `tests/${entry.name}`,
      editable: false,
      refs: [],
    }));
  const sessionsDir = path.join(gameDir, ".rpg-harness", "sessions");
  const sessions = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const issueGroups = await Promise.all(sessions
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(async (entry) => {
      const session = entry.name;
      return readFile(path.join(sessionsDir, session, "issues.jsonl"), "utf-8")
        .then((content) => content.split(/\r?\n/).flatMap((line, index) => {
          if (!line.trim()) return [];
          try {
            const issue = JSON.parse(line) as Record<string, unknown>;
            const reportId = typeof issue.id === "string" ? issue.id : `line-${index + 1}`;
            const id = `${session}/${reportId}`;
            const title = typeof issue.title === "string" ? issue.title : reportId;
            const status = typeof issue.status === "string" ? issue.status : "open";
            return [{
              kind: "issue" as const,
              id,
              key: `issue:${id}`,
              label: `[${status}] ${title}`,
              editable: false,
              refs: issueResourceRefs(issue),
            }];
          } catch {
            const id = `${session}/invalid-line-${index + 1}`;
            return [{
              kind: "issue" as const,
              id,
              key: `issue:${id}`,
              label: `[invalid] ${session}/issues.jsonl line ${index + 1}`,
              editable: false,
              refs: [],
            }];
          }
        }))
        .catch(() => []);
    }));
  const issueNodes = issueGroups.flat();
  return [...testNodes, ...issueNodes];
}

function issueResourceRefs(issue: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  const target = issue.target;
  if (typeof target === "string") {
    const match = target.match(/^(characters|items|enemies|weapons|skills|maps|scripts|actions)\/([^/]+?)\.(?:ya?ml|md)$/);
    if (match?.[1] && match[2]) {
      const singular = match[1] === "characters" ? "character"
        : match[1] === "items" ? "item"
        : match[1] === "enemies" ? "enemy"
        : match[1] === "weapons" ? "weapon"
        : match[1] === "skills" ? "skill"
        : match[1] === "maps" ? "map"
        : match[1] === "scripts" ? "script"
        : "action";
      refs.add(`${singular}:${match[2]}`);
    }
  }
  const evidence = issue.evidence;
  if (evidence && typeof evidence === "object" && !Array.isArray(evidence)) {
    const record = evidence as Record<string, unknown>;
    if (typeof record.currentScriptId === "string") {
      refs.add(`script:${record.currentScriptId}`);
    }
    const sourceTargets = record.sourceTargets;
    if (Array.isArray(sourceTargets)) {
      for (const value of sourceTargets) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const source = value as Record<string, unknown>;
        if (typeof source.scriptId === "string") refs.add(`script:${source.scriptId}`);
        if (typeof source.moduleId === "string") refs.add(`module:${source.moduleId}`);
      }
    }
  }
  return [...refs].sort();
}

async function patchMapAuthoring(
  ctx: Ctx,
  mapId: string,
  req: Request,
): Promise<Response> {
  const game = await loadGame(ctx.gameDir);
  const map = (game.maps ?? []).find((candidate) => candidate.id === mapId);
  if (!map) return json({ error: "map not found" }, 404);
  const patch = await readMapAuthoringPatch(req);
  if (patch instanceof Response) return patch;

  const abs = await resolveMapSourceFile(ctx.gameDir, mapId);
  if (!abs) return json({ error: "map source file not found" }, 404);
  let updated: Awaited<ReturnType<typeof updateMapAuthoring>>;
  try {
    updated = await updateMapAuthoring(
      abs,
      game,
      mapId,
      patch,
      () => loadGame(ctx.gameDir),
    );
  } catch (error) {
    return json({ error: (error as Error).message }, 400);
  }
  return json(await projectGame(ctx, updated.game));
}

async function postMapPlacementRenamePreview(
  ctx: Ctx,
  req: Request,
): Promise<Response> {
  const parsed = await readMapPlacementRenameIntent(req);
  if (parsed instanceof Response) return parsed;
  try {
    await requireMapTopologySource(ctx.gameDir, parsed.mapId);
    const game = await loadGame(ctx.gameDir);
    const plan = planMapPlacementRename(game, parsed);
    const sources = new Map<string, string>();
    for (const id of plan.changedIds) {
      sources.set(id, await requireMapTopologySource(ctx.gameDir, id));
    }
    await verifyMapPlacementRenameSources(sources, plan, parsed);
    return json({
      revision: plan.revision,
      targetKey: plan.targetKey,
      backlinks: plan.backlinks,
      changedIds: plan.changedIds,
    });
  } catch (error) {
    return mapPlacementRefactorErrorResponse(error);
  }
}

async function patchMapPlacementRename(
  ctx: Ctx,
  req: Request,
): Promise<Response> {
  const parsed = await readMapPlacementRenameIntent(req);
  if (parsed instanceof Response) return parsed;
  if (parsed.expectedRevision === undefined) {
    return json({
      error: "expectedRevision is required; preview this placement refactor before applying it",
      code: "map_placement_preview_required",
    }, 409);
  }
  try {
    await requireMapTopologySource(ctx.gameDir, parsed.mapId);
    const game = await loadGame(ctx.gameDir);
    const plan = planMapPlacementRename(game, parsed);
    const sources = new Map<string, string>();
    for (const id of plan.changedIds) {
      sources.set(id, await requireMapTopologySource(ctx.gameDir, id));
    }
    await verifyMapPlacementRenameSources(sources, plan, parsed);
    // Prove that the projected Studio response is representable before writes.
    await projectGame(ctx, plan.game);
    let project: Awaited<ReturnType<typeof projectGame>> | undefined;
    const updated = await updateMapPlacementRename(
      sources,
      parsed,
      () => loadGame(ctx.gameDir),
      async (updatedGame) => {
        for (const [id, expectedSource] of sources) {
          const authoritativeSource = await requireMapTopologySource(ctx.gameDir, id);
          if (authoritativeSource !== expectedSource) {
            throw new MapTopologyError(
              `map source authority changed during placement refactor reload: ${id}`,
              409,
              "stale_map_source",
            );
          }
        }
        project = await projectGame(ctx, updatedGame);
      },
    );
    if (!project) throw new Error("map placement response projection was not produced");
    return json({
      changedIds: updated.changedIds,
      newPlacementId: parsed.newPlacementId,
      project,
    });
  } catch (error) {
    return mapPlacementRefactorErrorResponse(error);
  }
}

async function postReciprocalMapRoutesPreview(
  ctx: Ctx,
  req: Request,
): Promise<Response> {
  const parsed = await readReciprocalMapRouteIntent(req);
  if (parsed instanceof Response) return parsed;
  try {
    await requireReciprocalMapRouteSources(ctx.gameDir, parsed);
    const game = await loadGame(ctx.gameDir);
    const plan = planReciprocalMapRoutes(game, parsed);
    return json({
      revision: plan.revision,
      changedIds: plan.changedIds,
      routes: plan.routes,
    });
  } catch (error) {
    return mapRouteErrorResponse(error);
  }
}

async function patchReciprocalMapRoutes(
  ctx: Ctx,
  req: Request,
): Promise<Response> {
  const parsed = await readReciprocalMapRouteIntent(req);
  if (parsed instanceof Response) return parsed;
  if (parsed.expectedRevision === undefined) {
    return json({
      error: "expectedRevision is required; preview these reciprocal routes before applying them",
      code: "map_route_preview_required",
    }, 409);
  }
  try {
    const sources = await requireReciprocalMapRouteSources(ctx.gameDir, parsed);
    const game = await loadGame(ctx.gameDir);
    const plan = planReciprocalMapRoutes(game, parsed);
    for (const id of plan.changedIds) {
      if (!sources.has(id)) {
        throw new MapTopologyError(`map source file not found: ${id}`, 404);
      }
    }
    await projectGame(ctx, plan.game);
    let project: Awaited<ReturnType<typeof projectGame>> | undefined;
    const updated = await updateReciprocalMapRoutes(
      sources,
      parsed,
      () => loadGame(ctx.gameDir),
      async (updatedGame) => {
        for (const [id, expectedSource] of sources) {
          const authoritativeSource = await requireMapTopologySource(ctx.gameDir, id);
          if (authoritativeSource !== expectedSource) {
            throw new MapTopologyError(
              `map source authority changed during reciprocal route reload: ${id}`,
              409,
              "stale_map_source",
            );
          }
        }
        project = await projectGame(ctx, updatedGame);
      },
    );
    if (!project) throw new Error("map route response projection was not produced");
    return json({ changedIds: updated.changedIds, project });
  } catch (error) {
    return mapRouteErrorResponse(error);
  }
}

async function postMapTopologyPreview(
  ctx: Ctx,
  mapId: string,
  req: Request,
): Promise<Response> {
  const parsed = await readMapTopologyIntent(req, mapId);
  if (parsed instanceof Response) return parsed;
  try {
    await requireMapTopologySource(ctx.gameDir, mapId);
    const game = await loadGame(ctx.gameDir);
    const plan = planMapTopology(game, parsed);
    for (const assignment of plan.assignments) {
      await requireMapTopologySource(ctx.gameDir, assignment.id);
    }
    return json({
      revision: mapTopologyRevision(game),
      changedIds: plan.changedIds,
      assignments: plan.assignments,
    });
  } catch (error) {
    return mapTopologyErrorResponse(error);
  }
}

async function patchMapTopology(
  ctx: Ctx,
  mapId: string,
  req: Request,
): Promise<Response> {
  const parsed = await readMapTopologyIntent(req, mapId);
  if (parsed instanceof Response) return parsed;
  if (parsed.expected.revision === undefined) {
    return json({
      error: "expected.revision is required; preview this topology change before applying it",
      code: "map_topology_preview_required",
    }, 409);
  }
  try {
    await requireMapTopologySource(ctx.gameDir, mapId);
    const game = await loadGame(ctx.gameDir);
    const plan = planMapTopology(game, parsed);
    const sources = new Map<string, string>();
    for (const assignment of plan.assignments) {
      const source = await requireMapTopologySource(ctx.gameDir, assignment.id);
      sources.set(assignment.id, source);
    }
    // Projection is part of the transaction contract: a response that cannot
    // be represented in Studio must fail before any source is replaced.
    await projectGame(ctx, plan.game);
    let project: Awaited<ReturnType<typeof projectGame>> | undefined;
    const updated = await updateMapTopology(
      sources,
      parsed,
      () => loadGame(ctx.gameDir),
      async (updatedGame) => {
        for (const [id, expectedSource] of sources) {
          const authoritativeSource = await requireMapTopologySource(ctx.gameDir, id);
          if (authoritativeSource !== expectedSource) {
            throw new MapTopologyError(
              `map source authority changed during topology reload: ${id}`,
              409,
              "stale_map_source",
            );
          }
        }
        project = await projectGame(ctx, updatedGame);
      },
    );
    if (!project) throw new Error("map topology response projection was not produced");
    return json({
      changedIds: updated.changedIds,
      project,
    });
  } catch (error) {
    return mapTopologyErrorResponse(error);
  }
}

async function requireMapTopologySource(gameDir: string, mapId: string): Promise<string> {
  const resolution = await resolveMapSource(gameDir, mapId);
  if (resolution.kind === "found") return resolution.path;
  if (resolution.kind === "ambiguous") {
    throw new MapTopologyError(
      `map source is ambiguous for ${mapId}: ${resolution.paths.join(", ")}`,
      409,
      "ambiguous_map_source",
    );
  }
  if (resolution.kind === "mismatched") {
    throw new MapTopologyError(
      `map source identity mismatch for ${mapId}: found ${resolution.actualId} in ${resolution.path}`,
      409,
      "mismatched_map_source",
    );
  }
  if (resolution.kind === "invalid") {
    throw new MapTopologyError(
      `map source is invalid for ${mapId}: ${resolution.error}`,
      422,
    );
  }
  throw new MapTopologyError(`map source file not found: ${mapId}`, 404);
}

async function requireReciprocalMapRouteSources(
  gameDir: string,
  intent: ReciprocalMapRouteIntent,
): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for (const id of new Set([
    intent.forward.sourceMapId,
    intent.reverse.sourceMapId,
  ])) {
    sources.set(id, await requireMapTopologySource(gameDir, id));
  }
  return sources;
}

function mapTopologyErrorResponse(error: unknown): Response {
  const status = error instanceof MapTopologyError
    ? error.status
    : error instanceof GameValidationError
      ? 422
      : 500;
  return json({
    error: error instanceof Error ? error.message : String(error),
    code: error instanceof MapTopologyError
      ? error.code
      : status === 422
        ? "invalid_map_topology"
        : status >= 500
          ? "map_topology_unavailable"
          : "invalid_map_topology",
  }, status);
}

function mapRouteErrorResponse(error: unknown): Response {
  const status = error instanceof MapTopologyError
    ? error.status
    : error instanceof GameValidationError
      ? 422
      : 500;
  return json({
    error: error instanceof Error ? error.message : String(error),
    code: error instanceof MapTopologyError
      ? (error.code === "invalid_map_topology" ? "invalid_map_routes" : error.code)
      : status === 422
        ? "invalid_map_routes"
        : "map_routes_unavailable",
  }, status);
}

function mapPlacementRefactorErrorResponse(error: unknown): Response {
  const status = error instanceof MapTopologyError
    ? error.status
    : error instanceof GameValidationError
      ? 422
      : 500;
  return json({
    error: error instanceof Error ? error.message : String(error),
    code: error instanceof MapTopologyError
      ? (error.code === "invalid_map_topology" ? "invalid_map_placement_refactor" : error.code)
      : status === 422
        ? "invalid_map_placement_refactor"
        : "map_placement_refactor_unavailable",
  }, status);
}

async function readMapPlacementRenameIntent(
  req: Request,
): Promise<MapPlacementRenameIntent | Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch (error) {
    return json({ error: `invalid JSON body: ${(error as Error).message}` }, 400);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return json({ error: "body must be an object" }, 400);
  }
  const body = raw as Record<string, unknown>;
  const unexpected = Object.keys(body).find((key) =>
    !["mapId", "placementId", "newPlacementId", "expectedRevision"].includes(key)
  );
  if (unexpected) {
    return json({ error: `unknown map placement refactor field: ${unexpected}` }, 400);
  }
  for (const field of ["mapId", "placementId", "newPlacementId"] as const) {
    if (typeof body[field] !== "string" || body[field].length === 0) {
      return json({ error: `${field} must be a non-empty string` }, 400);
    }
  }
  if (body.expectedRevision !== undefined && (
    typeof body.expectedRevision !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(body.expectedRevision)
  )) {
    return json({ error: "expectedRevision must be a sha256 placement revision" }, 400);
  }
  return {
    mapId: body.mapId as string,
    placementId: body.placementId as string,
    newPlacementId: body.newPlacementId as string,
    ...(typeof body.expectedRevision === "string"
      ? { expectedRevision: body.expectedRevision }
      : {}),
  };
}

async function readReciprocalMapRouteIntent(
  req: Request,
): Promise<ReciprocalMapRouteIntent | Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch (error) {
    return json({ error: `invalid JSON body: ${(error as Error).message}` }, 400);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return json({ error: "body must be an object" }, 400);
  }
  const body = raw as Record<string, unknown>;
  const unexpected = Object.keys(body).find((key) =>
    !["expectedRevision", "forward", "reverse"].includes(key)
  );
  if (unexpected) return json({ error: `unknown reciprocal route field: ${unexpected}` }, 400);
  if (body.expectedRevision !== undefined && (
    typeof body.expectedRevision !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(body.expectedRevision)
  )) {
    return json({ error: "expectedRevision must be a sha256 route revision" }, 400);
  }
  const forward = parseDirectedMapRoute(body.forward, "forward");
  if (typeof forward === "string") return json({ error: forward }, 400);
  const reverse = parseDirectedMapRoute(body.reverse, "reverse");
  if (typeof reverse === "string") return json({ error: reverse }, 400);
  return {
    ...(typeof body.expectedRevision === "string"
      ? { expectedRevision: body.expectedRevision }
      : {}),
    forward,
    reverse,
  };
}

function parseDirectedMapRoute(
  raw: unknown,
  label: string,
): DirectedMapRouteDraft | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return `${label} must be an object`;
  }
  const route = raw as Record<string, unknown>;
  const allowed = [
    "sourceMapId",
    "targetMapId",
    "placementId",
    "at",
    "eventId",
    "label",
    "trigger",
    "arrival",
  ];
  const unexpected = Object.keys(route).find((key) => !allowed.includes(key));
  if (unexpected) return `unknown ${label} route field: ${unexpected}`;
  for (const field of [
    "sourceMapId",
    "targetMapId",
    "placementId",
    "eventId",
    "label",
    "trigger",
  ] as const) {
    if (typeof route[field] !== "string" || route[field].trim().length === 0) {
      return `${label}.${field} must be a non-blank string`;
    }
  }
  const at = parseMapRoutePoint(route.at, `${label}.at`);
  if (typeof at === "string") return at;
  const arrival = route.arrival === undefined
    ? undefined
    : parseMapRouteArrival(route.arrival, `${label}.arrival`);
  if (typeof arrival === "string") return arrival;
  return {
    sourceMapId: route.sourceMapId as string,
    targetMapId: route.targetMapId as string,
    placementId: route.placementId as string,
    at,
    eventId: route.eventId as string,
    label: route.label as string,
    trigger: route.trigger as DirectedMapRouteDraft["trigger"],
    ...(arrival ? { arrival } : {}),
  };
}

function parseMapRouteArrival(
  raw: unknown,
  label: string,
): NonNullable<DirectedMapRouteDraft["arrival"]> | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return `${label} must be an object`;
  }
  const arrival = raw as Record<string, unknown>;
  const unexpected = Object.keys(arrival).find((key) => !["placementId", "at"].includes(key));
  if (unexpected) return `unknown ${label} field: ${unexpected}`;
  const hasPlacement = arrival.placementId !== undefined;
  const hasPoint = arrival.at !== undefined;
  if (hasPlacement === hasPoint) return `${label} must declare exactly one of placementId or at`;
  if (hasPlacement) {
    return typeof arrival.placementId === "string" && arrival.placementId.trim().length > 0
      ? { placementId: arrival.placementId }
      : `${label}.placementId must be a non-blank string`;
  }
  const at = parseMapRoutePoint(arrival.at, `${label}.at`);
  return typeof at === "string" ? at : { at };
}

function parseMapRoutePoint(
  raw: unknown,
  label: string,
): { x: number; y: number } | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return `${label} must be an object`;
  }
  const point = raw as Record<string, unknown>;
  const unexpected = Object.keys(point).find((key) => !["x", "y"].includes(key));
  if (unexpected) return `unknown ${label} field: ${unexpected}`;
  if (
    !Number.isInteger(point.x) || !Number.isInteger(point.y) ||
    (point.x as number) < 0 || (point.y as number) < 0
  ) {
    return `${label} must contain non-negative integer x and y coordinates`;
  }
  return { x: point.x as number, y: point.y as number };
}

async function readMapTopologyIntent(
  req: Request,
  mapId: string,
): Promise<MapTopologyIntent | Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch (error) {
    return json({ error: `invalid JSON body: ${(error as Error).message}` }, 400);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return json({ error: "body must be an object" }, 400);
  }
  const body = raw as Record<string, unknown>;
  const unexpected = Object.keys(body).find((key) =>
    !["expected", "destination", "sourceReplacementEntryId"].includes(key)
  );
  if (unexpected) return json({ error: `unknown topology field: ${unexpected}` }, 400);
  if (!body.expected || typeof body.expected !== "object" || Array.isArray(body.expected)) {
    return json({ error: "expected must be an object" }, 400);
  }
  if (!body.destination || typeof body.destination !== "object" || Array.isArray(body.destination)) {
    return json({ error: "destination must be an object" }, 400);
  }
  const expected = body.expected as Record<string, unknown>;
  const destination = body.destination as Record<string, unknown>;
  const unexpectedExpected = Object.keys(expected).find((key) =>
    !["chain", "isEntry", "sourceEntryId", "destinationEntryId", "revision"].includes(key)
  );
  if (unexpectedExpected) {
    return json({ error: `unknown expected topology field: ${unexpectedExpected}` }, 400);
  }
  const unexpectedDestination = Object.keys(destination).find((key) =>
    !["chain", "entry"].includes(key)
  );
  if (unexpectedDestination) {
    return json({ error: `unknown destination topology field: ${unexpectedDestination}` }, 400);
  }
  for (const [scope, record] of [["expected", expected], ["destination", destination]] as const) {
    const chain = record.chain;
    if (chain !== null && typeof chain !== "string") {
      return json({ error: `${scope}.chain must be a string or null` }, 400);
    }
    if (chain === "") {
      return json({ error: `${scope}.chain must be non-empty or null` }, 400);
    }
  }
  if (typeof expected.isEntry !== "boolean") {
    return json({ error: "expected.isEntry must be a boolean" }, 400);
  }
  if (expected.revision !== undefined && (
    typeof expected.revision !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(expected.revision)
  )) {
    return json({ error: "expected.revision must be a sha256 topology revision" }, 400);
  }
  for (const key of ["sourceEntryId", "destinationEntryId"] as const) {
    const value = expected[key];
    if (value !== null && typeof value !== "string") {
      return json({ error: `expected.${key} must be a string or null` }, 400);
    }
  }
  if (destination.entry !== "keep-existing" && destination.entry !== "make-selected") {
    return json({ error: "destination.entry must be keep-existing or make-selected" }, 400);
  }
  if (
    body.sourceReplacementEntryId !== undefined &&
    (typeof body.sourceReplacementEntryId !== "string" || body.sourceReplacementEntryId.length === 0)
  ) {
    return json({ error: "sourceReplacementEntryId must be a non-empty string" }, 400);
  }
  return {
    mapId,
    expected: {
      chain: expected.chain as string | null,
      isEntry: expected.isEntry,
      sourceEntryId: expected.sourceEntryId as string | null,
      destinationEntryId: expected.destinationEntryId as string | null,
      ...(typeof expected.revision === "string" ? { revision: expected.revision } : {}),
    },
    destination: {
      chain: destination.chain as string | null,
      entry: destination.entry,
    },
    ...(typeof body.sourceReplacementEntryId === "string"
      ? { sourceReplacementEntryId: body.sourceReplacementEntryId }
      : {}),
  };
}

async function readMapAuthoringPatch(req: Request): Promise<MapAuthoringPatch | Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch (error) {
    return json({ error: `invalid JSON body: ${(error as Error).message}` }, 400);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return json({ error: "body must be an object" }, 400);
  }
  const body = raw as Record<string, unknown>;
  const unexpectedTopLevel = Object.keys(body).find((key) => !["layout", "placements", "properties"].includes(key));
  if (unexpectedTopLevel) return json({ error: `unknown map patch field: ${unexpectedTopLevel}` }, 400);
  if (Object.keys(body).length === 0) return json({ error: "map patch must contain a change" }, 400);
  if (
    body.layout !== undefined &&
    !(body.layout === null || (body.layout && typeof body.layout === "object" && !Array.isArray(body.layout)))
  ) {
    return json({ error: "layout must be an object or null" }, 400);
  }
  if (body.placements !== undefined && !Array.isArray(body.placements)) {
    return json({ error: "placements must be an array" }, 400);
  }
  if (body.properties !== undefined) {
    if (!body.properties || typeof body.properties !== "object" || Array.isArray(body.properties)) {
      return json({ error: "properties must be an object" }, 400);
    }
    const properties = body.properties as Record<string, unknown>;
    const allowed = new Set([
      "name",
      "description",
      "difficulty",
      "bg",
      "isExtract",
    ]);
    const unexpected = Object.keys(properties).find((key) => !allowed.has(key));
    if (unexpected) return json({ error: `unknown map property: ${unexpected}` }, 400);
    if (properties.name !== undefined && typeof properties.name !== "string") {
      return json({ error: "properties.name must be a string" }, 400);
    }
    for (const key of ["description", "bg"] as const) {
      const value = properties[key];
      if (value !== undefined && value !== null && typeof value !== "string") {
        return json({ error: `properties.${key} must be a string or null` }, 400);
      }
    }
    if (
      properties.difficulty !== undefined &&
      (typeof properties.difficulty !== "number" || !Number.isFinite(properties.difficulty))
    ) {
      return json({ error: "properties.difficulty must be a finite number" }, 400);
    }
    for (const key of ["isExtract"] as const) {
      const value = properties[key];
      if (value !== undefined && typeof value !== "boolean") {
        return json({ error: `properties.${key} must be a boolean` }, 400);
      }
    }
  }
  return body as unknown as MapAuthoringPatch;
}

async function getAssets(ctx: Ctx): Promise<Response> {
  const game = await loadGame(ctx.gameDir);
  // Mirror the AssetSpec shape but flatten `renderings` into a
  // simple availability map — the web client doesn't need absolute
  // file paths (those are server-internal). For actual bytes, the
  // client GETs /files/<slot>/<asset-path>.
  const rows = await Promise.all(
    (game.assets ?? []).map((a) => projectAsset(a)),
  );
  // Ghost references ride along: paths scripts/characters point at
  // with no spec behind them. The gallery renders them as warning
  // cards so an author catches a typo'd or unwritten asset here
  // instead of mid-playthrough.
  const dangling = collectDanglingRefs(game, game.assets ?? []);
  return json({ assets: rows, dangling });
}

async function getAssetSpec(ctx: Ctx, assetPath: string): Promise<Response> {
  const game = await loadGame(ctx.gameDir);
  const spec = (game.assets ?? []).find((a) => a.path === assetPath);
  if (!spec) return json({ error: "asset not found" }, 404);
  return json(await projectAsset(spec));
}

async function projectAsset(a: AssetSpec) {
  // Tier file sizes for studio's compression-comparison UI. fs.stat
  // is cheap; we already touched these files during the loader walk
  // so the OS cache is warm. Missing slot → undefined size.
  const [qBytes, cBytes] = await Promise.all([
    statBytes(a.renderings.sourceQuality),
    statBytes(a.renderings.sourceCompressed),
  ]);
  return {
    path: a.path,
    kind: a.kind,
    description: a.description,
    prompt: a.prompt,
    placeholder: a.placeholder,
    ...(a.styleRef !== undefined ? { styleRef: a.styleRef } : {}),
    ...(a.refs !== undefined ? { refs: a.refs } : {}),
    ...(a.sizeHint !== undefined ? { sizeHint: a.sizeHint } : {}),
    ...(a.tileGrid !== undefined ? { tileGrid: a.tileGrid } : {}),
    ...(a.tags !== undefined ? { tags: a.tags } : {}),
    ...(a.tuiRender !== undefined ? { tuiRender: a.tuiRender } : {}),
    renderings: {
      source: a.renderings.source !== undefined,
      sourceQuality: a.renderings.sourceQuality !== undefined,
      sourceCompressed: a.renderings.sourceCompressed !== undefined,
      tuiTxt: a.renderings.tuiTxt !== undefined,
      tuiAns: a.renderings.tuiAns !== undefined,
      web: a.renderings.web !== undefined,
    },
    ...(qBytes !== undefined ? { sourceQualityBytes: qBytes } : {}),
    ...(cBytes !== undefined ? { sourceCompressedBytes: cBytes } : {}),
  };
}

async function statBytes(abs: string | undefined): Promise<number | undefined> {
  if (!abs) return undefined;
  try {
    return (await stat(abs)).size;
  } catch {
    return undefined;
  }
}

async function getFile(
  ctx: Ctx,
  slot: string,
  assetPath: string,
): Promise<Response> {
  const game = await loadGame(ctx.gameDir);
  const spec = (game.assets ?? []).find((a) => a.path === assetPath);
  if (!spec) return new Response("asset not found", { status: 404 });

  // Resolve slot → the absolute path the loader discovered. We trust
  // ONLY these paths — never construct a path from the URL ourselves.
  // That keeps the slot-vs-path-traversal attack surface zero.
  const abs = slotPath(spec, slot);
  if (!abs) return new Response("rendering not present", { status: 404 });

  // Defense in depth: even though the path came from a spec the
  // server itself loaded, refuse anything outside gameDir. A malicious
  // spec.yaml with `tui_txt: ../../../../etc/passwd` would otherwise
  // be reachable; the loader currently doesn't validate paths beyond
  // the spec dir but it's cheap to guard here.
  const rel = path.relative(ctx.gameDir, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return new Response("forbidden", { status: 403 });
  }

  const bytes = await readFile(abs);
  return new Response(bytes, {
    headers: { "content-type": mimeFor(abs) },
  });
}

function slotPath(
  spec: AssetSpec,
  slot: string,
): string | undefined {
  if (slot === "source") return spec.renderings.source;
  if (slot === "source-quality") return spec.renderings.sourceQuality;
  if (slot === "source-compressed") return spec.renderings.sourceCompressed;
  if (slot === "tui-txt") return spec.renderings.tuiTxt;
  if (slot === "tui-ans") return spec.renderings.tuiAns;
  if (slot === "web") return spec.renderings.web;
  return undefined;
}

// ─────────────────────────────────────────────────────────────────
// Write ops
// ─────────────────────────────────────────────────────────────────

// POST /api/assets/<asset-path>/source
//
// Accepts either multipart/form-data (field "file") OR a raw image/*
// body. PNG only — v2 keeps the rendering pipeline to one format so
// chafa input is predictable. The file is written as <asset-dir>/
// source.quality.png atomically (write to .tmp + rename) so a
// half-finished upload never leaves a torn file that the next
// render-tui would consume. (`source.quality.png` is the high-res
// master tier; cf. the source.{quality,compressed}.* convention in
// engine/types.ts AssetRenderings comment.)
async function postSource(
  ctx: Ctx,
  assetPath: string,
  req: Request,
): Promise<Response> {
  const dir = await resolveAssetDir(ctx, assetPath);
  if (!dir) return json({ error: "asset not found" }, 404);

  const bytes = await readUploadedImage(req);
  if (!bytes) {
    return json(
      { error: "expected multipart/form-data 'file' or image/* body" },
      400,
    );
  }
  if (!looksLikePng(bytes)) {
    return json({ error: "only image/png is accepted in v2" }, 415);
  }

  const final = path.join(dir, "source.quality.png");
  const tmp = final + ".tmp";
  await writeFile(tmp, bytes);
  await rename(tmp, final).catch(async (err) => {
    // Clean up the .tmp if rename failed; surface the original error.
    await unlink(tmp).catch(() => {});
    throw err;
  });

  return projectedAssetResponse(ctx, assetPath);
}

// POST /api/assets/<asset-path>/render-tui
//
// Body: { symbols?, cols?, rows?, dither? } — all optional. Empty
// body preserves v2-original behavior (block / spec.sizeHint / no
// dither). Caller-supplied cols/rows override spec.sizeHint.
async function postRenderTui(
  ctx: Ctx,
  assetPath: string,
  req: Request,
): Promise<Response> {
  const game = await loadGame(ctx.gameDir);
  const spec = (game.assets ?? []).find((a) => a.path === assetPath);
  if (!spec) return json({ error: "asset not found" }, 404);

  // Parse + validate options. Empty body OK (the no-op case);
  // malformed JSON → 400 with the parse error verbatim.
  let parsedOptions: ReturnType<typeof parseRenderOptions> = { options: {} };
  if ((req.headers.get("content-length") ?? "0") !== "0") {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch (err) {
      return json({ error: `invalid JSON body: ${(err as Error).message}` }, 400);
    }
    parsedOptions = parseRenderOptions(raw);
  }
  if ("error" in parsedOptions) {
    return json({ error: parsedOptions.error }, 400);
  }
  const opts = parsedOptions.options;

  const health = await getHealth();
  if (!health.chafa.present) {
    // 503 not 500: the server itself is fine; an optional dependency
    // is missing. The UI surfaces the install hint from /api/health.
    return json(
      {
        error:
          "chafa not installed. install with `brew install chafa` (macOS) and restart studio",
      },
      503,
    );
  }
  if (!spec.renderings.source) {
    // 412 (precondition failed) — caller needs to upload source.quality.png
    // first. Distinct from 404 so the UI can wire "upload" as the
    // hint instead of "asset gone".
    return json({ error: "no source.quality.png — upload one first" }, 412);
  }

  const dir = await resolveAssetDir(ctx, assetPath);
  if (!dir) return json({ error: "asset not found" }, 404);

  try {
    await renderSourceToTuiTxt({
      sourcePath: spec.renderings.source,
      outDir: dir,
      // Caller cols/rows win; fall back to spec hint; finally chafa
      // picks its own (terminal-derived) if both are absent.
      sizeCols: opts.cols ?? spec.sizeHint?.tui?.cols,
      sizeRows: opts.rows ?? spec.sizeHint?.tui?.rows,
      ...(opts.symbols !== undefined ? { symbols: opts.symbols } : {}),
      ...(opts.dither !== undefined ? { dither: opts.dither } : {}),
      ...(opts.colors !== undefined ? { colors: opts.colors } : {}),
    });
  } catch (err) {
    return json({ error: `chafa failed: ${(err as Error).message}` }, 500);
  }

  // Auto-persist the options the author just used. Only fields they
  // explicitly set go into spec.tui_render — defaults (when the user
  // left a dropdown on "(default: X)") stay out so the YAML stays
  // minimal. Best-effort: a write failure here doesn't fail the
  // whole render, since the chafa output already landed on disk.
  try {
    const persistFields: TuiRenderPrefs = {};
    if (opts.symbols !== undefined) persistFields.symbols = opts.symbols;
    if (opts.dither !== undefined) persistFields.dither = opts.dither;
    if (opts.colors !== undefined) persistFields.colors = opts.colors;
    if (opts.cols !== undefined) persistFields.cols = opts.cols;
    if (opts.rows !== undefined) persistFields.rows = opts.rows;
    if (Object.keys(persistFields).length > 0) {
      await updateSpec(specYamlPath(ctx.gameDir, assetPath), {
        tuiRender: persistFields,
      });
    }
  } catch (err) {
    process.stderr.write(
      `[studio] failed to persist render prefs to spec.yaml: ${(err as Error).message}\n`,
    );
  }

  return projectedAssetResponse(ctx, assetPath);
}

// PATCH /api/assets/<asset-path>/spec
//
// Body: { description?, prompt?, placeholder?, styleRef?, refs?,
//         sizeHint?, tags?, tuiRender? } — all optional. Rejects any
// other keys (kind, path, custom, renderings) with 400. Writes via
// the Document API to preserve hand-authored comments and key order.
async function patchSpec(
  ctx: Ctx,
  assetPath: string,
  req: Request,
): Promise<Response> {
  // Confirm the asset exists before touching disk — same warning-only
  // pathway the other write endpoints use.
  const game = await loadGame(ctx.gameDir);
  const spec = (game.assets ?? []).find((a) => a.path === assetPath);
  if (!spec) return json({ error: "asset not found" }, 404);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch (err) {
    return json({ error: `invalid JSON body: ${(err as Error).message}` }, 400);
  }
  const parsed = parsePatchBody(raw);
  if ("error" in parsed) return json({ error: parsed.error }, 400);
  if (parsed.fields.tileGrid !== undefined && spec.kind !== "tileset") {
    return json({ error: "tileGrid is only editable for tileset assets" }, 400);
  }

  if (Object.keys(parsed.fields).length === 0) {
    // Nothing to do but report success with the current asset state
    // so the client doesn't need a separate refetch.
    return projectedAssetResponse(ctx, assetPath);
  }

  try {
    await updateSpec(specYamlPath(ctx.gameDir, assetPath), parsed.fields);
  } catch (err) {
    return json({ error: `failed to write spec.yaml: ${(err as Error).message}` }, 500);
  }

  return projectedAssetResponse(ctx, assetPath);
}

// Look up the asset's directory on disk from its asset-path. We don't
// derive the dir by `path.join(gameDir, assetPath)` directly — instead
// we load the game, find the spec, and use the loader's resolved
// rendering paths to back out the directory. This way only assets the
// loader itself enumerated are reachable; an attacker-supplied URL
// path can't land outside `assets/{portraits,backgrounds,cgs}/<slug>/`.
async function resolveAssetDir(
  ctx: Ctx,
  assetPath: string,
): Promise<string | undefined> {
  const game = await loadGame(ctx.gameDir);
  const spec = (game.assets ?? []).find((a) => a.path === assetPath);
  if (!spec) return undefined;
  // The loader produces an asset-path string of the form
  // "assets/<kind>s/<slug>" and never anything else; joining is safe.
  const dir = path.join(ctx.gameDir, ...assetPath.split("/"));
  // Defense in depth: guard against `assetPath` containing `..` even
  // though the loader's spec list wouldn't legitimately yield one.
  const rel = path.relative(ctx.gameDir, dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return dir;
}

// Reload game + project + return — used by both write endpoints so
// the client gets back the same shape as GET /api/assets/<path>.
async function projectedAssetResponse(
  ctx: Ctx,
  assetPath: string,
): Promise<Response> {
  const game = await loadGame(ctx.gameDir);
  const spec = (game.assets ?? []).find((a) => a.path === assetPath);
  if (!spec) return json({ error: "asset disappeared" }, 500);
  return json(await projectAsset(spec));
}

async function readUploadedImage(req: Request): Promise<Uint8Array | null> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (ct.startsWith("multipart/form-data")) {
    const form = await req.formData();
    const f = form.get("file");
    if (!(f instanceof File)) return null;
    return new Uint8Array(await f.arrayBuffer());
  }
  if (ct.startsWith("image/")) {
    return new Uint8Array(await req.arrayBuffer());
  }
  return null;
}

// PNG signature: 89 50 4E 47 0D 0A 1A 0A. We refuse anything else so
// chafa input stays predictable. (A JPEG that we re-encoded server-
// side would mean shipping sharp; deferred.)
function looksLikePng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  return (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

// ─────────────────────────────────────────────────────────────────

function mimeFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".txt" || ext === ".ans") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
