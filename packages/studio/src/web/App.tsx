import React, { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import type { GameSummary } from "./api";
import { fetchGame } from "./api";
import { DraftNavigationDialog, type StudioDraftGuard } from "./DraftNavigationDialog";
import { Gallery } from "./pages/Gallery";
import { AssetDetail } from "./pages/AssetDetail";
import { Project } from "./pages/Project";

export function App() {
  const [game, setGame] = useState<GameSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftActive, setDraftActive] = useState(false);
  const [pendingRoute, setPendingRoute] = useState<{ path: string; label: string } | null>(null);
  const [routingSave, setRoutingSave] = useState(false);
  const [routingError, setRoutingError] = useState<string | null>(null);
  const draftGuardRef = useRef<StudioDraftGuard | null>(null);
  const navigate = useNavigate();

  const handleDraftGuardChange = useCallback((guard: StudioDraftGuard | null) => {
    draftGuardRef.current = guard;
    setDraftActive(Boolean(guard));
    if (!guard) {
      setPendingRoute(null);
      setRoutingError(null);
    }
  }, []);

  const requestRoute = (event: React.MouseEvent<HTMLAnchorElement>, path: string, label: string) => {
    if (event.currentTarget.getAttribute("aria-current") === "page") return;
    if (!draftGuardRef.current) return;
    event.preventDefault();
    setRoutingError(null);
    setPendingRoute({ path, label });
  };

  const finishRoute = (path: string) => {
    setPendingRoute(null);
    setRoutingError(null);
    navigate(path);
  };

  useEffect(() => {
    fetchGame()
      .then(setGame)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  useEffect(() => {
    if (!draftActive) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [draftActive]);

  return (
    <div className="studio-app">
      <header className="studio-titlebar">
        <div className="studio-brand" aria-label="AutoGal Studio">
          <span className="studio-brand-mark">A</span>
          <div>
            <strong>{game?.title ?? "AutoGal Studio"}</strong>
            <span>{game ? shortenPath(game.gameDir) : "Opening project…"}</span>
          </div>
        </div>
        <nav className="studio-mode-switcher" aria-label="Studio workspaces">
          <NavLink to="/" end onClick={(event) => requestRoute(event, "/", "Project workspace")}>
            <span aria-hidden="true">▦</span> Project
          </NavLink>
          <NavLink to="/assets" onClick={(event) => requestRoute(event, "/assets", "Asset Library")}>
            <span aria-hidden="true">◇</span> Assets
          </NavLink>
        </nav>
        <div className="studio-titlebar-actions">
          <span className={`studio-save-state${draftActive ? " has-draft" : ""}`}><i /> {draftActive ? "Unsaved project draft" : "Files are authoritative"}</span>
          {game && (
            <a
              className="studio-playtest"
              title="Open a fresh browser playtest session"
              href={buildPlaytestUrl(game.id, window.location.href, createPlaytestSession())}
              target="_blank"
              rel="noreferrer"
            >
              <span aria-hidden="true">▶</span>
              Playtest
              <kbd>Web</kbd>
            </a>
          )}
        </div>
      </header>

      <main className="studio-main">
        {error ? (
          <div className="studio-fatal" role="alert">
            <span>!</span>
            <div><strong>Project could not be opened</strong><p>{error}</p></div>
          </div>
        ) : (
          <Routes>
            <Route path="/" element={<Project onDraftGuardChange={handleDraftGuardChange} />} />
            <Route path="/assets" element={<Gallery />} />
            <Route path="/asset/*" element={<AssetDetail onDraftGuardChange={handleDraftGuardChange} />} />
          </Routes>
        )}
      </main>

      <footer className="studio-statusbar">
        <span><i className={draftActive ? "status-draft" : "status-ready"} /> {error ? "Project error" : draftActive ? "Draft not saved" : "Ready"}</span>
        {game && (
          <>
            <span>{game.counts.maps} maps</span>
            <span>{game.counts.characters + game.counts.enemies} actors</span>
            <span>{game.counts.scripts} scripts</span>
            <span>{game.counts.assets} assets</span>
          </>
        )}
        <span className="statusbar-spacer" />
        <span>UTF-8</span>
        <span>Map v2</span>
      </footer>
      {pendingRoute && draftGuardRef.current && (
        <DraftNavigationDialog
          guard={draftGuardRef.current}
          destination={pendingRoute.label}
          saving={routingSave}
          error={routingError}
          onStay={() => { setPendingRoute(null); setRoutingError(null); }}
          onDiscard={() => {
            const guard = draftGuardRef.current;
            if (!guard) return;
            guard.discard();
            finishRoute(pendingRoute.path);
          }}
          onSave={() => {
            const guard = draftGuardRef.current;
            if (!guard) return;
            setRoutingSave(true);
            setRoutingError(null);
            void guard.save().then((saved) => {
              if (saved) finishRoute(pendingRoute.path);
              else setRoutingError("The project rejected this draft. Review the validation message in the editor, then try again.");
            }).finally(() => setRoutingSave(false));
          }}
        />
      )}
    </div>
  );
}

function shortenPath(value: string): string {
  const parts = value.split("/").filter(Boolean);
  if (parts.length <= 3) return value;
  return `…/${parts.slice(-3).join("/")}`;
}

export function buildPlaytestUrl(gameId: string, studioHref: string, session: string): string {
  const url = new URL(studioHref);
  url.port = "5188";
  url.pathname = "/";
  url.hash = "";
  url.search = new URLSearchParams({ game: gameId, session }).toString();
  return url.toString();
}

function createPlaytestSession(): string {
  const entropy = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().slice(0, 8)
    : Date.now().toString(36);
  return `studio-playtest-${entropy}`;
}
