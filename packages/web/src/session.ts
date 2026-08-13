import type {
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

let infoPromise: Promise<WebSessionInfo> | null = null;
const bridgeRevisions = new Map<string, string | null>();

export function getSessionInfo(): Promise<WebSessionInfo> {
  if (!infoPromise) infoPromise = detectSessionInfo();
  return infoPromise;
}

export async function loadState(gameId: string): Promise<ComposedState | null> {
  const info = await getSessionInfo();
  if (info.mode === "shared") {
    const snapshot = await fetchBridgeSnapshot(gameId, info.session);
    bridgeRevisions.set(gameId, snapshot.revision);
    return snapshot.state;
  }
  try {
    const raw = localStorage.getItem(localKey(gameId));
    return raw === null ? null : (JSON.parse(raw) as ComposedState);
  } catch {
    return null;
  }
}

// Returns undefined when nothing changed, null when another surface cleared
// the session, or the new state when Headless/TUI advanced it. App polls this
// only while a shared Web game is open; CAS remains the race-condition guard.
export async function pollExternalState(
  gameId: string,
): Promise<ComposedState | null | undefined> {
  const info = await getSessionInfo();
  if (info.mode !== "shared") return undefined;
  const previous = bridgeRevisions.get(gameId);
  const snapshot = await fetchBridgeSnapshot(gameId, info.session);
  if (previous === undefined) {
    bridgeRevisions.set(gameId, snapshot.revision);
    return undefined;
  }
  if (snapshot.revision === previous) return undefined;
  bridgeRevisions.set(gameId, snapshot.revision);
  return snapshot.state;
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
    const payload = (await response.json()) as { revision?: unknown };
    if (typeof payload.revision !== "string") {
      throw new Error("session bridge did not return a revision");
    }
    bridgeRevisions.set(gameId, payload.revision);
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
): Promise<{ state: ComposedState | null; revision: string | null }> {
  const response = await fetch(bridgeEndpoint(gameId, session));
  if (!response.ok) throw await bridgeError(response);
  const payload = (await response.json()) as {
    state?: unknown;
    revision?: unknown;
  };
  if (payload.revision !== null && typeof payload.revision !== "string") {
    throw new Error("session bridge returned an invalid revision");
  }
  return {
    state: (payload.state ?? null) as ComposedState | null,
    revision: payload.revision ?? null,
  };
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
