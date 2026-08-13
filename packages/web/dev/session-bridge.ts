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
const PLAYTEST_AREAS = ["narrative", "gameplay", "engine", "ui", "tooling"] as const;
const PLAYTEST_SEVERITIES = ["note", "minor", "major", "blocker"] as const;
type PlaytestArea = (typeof PLAYTEST_AREAS)[number];
type PlaytestSeverity = (typeof PLAYTEST_SEVERITIES)[number];

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

export interface CreateBridgeFeedbackArgs {
  gameDir: string;
  session: string;
  area: PlaytestArea;
  severity: PlaytestSeverity;
  title: string;
  details?: string;
  target?: string;
}

export interface BridgeFeedbackReport {
  id: string;
  session: string;
  area: PlaytestArea;
  severity: PlaytestSeverity;
  title: string;
  evidence: {
    logEntry: number | null;
    currentScriptId: string | null;
    checkpoint?: { revision: string };
  };
  [key: string]: unknown;
}

export interface BridgeFeedbackFeed {
  revision: string;
  open: number;
  resolved: number;
  items: Array<{
    id: string;
    session: string;
    createdAt: string;
    status: "open" | "resolved" | "superseded";
    area: PlaytestArea;
    severity: PlaytestSeverity;
    title: string;
    details?: string;
    target?: string;
    resolvedAt?: string;
    resolution?: string;
    supersededAt?: string;
    supersededReason?: string;
    verification?: {
      kind: "player-feedback";
      verifiedAt: string;
      originalInputRevision: string;
      fixedInputRevision: string;
      certificateRevision: string;
      certificateCreatedAt: string;
    };
    evidence: {
      logEntry: number | null;
      currentScriptId: string | null;
      checkpoint?: { revision: string };
    };
  }>;
}

export interface BridgeExplorationStatus {
  revision: string;
  pendingOptions: number;
  next: {
    key: string;
    scriptId: string;
    choiceId: string;
    optionId: string;
    optionText: string;
  } | null;
}

export interface BridgeExplorationReceipt {
  sourceSession: string;
  /** Autonomous, completed branch that proves the authored option still works. */
  proofSession: string;
  /** Player-facing branch paused on the first new authored response. */
  session: string;
  webPath: string;
  workItem: NonNullable<BridgeExplorationStatus["next"]>;
}

export async function createBridgeFeedback(
  args: CreateBridgeFeedbackArgs,
): Promise<BridgeFeedbackReport> {
  assertSegment(args.session, "session");
  if (!PLAYTEST_AREAS.includes(args.area)) {
    throw new RequestError(400, `Invalid feedback area: ${args.area}`);
  }
  if (!PLAYTEST_SEVERITIES.includes(args.severity)) {
    throw new RequestError(400, `Invalid feedback severity: ${args.severity}`);
  }
  if (!args.title.trim()) throw new RequestError(400, "Feedback title cannot be empty");
  const cli = path.resolve(import.meta.dirname, "../../cli/src/bin.ts");
  const command = [
    cli,
    "report",
    args.gameDir,
    "--session",
    args.session,
    "--area",
    args.area,
    "--severity",
    args.severity,
    "--title",
    args.title.trim(),
    "--origin",
    "player-feedback/web",
    ...(args.details?.trim() ? ["--details", args.details.trim()] : []),
    ...(args.target?.trim() ? ["--target", args.target.trim()] : []),
  ];
  const { stdout } = await execFileAsync("bun", command, { maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout) as BridgeFeedbackReport;
}

export async function loadBridgeFeedbackFeed(
  gameDir: string,
  session: string,
): Promise<BridgeFeedbackFeed> {
  assertSegment(session, "session");
  const cli = path.resolve(import.meta.dirname, "../../cli/src/bin.ts");
  const { stdout } = await execFileAsync("bun", [
    cli,
    "reports",
    gameDir,
    "--session",
    session,
    "--status",
    "all",
    "--format",
    "json",
  ], { maxBuffer: 4 * 1024 * 1024 });
  const reports = JSON.parse(stdout) as unknown;
  if (!Array.isArray(reports)) throw new Error("Invalid feedback report list");
  const items = reports
    .filter(isPlayerFeedbackReport)
    .map((report) => ({
      id: report.id,
      session,
      createdAt: report.createdAt,
      status: report.status,
      area: report.area,
      severity: report.severity,
      title: report.title,
      ...(typeof report.details === "string" ? { details: report.details } : {}),
      ...(typeof report.target === "string" ? { target: report.target } : {}),
      ...(typeof report.resolvedAt === "string" ? { resolvedAt: report.resolvedAt } : {}),
      ...(typeof report.resolution === "string" ? { resolution: report.resolution } : {}),
      ...(typeof report.supersededAt === "string" ? { supersededAt: report.supersededAt } : {}),
      ...(typeof report.supersededReason === "string"
        ? { supersededReason: report.supersededReason }
        : {}),
      ...(isPlayerFeedbackVerification(report.verification)
        ? {
            verification: {
              kind: "player-feedback" as const,
              verifiedAt: report.verification.verifiedAt,
              originalInputRevision: report.verification.originalInputRevision,
              fixedInputRevision: report.verification.fixedInputRevision,
              certificateRevision: report.verification.certificateRevision,
              certificateCreatedAt: report.verification.certificateCreatedAt,
            },
          }
        : {}),
      evidence: {
        logEntry: Number.isInteger(report.evidence.logEntry)
          ? report.evidence.logEntry as number
          : null,
        currentScriptId: typeof report.evidence.currentScriptId === "string"
          ? report.evidence.currentScriptId
          : null,
        ...(isFeedbackCheckpoint(report.evidence.checkpoint)
          ? { checkpoint: { revision: report.evidence.checkpoint.revision } }
          : {}),
      },
    }))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const revision = createHash("sha256")
    .update(JSON.stringify(items))
    .digest("hex")
    .slice(0, 16);
  return {
    revision,
    open: items.filter((item) => item.status === "open").length,
    resolved: items.filter((item) => item.status === "resolved").length,
    items,
  };
}

export async function loadBridgeExplorationStatus(
  gameDir: string,
  session: string,
): Promise<BridgeExplorationStatus> {
  assertSegment(session, "session");
  const cli = path.resolve(import.meta.dirname, "../../cli/src/bin.ts");
  const { stdout } = await execFileAsync("bun", [
    cli,
    "choices",
    gameDir,
    "--session",
    session,
    "--family",
    "--status",
    "pending",
    "--format",
    "json",
  ], { maxBuffer: 8 * 1024 * 1024 });
  const report = parseChoiceCoveragePayload(stdout);
  const workItems = report.workItems.map(parseExplorationWorkItem);
  return {
    revision: createHash("sha256")
      .update(JSON.stringify(workItems))
      .digest("hex")
      .slice(0, 16),
    pendingOptions: workItems.length,
    next: workItems[0] ?? null,
  };
}

export async function createBridgeExploration(
  gameDir: string,
  sourceSession: string,
  key: string,
  now: () => number = Date.now,
): Promise<BridgeExplorationReceipt> {
  assertSegment(sourceSession, "source session");
  if (!key.trim()) throw new RequestError(400, "Exploration work key cannot be empty");
  const status = await loadBridgeExplorationStatus(gameDir, sourceSession);
  const workItem = status.next?.key === key
    ? status.next
    : await findBridgeExplorationWorkItem(gameDir, sourceSession, key);
  if (!workItem) throw new RequestError(409, `Pending exploration branch not found: ${key}`);
  const session = explorationSessionName(sourceSession, now(), randomUUID());
  const proofSession = `${session}-proof`;
  const cli = path.resolve(import.meta.dirname, "../../cli/src/bin.ts");
  await execFileAsync("bun", [
    cli,
    "cover",
    gameDir,
    "--session",
    proofSession,
    "--source-session",
    sourceSession,
    "--key",
    key,
    "--player-session",
    session,
    "--persona",
    "objective",
    "--max-steps",
    "1000",
  ], { maxBuffer: 8 * 1024 * 1024 });
  return {
    sourceSession,
    proofSession,
    session,
    webPath: `/?session=${encodeURIComponent(session)}&game=${encodeURIComponent(path.basename(gameDir))}`,
    workItem,
  };
}

export interface BridgeBranchContext {
  fromSession: string;
  sourceLogEntry: number;
  mode: string;
  handoff: {
    schemaVersion: 1;
    workKey: string;
    priority: "P0" | "P1" | "P2" | "P3";
    kind: string;
    title: string;
    operation: string;
    state: "target-reached" | "closest" | "reproduced" | "covered";
    preparedAt: string;
    target?: string;
    coordinates?: {
      reportId?: string;
      scriptId?: string;
      choiceId?: string;
      optionId?: string;
    };
    premiere?: {
      prompt?: string;
      optionText: string;
    };
  } | null;
  playerControl: {
    source: "web" | "tui";
    logEntry: number;
  } | null;
  outcome: {
    kind: "choice-selected";
    scriptId?: string;
    choiceId: string;
    optionId: string;
    optionText?: string;
    source?: string;
    logEntry: number;
  } | null;
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
    fuzzPersonas: string[];
    fuzzLanes: number;
    fuzzMaxDecisions: { seed: number; persona: string; decisions: number } | null;
    maxActivityRepetitions: number | null;
    maxActivityRepetitionsByKind: Record<string, number> | null;
    maxActivityRepetition: {
      seed: number;
      persona: string;
      activityKind: string;
      count: number;
      limit: number;
      objectiveIds?: string[];
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

export async function loadBridgeBranchContext(
  gameDir: string,
  session: string,
): Promise<BridgeBranchContext | null> {
  assertSegment(session, "session");
  return withSessionLock(gameDir, session, async () => {
    let raw: string;
    try {
      raw = await readFile(
        path.join(sessionDirectory(gameDir, session), "fork.json"),
        "utf-8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const value = JSON.parse(raw) as Record<string, unknown>;
    const modes = new Set([
      "checkpoint",
      "initial-state",
      "current-state",
      "playtest-checkpoint",
      "playtest-replay-checkpoint",
    ]);
    if (
      value.schemaVersion !== 1 ||
      typeof value.fromSession !== "string" ||
      !Number.isInteger(value.sourceLogEntry) || (value.sourceLogEntry as number) < 0 ||
      typeof value.mode !== "string" || !modes.has(value.mode)
    ) {
      throw new Error(`Invalid fork provenance for session: ${session}`);
    }
    assertSegment(value.fromSession, "source session");
    const handoff = parseBridgeHandoff(value.handoff);
    const entries = handoff
      ? await readBridgeSessionEntries(gameDir, session)
      : [];
    return {
      fromSession: value.fromSession,
      sourceLogEntry: value.sourceLogEntry as number,
      mode: value.mode,
      handoff,
      outcome: handoff
        ? readBridgeBranchOutcome(entries, handoff)
        : null,
      playerControl: handoff
        ? readBridgePlayerControl(entries)
        : null,
    };
  });
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

    const branchMatch = url.pathname.match(
      /^\/__rpgh\/session-bridge\/branch\/([^/]+)\/([^/]+)$/,
    );
    if (branchMatch) {
      if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
      const gameId = decodeURIComponent(branchMatch[1] ?? "");
      const session = decodeURIComponent(branchMatch[2] ?? "");
      assertSegment(gameId, "game id");
      assertSegment(session, "session");
      const gameDir = path.join(examplesRoot, gameId);
      await access(path.join(gameDir, "game.yaml"));
      sendJson(res, 200, { branch: await loadBridgeBranchContext(gameDir, session) });
      return true;
    }

    const explorationMatch = url.pathname.match(
      /^\/__rpgh\/session-bridge\/exploration\/([^/]+)\/([^/]+)$/,
    );
    if (explorationMatch) {
      if (req.method !== "GET" && req.method !== "POST") {
        return methodNotAllowed(res, ["GET", "POST"]);
      }
      const gameId = decodeURIComponent(explorationMatch[1] ?? "");
      const session = decodeURIComponent(explorationMatch[2] ?? "");
      assertSegment(gameId, "game id");
      assertSegment(session, "session");
      const gameDir = path.join(examplesRoot, gameId);
      await access(path.join(gameDir, "game.yaml"));
      if (req.method === "GET") {
        sendJson(res, 200, await loadBridgeExplorationStatus(gameDir, session));
        return true;
      }
      const body = await readJsonBody(req);
      const key = typeof body.key === "string" ? body.key : "";
      sendJson(res, 201, await createBridgeExploration(gameDir, session, key));
      return true;
    }

    const feedbackMatch = url.pathname.match(
      /^\/__rpgh\/session-bridge\/feedback\/([^/]+)\/([^/]+)$/,
    );
    if (feedbackMatch) {
      if (req.method !== "GET" && req.method !== "POST") {
        return methodNotAllowed(res, ["GET", "POST"]);
      }
      const gameId = decodeURIComponent(feedbackMatch[1] ?? "");
      const session = decodeURIComponent(feedbackMatch[2] ?? "");
      assertSegment(gameId, "game id");
      assertSegment(session, "session");
      const gameDir = path.join(examplesRoot, gameId);
      await access(path.join(gameDir, "game.yaml"));
      if (req.method === "GET") {
        sendJson(res, 200, await loadBridgeFeedbackFeed(gameDir, session));
        return true;
      }
      const body = await readJsonBody(req);
      const report = await createBridgeFeedback({
        gameDir,
        session,
        area: body.area as PlaytestArea,
        severity: body.severity as PlaytestSeverity,
        title: typeof body.title === "string" ? body.title : "",
        ...(typeof body.details === "string" ? { details: body.details } : {}),
        ...(typeof body.target === "string" ? { target: body.target } : {}),
      });
      bumpDevelopmentStatusGeneration(gameDir);
      developmentStatusCache.delete(gameDir);
      developmentStatusPending.delete(gameDir);
      sendJson(res, 201, { report });
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

function isPlayerFeedbackReport(value: unknown): value is {
  id: string;
  createdAt: string;
  status: "open" | "resolved" | "superseded";
  area: PlaytestArea;
  severity: PlaytestSeverity;
  title: string;
  details?: unknown;
  target?: unknown;
  resolvedAt?: unknown;
  resolution?: unknown;
  supersededAt?: unknown;
  supersededReason?: unknown;
  verification?: unknown;
  evidence: Record<string, unknown>;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  const origin = report.origin;
  return report.schemaVersion === 1 &&
    typeof report.id === "string" &&
    typeof report.createdAt === "string" &&
    (report.status === "open" || report.status === "resolved" || report.status === "superseded") &&
    typeof report.area === "string" && PLAYTEST_AREAS.includes(report.area as PlaytestArea) &&
    typeof report.severity === "string" && PLAYTEST_SEVERITIES.includes(report.severity as PlaytestSeverity) &&
    typeof report.title === "string" &&
    origin !== null && typeof origin === "object" && !Array.isArray(origin) &&
    (origin as Record<string, unknown>).kind === "player-feedback" &&
    (origin as Record<string, unknown>).surface === "web" &&
    report.evidence !== null && typeof report.evidence === "object" &&
    !Array.isArray(report.evidence);
}

function parseChoiceCoveragePayload(stdout: string): {
  workItems: unknown[];
} {
  const payload = JSON.parse(stdout) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid choice coverage payload");
  }
  const workItems = (payload as Record<string, unknown>).workItems;
  if (!Array.isArray(workItems)) throw new Error("Invalid choice coverage work items");
  return { workItems };
}

function parseExplorationWorkItem(value: unknown): NonNullable<BridgeExplorationStatus["next"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid exploration work item");
  }
  const item = value as Record<string, unknown>;
  for (const field of ["key", "scriptId", "choiceId", "optionId", "optionText"] as const) {
    if (typeof item[field] !== "string" || !item[field].trim()) {
      throw new Error(`Invalid exploration work item ${field}`);
    }
  }
  return {
    key: item.key as string,
    scriptId: item.scriptId as string,
    choiceId: item.choiceId as string,
    optionId: item.optionId as string,
    optionText: item.optionText as string,
  };
}

async function findBridgeExplorationWorkItem(
  gameDir: string,
  sourceSession: string,
  key: string,
): Promise<NonNullable<BridgeExplorationStatus["next"]> | null> {
  const cli = path.resolve(import.meta.dirname, "../../cli/src/bin.ts");
  const { stdout } = await execFileAsync("bun", [
    cli,
    "choices",
    gameDir,
    "--session",
    sourceSession,
    "--family",
    "--status",
    "pending",
    "--format",
    "json",
  ], { maxBuffer: 8 * 1024 * 1024 });
  return parseChoiceCoveragePayload(stdout).workItems
    .map(parseExplorationWorkItem)
    .find((item) => item.key === key) ?? null;
}

function explorationSessionName(sourceSession: string, timestamp: number, uuid: string): string {
  const source = sourceSession.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 36);
  return `explore-${source}-${timestamp.toString(36)}-${uuid.slice(0, 8)}`;
}

function isPlayerFeedbackVerification(value: unknown): value is {
  kind: "player-feedback";
  verifiedAt: string;
  originalInputRevision: string;
  fixedInputRevision: string;
  certificateRevision: string;
  certificateCreatedAt: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const verification = value as Record<string, unknown>;
  return verification.kind === "player-feedback" &&
    typeof verification.verifiedAt === "string" &&
    typeof verification.certificateCreatedAt === "string" &&
    typeof verification.originalInputRevision === "string" &&
    /^[a-f0-9]{64}$/.test(verification.originalInputRevision) &&
    typeof verification.fixedInputRevision === "string" &&
    /^[a-f0-9]{64}$/.test(verification.fixedInputRevision) &&
    typeof verification.certificateRevision === "string" &&
    /^[a-f0-9]{64}$/.test(verification.certificateRevision);
}

function isFeedbackCheckpoint(value: unknown): value is { revision: string } {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).revision === "string" &&
    /^[a-f0-9]{64}$/.test((value as Record<string, unknown>).revision as string);
}

function parseBridgeHandoff(value: unknown): BridgeBranchContext["handoff"] {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid development branch handoff");
  }
  const handoff = value as Record<string, unknown>;
  const priorities = new Set(["P0", "P1", "P2", "P3"]);
  const states = new Set(["target-reached", "closest", "reproduced", "covered"]);
  if (
    handoff.schemaVersion !== 1 ||
    typeof handoff.workKey !== "string" || !handoff.workKey.trim() ||
    typeof handoff.priority !== "string" || !priorities.has(handoff.priority) ||
    typeof handoff.kind !== "string" || !handoff.kind.trim() ||
    typeof handoff.title !== "string" || !handoff.title.trim() ||
    typeof handoff.operation !== "string" || !handoff.operation.trim() ||
    typeof handoff.state !== "string" || !states.has(handoff.state) ||
    typeof handoff.preparedAt !== "string" || !handoff.preparedAt.trim() ||
    (handoff.target !== undefined && typeof handoff.target !== "string") ||
    !isBridgeHandoffCoordinates(handoff.coordinates) ||
    !isBridgeHandoffPremiere(handoff.premiere)
  ) {
    throw new Error("Invalid development branch handoff");
  }
  return handoff as unknown as NonNullable<BridgeBranchContext["handoff"]>;
}

function isBridgeHandoffPremiere(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const premiere = value as Record<string, unknown>;
  return typeof premiere.optionText === "string" && premiere.optionText.trim().length > 0 &&
    (premiere.prompt === undefined ||
      (typeof premiere.prompt === "string" && premiere.prompt.trim().length > 0)) &&
    Object.keys(premiere).every((key) => key === "prompt" || key === "optionText");
}

function isBridgeHandoffCoordinates(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const coordinates = value as Record<string, unknown>;
  const allowed = new Set(["reportId", "scriptId", "choiceId", "optionId"]);
  return Object.keys(coordinates).length > 0 &&
    Object.entries(coordinates).every(([key, nested]) =>
      allowed.has(key) && typeof nested === "string" && nested.trim().length > 0
    );
}

async function readBridgeSessionEntries(
  gameDir: string,
  session: string,
): Promise<Record<string, unknown>[]> {
  let raw: string;
  try {
    raw = await readFile(
      path.join(sessionDirectory(gameDir, session), "log.jsonl"),
      "utf-8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return raw.split(/\r?\n/).filter((line) => line.trim()).map((line) =>
    JSON.parse(line) as Record<string, unknown>
  );
}

function readBridgePlayerControl(
  entries: Record<string, unknown>[],
): BridgeBranchContext["playerControl"] {
  const index = entries.findIndex((entry) => {
    if (entry.source !== "web" && entry.source !== "tui") return false;
    if (!entry.input || typeof entry.input !== "object" || Array.isArray(entry.input)) {
      return false;
    }
    const inputResult = entry.inputResult;
    if (inputResult === undefined) return true;
    return typeof inputResult === "object" && !Array.isArray(inputResult) &&
      (inputResult as Record<string, unknown>).accepted === true;
  });
  if (index < 0) return null;
  return {
    source: entries[index]!.source as "web" | "tui",
    logEntry: index + 1,
  };
}

function readBridgeBranchOutcome(
  entries: Record<string, unknown>[],
  handoff: NonNullable<BridgeBranchContext["handoff"]>,
): BridgeBranchContext["outcome"] {
  const choiceId = handoff.coordinates?.choiceId;
  if (!choiceId) return null;
  const presentedAt = entries.findLastIndex((entry) => {
    const output = entry.output;
    if (!output || typeof output !== "object" || Array.isArray(output)) return false;
    const choice = output as Record<string, unknown>;
    return choice.type === "choice" && choice.choiceId === choiceId &&
      (handoff.coordinates?.scriptId === undefined ||
        choice.scriptId === handoff.coordinates.scriptId);
  });
  if (presentedAt < 0) return null;
  const presented = entries[presentedAt]!.output as Record<string, unknown>;
  for (let index = presentedAt + 1; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const decision = entry.decision;
    if (!decision || typeof decision !== "object" || Array.isArray(decision)) continue;
    const selected = decision as Record<string, unknown>;
    if (
      selected.choiceId !== choiceId ||
      typeof selected.optionId !== "string" ||
      (handoff.coordinates?.scriptId !== undefined &&
        selected.scriptId !== handoff.coordinates.scriptId) ||
      (handoff.coordinates?.optionId !== undefined &&
        selected.optionId !== handoff.coordinates.optionId)
    ) continue;
    const optionText = choiceOptionText(
      presented,
      selected.optionId,
    );
    return {
      kind: "choice-selected",
      ...(typeof selected.scriptId === "string" ? { scriptId: selected.scriptId } : {}),
      choiceId,
      optionId: selected.optionId,
      ...(optionText ? { optionText } : {}),
      ...(typeof entry.source === "string" ? { source: entry.source } : {}),
      logEntry: index + 1,
    };
  }
  return null;
}

function choiceOptionText(
  choice: Record<string, unknown>,
  optionId: string,
): string | null {
  if (!Array.isArray(choice.options)) return null;
  const option = choice.options.find((candidate) =>
    candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
    (candidate as Record<string, unknown>).id === optionId
  ) as Record<string, unknown> | undefined;
  return typeof option?.text === "string" ? option.text : null;
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
