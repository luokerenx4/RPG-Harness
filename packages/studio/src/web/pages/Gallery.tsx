import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { AssetKind, AssetRow, DanglingRefs } from "../api";
import { fetchAssets, sourceImageUrl } from "../api";

// Asset gallery. Single grid, no pagination — RPG-Harness games are
// small enough that "scroll through all your assets" is the natural
// browse mode. Sort: kind (bg → cg → portrait), then path. The user
// can override with the filter chips at the top.
//
// Ghost cards: references that don't resolve (script points at an
// asset with no spec; defaultPortraits names an emotion the character
// doesn't have) render as warning cards pinned BEFORE the real grid —
// they are exactly the things a player would hit as placeholder text
// in-game, so they outrank everything else in the gallery.
export function Gallery() {
  const [assets, setAssets] = useState<AssetRow[] | null>(null);
  const [dangling, setDangling] = useState<DanglingRefs | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<AssetKind | "all" | "missing">("all");
  const [query, setQuery] = useState("");
  // The "asset pack" view: narrow to one character's full design
  // package via refs.characters. Composes with the kind filter.
  const [charFilter, setCharFilter] = useState<string | "all">("all");
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchAssets()
      .then((r) => {
        setAssets(r.assets);
        setDangling(r.dangling);
      })
      .catch((e) => setErr(e.message));
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
      if (event.key === "Escape" && document.activeElement === searchRef.current) {
        setQuery("");
        searchRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const filtered = useMemo(() => {
    if (!assets) return [];
    let rows = assets;
    if (charFilter !== "all") {
      rows = rows.filter((a) => a.refs?.characters?.includes(charFilter));
    }
    if (filter === "all") return rows.filter((asset) => matchesAssetQuery(asset, query));
    if (filter === "missing") {
      rows = rows.filter((a) => !a.renderings.tuiTxt && !a.renderings.tuiAns);
    } else {
      rows = rows.filter((a) => a.kind === filter);
    }
    return rows.filter((asset) => matchesAssetQuery(asset, query));
  }, [assets, filter, charFilter, query]);

  const characterIds = useMemo(() => {
    if (!assets) return [];
    const ids = new Set<string>();
    for (const a of assets) for (const c of a.refs?.characters ?? []) ids.add(c);
    return [...ids].sort();
  }, [assets]);

  // Ghosts stay visible under "all" and under the kind filter their
  // path implies (assets/cgs/… → cg). The "missing" chip is about
  // missing TUI renderings of EXISTING specs, so ghosts show there too
  // — both are flavors of "work not done yet".
  const ghosts = useMemo(() => {
    if (!dangling) return [];
    return dangling.missingAssets.filter((m) => {
      if (filter === "all" || filter === "missing") return true;
      return kindFromPath(m.assetPath) === filter;
    }).filter((missing) => matchesTextQuery([missing.assetPath, ...missing.referencedBy], query));
  }, [dangling, filter, query]);
  const ghostEmotions =
    filter === "all" || filter === "missing" || filter === "portrait"
      ? (dangling?.missingEmotions ?? []).filter((missing) => matchesTextQuery([
          missing.characterId,
          missing.emotion,
          ...missing.referencedBy,
        ], query))
      : [];

  if (err) return <div className="empty">⚠ {err}</div>;
  if (!assets) return <div className="empty">loading…</div>;

  if (
    assets.length === 0 &&
    (dangling?.missingAssets.length ?? 0) === 0 &&
    (dangling?.missingEmotions.length ?? 0) === 0
  ) {
    return (
      <div className="empty">
        <p>No assets declared yet.</p>
        <p className="muted">
          Drop a spec.yaml under <code>assets/portraits/</code>,{" "}
          <code>assets/backgrounds/</code>, <code>assets/cgs/</code>, or{" "}
          <code>assets/sheets/</code>, or <code>assets/tilesets/</code> to get started.
        </p>
      </div>
    );
  }

  const counts = {
    all: assets.length,
    portrait: assets.filter((a) => a.kind === "portrait").length,
    bg: assets.filter((a) => a.kind === "bg").length,
    cg: assets.filter((a) => a.kind === "cg").length,
    sheet: assets.filter((a) => a.kind === "sheet").length,
    tileset: assets.filter((a) => a.kind === "tileset").length,
    missing: assets.filter((a) => !a.renderings.tuiTxt && !a.renderings.tuiAns)
      .length,
    ghost:
      (dangling?.missingAssets.length ?? 0) +
      (dangling?.missingEmotions.length ?? 0),
  };
  const shown = filtered.length + ghosts.length + ghostEmotions.length;

  const focusFirstAsset = () => {
    gridRef.current?.querySelector<HTMLAnchorElement>("a.card")?.focus();
  };

  const navigateAssetGrid = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "].includes(event.key)) return;
    const cards = Array.from(event.currentTarget.querySelectorAll<HTMLAnchorElement>("a.card"));
    const target = event.target instanceof HTMLAnchorElement ? event.target : null;
    if (!target || !cards.includes(target)) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      target.click();
      return;
    }
    event.preventDefault();
    const nextRow = cards.findIndex((card) => card.offsetTop > cards[0]!.offsetTop);
    const columns = nextRow === -1 ? Math.max(1, cards.length) : nextRow;
    cards[nextAssetCardIndex(cards.indexOf(target), cards.length, columns, event.key)]?.focus();
  };

  return (
    <div className="asset-library">
      <header className="library-header">
        <div className="library-title"><span>ASSET LIBRARY</span><h1>Visual resources</h1><p>Inspect source tiers, prompts, references, and terminal renderings.</p></div>
        <label className="library-search"><span aria-hidden="true">⌕</span><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          focusFirstAsset();
        }} placeholder="Find path, prompt, tag…" aria-label="Search assets" />{query ? <button type="button" aria-label="Clear asset search" onClick={() => setQuery("")}>×</button> : <kbd>⌘K</kbd>}</label>
        <strong>{shown}<small> shown</small></strong>
      </header>
      <div className="library-filters">
      <div className="row">
        <FilterChip
          label={`all (${counts.all})`}
          active={filter === "all"}
          onClick={() => setFilter("all")}
        />
        <FilterChip
          label={`portrait (${counts.portrait})`}
          active={filter === "portrait"}
          onClick={() => setFilter("portrait")}
        />
        <FilterChip
          label={`bg (${counts.bg})`}
          active={filter === "bg"}
          onClick={() => setFilter("bg")}
        />
        <FilterChip
          label={`cg (${counts.cg})`}
          active={filter === "cg"}
          onClick={() => setFilter("cg")}
        />
        <FilterChip
          label={`sheet (${counts.sheet})`}
          active={filter === "sheet"}
          onClick={() => setFilter("sheet")}
        />
        <FilterChip
          label={`tileset (${counts.tileset})`}
          active={filter === "tileset"}
          onClick={() => setFilter("tileset")}
        />
        <FilterChip
          label={`missing TUI (${counts.missing})`}
          active={filter === "missing"}
          onClick={() => setFilter("missing")}
        />
      </div>
      {characterIds.length > 0 && (
        <div className="row character-filters">
          <FilterChip
            label="all characters"
            active={charFilter === "all"}
            onClick={() => setCharFilter("all")}
          />
          {characterIds.map((id) => (
            <FilterChip
              key={id}
              label={id}
              active={charFilter === id}
              onClick={() => setCharFilter(id)}
            />
          ))}
        </div>
      )}
      <span className="library-filter-hint">↑↓←→ Navigate · Enter Open</span>
      </div>
      <div className="library-scroll">
      {counts.ghost > 0 && (
        <div className="ghost-banner">
          ⚠ {counts.ghost} reference{counts.ghost === 1 ? "" : "s"} in
          scripts/characters resolve to nothing — players will see
          placeholder text. Create the spec (or fix the path / emotion
          name) to clear these.
        </div>
      )}
      <div ref={gridRef} className="grid" onKeyDown={navigateAssetGrid}>
        {ghosts.map((g) => (
          <GhostCard
            key={g.assetPath}
            title={g.assetPath}
            detail={`no spec.yaml at ${g.assetPath}/`}
            referencedBy={g.referencedBy}
            kind={kindFromPath(g.assetPath)}
          />
        ))}
        {ghostEmotions.map((g) => (
          <GhostCard
            key={`${g.characterId}:${g.emotion}`}
            title={`${g.characterId} · ${g.emotion}`}
            detail={`characters/${g.characterId}.md has no portraits.${g.emotion}`}
            referencedBy={g.referencedBy}
            kind="portrait"
          />
        ))}
        {filtered.map((a) => (
          <AssetCard key={a.path} asset={a} />
        ))}
        {shown === 0 && <div className="library-empty"><strong>No matching assets</strong><span>Clear the search or choose another resource filter.</span></div>}
      </div>
      </div>
    </div>
  );
}

// Best-effort kind from the path's directory segment. Unknown layout
// (typo'd dir etc.) gets labeled by its raw segment so the card still
// communicates where the author pointed.
function kindFromPath(p: string): AssetKind | string {
  const seg = p.split("/")[1] ?? "";
  if (seg === "portraits") return "portrait";
  if (seg === "backgrounds") return "bg";
  if (seg === "cgs") return "cg";
  if (seg === "sheets") return "sheet";
  if (seg === "tilesets") return "tileset";
  return seg || "?";
}

function matchesTextQuery(values: Array<string | undefined>, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return normalized.length === 0 || values.some((value) => value?.toLowerCase().includes(normalized));
}

export function matchesAssetQuery(asset: AssetRow, query: string): boolean {
  return matchesTextQuery([
    asset.path,
    asset.kind,
    asset.description,
    asset.prompt,
    asset.placeholder,
    asset.styleRef,
    ...(asset.tags ?? []),
    ...(asset.refs?.characters ?? []),
    asset.refs?.emotion,
  ], query);
}

export function nextAssetCardIndex(
  current: number,
  total: number,
  columns: number,
  key: string,
): number {
  if (total <= 0) return -1;
  if (current < 0 || current >= total) return 0;
  if (key === "Home") return 0;
  if (key === "End") return total - 1;
  if (key === "ArrowLeft") return Math.max(0, current - 1);
  if (key === "ArrowRight") return Math.min(total - 1, current + 1);
  if (key === "ArrowUp") return Math.max(0, current - Math.max(1, columns));
  if (key === "ArrowDown") return Math.min(total - 1, current + Math.max(1, columns));
  return current;
}

function GhostCard({
  title,
  detail,
  referencedBy,
  kind,
}: {
  title: string;
  detail: string;
  referencedBy: string[];
  kind: string;
}) {
  return (
    <div className="card ghost-card">
      <div className="thumb">
        <div className="placeholder-thumb ghost-thumb">missing</div>
      </div>
      <div className="body">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className={`kind-badge ${kind}`}>{kind}</span>
          <span className="ghost-flag">NO SPEC</span>
        </div>
        <div className="path">{title}</div>
        <div className="placeholder-text">{detail}</div>
        <div className="placeholder-text muted">
          referenced by: {referencedBy.join(", ")}
        </div>
      </div>
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={"btn" + (active ? " primary" : "")} onClick={onClick}>
      {label}
    </button>
  );
}

function AssetCard({ asset }: { asset: AssetRow }) {
  const atlasSummary = assetAtlasSummary(asset);
  return (
    <Link to={`/asset/${asset.path}`} className={`card${asset.kind === "tileset" ? " tileset-card" : ""}`} aria-label={`${asset.kind} · ${asset.placeholder} · ${asset.path}${atlasSummary ? ` · ${atlasSummary}` : ""}`}>
      <div className="thumb">
        {asset.renderings.source ? (
          <img src={sourceImageUrl(asset.path)} alt={asset.placeholder} />
        ) : (
          <div className="placeholder-thumb">{asset.placeholder}</div>
        )}
        {asset.kind === "tileset" && <span className={`atlas-stamp${asset.tileGrid ? " ready" : " missing"}`}><i aria-hidden="true">▦</i><strong>{asset.tileGrid ? `${asset.tileGrid.columns}×${asset.tileGrid.rows}` : "?×?"}</strong><small>ATLAS</small></span>}
      </div>
      <div className="body">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className={`kind-badge ${asset.kind}`}>{asset.kind}</span>
          <RenderingFlags r={asset.renderings} />
        </div>
        <div className="path">{asset.path}</div>
        <div className="placeholder-text">{asset.placeholder}</div>
        {atlasSummary && <div className={`asset-card-specialization${asset.tileGrid ? "" : " warning"}`}>{atlasSummary}</div>}
      </div>
    </Link>
  );
}

export function assetAtlasSummary(asset: Pick<AssetRow, "kind" | "tileGrid">): string | undefined {
  if (asset.kind !== "tileset") return undefined;
  const grid = asset.tileGrid;
  if (!grid) return "atlas metadata missing";
  const count = grid.columns * grid.rows;
  return `${grid.columns}×${grid.rows} atlas · ${count} tiles · IDs ${grid.firstId}–${grid.firstId + count - 1}`;
}

function RenderingFlags({ r }: { r: AssetRow["renderings"] }) {
  return (
    <div className="rendering-flags">
      <span className={"flag" + (r.tuiAns ? " present" : "")}>ANS</span>
      <span className={"flag" + (r.tuiTxt ? " present" : "")}>TXT</span>
      <span className={"flag" + (r.source ? " present" : "")}>SRC</span>
      <span className={"flag" + (r.web ? " present" : "")}>WEB</span>
    </div>
  );
}
