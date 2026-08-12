import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssetSpec, TuiRenderPrefs } from "@rpg-harness/engine";
import { collectDanglingRefs, loadGame } from "@rpg-harness/cli/loader";
import { getHealth } from "./health";
import { parseRenderOptions, renderSourceToTuiTxt } from "./render";
import { parsePatchBody, specYamlPath, updateSpec } from "./spec-write";

interface Ctx {
  gameDir: string;
}

// Dispatch by URL path + method. Tiny hand-rolled router — Bun.serve
// doesn't ship with one and adding express/hono for a handful of
// routes is overkill. GET handlers read; POST handlers write.
export async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method.toUpperCase();

  if (method === "GET") {
    if (pathname === "/api/health") return getHealthRoute();
    if (pathname === "/api/game") return getGame(ctx);
    if (pathname === "/api/assets") return getAssets(ctx);

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
    // /api/assets/<asset-path>/source       — upload source.quality.png
    // /api/assets/<asset-path>/render-tui   — invoke chafa
    const m = pathname.match(/^\/api\/assets\/(.+)\/(source|render-tui)$/);
    if (m && m[1] && m[2]) {
      if (m[2] === "source") return postSource(ctx, m[1], req);
      if (m[2] === "render-tui") return postRenderTui(ctx, m[1], req);
    }
  }

  if (method === "PATCH") {
    // /api/assets/<asset-path>/spec — edit mutable spec fields
    const m = pathname.match(/^\/api\/assets\/(.+)\/spec$/);
    if (m && m[1]) return patchSpec(ctx, m[1], req);
  }

  return new Response("not found", { status: 404 });
}

async function getHealthRoute(): Promise<Response> {
  return json(await getHealth());
}

async function getGame(ctx: Ctx): Promise<Response> {
  const game = await loadGame(ctx.gameDir);
  return json({
    title: game.title,
    counts: {
      characters: game.characters.length,
      scripts: game.scripts.length,
      assets: (game.assets ?? []).length,
    },
    gameDir: ctx.gameDir,
  });
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
