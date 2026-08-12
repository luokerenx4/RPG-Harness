import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState } from "@rpg-harness/engine";
import { loadGame } from "../loader";
import {
  listPlaytestReports,
  reproducePlaytestReport,
} from "../playtest-reports";
import { saveSession, sessionDir } from "../session";
import { detectTerminalScriptId, runAutoplay } from "./autoplay";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

describe("autoplay ending summary", () => {
  test("uses the terminal state's last completed script without naming guesses", () => {
    expect(detectTerminalScriptId({
      done: true,
      trace: [{ output: { type: "gameEnd" } }],
      finalState: { baseline: { completionOrder: ["intro", "ending_oni_self"] } },
    })).toBe("ending_oni_self");
  });

  test("does not call an unfinished run an ending", () => {
    expect(detectTerminalScriptId({
      done: false,
      trace: [],
      finalState: { baseline: { completionOrder: ["scene_005"] } },
    })).toBeNull();
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
    expect(summary.report?.details).toContain("exact 2-output cycle");
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

async function pathExists(target: string): Promise<boolean> {
  try {
    await readFile(path.join(target, "state.json"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
