import { describe, expect, test } from "bun:test";
import type { ComposedState, Game, Script } from "@rpg-harness/engine";
import { analyzeScriptCoverage, collectScriptCoverage } from "./coverage";

describe("story coverage", () => {
  test("distinguishes completed, started, uncovered and intentionally ignored scripts", () => {
    const scripts: Script[] = [
      { id: "done", title: "Done", beats: [] },
      { id: "active", title: "Active", beats: [] },
      { id: "missing", title: "Missing", beats: [] },
      {
        id: "router",
        title: "Router",
        beats: [],
        coverage: { ignore: true, reason: "redirect placeholder" },
      },
    ];
    const game = { title: "Coverage test", characters: [], scripts } as Game;
    const completed = state();
    completed.baseline.scripts.done = {
      completed: true,
      selfSwitches: { A: false, B: false, C: false, D: false },
    };
    completed.baseline.completionOrder.push("done");
    const started = state();
    started.baseline.currentScriptId = "active";

    const report = analyzeScriptCoverage(game, [
      { session: "completed-run", state: completed },
      { session: "active-run", state: started },
    ]);

    expect(report.summary).toEqual({
      total: 4,
      tracked: 3,
      completed: 1,
      started: 1,
      uncovered: 1,
      ignored: 1,
      completionPercent: 33.33,
    });
    expect(report.scripts).toEqual([
      expect.objectContaining({
        id: "active",
        status: "started",
        startedSessions: ["active-run"],
      }),
      expect.objectContaining({
        id: "done",
        status: "completed",
        completedSessions: ["completed-run"],
      }),
      expect.objectContaining({ id: "missing", status: "uncovered" }),
      expect.objectContaining({
        id: "router",
        status: "ignored",
        ignoreReason: "redirect placeholder",
      }),
    ]);
  });

  test("rejects session names that escape the session directory", async () => {
    await expect(
      collectScriptCoverage("/tmp/coverage-test", "../outside"),
    ).rejects.toThrow("Invalid session name");
  });
});

function state(): ComposedState {
  return {
    baseline: {
      characters: {},
      switches: {},
      variables: {},
      scripts: {},
      completionOrder: [],
      currentScriptId: null,
      beatIndex: 0,
      scriptCursor: null,
      inventory: {},
      currentMapId: null,
      weapons: {},
      equippedWeaponId: null,
      knownSkills: [],
      visuals: { bg: null, portraits: {}, cg: null },
    },
    runtime: {
      pendingNarrations: [],
      activeTriggers: [],
      firedTriggers: [],
      firedScriptStarts: [],
      lastHubActivities: [],
    },
  };
}
