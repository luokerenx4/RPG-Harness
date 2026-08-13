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
  detectTerminalScriptId,
  runAutoplay,
  summarizeDecisionPath,
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

  test("forks a player save before moving and reports a checkpointed stop", async () => {
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
    expect(summary.report).toMatchObject({
      status: "open",
      session: "ai-audit",
      area: "tooling",
      severity: "major",
    });
    expect(summary.progress.madeProgress).toBe(false);
    expect(summary.report?.evidence.checkpoint).toBeDefined();
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
    expect(await listPlaytestReports(gameDir, "ai-audit")).toHaveLength(1);

    const reproduced = await reproducePlaytestReport({
      gameDir,
      id: summary.report!.id,
      session: "ai-audit",
      to: "ai-audit-repro",
    });
    expect(reproduced.webPath).toBe("/?session=ai-audit-repro");
    expect(JSON.parse(await readFile(
      path.join(sessionDir(gameDir, "ai-audit-repro"), "state.json"),
      "utf-8",
    ))).toEqual(summary.finalState);
  });

  test("classifies a progressing max-step stop as a note-level budget checkpoint", async () => {
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
    expect(summary.report).toMatchObject({
      severity: "note",
      title: "Autoplay greedy reached a budget checkpoint with progress",
    });
    expect(summary.report?.details).toContain("Continue from this checkpoint");
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
      maxSteps: 1,
      seed: 1,
      session: "fresh-random",
      reportOnStop: true,
    });
    const report = original.report;
    if (!report) throw new Error("fixture did not create a causal autoplay report");

    expect(original.decisionPath.decisions).toHaveLength(1);
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
      maxSteps: 1,
      seed: 1,
      fromSession: "fresh-random-replay-source",
      session: "fresh-random-replay-run",
      reportOnStop: false,
    });

    expect(replay.decisionPath).toEqual(original.decisionPath);
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
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "run.ts"), [
    'import type { RunFunction } from "@rpg-harness/engine";',
    "const run: RunFunction = async function* () {",
    "  while (true) {",
    '    yield { type: "hubMenu", snapshot: { day: 1, maxDay: 1, slot: 0, slotName: "day", slotsPerDay: 1, stats: [], affections: [], activities: [{ id: "toggle", kind: "action", title: "Toggle", cost: 0, effectsHint: "+1", available: true }] } };',
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
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "run.ts"), [
    'import type { RunFunction } from "@rpg-harness/engine";',
    "const run: RunFunction = async function* () {",
    "  while (true) {",
    '    const input = yield { type: "hubMenu", snapshot: { day: 1, maxDay: 1, slot: 0, slotName: "day", slotsPerDay: 1, stats: [], affections: [], activities: [{ id: "left", kind: "action", title: "Left", cost: 0, available: true }, { id: "right", kind: "action", title: "Right", cost: 0, available: true }] } };',
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
