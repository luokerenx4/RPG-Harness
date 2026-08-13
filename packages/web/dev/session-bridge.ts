import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import type { Plugin } from "vite";
import {
  appendCheckpointedSessionEvent,
  withSessionLock,
} from "@rpg-harness/session-store";

const API_ROOT = "/__rpgh/session-bridge";
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const developmentStatusCache = new Map<string, {
  gameDir: string;
  value: BridgeDevelopmentStatus;
  staleAfter: number;
}>();
const developmentStatusPending = new Map<string, {
  generation: number;
  promise: Promise<BridgeDevelopmentStatus>;
}>();
const developmentStatusGenerations = new Map<string, number>();
let developmentStatusGlobalGeneration = 0;
const SESSION_EVIDENCE_DEBOUNCE_MS = 15_000;

export interface BridgeStepEvent {
  input: unknown;
  output: unknown;
  inputResult?: unknown;
  decision?: unknown;
}

export interface SaveBridgeSessionArgs {
  gameDir: string;
  session: string;
  state: unknown;
  event?: BridgeStepEvent;
  expectedRevision?: string | null;
  now?: () => number;
}

export interface BridgeSessionSnapshot {
  state: unknown | null;
  revision: string | null;
}

export interface BridgeDevelopmentStatus {
  revision: string;
  worklist: {
    total: number;
    executable: number;
    diagnostic: number;
    authoring: number;
    highestPriority: "P0" | "P1" | "P2" | "P3" | null;
    next: { key: string; title: string } | null;
  };
  quality: {
    status: "certified" | "uncertified";
    inputRevision: string | null;
    certificateRevision: string | null;
    createdAt: string | null;
    endings: number;
    paths: number;
    seeds: number[];
    maxActivityRepetitions: number | null;
    maxActivityRepetition: {
      seed: number;
      persona: string;
      activityKind: string;
      count: number;
    } | null;
  };
}

export function sessionBridgePlugin(examplesRoot: string): Plugin {
  return {
    name: "rpg-harness-session-bridge",
    apply: "serve",
    configureServer(server) {
      installDevelopmentStatusInvalidation(server.watcher, examplesRoot);
      server.middlewares.use((req, res, next) => {
        void handleBridgeRequest(req, res, examplesRoot).then((handled) => {
          if (!handled) next();
        });
      });
    },
  };
}

export function installDevelopmentStatusInvalidation(
  watcher: {
    add?(files: string | string[]): unknown;
    on(event: string, callback: (file: string) => void): unknown;
  },
  examplesRoot: string,
): void {
  const repoRoot = path.dirname(path.resolve(examplesRoot));
  watcher.add?.([
    path.resolve(examplesRoot),
    path.join(repoRoot, "packages", "cli", "src"),
    path.join(repoRoot, "packages", "engine", "src"),
    path.join(repoRoot, "packages", "frontend-core", "src"),
    path.join(repoRoot, "packages", "parser", "src"),
    path.join(repoRoot, "packages", "session-store", "src"),
    path.join(repoRoot, "packages", "web", "src"),
    path.join(repoRoot, "packages", "web", "dev"),
    path.join(repoRoot, "packages", "web", "vite.config.ts"),
    path.join(repoRoot, "packages", "web", "package.json"),
    path.join(repoRoot, "packages", "web", "index.html"),
  ]);
  const invalidate = (file: string) => {
    const invalidation = developmentStatusInvalidation(file, examplesRoot);
    if (invalidation?.scope === "all") {
      developmentStatusGlobalGeneration += 1;
      developmentStatusCache.clear();
      developmentStatusPending.clear();
      return;
    }
    if (!invalidation) return;
    if (invalidation.immediate) {
      bumpDevelopmentStatusGeneration(invalidation.gameDir);
      developmentStatusCache.delete(invalidation.gameDir);
      developmentStatusPending.delete(invalidation.gameDir);
      return;
    }
    const cached = developmentStatusCache.get(invalidation.gameDir);
    if (cached && !Number.isFinite(cached.staleAfter)) {
      cached.staleAfter = Date.now() + SESSION_EVIDENCE_DEBOUNCE_MS;
    }
  };
  watcher.on("add", invalidate);
  watcher.on("change", invalidate);
  watcher.on("unlink", invalidate);
}

export function developmentStatusInvalidation(
  file: string,
  examplesRoot: string,
):
  | { scope: "all" }
  | { scope: "game"; gameDir: string; immediate: boolean }
  | null {
  const root = path.resolve(examplesRoot);
  const resolvedFile = path.resolve(file);
  const repoRoot = path.dirname(root);
  const runtimeRelative = path.relative(path.join(repoRoot, "packages"), resolvedFile);
  if (
    runtimeRelative !== "" &&
    !runtimeRelative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(runtimeRelative) &&
    /^(?:(?:cli|engine|frontend-core|parser|session-store)\/src\/|web\/(?:src|dev)\/|web\/(?:vite\.config\.ts|package\.json|index\.html)$)/.test(
      runtimeRelative.split(path.sep).join("/"),
    )
  ) return { scope: "all" };
  const relative = path.relative(root, resolvedFile);
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) return null;
  const [gameId, ...segments] = relative.split(path.sep);
  if (!gameId || segments.length === 0) return null;
  const normalized = segments.join("/");
  const projectEvidence = normalized.startsWith(".rpg-harness/") &&
    (normalized.includes("/issues.jsonl") ||
      normalized.startsWith(".rpg-harness/evidence/quality/"));
  const sessionEvidence = normalized.startsWith(".rpg-harness/sessions/");
  const authoredOrRuntime = !segments.some((segment) => segment.startsWith("."));
  if (!projectEvidence && !sessionEvidence && !authoredOrRuntime) return null;
  return {
    scope: "game",
    gameDir: path.join(root, gameId),
    immediate: projectEvidence || authoredOrRuntime,
  };
}

export async function loadBridgeSession(
  gameDir: string,
  session: string,
): Promise<unknown | null> {
  assertSegment(session, "session");
  try {
    return JSON.parse(
      await readFile(path.join(sessionDirectory(gameDir, session), "state.json"), "utf-8"),
    ) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function loadBridgeSnapshot(
  gameDir: string,
  session: string,
): Promise<BridgeSessionSnapshot> {
  const state = await loadBridgeSession(gameDir, session);
  return {
    state,
    revision: state === null ? null : revisionOf(state),
  };
}

export async function saveBridgeSession(
  args: SaveBridgeSessionArgs,
): Promise<string> {
  assertSegment(args.session, "session");
  if (!args.state || typeof args.state !== "object" || Array.isArray(args.state)) {
    throw new Error("state must be a JSON object");
  }
  return withSessionLock(args.gameDir, args.session, async () => {
    const dir = sessionDirectory(args.gameDir, args.session);
    await mkdir(dir, { recursive: true });

    if (args.expectedRevision !== undefined) {
      const current = await loadBridgeSnapshot(args.gameDir, args.session);
      if (current.revision !== args.expectedRevision) {
        throw new RequestError(
          409,
          `Session revision conflict: expected ${args.expectedRevision ?? "empty"}, current ${current.revision ?? "empty"}`,
        );
      }
    }

    // Replace the save atomically so readers see either complete version.
    const stateFile = path.join(dir, "state.json");
    const temporary = path.join(dir, `.state-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(args.state, null, 2), "utf-8");
    await rename(temporary, stateFile);

    if (args.event) {
      await appendCheckpointedSessionEvent(
        args.gameDir,
        args.session,
        {
          t: (args.now ?? Date.now)(),
          source: "web",
          input: args.event.input,
          output: args.event.output,
          ...(args.event.inputResult !== undefined
            ? { inputResult: args.event.inputResult }
            : {}),
          ...(args.event.decision !== undefined
            ? { decision: args.event.decision }
            : {}),
        },
        args.state,
      );
    }
    return revisionOf(args.state);
  });
}

export async function clearBridgeSession(
  gameDir: string,
  session: string,
): Promise<void> {
  assertSegment(session, "session");
  await withSessionLock(gameDir, session, async () => {
    const dir = sessionDirectory(gameDir, session);
    // A fresh playthrough resets only replay state. Keep issues.jsonl: findings
    // remain useful after the save that exposed them is restarted.
    await Promise.all([
      unlinkIfPresent(path.join(dir, "state.json")),
      unlinkIfPresent(path.join(dir, "log.jsonl")),
      unlinkIfPresent(path.join(dir, "fork.json")),
      rm(path.join(dir, "checkpoints"), { recursive: true, force: true }),
    ]);
  });
}

export async function loadBridgeDevelopmentStatus(
  gameDir: string,
): Promise<BridgeDevelopmentStatus> {
  const resolvedGameDir = path.resolve(gameDir);
  const cached = developmentStatusCache.get(resolvedGameDir);
  if (cached && cached.staleAfter > Date.now()) return cached.value;
  const generation = developmentStatusGeneration(resolvedGameDir);
  const pending = developmentStatusPending.get(resolvedGameDir);
  if (pending?.generation === generation) return pending.promise;
  const promise = computeBridgeDevelopmentStatus(resolvedGameDir).then((value) => {
    if (developmentStatusGeneration(resolvedGameDir) === generation) {
      developmentStatusCache.set(resolvedGameDir, {
        gameDir: resolvedGameDir,
        value,
        staleAfter: Number.POSITIVE_INFINITY,
      });
    }
    return value;
  }).finally(() => {
    const current = developmentStatusPending.get(resolvedGameDir);
    if (current?.promise === promise) developmentStatusPending.delete(resolvedGameDir);
  });
  developmentStatusPending.set(resolvedGameDir, { generation, promise });
  return promise;
}

async function computeBridgeDevelopmentStatus(
  gameDir: string,
): Promise<BridgeDevelopmentStatus> {
  const cli = path.resolve(import.meta.dirname, "../../cli/src/bin.ts");
  const { stdout } = await execFileAsync(
    "bun",
    [cli, "project-status", gameDir],
    { maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout) as BridgeDevelopmentStatus;
}

function developmentStatusGeneration(gameDir: string): number {
  return developmentStatusGlobalGeneration * 1_000_000_000 +
    (developmentStatusGenerations.get(gameDir) ?? 0);
}

function bumpDevelopmentStatusGeneration(gameDir: string): void {
  developmentStatusGenerations.set(
    gameDir,
    (developmentStatusGenerations.get(gameDir) ?? 0) + 1,
  );
}

async function handleBridgeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  examplesRoot: string,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith(API_ROOT)) return false;

  try {
    if (url.pathname === API_ROOT) {
      if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
      sendJson(res, 200, {
        enabled: true,
        storage: "filesystem",
        defaultSession: "web",
      });
      return true;
    }

    const developmentMatch = url.pathname.match(
      /^\/__rpgh\/session-bridge\/development\/([^/]+)$/,
    );
    if (developmentMatch) {
      if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
      const gameId = decodeURIComponent(developmentMatch[1] ?? "");
      assertSegment(gameId, "game id");
      const gameDir = path.join(examplesRoot, gameId);
      await access(path.join(gameDir, "game.yaml"));
      sendJson(res, 200, await loadBridgeDevelopmentStatus(gameDir));
      return true;
    }

    const match = url.pathname.match(
      /^\/__rpgh\/session-bridge\/session\/([^/]+)\/([^/]+)$/,
    );
    if (!match) {
      sendJson(res, 404, { error: "Unknown session bridge route" });
      return true;
    }
    const gameId = decodeURIComponent(match[1] ?? "");
    const session = decodeURIComponent(match[2] ?? "");
    assertSegment(gameId, "game id");
    assertSegment(session, "session");
    const gameDir = path.join(examplesRoot, gameId);
    await access(path.join(gameDir, "game.yaml"));

    if (req.method === "GET") {
      sendJson(res, 200, await loadBridgeSnapshot(gameDir, session));
      return true;
    }
    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      const state = body.state;
      const event = body.event;
      const expectedRevision = body.expectedRevision;
      if (event !== undefined && (!event || typeof event !== "object")) {
        throw new RequestError(400, "event must be an object when provided");
      }
      if (
        expectedRevision !== null &&
        typeof expectedRevision !== "string"
      ) {
        throw new RequestError(
          400,
          "expectedRevision must be a string or null",
        );
      }
      const revision = await saveBridgeSession({
        gameDir,
        session,
        state,
        expectedRevision,
        ...(event !== undefined ? { event: event as BridgeStepEvent } : {}),
      });
      sendJson(res, 200, { ok: true, revision });
      return true;
    }
    if (req.method === "DELETE") {
      await clearBridgeSession(gameDir, session);
      sendJson(res, 200, { ok: true });
      return true;
    }
    return methodNotAllowed(res, ["GET", "PUT", "DELETE"]);
  } catch (error) {
    const status = error instanceof RequestError ? error.status : 500;
    sendJson(res, status, {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

function revisionOf(state: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(state))
    .digest("hex")
    .slice(0, 16);
}

function sessionDirectory(gameDir: string, session: string): string {
  return path.join(gameDir, ".rpg-harness", "sessions", session);
}

function assertSegment(value: string, label: string): void {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new RequestError(400, `Invalid ${label}: ${JSON.stringify(value)}`);
  }
}

async function unlinkIfPresent(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) {
      throw new RequestError(413, "Session payload exceeds 5 MiB");
    }
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch (error) {
    throw new RequestError(400, `Invalid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RequestError(400, "Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function methodNotAllowed(res: ServerResponse, allowed: string[]): true {
  res.setHeader("Allow", allowed.join(", "));
  sendJson(res, 405, { error: "Method not allowed" });
  return true;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
