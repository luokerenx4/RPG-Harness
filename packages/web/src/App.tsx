import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComposedState, Game } from "@rpg-harness/engine";
import type { InputResult } from "@rpg-harness/engine";
import { listGames, loadWebGame } from "./loadGame";
import {
  clearState,
  getSessionInfo,
  hasSave,
  loadBranchContext,
  loadAiStatus,
  loadState,
  loadDevelopmentStatus,
  loadExplorationStatus,
  loadFeedbackFeed,
  pollExternalState,
  requestedWebGame,
  advanceAiTurn,
  saveState,
  startNextExploration,
  submitFeedback,
  webGameRoute,
  type WebSessionInfo,
  type WebAiTurnReceipt,
  type WebBranchContext,
  type WebDevelopmentStatus,
  type WebFeedbackFeed,
} from "./session";
import { WebPlayScreen } from "./WebPlayScreen";
import {
  pickerSaveSummary,
  type PickerSaveSummary,
} from "./pickerSaveSummary";

interface Loaded {
  id: string;
  game: Game;
  assetUrls: Record<string, string>;
  sessionInfo: WebSessionInfo;
  revision: number;
  initialState?: ComposedState;
  developmentStatus?: WebDevelopmentStatus;
  branchContext?: WebBranchContext;
  feedbackFeed?: WebFeedbackFeed;
  externalInputNotice?: {
    result: InputResult;
    source?: string;
  };
  externalAdvanceNotice?: {
    source?: string;
    logCursor: number;
  };
  aiTurnReceipt?: WebAiTurnReceipt;
  aiPersona?: string;
}

export function App() {
  const games = useMemo(() => listGames(), []);
  const [savedGames, setSavedGames] = useState<Set<string> | null>(null);
  const [saveSummaries, setSaveSummaries] = useState<Map<string, PickerSaveSummary>>(
    () => new Map(),
  );
  const [sessionInfo, setSessionInfo] = useState<WebSessionInfo | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoStartConsumed, setAutoStartConsumed] = useState(false);
  const [aiTurnPending, setAiTurnPending] = useState(false);
  const [freshStartGameId, setFreshStartGameId] = useState<string | null>(null);
  const pickerListRef = useRef<HTMLUListElement>(null);
  const freshStartReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const requestedGame = useMemo(
    () => requestedWebGame(window.location.search),
    [],
  );

  const refreshSessions = useCallback(async () => {
    try {
      const info = await getSessionInfo();
      const statuses = await Promise.all(
        games.map(async (gameInfo) => {
          const saved = await hasSave(gameInfo.id);
          if (!saved) return { id: gameInfo.id, saved, summary: null };
          const state = await loadState(gameInfo.id).catch(() => null);
          const summary = state
            ? pickerSaveSummary(loadWebGame(gameInfo.id).game, state)
            : null;
          return { id: gameInfo.id, saved, summary };
        }),
      );
      setSessionInfo(info);
      setSavedGames(
        new Set(statuses.filter((status) => status.saved).map((status) => status.id)),
      );
      setSaveSummaries(new Map(statuses.flatMap((status) =>
        status.summary ? [[status.id, status.summary] as const] : []
      )));
    } catch (err) {
      setError(err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err));
    }
  }, [games]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  const closeFreshStart = useCallback(() => {
    setFreshStartGameId(null);
    requestAnimationFrame(() => freshStartReturnFocusRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!freshStartGameId) return;
    const dialog = document.querySelector<HTMLElement>(".picker-reset-dialog");
    const buttons = () => Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeFreshStart();
        return;
      }
      const entries = buttons();
      if (entries.length === 0) return;
      const currentIndex = entries.indexOf(document.activeElement as HTMLButtonElement);
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const nextIndex = event.key === "Home"
          ? 0
          : event.key === "End"
            ? entries.length - 1
            : nextPickerIndex(currentIndex, entries.length, event.key === "ArrowRight" ? 1 : -1);
        entries[nextIndex]?.focus();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        entries[nextPickerIndex(currentIndex, entries.length, event.shiftKey ? -1 : 1)]?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [freshStartGameId, closeFreshStart]);

  useEffect(() => {
    const list = pickerListRef.current;
    if (!list || loaded || savedGames === null || freshStartGameId) return;
    const buttons = () => Array.from(list.querySelectorAll<HTMLButtonElement>(".picker-btn:not(:disabled)"));
    const initial = buttons()[0];
    if (initial && (document.activeElement === document.body || document.activeElement === null)) initial.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const entries = buttons();
      if (entries.length === 0) return;
      event.preventDefault();
      const currentIndex = entries.indexOf(document.activeElement as HTMLButtonElement);
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? entries.length - 1
          : nextPickerIndex(currentIndex, entries.length, event.key === "ArrowDown" ? 1 : -1);
      entries[nextIndex]?.focus();
    };
    list.addEventListener("keydown", onKeyDown);
    return () => list.removeEventListener("keydown", onKeyDown);
  }, [freshStartGameId, loaded, savedGames]);

  const start = useCallback(async (id: string, fresh: boolean) => {
    try {
      if (fresh) await clearState(id);
      const [saved, branchContext, feedbackFeed] = await Promise.all([
        fresh ? Promise.resolve(null) : loadState(id),
        loadBranchContext(id),
        loadFeedbackFeed(id).catch(() => null),
      ]);
      const { game, assetUrls } = loadWebGame(id);
      const info = await getSessionInfo();
      setLoaded({
        id,
        game,
        assetUrls,
        sessionInfo: info,
        revision: 0,
        ...(saved ? { initialState: saved } : {}),
        ...(branchContext ? { branchContext } : {}),
        ...(feedbackFeed ? { feedbackFeed } : {}),
      });
      window.history.replaceState(
        window.history.state,
        "",
        webGameRoute(window.location.href, id),
      );
    } catch (err) {
      setError(err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err));
    }
  }, []);

  useEffect(() => {
    if (
      autoStartConsumed || savedGames === null || loaded || !requestedGame ||
      !games.some((game) => game.id === requestedGame)
    ) return;
    setAutoStartConsumed(true);
    void start(requestedGame, false);
  }, [autoStartConsumed, games, loaded, requestedGame, savedGames, start]);

  useEffect(() => {
    if (!loaded || loaded.sessionInfo.mode !== "shared") return;
    let cancelled = false;
    let checking = false;
    const poll = async () => {
      if (checking || cancelled) return;
      checking = true;
      try {
        const update = await pollExternalState(loaded.id);
        if (cancelled || update === undefined) return;
        if (update.stateChanged && update.state === null) {
          setLoaded(null);
          void refreshSessions();
          return;
        }
        setLoaded((current) =>
          current && current.id === loaded.id
            ? {
                ...current,
                ...(update.stateChanged && update.state
                  ? {
                      initialState: update.state,
                      revision: current.revision + 1,
                    }
                  : {}),
                ...(update.latestRejectedInput
                  ? { externalInputNotice: update.latestRejectedInput }
                  : { externalInputNotice: undefined }),
                ...(update.latestAcceptedInput
                  ? {
                      externalAdvanceNotice: update.latestAcceptedInput,
                      aiTurnReceipt: undefined,
                    }
                  : { externalAdvanceNotice: undefined }),
              }
            : current,
        );
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err),
          );
        }
      } finally {
        checking = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 750);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loaded?.id, loaded?.sessionInfo.mode, refreshSessions]);

  useEffect(() => {
    if (
      !loaded ||
      loaded.sessionInfo.mode !== "shared" ||
      !needsBranchContextPolling(loaded.branchContext)
    ) return;
    let cancelled = false;
    let checking = false;
    const poll = async () => {
      if (checking || cancelled) return;
      checking = true;
      try {
        const branchContext = await loadBranchContext(loaded.id);
        if (cancelled || !branchContext?.handoff) return;
        const currentHasHandoff = loaded.branchContext?.handoff !== null &&
          loaded.branchContext?.handoff !== undefined;
        if (
          currentHasHandoff &&
          !branchContext.outcome &&
          !branchContext.playerControl
        ) return;
        setLoaded((current) =>
          current && current.id === loaded.id
            ? { ...current, branchContext }
            : current
        );
      } catch {
        // A named branch may be opened before Headless finishes materializing
        // fork metadata. Gameplay state polling remains authoritative; retry.
      } finally {
        checking = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 750);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    loaded?.id,
    loaded?.sessionInfo.mode,
    loaded?.branchContext?.handoff,
    loaded?.branchContext?.outcome,
    loaded?.branchContext?.playerControl,
  ]);

  useEffect(() => {
    if (!loaded || loaded.sessionInfo.mode !== "shared") return;
    let cancelled = false;
    let checking = false;
    const poll = async () => {
      if (checking || cancelled) return;
      checking = true;
      try {
        const status = await loadDevelopmentStatus(loaded.id);
        if (cancelled || !status) return;
        setLoaded((current) =>
          current && current.id === loaded.id &&
              current.developmentStatus?.revision !== status.revision
            ? { ...current, developmentStatus: status }
            : current
        );
      } catch {
        // Development status is advisory. Gameplay and session CAS remain live
        // even when a code scan briefly races an editor write.
      } finally {
        checking = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loaded?.id, loaded?.sessionInfo.mode]);

  useEffect(() => {
    if (!loaded || loaded.sessionInfo.mode !== "shared") return;
    let cancelled = false;
    let checking = false;
    const poll = async () => {
      if (checking || cancelled) return;
      checking = true;
      try {
        const feed = await loadFeedbackFeed(loaded.id);
        if (cancelled || !feed) return;
        setLoaded((current) =>
          current && current.id === loaded.id &&
              current.feedbackFeed?.revision !== feed.revision
            ? { ...current, feedbackFeed: feed }
            : current
        );
      } catch {
        // Feedback history is advisory; gameplay persistence remains live.
      } finally {
        checking = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loaded?.id, loaded?.sessionInfo.mode]);

  const exit = useCallback(() => {
    setLoaded(null);
    window.history.replaceState(
      window.history.state,
      "",
      webGameRoute(window.location.href, null),
    );
    void refreshSessions();
  }, [refreshSessions]);

  const loadCurrentAiStatus = useCallback(
    () => loaded
      ? loadAiStatus(loaded.id)
      : Promise.resolve({ personas: [], control: null }),
    [loaded?.id],
  );

  if (error) {
    return <pre className="boot-error">{error}</pre>;
  }

  if (loaded) {
    return (
      <WebPlayScreen
        key={`${loaded.id}:${loaded.revision}:${loaded.initialState ? "resume" : "new"}`}
        game={loaded.game}
        assetUrls={loaded.assetUrls}
        {...(loaded.initialState ? { initialState: loaded.initialState } : {})}
        onCommit={async (state, event) => {
          await saveState(loaded.id, state, event);
          if (event?.inputResult?.accepted) {
            setLoaded((current) =>
              current && current.id === loaded.id
                ? { ...current, aiTurnReceipt: undefined }
                : current
            );
          }
        }}
        sessionLabel={loaded.sessionInfo.label}
        branchContext={loaded.branchContext}
        developmentStatus={loaded.developmentStatus}
        feedbackEnabled={loaded.sessionInfo.mode === "shared"}
        onFeedback={(input) => submitFeedback(loaded.id, input)}
        feedbackFeed={loaded.feedbackFeed}
        externalInputNotice={loaded.externalInputNotice}
        externalAdvanceNotice={loaded.externalAdvanceNotice}
        aiTurnReceipt={loaded.aiTurnReceipt}
        aiTurnPending={aiTurnPending}
        initialAiPersona={loaded.aiPersona}
        aiControlEnabled={loaded.sessionInfo.mode === "shared"}
        onLoadAiStatus={loadCurrentAiStatus}
        onAdvanceAiTurn={async (persona) => {
          setAiTurnPending(true);
          try {
            const receipt = await advanceAiTurn(loaded.id, persona);
            setLoaded((current) =>
              current && current.id === loaded.id
                ? {
                    ...current,
                    initialState: receipt.state,
                    revision: current.revision + 1,
                    aiTurnReceipt: receipt,
                    aiPersona: persona,
                  }
                : current
            );
            return receipt;
          } finally {
            setAiTurnPending(false);
          }
        }}
        explorationEnabled={loaded.sessionInfo.mode === "shared"}
        onLoadExploration={() => loadExplorationStatus(loaded.id)}
        onExplore={async (key) => {
          const branch = await startNextExploration(loaded.id, key);
          window.location.assign(branch.webPath);
        }}
        onExit={exit}
      />
    );
  }

  return (
    <div className="picker">
      <aside className="picker-hero">
        <span className="picker-kicker">OPEN RPG AUTHORING RUNTIME</span>
        <div className="picker-emblem" aria-hidden="true">R</div>
        <h1 className="picker-title">RPG<span>HARNESS</span></h1>
        <p className="picker-sub">Headless RPG Maker, rendered for players.</p>
        <div className="picker-rule" />
        <p className="picker-note">同じゲーム資源を Web・TUI・Headless で共有します。</p>
        <p className="picker-session">
          <i aria-hidden="true" /> {sessionInfo ? sessionInfo.label : "保存先を確認中…"}
        </p>
      </aside>
      <main className="picker-library">
        <header className="picker-library-head">
          <div><span>SELECT PROJECT</span><h2>物語を選ぶ</h2></div>
          <small>{games.length} PROJECT{games.length === 1 ? "" : "S"}</small>
        </header>
        <ul ref={pickerListRef} className="picker-list">
          {games.map((g, index) => {
            const saved = savedGames?.has(g.id) ?? false;
            const summary = saveSummaries.get(g.id);
            return (
              <li key={g.id} className="picker-row">
                <button
                  className="picker-btn"
                  disabled={savedGames === null}
                  onClick={() => void start(g.id, !saved)}
                >
                  <span className="picker-index">{String(index + 1).padStart(2, "0")}</span>
                  <span className="picker-game-copy">
                    <strong>{g.title}</strong><small>{g.id}</small>
                    {saved && summary && (
                      <span className="picker-save-meta">
                        <b>{summary.location}</b>
                        <i>{summary.activity}</i>
                        <em>{summary.records} RECORDS</em>
                      </span>
                    )}
                  </span>
                  <span className="picker-action">{saved ? "続きから" : "はじめる"}<i>›</i></span>
                </button>
                {saved && (
                  <button
                    className="picker-fresh"
                    title="セーブを消して最初から"
                    aria-haspopup="dialog"
                    onClick={(event) => {
                      freshStartReturnFocusRef.current = event.currentTarget;
                      setFreshStartGameId(g.id);
                    }}
                  >
                    <span>↻</span> 最初から
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <footer className="picker-footer"><span>↑↓ SELECT · ENTER START</span><span>FILES ARE AUTHORITATIVE</span><span>WEB SURFACE · READY</span></footer>
      </main>
      {freshStartGameId && (
        <div className="picker-reset-overlay" onClick={closeFreshStart}>
          <section className="picker-reset-dialog" role="alertdialog" aria-modal="true" aria-labelledby="picker-reset-title" aria-describedby="picker-reset-description" onClick={(event) => event.stopPropagation()}>
            <span className="picker-reset-kicker">NEW GAME</span>
            <div className="picker-reset-emblem" aria-hidden="true">↻</div>
            <h2 id="picker-reset-title">最初から始めますか？</h2>
            <strong>{games.find((game) => game.id === freshStartGameId)?.title ?? freshStartGameId}</strong>
            <p id="picker-reset-description">現在のセーブを消去して、新しい物語を開始します。共有セッションの進行は元に戻せません。</p>
            <small>{sessionInfo?.label ?? "local save"}</small>
            <div className="picker-reset-actions">
              <button type="button" autoFocus onClick={closeFreshStart}>キャンセル</button>
              <button type="button" className="danger" onClick={() => {
                const id = freshStartGameId;
                setFreshStartGameId(null);
                void start(id, true);
              }}>セーブを消して開始</button>
            </div>
            <footer>←→ · 選択　Enter · 決定　Esc · 戻る</footer>
          </section>
        </div>
      )}
    </div>
  );
}

export function nextPickerIndex(currentIndex: number, total: number, delta: 1 | -1): number {
  if (total <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= total) return delta > 0 ? 0 : total - 1;
  return (currentIndex + delta + total) % total;
}

function needsBranchContextPolling(branch: WebBranchContext | undefined): boolean {
  if (!branch?.handoff) return true;
  return !branch.playerControl;
}
