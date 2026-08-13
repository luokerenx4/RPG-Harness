import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { ComposedState, Game } from "@rpg-harness/engine";
import { listGames, loadWebGame } from "./loadGame";
import {
  clearState,
  getSessionInfo,
  hasSave,
  loadBranchContext,
  loadState,
  loadDevelopmentStatus,
  pollExternalState,
  saveState,
  submitFeedback,
  type WebSessionInfo,
  type WebBranchContext,
  type WebDevelopmentStatus,
} from "./session";
import { WebPlayScreen } from "./WebPlayScreen";

interface Loaded {
  id: string;
  game: Game;
  assetUrls: Record<string, string>;
  sessionInfo: WebSessionInfo;
  revision: number;
  initialState?: ComposedState;
  developmentStatus?: WebDevelopmentStatus;
  branchContext?: WebBranchContext;
}

export function App() {
  const games = useMemo(() => listGames(), []);
  const [savedGames, setSavedGames] = useState<Set<string> | null>(null);
  const [sessionInfo, setSessionInfo] = useState<WebSessionInfo | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      const info = await getSessionInfo();
      const statuses = await Promise.all(
        games.map(async (game) => [game.id, await hasSave(game.id)] as const),
      );
      setSessionInfo(info);
      setSavedGames(
        new Set(statuses.filter(([, saved]) => saved).map(([id]) => id)),
      );
    } catch (err) {
      setError(err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err));
    }
  }, [games]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  const start = useCallback(async (id: string, fresh: boolean) => {
    try {
      if (fresh) await clearState(id);
      const [saved, branchContext] = await Promise.all([
        fresh ? Promise.resolve(null) : loadState(id),
        loadBranchContext(id),
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
      });
    } catch (err) {
      setError(err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err));
    }
  }, []);

  useEffect(() => {
    if (!loaded || loaded.sessionInfo.mode !== "shared") return;
    let cancelled = false;
    let checking = false;
    const poll = async () => {
      if (checking || cancelled) return;
      checking = true;
      try {
        const state = await pollExternalState(loaded.id);
        if (cancelled || state === undefined) return;
        if (state === null) {
          setLoaded(null);
          void refreshSessions();
          return;
        }
        setLoaded((current) =>
          current && current.id === loaded.id
            ? {
                ...current,
                initialState: state,
                revision: current.revision + 1,
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
        if (currentHasHandoff && !branchContext.outcome) return;
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

  const exit = useCallback(() => {
    setLoaded(null);
    void refreshSessions();
  }, [refreshSessions]);

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
        onCommit={(state, event) => saveState(loaded.id, state, event)}
        sessionLabel={loaded.sessionInfo.label}
        branchContext={loaded.branchContext}
        developmentStatus={loaded.developmentStatus}
        feedbackEnabled={loaded.sessionInfo.mode === "shared"}
        onFeedback={(input) => submitFeedback(loaded.id, input)}
        onExit={exit}
      />
    );
  }

  return (
    <div className="picker">
      <h1 className="picker-title">RPG-Harness</h1>
      <p className="picker-sub">headless RPG Maker — web</p>
      <p className="picker-session">
        {sessionInfo ? `⛓ ${sessionInfo.label}` : "保存先を確認中…"}
      </p>
      <ul className="picker-list">
        {games.map((g) => {
          const saved = savedGames?.has(g.id) ?? false;
          return (
            <li key={g.id} className="picker-row">
              <button
                className="picker-btn"
                disabled={savedGames === null}
                onClick={() => void start(g.id, !saved)}
              >
                <span>{g.title}</span>
                <span className="picker-action">{saved ? "続きから ▸" : "はじめる ▸"}</span>
              </button>
              {saved && (
                <button
                  className="picker-fresh"
                  title="セーブを消して最初から"
                  onClick={() => void start(g.id, true)}
                >
                  最初から
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function needsBranchContextPolling(branch: WebBranchContext | undefined): boolean {
  if (!branch?.handoff) return true;
  return typeof branch.handoff.coordinates?.choiceId === "string" && !branch.outcome;
}
