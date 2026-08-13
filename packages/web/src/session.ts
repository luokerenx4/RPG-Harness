import type {
  ActivityDecisionContext,
  ChoiceDecisionContext,
  ComposedState,
  Input,
  InputResult,
  Output,
} from "@rpg-harness/engine";

// Production remains a static web app with a localStorage save. In local Vite
// development, /__rpgh/session-bridge is provided by vite.config.ts and the
// same API transparently writes the CLI's state.json + log.jsonl session.

const LOCAL_PREFIX = "rpgh:save:";
const BRIDGE_ROOT = "/__rpgh/session-bridge";
export const WEB_SESSION_NAME = "web";
export const SESSION_QUERY_PARAM = "session";

export interface WebStepEvent {
  input: Input;
  output: Output;
  inputResult?: InputResult;
  decision?: ChoiceDecisionContext;
  activityDecision?: ActivityDecisionContext;
  /** State immediately before an accepted input, persisted as a replay checkpoint by the bridge. */
  replayState?: ComposedState;
}

export interface WebSessionInfo {
  mode: "shared" | "browser";
  session: string;
  label: string;
}

export interface WebBranchContext {
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

export interface WebDevelopmentStatus {
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

export type WebFeedbackArea = "narrative" | "gameplay" | "engine" | "ui" | "tooling";
export type WebFeedbackSeverity = "note" | "minor" | "major" | "blocker";

export interface WebFeedbackInput {
  area: WebFeedbackArea;
  severity: WebFeedbackSeverity;
  title: string;
  details?: string;
  target?: string;
}

export interface WebFeedbackReceipt {
  id: string;
  session: string;
  area: WebFeedbackArea;
  severity: WebFeedbackSeverity;
  title: string;
  evidence: {
    logEntry: number | null;
    currentScriptId: string | null;
    checkpoint?: { revision: string };
  };
}

export interface WebFeedbackFeed {
  revision: string;
  open: number;
  resolved: number;
  items: Array<WebFeedbackReceipt & {
    createdAt: string;
    status: "open" | "resolved" | "superseded";
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
  }>;
}

export interface WebExplorationStatus {
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

export interface WebExplorationReceipt {
  sourceSession: string;
  proofSession: string;
  session: string;
  webPath: string;
  workItem: NonNullable<WebExplorationStatus["next"]>;
}

let infoPromise: Promise<WebSessionInfo> | null = null;
const bridgeRevisions = new Map<string, string | null>();
const bridgeLogCursors = new Map<string, number>();
const bridgeLogIdentities = new Map<string, string | null>();

export interface WebExternalSessionUpdate {
  state: ComposedState | null;
  stateChanged: boolean;
  latestRejectedInput?: {
    result: InputResult;
    source?: string;
  };
}

export function getSessionInfo(): Promise<WebSessionInfo> {
  if (!infoPromise) infoPromise = detectSessionInfo();
  return infoPromise;
}

export async function loadState(gameId: string): Promise<ComposedState | null> {
  const info = await getSessionInfo();
  if (info.mode === "shared") {
    const snapshot = await fetchBridgeSnapshot(gameId, info.session);
    bridgeRevisions.set(gameId, snapshot.revision);
    bridgeLogCursors.set(gameId, snapshot.logCursor);
    bridgeLogIdentities.set(gameId, snapshot.logIdentity);
    return snapshot.state;
  }
  try {
    const raw = localStorage.getItem(localKey(gameId));
    return raw === null ? null : (JSON.parse(raw) as ComposedState);
  } catch {
    return null;
  }
}

// Returns undefined when neither the save nor append-only log changed. A save
// update reloads the current screen; a log-only update can surface a rejected
// input from Headless/TUI without pretending gameplay advanced. App polls this
// only while a shared Web game is open; CAS remains the write-conflict guard.
export async function pollExternalState(
  gameId: string,
): Promise<WebExternalSessionUpdate | undefined> {
  const info = await getSessionInfo();
  if (info.mode !== "shared") return undefined;
  const previous = bridgeRevisions.get(gameId);
  const previousLogCursor = bridgeLogCursors.get(gameId);
  const previousLogIdentity = bridgeLogIdentities.get(gameId);
  const snapshot = await fetchBridgeSnapshot(
    gameId,
    info.session,
    previousLogCursor,
    previousLogIdentity,
  );
  if (previous === undefined) {
    bridgeRevisions.set(gameId, snapshot.revision);
    bridgeLogCursors.set(gameId, snapshot.logCursor);
    bridgeLogIdentities.set(gameId, snapshot.logIdentity);
    return undefined;
  }
  const stateChanged = snapshot.revision !== previous;
  const logChanged = snapshot.logCursor !== previousLogCursor ||
    snapshot.logIdentity !== previousLogIdentity;
  if (!stateChanged && !logChanged) return undefined;
  bridgeRevisions.set(gameId, snapshot.revision);
  bridgeLogCursors.set(gameId, snapshot.logCursor);
  bridgeLogIdentities.set(gameId, snapshot.logIdentity);
  const latestRejectedInput = snapshot.latestRejectedEvent?.source !== "web" &&
      isRejectedInputResult(snapshot.latestRejectedEvent?.inputResult)
    ? {
        result: snapshot.latestRejectedEvent.inputResult,
        ...(snapshot.latestRejectedEvent.source
          ? { source: snapshot.latestRejectedEvent.source }
          : {}),
      }
    : undefined;
  return {
    state: snapshot.state,
    stateChanged,
    ...(latestRejectedInput ? { latestRejectedInput } : {}),
  };
}

export async function loadDevelopmentStatus(
  gameId: string,
): Promise<WebDevelopmentStatus | null> {
  const info = await getSessionInfo();
  if (info.mode !== "shared") return null;
  const response = await fetch(
    `${BRIDGE_ROOT}/development/${encodeURIComponent(gameId)}`,
  );
  if (!response.ok) throw await bridgeError(response);
  return await response.json() as WebDevelopmentStatus;
}

export async function loadBranchContext(
  gameId: string,
): Promise<WebBranchContext | null> {
  const info = await getSessionInfo();
  if (info.mode !== "shared") return null;
  const response = await fetch(
    `${BRIDGE_ROOT}/branch/${encodeURIComponent(gameId)}/${encodeURIComponent(info.session)}`,
  );
  if (!response.ok) throw await bridgeError(response);
  const payload = (await response.json()) as { branch?: unknown };
  return (payload.branch ?? null) as WebBranchContext | null;
}

export async function submitFeedback(
  gameId: string,
  input: WebFeedbackInput,
): Promise<WebFeedbackReceipt> {
  const info = await getSessionInfo();
  if (info.mode !== "shared") {
    throw new Error("AI feedback requires the local shared-session bridge");
  }
  const response = await fetch(
    `${BRIDGE_ROOT}/feedback/${encodeURIComponent(gameId)}/${encodeURIComponent(info.session)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) throw await bridgeError(response);
  const payload = await response.json() as { report?: WebFeedbackReceipt };
  if (!payload.report || typeof payload.report.id !== "string") {
    throw new Error("session bridge did not return a feedback report");
  }
  return payload.report;
}

export async function loadFeedbackFeed(gameId: string): Promise<WebFeedbackFeed | null> {
  const info = await getSessionInfo();
  if (info.mode !== "shared") return null;
  const response = await fetch(
    `${BRIDGE_ROOT}/feedback/${encodeURIComponent(gameId)}/${encodeURIComponent(info.session)}`,
  );
  if (!response.ok) throw await bridgeError(response);
  return await response.json() as WebFeedbackFeed;
}

export async function loadExplorationStatus(
  gameId: string,
): Promise<WebExplorationStatus | null> {
  const info = await getSessionInfo();
  if (info.mode !== "shared") return null;
  const response = await fetch(
    `${BRIDGE_ROOT}/exploration/${encodeURIComponent(gameId)}/${encodeURIComponent(info.session)}`,
  );
  if (!response.ok) throw await bridgeError(response);
  return await response.json() as WebExplorationStatus;
}

export async function startNextExploration(
  gameId: string,
  key: string,
): Promise<WebExplorationReceipt> {
  const info = await getSessionInfo();
  if (info.mode !== "shared") {
    throw new Error("AI branch exploration requires the local shared-session bridge");
  }
  const response = await fetch(
    `${BRIDGE_ROOT}/exploration/${encodeURIComponent(gameId)}/${encodeURIComponent(info.session)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    },
  );
  if (!response.ok) throw await bridgeError(response);
  return await response.json() as WebExplorationReceipt;
}

export async function saveState(
  gameId: string,
  state: ComposedState,
  event?: WebStepEvent,
): Promise<void> {
  const info = await getSessionInfo();
  if (info.mode === "shared") {
    const expectedRevision = bridgeRevisions.get(gameId) ?? null;
    const response = await fetch(bridgeEndpoint(gameId, info.session), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state,
        expectedRevision,
        ...(event ? { event } : {}),
      }),
    });
    if (!response.ok) throw await bridgeError(response);
    const payload = (await response.json()) as {
      revision?: unknown;
      logCursor?: unknown;
      logIdentity?: unknown;
    };
    if (typeof payload.revision !== "string") {
      throw new Error("session bridge did not return a revision");
    }
    if (!Number.isSafeInteger(payload.logCursor) || (payload.logCursor as number) < 0) {
      throw new Error("session bridge did not return a valid log cursor");
    }
    if (payload.logIdentity !== null && typeof payload.logIdentity !== "string") {
      throw new Error("session bridge did not return a valid log identity");
    }
    bridgeRevisions.set(gameId, payload.revision);
    bridgeLogCursors.set(gameId, payload.logCursor as number);
    bridgeLogIdentities.set(gameId, payload.logIdentity ?? null);
    return;
  }
  try {
    localStorage.setItem(localKey(gameId), JSON.stringify(state));
  } catch {
    // Static deployments keep best-effort browser persistence. The in-memory
    // engine can still continue when storage is disabled or out of quota.
  }
}

export async function clearState(gameId: string): Promise<void> {
  const info = await getSessionInfo();
  if (info.mode === "shared") {
    const response = await fetch(bridgeEndpoint(gameId, info.session), {
      method: "DELETE",
    });
    if (!response.ok) throw await bridgeError(response);
    bridgeRevisions.set(gameId, null);
    bridgeLogCursors.set(gameId, 0);
    bridgeLogIdentities.set(gameId, null);
    return;
  }
  try {
    localStorage.removeItem(localKey(gameId));
  } catch {
    // ignore
  }
}

export async function hasSave(gameId: string): Promise<boolean> {
  return (await loadState(gameId)) !== null;
}

export function requestedSharedSession(search: string): string | null {
  const requested = new URLSearchParams(search).get(SESSION_QUERY_PARAM);
  if (requested === null || requested === "") return null;
  if (
    requested === "." ||
    requested === ".." ||
    requested.includes("/") ||
    requested.includes("\\") ||
    requested.includes("\0")
  ) {
    return null;
  }
  return requested;
}

async function detectSessionInfo(): Promise<WebSessionInfo> {
  try {
    const response = await fetch(BRIDGE_ROOT, {
      headers: { Accept: "application/json" },
    });
    if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
      const payload = (await response.json()) as {
        enabled?: unknown;
        defaultSession?: unknown;
      };
      if (payload.enabled === true && typeof payload.defaultSession === "string") {
        const requested = requestedSharedSession(window.location.search);
        const session = requested ?? payload.defaultSession;
        return {
          mode: "shared",
          session,
          label: `共有セッション: ${session} · live`,
        };
      }
    }
  } catch {
    // Static host or bridge unavailable: browser-only save remains valid.
  }
  return { mode: "browser", session: "browser", label: "ブラウザ保存" };
}

async function fetchBridgeSnapshot(
  gameId: string,
  session: string,
  knownLogCursor?: number,
  knownLogIdentity?: string | null,
): Promise<{
  state: ComposedState | null;
  revision: string | null;
  logCursor: number;
  logIdentity: string | null;
  latestRejectedEvent?: { source?: string; inputResult?: unknown };
}> {
  const endpoint = new URL(bridgeEndpoint(gameId, session), window.location.origin);
  if (knownLogCursor !== undefined) {
    endpoint.searchParams.set("logCursor", String(knownLogCursor));
    endpoint.searchParams.set("logIdentity", knownLogIdentity ?? "");
  }
  const response = await fetch(endpoint);
  if (!response.ok) throw await bridgeError(response);
  const payload = (await response.json()) as {
    state?: unknown;
    revision?: unknown;
    logCursor?: unknown;
    logIdentity?: unknown;
    latestRejectedEvent?: unknown;
  };
  if (payload.revision !== null && typeof payload.revision !== "string") {
    throw new Error("session bridge returned an invalid revision");
  }
  if (!Number.isSafeInteger(payload.logCursor) || (payload.logCursor as number) < 0) {
    throw new Error("session bridge returned an invalid log cursor");
  }
  if (payload.logIdentity !== null && typeof payload.logIdentity !== "string") {
    throw new Error("session bridge returned an invalid log identity");
  }
  if (
    payload.latestRejectedEvent !== undefined &&
    (!payload.latestRejectedEvent ||
      typeof payload.latestRejectedEvent !== "object" ||
      Array.isArray(payload.latestRejectedEvent))
  ) throw new Error("session bridge returned an invalid rejected event");
  return {
    state: (payload.state ?? null) as ComposedState | null,
    revision: payload.revision ?? null,
    logCursor: payload.logCursor as number,
    logIdentity: payload.logIdentity ?? null,
    ...(payload.latestRejectedEvent !== undefined
      ? {
          latestRejectedEvent: payload.latestRejectedEvent as {
            source?: string;
            inputResult?: unknown;
          },
        }
      : {}),
  };
}

function isRejectedInputResult(value: unknown): value is InputResult {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).accepted === false &&
    typeof (value as Record<string, unknown>).code === "string" &&
    typeof (value as Record<string, unknown>).message === "string" &&
    Array.isArray((value as Record<string, unknown>).expected);
}

function bridgeEndpoint(gameId: string, session: string): string {
  return `${BRIDGE_ROOT}/session/${encodeURIComponent(gameId)}/${encodeURIComponent(session)}`;
}

function localKey(gameId: string): string {
  return LOCAL_PREFIX + gameId;
}

async function bridgeError(response: Response): Promise<Error> {
  let detail = response.statusText;
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string") detail = payload.error;
  } catch {
    // retain statusText
  }
  if (response.status === 409) {
    return new Error(
      `共有セッションが別の画面で進みました。古い GUI 状態は保存していません。主菜单へ戻り「続きから」で再読み込みしてください。\n${detail}`,
    );
  }
  return new Error(`session bridge ${response.status}: ${detail}`);
}
