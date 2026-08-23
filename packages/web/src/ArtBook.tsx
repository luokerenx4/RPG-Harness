import React, { useMemo, useState } from "react";
import type { AssetSpec, Game } from "@rpg-harness/engine";

// 設定集 — the in-game art book. A pure projection of the game's
// descriptive assets: sheet-kind assets (master / turnaround /
// expression grids) plus in-game portraits, grouped per character via
// refs.characters. Nothing here is a new store — the gallery shows
// exactly what generation uses as reference, so players browse the
// same canon the art pipeline draws from.
interface Pack {
  id: string;
  name: string;
  description: string;
  sheets: AssetSpec[];
  portraits: AssetSpec[];
}

export function ArtBook({
  game,
  assetUrls,
  onClose,
}: {
  game: Game;
  assetUrls: Record<string, string>;
  onClose: () => void;
}) {
  const packs = useMemo(() => buildPacks(game), [game]);
  const [active, setActive] = useState(0);

  if (packs.length === 0) {
    return (
      <div className="backlog-overlay" role="dialog" aria-modal="true" aria-label="設定集" onClick={onClose}>
        <div className="backlog-inner" onClick={(e) => e.stopPropagation()}>
          <div className="backlog-head">
            <span>設定集</span>
            <button className="hud-btn" onClick={onClose}>
              閉じる
            </button>
          </div>
          <div className="artbook-empty">設定資料はまだありません。</div>
        </div>
      </div>
    );
  }

  const pack = packs[Math.min(active, packs.length - 1)]!;

  return (
    <div className="backlog-overlay" role="dialog" aria-modal="true" aria-label="設定集" onClick={onClose}>
      <div className="backlog-inner artbook-inner" onClick={(e) => e.stopPropagation()}>
        <header className="artbook-head">
          <div><span>ARCHIVE · {packs.length} RECORDS</span><strong>設定資料集</strong></div>
          <button type="button" onClick={onClose}>閉じる <kbd>Esc</kbd></button>
        </header>
        <div className="artbook-layout">
          <aside className="artbook-index">
            <header><span>CHARACTERS</span><small>{packs.length}</small></header>
            <nav aria-label="設定集の人物">
              {packs.map((candidate, index) => (
                <button
                  type="button"
                  key={candidate.id}
                  className={index === active ? "active" : ""}
                  onClick={() => setActive(index)}
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div><strong>{candidate.name}</strong><small>{candidate.id}</small></div>
                  <i>{candidate.sheets.length + candidate.portraits.length}</i>
                </button>
              ))}
            </nav>
            <footer><span>CANON ASSET INDEX</span><small>生成参照と同じ資料</small></footer>
          </aside>
          <main className="artbook-scroll">
            <header className="artbook-record-head">
              <div><span>CHARACTER FILE · {String(active + 1).padStart(2, "0")}</span><h2>{pack.name}</h2><code>{pack.id}</code></div>
              <dl><div><dt>SHEETS</dt><dd>{pack.sheets.length}</dd></div><div><dt>PORTRAITS</dt><dd>{pack.portraits.length}</dd></div></dl>
              {pack.description && <p>{pack.description}</p>}
            </header>
            {pack.sheets.length > 0 && (
              <section className="artbook-gallery-section">
                <header><span>DESIGN SHEETS</span><small>公式設定画</small></header>
                {pack.sheets.map((sheet) => (
                  <Plate key={sheet.path} spec={sheet} assetUrls={assetUrls} wide />
                ))}
              </section>
            )}
            {pack.portraits.length > 0 && (
              <section className="artbook-gallery-section">
                <header><span>PORTRAIT ARCHIVE</span><small>ゲーム内立絵</small></header>
                <div className="artbook-portrait-row">
                  {pack.portraits.map((portrait) => (
                    <Plate key={portrait.path} spec={portrait} assetUrls={assetUrls} />
                  ))}
                </div>
              </section>
            )}
          </main>
        </div>
        <footer className="artbook-footer"><span>{pack.name} · {pack.sheets.length + pack.portraits.length} assets</span><span>RPG HARNESS ARCHIVE</span></footer>
      </div>
    </div>
  );
}

function Plate({
  spec,
  assetUrls,
  wide,
}: {
  spec: AssetSpec;
  assetUrls: Record<string, string>;
  wide?: boolean;
}) {
  const url = assetUrls[spec.path];
  return (
    <figure className={"artbook-plate" + (wide ? " wide" : "")}>
      {url ? (
        <img src={url} alt={spec.placeholder} draggable={false} />
      ) : (
        <div className="artbook-placeholder">{spec.placeholder}</div>
      )}
      <figcaption><span>{spec.kind}</span><p>{spec.placeholder}</p><code>{spec.path}</code></figcaption>
    </figure>
  );
}

function buildPacks(game: Game): Pack[] {
  const assets = game.assets ?? [];
  const packs: Pack[] = [];
  for (const c of game.characters) {
    const mine = assets.filter((a) => a.refs?.characters?.includes(c.id));
    const sheets = mine
      .filter((a) => a.kind === "sheet")
      .sort(rankSheet);
    const portraits = mine.filter((a) => a.kind === "portrait");
    if (sheets.length === 0 && portraits.length === 0) continue;
    packs.push({
      id: c.id,
      name: c.name,
      description: sheets[0]?.description ?? portraits[0]?.description ?? "",
      sheets,
      portraits,
    });
  }
  return packs;
}

// Master first, then the split sheets, then anything else by path.
function rankSheet(a: AssetSpec, b: AssetSpec): number {
  const r = (s: AssetSpec) =>
    s.tags?.includes("master") || s.path.endsWith("-master")
      ? 0
      : s.path.endsWith("-turnaround")
        ? 1
        : s.path.endsWith("-expressions")
          ? 2
          : 3;
  return r(a) - r(b) || a.path.localeCompare(b.path);
}
