import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectResourceNode } from "@rpg-harness/engine";
import type { ProjectResponse } from "./api";
import {
  DatabaseOverview,
  databaseOverviewCategories,
  databaseSectionForKind,
  nextDatabaseOverviewCardIndex,
} from "./DatabaseOverview";

function resource(kind: ProjectResourceNode["kind"], id: string): ProjectResourceNode {
  return { kind, id, key: `${kind}:${id}`, label: id, refs: [] };
}

const project = {
  graph: {
    resources: [
      resource("character", "kagari"),
      resource("character", "kasumi"),
      resource("item", "soul_shard"),
      resource("weapon", "yaodao"),
      resource("skill", "hayagake"),
      resource("enemy", "oni"),
      resource("map", "swamp"),
      resource("asset", "assets/sprites/kagari"),
    ],
    backlinks: {},
    missing: [],
    unreferenced: [],
  },
  maps: [{ id: "swamp" }, { id: "shrine" }],
  assets: [
    { path: "assets/sprites/kagari" },
    { path: "assets/tilesets/shrine" },
    { path: "assets/backgrounds/swamp" },
  ],
} as unknown as ProjectResponse;

describe("Studio Game Database overview", () => {
  test("keeps a fixed RPG-style category catalog and derives counts from the project projection", () => {
    expect(databaseOverviewCategories(project).map(({ kind, count }) => [kind, count])).toEqual([
      ["character", 2],
      ["item", 1],
      ["weapon", 1],
      ["skill", 1],
      ["enemy", 1],
      ["action", 0],
      ["map", 2],
      ["asset", 3],
    ]);
  });

  test("renders empty categories as named creation targets instead of hiding them", () => {
    const html = renderToStaticMarkup(<DatabaseOverview
      project={project}
      onOpenKind={() => {}}
      onCreateKind={() => {}}
      onOpenAssets={() => {}}
    />);
    expect(html).toContain("Game Database");
    expect(html).toContain('aria-label="Create first Actions, 0 records"');
    expect(html).toContain("Create first record");
    expect(html).toContain('aria-label="Open Weapons / Equipment, 1 record"');
    expect(html).toContain('aria-label="Open Maps, 2 maps"');
    expect(html).toContain('aria-label="Open Visual Assets, 3 assets"');
  });

  test("moves through the responsive database card grid without leaving its bounds", () => {
    expect(nextDatabaseOverviewCardIndex(1, 8, 4, "ArrowDown")).toBe(5);
    expect(nextDatabaseOverviewCardIndex(7, 8, 4, "ArrowDown")).toBe(7);
    expect(nextDatabaseOverviewCardIndex(4, 8, 4, "ArrowUp")).toBe(0);
    expect(nextDatabaseOverviewCardIndex(0, 8, 4, "ArrowLeft")).toBe(0);
    expect(nextDatabaseOverviewCardIndex(7, 8, 4, "ArrowRight")).toBe(7);
    expect(nextDatabaseOverviewCardIndex(3, 8, 4, "Home")).toBe(0);
    expect(nextDatabaseOverviewCardIndex(3, 8, 4, "End")).toBe(7);
  });

  test("routes world and database record kinds through their existing workspaces", () => {
    expect(databaseSectionForKind("map")).toBe("world");
    expect(databaseSectionForKind("character")).toBe("database");
    expect(databaseSectionForKind("action")).toBe("database");
    expect(databaseSectionForKind("asset")).toBeNull();
  });
});
