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
      <div className="backlog-overlay" onClick={onClose}>
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
    <div className="backlog-overlay" onClick={onClose}>
      <div className="backlog-inner artbook-inner" onClick={(e) => e.stopPropagation()}>
        <div className="backlog-head">
          <span>設定集</span>
          <button className="hud-btn" onClick={onClose}>
            閉じる
          </button>
        </div>
        <div className="artbook-tabs">
          {packs.map((p, i) => (
            <button
              key={p.id}
              className={"hud-btn" + (i === active ? " artbook-tab-active" : "")}
              onClick={() => setActive(i)}
            >
              {p.name}
            </button>
          ))}
        </div>
        <div className="backlog-scroll artbook-scroll">
          {pack.sheets.map((s) => (
            <Plate key={s.path} spec={s} assetUrls={assetUrls} wide />
          ))}
          {pack.portraits.length > 0 && (
            <div className="artbook-portrait-row">
              {pack.portraits.map((s) => (
                <Plate key={s.path} spec={s} assetUrls={assetUrls} />
              ))}
            </div>
          )}
        </div>
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
      <figcaption>{spec.placeholder}</figcaption>
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
    packs.push({ id: c.id, name: c.name, sheets, portraits });
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
