import { afterEach, describe, expect, test } from "bun:test";
import { scriptRevision, type ComposedState, type Game, type Script } from "@rpg-harness/engine";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyzeScriptCoverage, collectScriptCoverage } from "./coverage";
import { loadGame } from "../loader";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true })
  ));
});

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
      completedRevision: scriptRevision(scripts[0]!),
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
      stale: 0,
      started: 1,
      uncovered: 1,
      ignored: 1,
      legacyCompletions: 0,
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
    expect(report.scripts.find((row) => row.id === "done")?.legacySessions)
      .toEqual([]);
  });

  test("rejects session names that escape the session directory", async () => {
    await expect(
      collectScriptCoverage("/tmp/coverage-test", "../outside"),
    ).rejects.toThrow("Invalid session name");
  });

  test("CLI family scope requires an explicit source session", async () => {
    const child = Bun.spawn([
      process.execPath,
      path.resolve(import.meta.dir, "../bin.ts"),
      "coverage",
      "/tmp/coverage-family-cli",
      "--family",
    ], { stdout: "pipe", stderr: "pipe" });

    expect(await child.exited).toBe(2);
    expect(await new Response(child.stderr).text()).toContain(
      "--family requires --session",
    );
  });

  test("marks completions from an edited authored revision as stale", () => {
    const script: Script = {
      id: "scene",
      title: "Scene",
      beats: [{ type: "narration", text: "new copy" }],
    };
    const game = { title: "Freshness", characters: [], scripts: [script] } as Game;
    const old = state();
    old.baseline.scripts.scene = {
      completed: true,
      completedRevision: "old-revision",
      selfSwitches: { A: false, B: false, C: false, D: false },
    };
    const report = analyzeScriptCoverage(game, [{ session: "old-run", state: old }]);

    expect(report.summary).toMatchObject({ completed: 0, stale: 1 });
    expect(report.scripts[0]).toMatchObject({
      status: "stale",
      completedSessions: [],
      staleSessions: ["old-run"],
    });

    old.baseline.scripts.scene!.completedRevision = scriptRevision(script);
    expect(analyzeScriptCoverage(game, [{ session: "new-run", state: old }])
      .scripts[0]?.status).toBe("completed");
  });

  test("unversioned completions are always stale", () => {
    const script: Script = { id: "scene", title: "Scene", beats: [] };
    const game = {
      title: "Strict",
      characters: [],
      scripts: [script],
    } as Game;
    const legacy = state();
    legacy.baseline.scripts.scene = {
      completed: true,
      selfSwitches: { A: false, B: false, C: false, D: false },
    };

    const report = analyzeScriptCoverage(game, [{ session: "legacy", state: legacy }]);
    expect(report.summary).toMatchObject({ completed: 0, stale: 1, legacyCompletions: 1 });
    expect(report.scripts[0]).toMatchObject({
      status: "stale",
      staleSessions: ["legacy"],
      legacySessions: ["legacy"],
    });
  });

  test("scopes development evidence to a source session and its fork descendants", async () => {
    const gameDir = await mkdtemp(path.join(tmpdir(), "rpgh-coverage-family-"));
    temporaryDirectories.push(gameDir);
    await mkdir(path.join(gameDir, "scripts"), { recursive: true });
    await writeFile(path.join(gameDir, "game.yaml"), "title: Coverage family\n");
    await writeFile(path.join(gameDir, "scripts", "scene.md"), [
      "---",
      "id: scene",
      "title: Scene",
      "characters: []",
      "---",
      "",
      "Scene.",
      "",
      "[end]",
      "",
    ].join("\n"));
    const currentRevision = scriptRevision((await loadGame(gameDir)).scripts[0]!);
    const sessionsRoot = path.join(gameDir, ".rpg-harness", "sessions");
    for (const name of ["player", "child", "grandchild", "unrelated"]) {
      await mkdir(path.join(sessionsRoot, name), { recursive: true });
      const sessionState = state();
      if (name !== "player") {
        sessionState.baseline.scripts.scene = {
          completed: true,
          completedRevision: currentRevision,
          selfSwitches: { A: false, B: false, C: false, D: false },
        };
      }
      await writeFile(
        path.join(sessionsRoot, name, "state.json"),
        JSON.stringify(sessionState),
      );
    }
    await writeFile(path.join(sessionsRoot, "child", "fork.json"), JSON.stringify({
      fromSession: "player",
      sourceLogEntry: 0,
    }));
    await writeFile(path.join(sessionsRoot, "grandchild", "fork.json"), JSON.stringify({
      fromSession: "child",
      sourceLogEntry: 0,
    }));

    const sourceOnly = await collectScriptCoverage(gameDir, "player");
    const family = await collectScriptCoverage(gameDir, "player", true);

    expect(sourceOnly.scripts[0]?.status).toBe("uncovered");
    expect(family.sessions).toEqual(["child", "grandchild", "player"]);
    expect(family.scripts[0]).toMatchObject({
      status: "completed",
      completedSessions: ["child", "grandchild"],
    });
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
