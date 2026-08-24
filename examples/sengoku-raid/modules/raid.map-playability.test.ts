import { expect, test } from "bun:test";
import path from "node:path";
import { loadGame } from "@rpg-harness/cli";
import {
  analyzeMapPlayability,
  buildPresetContext,
  collectMapAvailableResources,
  createInitialState,
} from "@rpg-harness/engine";

const GAME_DIR = path.resolve(import.meta.dir, "..");

test("sengoku-raid spatial maps have no playability warnings", async () => {
  const game = await loadGame(GAME_DIR);
  const warnings = analyzeMapPlayability(game)
    .filter((diagnostic) => diagnostic.severity === "warning");

  expect(warnings).toEqual([]);
});

test("the real directional atlas stays presentation-only on an existing route", async () => {
  const game = await loadGame(GAME_DIR);
  const asset = game.assets?.find(
    (candidate) => candidate.path === "assets/sprites/paper-shikigami-field",
  );
  expect(asset).toMatchObject({
    kind: "sprite",
    spriteGrid: {
      columns: 2,
      rows: 2,
      defaultFacing: "south",
      frames: { north: 0, east: 1, south: 2, west: 3 },
    },
  });
  expect(asset?.renderings.sourceCompressed).toEndWith("source.compressed.webp");

  const map = game.maps?.find(
    (candidate) => candidate.id === "sumida_river_drowned_shrine",
  );
  const placement = map?.placements?.find(
    (candidate) => candidate.id === "exit_sumida_river_drift_pier",
  );
  expect(placement).toMatchObject({
    at: { x: 11, y: 5 },
    asset: "assets/sprites/paper-shikigami-field",
    facing: "east",
    footprint: { width: 1, height: 2 },
    collision: "trigger",
    resource: { kind: "map", id: "sumida_river_drift_pier" },
    events: [{ id: "move", trigger: "manual", label: "川沿い", order: 1 }],
  });

  const state = createInitialState(game);
  state.baseline.currentMapId = "sumida_river_drowned_shrine";
  const resources = collectMapAvailableResources(
    buildPresetContext(game, state, () => 0),
  ).filter((candidate) => candidate.placementId === placement?.id);

  expect(resources).toHaveLength(2);
  expect(resources.every((candidate) =>
    !("asset" in candidate) && !("facing" in candidate)
  )).toBe(true);
  expect(resources.find((candidate) => candidate.eventId === "move")).toMatchObject({
    key: "map:sumida_river_drowned_shrine/placement:exit_sumida_river_drift_pier/event:move",
    resource: { kind: "map", id: "sumida_river_drift_pier" },
    activity: {
      actionKind: "moveToMap",
      payload: {
        to: "sumida_river_drift_pier",
        routeKey: "map:sumida_river_drowned_shrine/placement:exit_sumida_river_drift_pier/event:move",
      },
    },
  });
});
