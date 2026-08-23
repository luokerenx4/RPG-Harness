import React, { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import type { GameSummary } from "./api";
import { fetchGame } from "./api";
import { Gallery } from "./pages/Gallery";
import { AssetDetail } from "./pages/AssetDetail";
import { Project } from "./pages/Project";

export function App() {
  const [game, setGame] = useState<GameSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchGame()
      .then(setGame)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

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
          <NavLink to="/" end>
            <span aria-hidden="true">▦</span> Project
          </NavLink>
          <NavLink to="/assets">
            <span aria-hidden="true">◇</span> Assets
          </NavLink>
        </nav>
        <div className="studio-titlebar-actions">
          <span className="studio-save-state"><i /> Files are authoritative</span>
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
            <Route path="/" element={<Project />} />
            <Route path="/assets" element={<Gallery />} />
            <Route path="/asset/*" element={<AssetDetail />} />
          </Routes>
        )}
      </main>

      <footer className="studio-statusbar">
        <span><i className="status-ready" /> {error ? "Project error" : "Ready"}</span>
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
