import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState } from "@rpg-harness/engine";
import { withSessionLock } from "@rpg-harness/session-store";
import { loadGame } from "../loader";
import {
  listPlaytestReports,
  reproducePlaytestReport,
} from "../playtest-reports";
import { appendLog, loadSession, saveSession, sessionDir } from "../session";
import {
  collectAutoplaySourceTargets,
  compactAutoplaySummary,
  detectTerminalScriptId,
  runAutoplay,
  summarizeDecisionPath,
  type AutoplaySummary,
} from "./autoplay";
import { loadForkSource } from "./fork";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

describe("autoplay ending summary", () => {
  test("uses the terminal output's explicit stable identity", () => {
    expect(detectTerminalScriptId({
      done: true,
      trace: [{ output: { type: "gameEnd", endingId: "ending_oni_self" } }],
    })).toBe("ending_oni_self");
  });

  test("accepts a legitimate generic gameEnd without borrowing a previous script id", () => {
    expect(detectTerminalScriptId({
      done: true,
      trace: [{ output: { type: "gameEnd", reason: "calendar ended" } }],
    })).toBe("game-end");
  });

  test("does not call an unfinished run an ending", () => {
    expect(detectTerminalScriptId({
      done: false,
      trace: [],
    })).toBeNull();
  });
});

describe("autoplay semantic decision paths", () => {
  test("keeps default CLI output bounded while pointing at exact details", () => {
    const full = {
      reason: "completed",
      persona: "completionist",
      seed: 17,
      progress: {
        madeProgress: true,
        completedScripts: Array.from(
          { length: 1_000 },
          (_, index) => `script:${index}`,
        ),
        objectiveChanges: Array.from({ length: 1_000 }, (_, index) => ({
          objectiveId: "main",
          requirementId: `requirement:${index}`,
          from: index,
          to: index + 1,
        })),
      },
      decisionPath: {
        revision: "decision-revision",
        decisions: Array.from({ length: 1_000 }, (_, index) => ({
          type: "doActivity" as const,
          id: `activity:${index}`,
        })),
      },
      decisions: 1_000,
      rejectedInputs: 0,
      steps: 1_001,
      finalState: createInitialState([]),
      ending: "intro",
      session: "agent-run",
      webPath: "/?session=agent-run",
      choiceCoverage: {
        summary: {
          choices: 1,
          covered: 0,
          partial: 1,
          uncovered: 0,
          locked: 0,
          options: 2,
          selectedOptions: 1,
          pendingOptions: 1,
          lockedOptions: 0,
          untrackedChoiceEvents: 0,
          staleChoiceEvents: 0,
          unversionedChoiceEvents: 0,
        },
        pendingBranches: [{ evidence: { checkpoint: "large" } }],
      },
      report: {
        id: "pt-bounded",
        status: "open",
        session: "agent-run",
        area: "tooling",
        severity: "major",
        title: "Large evidence",
        evidence: { huge: "x".repeat(100_000) },
      },
    } as unknown as AutoplaySummary;

    const compact = compactAutoplaySummary(full);

    expect(compact.persona).toBe("completionist");
    expect(compact.decisionPath).toEqual({ revision: "decision-revision" });
    expect(compact.finalStateRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(compact.progress).toMatchObject({
      completedScripts: { count: 1_000 },
      objectiveChanges: { count: 1_000 },
    });
    expect(compact.progress.completedScripts.recent).toHaveLength(10);
    expect(compact.progress.objectiveChanges.recent).toHaveLength(10);
    expect(compact.choiceCoverage).toMatchObject({
      pendingBranches: 1,
      next: {
        command: "worklist",
        args: { session: "agent-run" },
      },
    });
    expect(compact).not.toHaveProperty("finalState");
    expect(compact.choiceCoverage).not.toHaveProperty("pendingBranches.0");
    expect(compact.report).toEqual({
      id: "pt-bounded",
      status: "open",
      session: "agent-run",
      area: "tooling",
      severity: "major",
      title: "Large evidence",
      next: {
        command: "inspect-report",
        args: { id: "pt-bounded", session: "agent-run" },
      },
    });
    expect(JSON.stringify(compact).length).toBeLessThan(2_000);
  });

  test("maps stable activity and choice contracts back to authoring files", () => {
    const gameDir = "/game";
    const game = {
      characters: [],
      scripts: [{
        id: "route",
        title: "Route",
        source: "/game/scripts/route.md",
        beats: [],
      }],
      modules: [{
        id: "raid",
        source: "modules/raid.ts",
        actionHandlers: { depart: () => ({}) },
      }],
    } as unknown as Parameters<typeof collectAutoplaySourceTargets>[1];
    const hub = {
      type: "hubMenu" as const,
      snapshot: {
        day: 1,
        maxDay: 1,
        slot: 0,
        slotName: "day",
        slotsPerDay: 1,
        stats: [],
        affections: [],
        activities: [{
          id: "depart:kuro",
          kind: "action" as const,
          title: "Depart",
          cost: 1,
          available: true,
          actionKind: "raid:depart",
          payload: { mapId: "kuro" },
        }],
      },
    };
    const choice = {
      type: "choice" as const,
      scriptId: "route",
      scriptRevision: "b".repeat(64),
      choiceId: "fork",
      options: [{ id: "left", text: "Left", available: true }],
    };
    const trace = [
      { index: 0, input: null, output: hub },
      {
        index: 1,
        input: { type: "doActivity" as const, id: "depart:kuro" },
        output: choice,
      },
      {
        index: 2,
        input: { type: "choose" as const, choiceId: "fork", optionId: "left" },
        output: { type: "narration" as const, text: "Left" },
        decision: {
          scriptId: "route",
          choiceId: "fork",
          optionId: "left",
        },
      },
    ];

    expect(collectAutoplaySourceTargets(gameDir, game, trace)).toEqual([
      {
        kind: "module-action",
        file: "modules/raid.ts",
        moduleId: "raid",
        actionKind: "raid:depart",
        activityId: "depart:kuro",
      },
      {
        kind: "script",
        file: "scripts/route.md",
        scriptId: "route",
        scriptRevision: "b".repeat(64),
        choiceId: "fork",
      },
    ]);
  });

  test("uses the terminal save cursor when a narration has no inline script id", () => {
    const game = {
      characters: [],
      scripts: [{
        id: "prologue",
        title: "Prologue",
        source: "/game/scripts/prologue.md",
        beats: [],
      }],
    } as unknown as Parameters<typeof collectAutoplaySourceTargets>[1];
    expect(collectAutoplaySourceTargets(
      "/game",
      game,
      [{
        index: 0,
        input: { type: "next" },
        output: { type: "narration", text: "Still inside the prologue." },
      }],
      undefined,
      "prologue",
    )).toEqual([{
      kind: "script",
      file: "scripts/prologue.md",
      scriptId: "prologue",
    }]);
  });

  test("content-addresses accepted semantic ids and ignores rejected inputs", () => {
    const first = summarizeDecisionPath([
      {
        input: { type: "doActivity", id: "locked" },
        inputResult: { accepted: false, code: "activity-locked", message: "locked", expected: [] },
      },
      {
        input: { type: "doActivity", id: "search" },
        inputResult: { accepted: true, code: "accepted", message: "accepted", expected: [] },
        output: {
          type: "hubMenu",
          snapshot: {
            day: 0,
            maxDay: 0,
            slot: 0,
            slotName: "",
            slotsPerDay: 0,
            stats: [],
            affections: [],
            activities: [{
              id: "search",
              kind: "action",
              title: "Search",
              cost: 0,
              available: true,
              aiTags: ["exploration", "reward"],
            }],
          },
        },
      },
      {
        input: { type: "choose", index: 2 },
        inputResult: { accepted: true, code: "accepted", message: "accepted", expected: [] },
        decision: { scriptId: "intro", choiceId: "route", optionId: "third" },
      },
      { input: { type: "next" } },
    ]);
    const second = summarizeDecisionPath([
      {
        input: { type: "doActivity", id: "search" },
        output: {
          type: "hubMenu",
          snapshot: {
            day: 0,
            maxDay: 0,
            slot: 0,
            slotName: "",
            slotsPerDay: 0,
            stats: [],
            affections: [],
            activities: [{
              id: "search",
              kind: "action",
              title: "Search",
              cost: 0,
              available: true,
              aiTags: ["exploration", "reward"],
            }],
          },
        },
      },
      {
        input: { type: "choose", choiceId: "route", optionId: "third" },
        decision: { scriptId: "intro", choiceId: "route", optionId: "third" },
      },
    ]);

    expect(first).toEqual(second);
    expect(first.decisions).toEqual([
      { type: "doActivity", id: "search", aiTags: ["exploration", "reward"] },
      { type: "choose", scriptId: "intro", choiceId: "route", optionId: "third" },
    ]);
    expect(first.revision).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("autoplay autonomous development lane", () => {
  test("files structured cycle evidence when a persona stalls", async () => {
    const gameDir = await temporaryToggleGame();
    const summary = await runAutoplay({
      gameDir,
      persona: "greedy",
      verbose: false,
      maxSteps: 100,
      session: "ai-stalled",
      reportOnStop: true,
    });

    expect(summary.reason).toBe("stalled");
    expect(summary.decisions).toBeLessThan(100);
    expect(summary.stall).toMatchObject({ cycleLength: 2, repetitions: 3 });
    expect(summary.report?.evidence.stall).toEqual(summary.stall);
    expect(summary.report?.target).toBe("modules/actions.ts");
    expect(summary.report?.evidence.sourceTargets).toEqual([{
      kind: "module-action",
      file: "modules/actions.ts",
      moduleId: "toggle-actions",
      actionKind: "toggle-actions:toggle",
      activityId: "toggle",
    }]);
    expect(summary.seed).toBeInteger();
    expect(summary.report?.evidence.autoplay).toEqual({
      replayCheckpoint: {
        schemaVersion: 1,
        file: expect.stringMatching(/^issue-checkpoints\/[a-f0-9]{64}\.json$/),
        revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      replayLogEntry: 0,
      persona: "greedy",
      maxSteps: 100,
      seed: summary.seed,
      stopReason: "stalled",
      decisions: summary.decisions,
      rejectedInputs: summary.rejectedInputs,
      steps: summary.steps,
      decisionPathRevision: summary.decisionPath.revision,
    });
    expect(summary.report?.details).toContain("exact 2-output cycle");
  });

  test("reports repeated behavior whose state counter masks an exact stall", async () => {
    const gameDir = await temporaryChangingCycleGame();
    const summary = await runAutoplay({
      gameDir,
      persona: "greedy",
      verbose: false,
      maxSteps: 6,
      session: "ai-changing-cycle",
      reportOnStop: true,
    });

    expect(summary.reason).toBe("max-steps");
    expect(summary.stall).toBeUndefined();
    expect(summary.behaviorCycle).toMatchObject({
      cycleLength: 2,
      repetitions: 3,
      changingStatePaths: ["baseline.inventory.turns"],
    });
    expect(summary.report?.evidence.behaviorCycle).toEqual(summary.behaviorCycle);
    expect(summary.report?.details).toContain("while only these state paths kept changing");
  });

  test("freezes incident evidence before a later GUI transaction changes the live session", async () => {
    const gameDir = await temporaryChangingCycleGame();
    const game = await loadGame(gameDir);
    const session = "ai-then-gui";
    let guiState: Awaited<ReturnType<typeof loadSession>> | undefined;

    const summary = await runAutoplay({
      gameDir,
      persona: "greedy",
      verbose: false,
      maxSteps: 6,
      session,
      reportOnStop: true,
    }, {
      afterSessionTransaction: async () => {
        await withSessionLock(gameDir, session, async () => {
          const state = await loadSession(gameDir, session, game);
          state.baseline.currentScriptId = "gui-followup";
          state.baseline.switches.guiTouched = true;
          await saveSession(gameDir, session, state);
          await appendLog(gameDir, session, {
            t: Date.now(),
            source: "web",
            input: { type: "next" },
            output: { type: "narration", text: "GUI moved after autoplay." },
          }, state);
          guiState = structuredClone(state);
        });
      },
    });

    expect(summary.reason).toBe("max-steps");
    const report = summary.report!;
    const issueCheckpoint = report.evidence.checkpoint!;
    const issueState = JSON.parse(await readFile(
      path.join(sessionDir(gameDir, session), ...issueCheckpoint.file.split("/")),
      "utf-8",
    ));
    const liveState = JSON.parse(await readFile(
      path.join(sessionDir(gameDir, session), "state.json"),
      "utf-8",
    ));
    const liveLog = (await readFile(
      path.join(sessionDir(gameDir, session), "log.jsonl"),
      "utf-8",
    )).trim().split("\n").map((line) => JSON.parse(line));

    expect(issueState).toEqual(summary.finalState);
    expect(issueState.baseline.switches.guiTouched).toBeUndefined();
    expect(liveState).toEqual(guiState!);
    expect(liveState.baseline).toMatchObject({
      currentScriptId: "gui-followup",
      switches: { guiTouched: true },
    });
    expect(liveLog.at(-1)).toMatchObject({
      source: "web",
      output: { type: "narration", text: "GUI moved after autoplay." },
    });
    expect(report.evidence.logEntry).toBe(liveLog.length - 1);
    expect(report.evidence.lastEvent).not.toEqual({
      input: { type: "next" },
      output: { type: "narration", text: "GUI moved after autoplay." },
    });
    expect(report.evidence.currentScriptId).not.toBe("gui-followup");
    expect(report.evidence.autoplay?.replayCheckpoint.revision)
      .not.toBe(issueCheckpoint.revision);
  });

  test("forks a player save and exposes a resumable zero-budget stop", async () => {
    const gameDir = await temporaryGame();
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "player-main", createInitialState(game));
    const sourceBefore = await readFile(
      path.join(sessionDir(gameDir, "player-main"), "state.json"),
      "utf-8",
    );

    const summary = await runAutoplay({
      gameDir,
      persona: "greedy",
      verbose: false,
      maxSteps: 0,
      fromSession: "player-main",
      session: "ai-audit",
      reportOnStop: true,
    });

    expect(summary.reason).toBe("max-steps");
    expect(summary.decisions).toBe(0);
    expect(summary.steps).toBe(1);
    expect(summary.choiceCoverage).toMatchObject({
      summary: { choices: 0, pendingOptions: 0 },
      pendingBranches: [],
    });
    expect(summary.ending).toBeNull();
    expect(summary.session).toBe("ai-audit");
    expect(summary.webPath).toBe("/?session=ai-audit");
    expect(summary.fork).toMatchObject({
      fromSession: "player-main",
      session: "ai-audit",
    });
    expect(summary.report).toBeUndefined();
    expect(summary.continuation).toEqual({
      kind: "budget-exhausted",
      session: "ai-audit",
      webPath: "/?session=ai-audit",
      next: {
        command: "autoplay",
        args: {
          persona: "greedy",
          maxSteps: 1,
          seed: summary.seed,
          session: "ai-audit",
          reportOnStop: true,
        },
      },
    });
    expect(summary.progress.madeProgress).toBe(false);
    expect(await readFile(
      path.join(sessionDir(gameDir, "player-main"), "state.json"),
      "utf-8",
    )).toBe(sourceBefore);

    const provenance = JSON.parse(await readFile(
      path.join(sessionDir(gameDir, "ai-audit"), "fork.json"),
      "utf-8",
    ));
    expect(provenance.fromSession).toBe("player-main");
    expect(await listPlaytestReports(gameDir, "player-main")).toEqual([]);
    expect(await listPlaytestReports(gameDir, "ai-audit")).toEqual([]);
  });

  test("returns progressing max-step stops as continuations instead of issues", async () => {
    const gameDir = await temporaryGame();
    const summary = await runAutoplay({
      gameDir,
      persona: "greedy",
      verbose: false,
      maxSteps: 1,
      session: "ai-budget-progress",
      reportOnStop: true,
    });

    expect(summary.reason).toBe("max-steps");
    expect(summary.progress).toMatchObject({
      madeProgress: true,
      scriptProgress: { from: null, to: "intro" },
    });
    expect(summary.report).toBeUndefined();
    expect(summary.continuation).toMatchObject({
      kind: "budget-exhausted",
      session: "ai-budget-progress",
      next: {
        command: "autoplay",
        args: {
          persona: "greedy",
          maxSteps: 1,
          session: "ai-budget-progress",
          reportOnStop: true,
        },
      },
    });
    expect(await listPlaytestReports(gameDir, "ai-budget-progress")).toEqual([]);
  });

  test("does not file an issue when the forked AI branch reaches gameEnd", async () => {
    const gameDir = await temporaryGame();
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "player-main", createInitialState(game));

    const summary = await runAutoplay({
      gameDir,
      persona: "greedy",
      verbose: false,
      maxSteps: 20,
      fromSession: "player-main",
      session: "ai-complete",
      reportOnStop: true,
    });

    expect(summary.reason).toBe("completed");
    expect(summary.ending).toBe("intro");
    expect(summary.report).toBeUndefined();
    expect(await listPlaytestReports(gameDir, "ai-complete")).toEqual([]);
  });

  test("files an incident when a generator returns without a public gameEnd", async () => {
    const gameDir = await temporarySilentReturnGame();
    const summary = await runAutoplay({
      gameDir,
      persona: "greedy",
      verbose: false,
      maxSteps: 20,
      session: "ai-silent-return",
      reportOnStop: true,
    });

    expect(summary).toMatchObject({
      reason: "completed",
      ending: null,
      report: {
        status: "open",
        title: "Autoplay greedy completed without a public gameEnd",
        evidence: {
          checkpoint: { schemaVersion: 1 },
          autoplay: { stopReason: "completed" },
        },
      },
    });
    expect(summary.report?.details).toContain(
      "returned without a public gameEnd output",
    );
  });

  test("replays a fresh random session from the causal checkpoint without shifting its RNG", async () => {
    const gameDir = await temporaryRandomChoiceGame();
    const original = await runAutoplay({
      gameDir,
      persona: "random",
      verbose: false,
      maxSteps: 100,
      seed: 1,
      session: "fresh-random",
      reportOnStop: true,
    });
    const report = original.report;
    if (!report) throw new Error("fixture did not create a causal autoplay report");

    expect(original.reason).toBe("stalled");
    expect(original.decisionPath.decisions.length).toBeGreaterThan(1);
    expect(report.evidence.autoplay?.decisionPathRevision)
      .toBe(original.decisionPath.revision);

    await reproducePlaytestReport({
      gameDir,
      id: report.id,
      session: "fresh-random",
      to: "fresh-random-replay-source",
      checkpoint: "autoplay-replay",
    });
    const replay = await runAutoplay({
      gameDir,
      persona: "random",
      verbose: false,
      maxSteps: 100,
      seed: 1,
      fromSession: "fresh-random-replay-source",
      session: "fresh-random-replay-run",
      reportOnStop: false,
    });

    expect(replay.decisionPath).toEqual(original.decisionPath);
  });

  test("mints and returns a reproducible seed for a standalone stochastic persona", async () => {
    const gameDir = await temporaryRandomChoiceGame();
    const originalRandom = Math.random;
    const first = await runAutoplay({
      gameDir,
      persona: "random",
      verbose: false,
      maxSteps: 1,
      session: "auto-seeded-random",
    });

    expect(first.persona).toBe("random");
    expect(first.seed).toBeInteger();
    expect(first.seed).toBeGreaterThanOrEqual(0);
    expect(first.seed).toBeLessThan(0x1_0000_0000);
    expect(Math.random).toBe(originalRandom);

    const replay = await runAutoplay({
      gameDir,
      persona: "random",
      verbose: false,
      maxSteps: 1,
      seed: first.seed,
      session: "auto-seeded-random-replay",
    });

    expect(replay.persona).toBe("random");
    expect(replay.seed).toBe(first.seed);
    expect(replay.decisionPath).toEqual(first.decisionPath);
    expect(replay.finalState["random-world"])
      .toEqual(first.finalState["random-world"]);
  });

  test("uses the public seed for fresh world initialization as well as the persona", async () => {
    const gameDir = await temporaryRandomChoiceGame();
    const originalRandom = Math.random;
    Math.random = () => 0.5;
    try {
      const first = await runAutoplay({
        gameDir,
        persona: "random",
        verbose: false,
        maxSteps: 3,
        seed: 1234,
        session: "seeded-world-a",
      });
      const replay = await runAutoplay({
        gameDir,
        persona: "random",
        verbose: false,
        maxSteps: 3,
        seed: 1234,
        session: "seeded-world-b",
      });

      expect(first.finalState["random-world"]).toMatchObject({ seed: 1234 });
      expect(replay.finalState["random-world"])
        .toEqual(first.finalState["random-world"]);
      expect(replay.decisionPath).toEqual(first.decisionPath);
      expect(replay.finalState).toEqual(first.finalState);
    } finally {
      Math.random = originalRandom;
    }
  });

  test("keeps runner-owned persona randomness out of global Math.random", async () => {
    const gameDir = await temporaryGlobalRandomGuardGame();
    const originalRandom = Math.random;
    const summary = await runAutoplay({
      gameDir,
      persona: "global-guard",
      verbose: false,
      maxSteps: 1,
      seed: 8,
    });

    expect(summary.reason).toBe("max-steps");
    expect(summary.error).toBeUndefined();
    expect(Math.random).toBe(originalRandom);
  });

  test("continues the random persona stream across bounded runs", async () => {
    const gameDir = await temporaryRandomChoiceGame();
    const uninterrupted = await runAutoplay({
      gameDir,
      persona: "random",
      verbose: false,
      maxSteps: 3,
      seed: 23,
      session: "random-uninterrupted",
      reportOnStop: true,
    });
    const first = await runAutoplay({
      gameDir,
      persona: "random",
      verbose: false,
      maxSteps: 1,
      seed: 23,
      session: "random-segmented",
      reportOnStop: true,
    });
    const nextSeed = first.continuation?.next.args.seed;
    if (nextSeed === undefined) throw new Error("continuation did not retain RNG state");
    const second = await runAutoplay({
      gameDir,
      persona: "random",
      verbose: false,
      maxSteps: 1,
      seed: nextSeed,
      session: "random-segmented",
      reportOnStop: true,
    });

    expect([
      ...first.decisionPath.decisions,
      ...second.decisionPath.decisions,
    ]).toEqual(uninterrupted.decisionPath.decisions);
    expect(first.report).toBeUndefined();
    expect(second.report).toBeUndefined();
  });

  test("validates the persona and source before leaving a target branch", async () => {
    const gameDir = await temporaryGame();
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "player-main", createInitialState(game));

    await expect(runAutoplay({
      gameDir,
      persona: "does-not-exist",
      verbose: false,
      maxSteps: 1,
      fromSession: "player-main",
      session: "bad-persona-branch",
    })).rejects.toThrow("Unknown persona");
    await expect(pathExists(sessionDir(gameDir, "bad-persona-branch"))).resolves.toBe(false);

    await expect(runAutoplay({
      gameDir,
      persona: "greedy",
      verbose: false,
      maxSteps: 1,
      fromSession: "missing-player",
      session: "missing-source-branch",
    })).rejects.toThrow("Source session does not exist");
    await expect(pathExists(sessionDir(gameDir, "missing-source-branch"))).resolves.toBe(false);

    await expect(runAutoplay({
      gameDir,
      persona: "greedy",
      verbose: false,
      maxSteps: 1,
      seed: 0x1_0000_0000,
    })).rejects.toThrow("--seed must be a uint32 integer");
  });

  test("keeps fork initialization and play in one target transaction", async () => {
    const gameDir = await temporaryGame();
    const game = await loadGame(gameDir);
    const sourceSession = "atomic-player";
    const targetSession = "atomic-ai";
    await saveSession(gameDir, sourceSession, createInitialState(game));
    const source = await loadForkSource(gameDir, sourceSession);
    let guiWrite: Promise<void> | undefined;

    const summary = await runAutoplay({
      gameDir,
      persona: "greedy",
      verbose: false,
      maxSteps: 10,
      session: targetSession,
      preparedForkSource: { fromSession: sourceSession, source },
    }, {
      afterForkInitializedWhileLocked: () => {
        guiWrite = withSessionLock(gameDir, targetSession, async () => {
          const state = await loadSession(gameDir, targetSession, game);
          state.baseline.switches.guiTouchedBetweenForkAndPlay = true;
          await saveSession(gameDir, targetSession, state);
        });
      },
    });

    expect(summary.ending).toBe("intro");
    expect(summary.finalState.baseline.switches.guiTouchedBetweenForkAndPlay)
      .toBeUndefined();
    if (!guiWrite) throw new Error("GUI contender was not started");
    await guiWrite;
    expect((await loadSession(gameDir, targetSession, game)).baseline.switches)
      .toMatchObject({ guiTouchedBetweenForkAndPlay: true });
  });
});

async function temporaryGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-autoplay-lane-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), "title: Autoplay lane test\n", "utf-8");
  await writeFile(
    path.join(dir, "scripts", "intro.md"),
    [
      "---",
      "id: intro",
      "title: Intro",
      "characters: []",
      "---",
      "",
      "A single beat.",
      "",
      "[end]",
      "",
    ].join("\n"),
    "utf-8",
  );
  return dir;
}

async function temporaryToggleGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-autoplay-stall-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "modules"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), [
    "title: Autoplay stall test",
    "preset: ./modules/run.ts",
    "modules:",
    "  - ./modules/actions.ts",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "actions.ts"), [
    'import type { Module } from "@rpg-harness/engine";',
    "const actions: Module = {",
    '  id: "toggle-actions",',
    '  actionHandlers: { toggle: () => ({}) },',
    "};",
    "export default actions;",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "run.ts"), [
    'import type { RunFunction } from "@rpg-harness/engine";',
    "const run: RunFunction = async function* () {",
    "  while (true) {",
    '    yield { type: "hubMenu", snapshot: { day: 1, maxDay: 1, slot: 0, slotName: "day", slotsPerDay: 1, stats: [], affections: [], activities: [{ id: "toggle", kind: "action", title: "Toggle", cost: 0, effectsHint: "+1", available: true, actionKind: "toggle-actions:toggle", payload: { direction: "flip" } }] } };',
    '    yield { type: "narration", text: "Nothing changes." };',
    "  }",
    "};",
    "export default run;",
    "",
  ].join("\n"), "utf-8");
  return dir;
}

async function temporaryChangingCycleGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-autoplay-changing-cycle-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "modules"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), [
    "title: Autoplay changing cycle test",
    "preset: ./modules/run.ts",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "run.ts"), [
    'import type { RunFunction } from "@rpg-harness/engine";',
    "const run: RunFunction = async function* (ctx) {",
    "  while (true) {",
    "    ctx.state.baseline.inventory.turns = (ctx.state.baseline.inventory.turns ?? 0) + 1;",
    '    yield { type: "hubMenu", snapshot: { day: 1, maxDay: 1, slot: 0, slotName: "day", slotsPerDay: 1, stats: [], affections: [], activities: [{ id: "toggle", kind: "action", title: "Toggle", cost: 0, effectsHint: "+1", available: true }] } };',
    '    yield { type: "narration", text: "Still circling." };',
    "  }",
    "};",
    "export default run;",
    "",
  ].join("\n"), "utf-8");
  return dir;
}

async function temporarySilentReturnGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-autoplay-silent-return-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "modules"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), [
    "title: Autoplay silent return test",
    "preset: ./modules/run.ts",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "run.ts"), [
    'import type { RunFunction } from "@rpg-harness/engine";',
    "const run: RunFunction = async function* () {",
    '  yield { type: "narration", text: "The route simply disappears." };',
    "  return;",
    "};",
    "export default run;",
    "",
  ].join("\n"), "utf-8");
  return dir;
}

async function temporaryRandomChoiceGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-autoplay-random-replay-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "modules"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), [
    "title: Autoplay random replay test",
    "preset: ./modules/run.ts",
    "modules:",
    "  - ./modules/world.ts",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "world.ts"), [
    'import type { Module } from "@rpg-harness/engine";',
    "const world: Module = {",
    '  id: "random-world",',
    "  initialize: (_game, context) => ({",
    "    seed: context.seed,",
    '    order: context.rng() < 0.5 ? "left-first" : "right-first",',
    "  }),",
    "};",
    "export default world;",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "run.ts"), [
    'import type { RunFunction } from "@rpg-harness/engine";',
    "const run: RunFunction = async function* (ctx) {",
    "  while (true) {",
    '    const world = ctx.state["random-world"] as { order: string };',
    '    const ids = world.order === "left-first" ? ["left", "right"] : ["right", "left"];',
    '    const activities = ids.map((id) => ({ id, kind: "action" as const, title: id, cost: 0, available: true }));',
    '    const input = yield { type: "hubMenu", snapshot: { day: 1, maxDay: 1, slot: 0, slotName: "day", slotsPerDay: 1, stats: [], affections: [], activities } };',
    '    yield { type: "narration", text: input.type === "doActivity" ? input.id : "none" };',
    "  }",
    "};",
    "export default run;",
    "",
  ].join("\n"), "utf-8");
  return dir;
}

async function temporaryGlobalRandomGuardGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-autoplay-global-rng-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "modules"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), [
    "title: Autoplay global RNG guard",
    "preset: ./modules/run.ts",
    "modules:",
    "  - ./modules/guard.ts",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "run.ts"), [
    'import type { RunFunction } from "@rpg-harness/engine";',
    "const run: RunFunction = async function* () {",
    "  while (true) {",
    '    yield { type: "hubMenu", snapshot: { day: 1, maxDay: 1, slot: 0, slotName: "day", slotsPerDay: 1, stats: [], affections: [], activities: [{ id: "wait", kind: "action", title: "Wait", cost: 0, available: true }] } };',
    '    yield { type: "narration", text: "waited" };',
    "  }",
    "};",
    "export default run;",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "guard.ts"), [
    'import type { Module } from "@rpg-harness/engine";',
    "const importedMathRandom = Math.random;",
    "const guard: Module = {",
    '  id: "global-random-guard",',
    "  aiPersonas: {",
    '    "global-guard": {',
    '      description: "Fails if the runner replaces process-global randomness",',
    "      decide: async (output, _state, _step, context) => {",
    '        if (Math.random !== importedMathRandom) throw new Error("global Math.random was replaced");',
    "        context?.rng();",
    '        if (output.type === "hubMenu") return { type: "doActivity", id: "wait" };',
    '        if (output.type === "gameEnd") return null;',
    '        return { type: "next" };',
    "      },",
    "    },",
    "  },",
    "};",
    "export default guard;",
    "",
  ].join("\n"), "utf-8");
  return dir;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await readFile(path.join(target, "state.json"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
