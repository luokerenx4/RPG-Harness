import React, { useEffect, useState } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import type { GameSummary } from "./api";
import { fetchGame } from "./api";
import { Gallery } from "./pages/Gallery";
import { AssetDetail } from "./pages/AssetDetail";
import { Project } from "./pages/Project";
import { Link } from "react-router-dom";

// Single-page shell. Loads the GameSummary once at boot so the header
// can show title + asset counts; child pages fetch their own data.
// No global store, no auth — the studio's whole API surface is
// reading files from one game directory.
export function App() {
  const [game, setGame] = useState<GameSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const loc = useLocation();

  useEffect(() => {
    fetchGame()
      .then(setGame)
      .catch((e) => setErr(e.message));
  }, []);

  return (
    <div className="app">
      <header className="header">
        <div>
          <Link className="title" to="/">{game?.title ?? "rpgh studio"}</Link>
          {loc.pathname !== "/" && (
            <span className="muted"> &nbsp;·&nbsp; Project Studio</span>
          )}
        </div>
        <nav className="studio-nav">
          <Link to="/">Project</Link>
          <Link to="/assets">Assets</Link>
        </nav>
        <div className="meta">
          {game && (
            <>
              <span>
                {game.counts.assets} asset
                {game.counts.assets === 1 ? "" : "s"}
              </span>
              <span>
                {game.counts.characters} character
                {game.counts.characters === 1 ? "" : "s"}
              </span>
              <span>
                {game.counts.scripts} script
                {game.counts.scripts === 1 ? "" : "s"}
              </span>
              <span className="game-dir" title={game.gameDir}>
                {shortenPath(game.gameDir)}
              </span>
            </>
          )}
        </div>
      </header>
      <main className="main">
        {err && <div className="empty">⚠ {err}</div>}
        {!err && (
          <Routes>
            <Route path="/" element={<Project />} />
            <Route path="/assets" element={<Gallery />} />
            <Route path="/asset/*" element={<AssetDetail />} />
          </Routes>
        )}
      </main>
    </div>
  );
}

// Trim long absolute paths to ".../<last 2 segments>" so the header
// stays readable on narrow windows. The full path is in the title
// attribute so hover still gives the exact location.
function shortenPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return ".../" + parts.slice(-2).join("/");
}
