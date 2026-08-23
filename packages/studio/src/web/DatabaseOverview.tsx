import React, { useRef } from "react";
import type { ProjectResourceKind } from "@rpg-harness/engine";
import type { ProjectResponse } from "./api";

export type DatabaseOverviewKind =
  | "character"
  | "item"
  | "weapon"
  | "skill"
  | "enemy"
  | "action"
  | "map"
  | "asset";

export interface DatabaseOverviewCategory {
  kind: DatabaseOverviewKind;
  icon: string;
  eyebrow: string;
  label: string;
  description: string;
  count: number;
  countLabel: string;
}

const DATABASE_CATEGORY_META: Array<Omit<DatabaseOverviewCategory, "count">> = [
  {
    kind: "character",
    icon: "♙",
    eyebrow: "ACTORS",
    label: "Characters",
    description: "Playable identities, companions, portraits and field presence.",
    countLabel: "records",
  },
  {
    kind: "item",
    icon: "◇",
    eyebrow: "INVENTORY",
    label: "Items",
    description: "Collectibles, currencies, consumables and quest resources.",
    countLabel: "records",
  },
  {
    kind: "weapon",
    icon: "†",
    eyebrow: "EQUIPMENT",
    label: "Weapons / Equipment",
    description: "Equippable records and the authored effects they carry.",
    countLabel: "records",
  },
  {
    kind: "skill",
    icon: "✦",
    eyebrow: "ABILITIES",
    label: "Skills",
    description: "Learned techniques, requirements and runtime effects.",
    countLabel: "records",
  },
  {
    kind: "enemy",
    icon: "♞",
    eyebrow: "ENCOUNTERS",
    label: "Enemies",
    description: "Hostile actors, combat profiles and encounter identities.",
    countLabel: "records",
  },
  {
    kind: "action",
    icon: "▶",
    eyebrow: "SYSTEM",
    label: "Actions",
    description: "Reusable engine-facing commands available to game content.",
    countLabel: "records",
  },
  {
    kind: "map",
    icon: "▦",
    eyebrow: "WORLD",
    label: "Maps",
    description: "Node and 2D spaces, layers, placements and map events.",
    countLabel: "maps",
  },
  {
    kind: "asset",
    icon: "▧",
    eyebrow: "VISUALS",
    label: "Visual Assets",
    description: "Portraits, backgrounds, CGs, sprites, sheets and tilesets.",
    countLabel: "assets",
  },
];

export function databaseOverviewCategories(
  project: Pick<ProjectResponse, "graph" | "maps" | "assets">,
): DatabaseOverviewCategory[] {
  return DATABASE_CATEGORY_META.map((category) => ({
    ...category,
    count: category.kind === "map"
      ? project.maps.length
      : category.kind === "asset"
        ? project.assets.length
        : project.graph.resources.filter((resource) => resource.kind === category.kind).length,
  }));
}

export function nextDatabaseOverviewCardIndex(
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

export function DatabaseOverview({
  project,
  onOpenKind,
  onCreateKind,
  onOpenAssets,
}: {
  project: Pick<ProjectResponse, "graph" | "maps" | "assets">;
  onOpenKind: (kind: Exclude<DatabaseOverviewKind, "asset">) => void;
  onCreateKind: (kind: Exclude<DatabaseOverviewKind, "asset">) => void;
  onOpenAssets: () => void;
}) {
  const gridRef = useRef<HTMLElement | null>(null);
  const categories = databaseOverviewCategories(project);
  const recordCount = categories.reduce((total, category) => total + category.count, 0);

  const navigateGrid = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "].includes(event.key)) return;
    const cards = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button.database-overview-card"));
    const target = event.target instanceof HTMLButtonElement ? event.target : null;
    if (!target || !cards.includes(target)) return;
    event.preventDefault();
    if (event.key === "Enter" || event.key === " ") {
      target.click();
      return;
    }
    const nextRow = cards.findIndex((card) => card.offsetTop > cards[0]!.offsetTop);
    const columns = nextRow === -1 ? Math.max(1, cards.length) : nextRow;
    cards[nextDatabaseOverviewCardIndex(cards.indexOf(target), cards.length, columns, event.key)]?.focus();
  };

  return (
    <section className="database-overview" aria-labelledby="database-overview-title">
      <header className="database-overview-hero">
        <div className="database-overview-mark" aria-hidden="true">◫</div>
        <div>
          <span>AUTHORITATIVE PROJECT CATALOG</span>
          <h1 id="database-overview-title">Game Database</h1>
          <p>Open every authored game record from one RPG-style catalog. Maps and visual resources keep their specialized editors.</p>
        </div>
        <dl>
          <div><dt>Categories</dt><dd>{categories.length}</dd></div>
          <div><dt>Records</dt><dd>{recordCount}</dd></div>
        </dl>
      </header>

      <nav
        ref={gridRef}
        className="database-overview-grid"
        aria-label="Game Database categories"
        onKeyDown={navigateGrid}
      >
        {categories.map((category) => {
          const empty = category.count === 0;
          const asset = category.kind === "asset";
          const countLabel = category.count === 1
            ? category.countLabel.replace(/s$/, "")
            : category.countLabel;
          const action = category.kind === "asset"
            ? onOpenAssets
            : empty
              ? () => onCreateKind(category.kind as Exclude<DatabaseOverviewKind, "asset">)
              : () => onOpenKind(category.kind as Exclude<DatabaseOverviewKind, "asset">);
          const verb = asset ? "Open" : empty ? "Create first" : "Open";
          return (
            <button
              type="button"
              className={`database-overview-card kind-${category.kind}${empty ? " empty" : ""}`}
              aria-label={`${verb} ${category.label}, ${category.count} ${countLabel}`}
              key={category.kind}
              onClick={action}
            >
              <i aria-hidden="true">{category.icon}</i>
              <span className="database-overview-card-copy">
                <small>{category.eyebrow}</small>
                <strong>{category.label}</strong>
                <p>{category.description}</p>
              </span>
              <span className="database-overview-card-count"><b>{category.count}</b><small>{countLabel}</small></span>
              <em>{asset ? "Open library" : empty ? "Create first record" : "Open records"}<span aria-hidden="true">→</span></em>
            </button>
          );
        })}
      </nav>
      <footer className="database-overview-footer">
        <span><kbd>↑↓←→</kbd> Navigate</span>
        <span><kbd>Home</kbd><kbd>End</kbd> Jump</span>
        <span><kbd>Enter</kbd> Open</span>
      </footer>
    </section>
  );
}

export function databaseSectionForKind(kind: ProjectResourceKind): "world" | "database" | null {
  if (kind === "map") return "world";
  if (["character", "item", "weapon", "skill", "enemy", "action"].includes(kind)) return "database";
  return null;
}
