import React, { useEffect, useMemo, useState } from "react";
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
  // The "asset pack" view: narrow to one character's full design
  // package via refs.characters. Composes with the kind filter.
  const [charFilter, setCharFilter] = useState<string | "all">("all");

  useEffect(() => {
    fetchAssets()
      .then((r) => {
        setAssets(r.assets);
        setDangling(r.dangling);
      })
      .catch((e) => setErr(e.message));
  }, []);

  const filtered = useMemo(() => {
    if (!assets) return [];
    let rows = assets;
    if (charFilter !== "all") {
      rows = rows.filter((a) => a.refs?.characters?.includes(charFilter));
    }
    if (filter === "all") return rows;
    if (filter === "missing") {
      return rows.filter((a) => !a.renderings.tuiTxt && !a.renderings.tuiAns);
    }
    return rows.filter((a) => a.kind === filter);
  }, [assets, filter, charFilter]);

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
    });
  }, [dangling, filter]);
  const ghostEmotions =
    filter === "all" || filter === "missing" || filter === "portrait"
      ? dangling?.missingEmotions ?? []
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
          <code>assets/sheets/</code> to get started.
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
    missing: assets.filter((a) => !a.renderings.tuiTxt && !a.renderings.tuiAns)
      .length,
    ghost:
      (dangling?.missingAssets.length ?? 0) +
      (dangling?.missingEmotions.length ?? 0),
  };

  return (
    <>
      <h1 className="page-title">Assets</h1>
      <div className="row" style={{ marginBottom: 16 }}>
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
          label={`missing TUI (${counts.missing})`}
          active={filter === "missing"}
          onClick={() => setFilter("missing")}
        />
      </div>
      {characterIds.length > 0 && (
        <div className="row" style={{ marginBottom: 16 }}>
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
      {counts.ghost > 0 && (
        <div className="ghost-banner">
          ⚠ {counts.ghost} reference{counts.ghost === 1 ? "" : "s"} in
          scripts/characters resolve to nothing — players will see
          placeholder text. Create the spec (or fix the path / emotion
          name) to clear these.
        </div>
      )}
      <div className="grid">
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
      </div>
    </>
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
  return seg || "?";
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
  return (
    <Link to={`/asset/${asset.path}`} className="card">
      <div className="thumb">
        {asset.renderings.source ? (
          <img src={sourceImageUrl(asset.path)} alt={asset.placeholder} />
        ) : (
          <div className="placeholder-thumb">{asset.placeholder}</div>
        )}
      </div>
      <div className="body">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className={`kind-badge ${asset.kind}`}>{asset.kind}</span>
          <RenderingFlags r={asset.renderings} />
        </div>
        <div className="path">{asset.path}</div>
        <div className="placeholder-text">{asset.placeholder}</div>
      </div>
    </Link>
  );
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
