import { expect, test } from "bun:test";
import path from "node:path";
import { loadGame } from "@rpg-harness/cli";
import { analyzeMapPlayability } from "@rpg-harness/engine";

const GAME_DIR = path.resolve(import.meta.dir, "..");

test("sengoku-raid spatial maps have no playability warnings", async () => {
  const game = await loadGame(GAME_DIR);
  const warnings = analyzeMapPlayability(game)
    .filter((diagnostic) => diagnostic.severity === "warning");

  expect(warnings).toEqual([]);
});
