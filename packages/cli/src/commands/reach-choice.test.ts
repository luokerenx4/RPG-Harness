import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState, peek, step } from "@rpg-harness/engine";
import { loadGame } from "../loader";
import { appendLog, saveSession, sessionDir } from "../session";
import { runReachChoice } from "./reach-choice";
import { listPlaytestReports } from "../playtest-reports";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

describe("reach-choice", () => {
  test("searches read-only then persists a fully verified replay path", async () => {
    const gameDir = await temporaryGame(false);
    await seedSession(gameDir, "source");

    const result = await runReachChoice({
      gameDir,
      fromSession: "source",
      session: "ai-reach",
      key: "target/crossroads",
      maxNodes: 20,
      maxSteps: 20,
      pretty: false,
    });

    expect(result).toMatchObject({
      found: true,
      reason: "found",
      path: {
        inputs: 2,
        decisions: 1,
        forcedAdvances: 1,
        choices: 0,
        activities: 0,
        scriptSelections: 1,
      },
      replayVerified: true,
      session: "ai-reach",
      webPath: "/?session=ai-reach",
      output: {
        type: "choice",
        scriptId: "target",
        choiceId: "crossroads",
      },
    });
    expect(result.inputs).toEqual([
      { type: "select", scriptId: "target" },
      { type: "next" },
    ]);
    expect(JSON.parse(await readFile(
      path.join(sessionDir(gameDir, "ai-reach"), "fork.json"),
      "utf-8",
    ))).toMatchObject({ fromSession: "source" });
  });

  test("does not create the target session when the bounded search misses", async () => {
    const gameDir = await temporaryGame(true);
    await seedSession(gameDir, "source");

    const result = await runReachChoice({
      gameDir,
      fromSession: "source",
      session: "ai-miss",
      key: "target/crossroads",
      maxNodes: 20,
      maxSteps: 20,
      pretty: false,
    });

    expect(result.found).toBe(false);
    expect(result.replayVerified).toBe(false);
    expect(result.session).toBeUndefined();
    expect(result.webPath).toBeUndefined();
    expect(result.requestedSession).toBe("ai-miss");
    await expect(readFile(
      path.join(sessionDir(gameDir, "ai-miss"), "state.json"),
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("exits non-zero when the bounded CLI search misses", async () => {
    const gameDir = await temporaryGame(true);
    await seedSession(gameDir, "source");
    const child = Bun.spawn([
      process.execPath,
      path.resolve(import.meta.dir, "../bin.ts"),
      "reach",
      gameDir,
      "--from-session",
      "source",
      "--session",
      "ai-miss-cli",
      "--key",
      "target/crossroads",
      "--max-nodes",
      "20",
      "--max-steps",
      "20",
    ], { stdout: "pipe", stderr: "pipe" });

    expect(await child.exited).toBe(1);
    expect(JSON.parse(await new Response(child.stdout).text())).toMatchObject({
      status: "not-reached",
      found: false,
    });
    expect(await new Response(child.stderr).text()).toBe("");
  });

  test("forks a saved session with no log instead of replacing it with a new game", async () => {
    const gameDir = await temporaryGame(false);
    const game = await loadGame(gameDir);
    const state = createInitialState(game);
    state.baseline.variables.savedMarker = 42;
    await saveSession(gameDir, "gui-before-input", state);

    const result = await runReachChoice({
      gameDir,
      fromSession: "gui-before-input",
      session: "ai-from-gui",
      key: "target/crossroads",
      maxNodes: 20,
      maxSteps: 20,
      pretty: false,
    });

    expect(result.found).toBe(true);
    const saved = JSON.parse(await readFile(
      path.join(sessionDir(gameDir, "ai-from-gui"), "state.json"),
      "utf-8",
    ));
    expect(saved.baseline.variables.savedMarker).toBe(42);
    expect(result.fork).toMatchObject({
      sourceLogEntry: 0,
      mode: "current-state",
    });
  });

  test("can persist the closest miss as a reproducible coding issue", async () => {
    const gameDir = await temporaryGame(true);
    await seedSession(gameDir, "source");

    const result = await runReachChoice({
      gameDir,
      fromSession: "source",
      session: "ai-miss-report",
      key: "target/crossroads",
      maxNodes: 20,
      maxSteps: 20,
      reportOnMiss: true,
      pretty: false,
    });

    expect(result).toMatchObject({
      found: false,
      replayVerified: true,
      session: "ai-miss-report",
      webPath: "/?session=ai-miss-report",
      report: {
        status: "open",
        area: "gameplay",
        severity: "note",
        session: "ai-miss-report",
        target: "scripts/target.md",
      },
    });
    expect(result.report?.details).toContain("switch.impossible");
    expect(result.report?.details).toContain("Closest input path");
    expect(result.report?.evidence.checkpoint).toBeDefined();
    expect(await listPlaytestReports(gameDir, "ai-miss-report")).toHaveLength(1);
  });

  test("rewinds a terminal GUI lineage to its latest choice checkpoint", async () => {
    const gameDir = await temporaryHistoryFallbackGame();
    const game = await loadGame(gameDir);
    let current = await peek(game, createInitialState(game));
    for (const input of [
      { type: "select", scriptId: "route" } as const,
      { type: "next" } as const,
      { type: "choose", choiceId: "route-choice", optionId: "finish" } as const,
      { type: "next" } as const,
    ]) {
      current = await step(game, current.state, input);
      await saveSession(gameDir, "gui-player", current.state);
      await appendLog(gameDir, "gui-player", {
        source: "web",
        input,
        output: current.output,
      }, current.state);
    }
    expect(current.output?.type).toBe("gameEnd");

    const result = await runReachChoice({
      gameDir,
      fromSession: "gui-player",
      session: "ai-other-route",
      key: "target/other-ending",
      maxNodes: 100,
      maxSteps: 20,
      pretty: false,
    });

    expect(result).toMatchObject({
      status: "reached",
      found: true,
      replayVerified: true,
      attemptedSources: 2,
      source: {
        session: "gui-player",
        logEntry: 2,
        mode: "checkpoint",
        historyFallback: true,
      },
      fork: { sourceLogEntry: 2 },
      output: { type: "choice", scriptId: "target", choiceId: "other-ending" },
      path: { inputs: 4, decisions: 2, forcedAdvances: 2, choices: 1 },
    });
    expect(result.inputs).toContainEqual({
      type: "choose",
      index: 1,
    });
  });
});

async function temporaryHistoryFallbackGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-reach-history-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), [
    "title: Historical reach test",
    "switches:",
    "  other_route: { initial: false }",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "scripts", "route.md"), [
    "---",
    "id: route",
    "title: Route",
    "characters: []",
    "---",
    "",
    "Choose a route.",
    "",
    "```yaml",
    "type: choice",
    "id: route-choice",
    "prompt: Which route?",
    "options:",
    "  - id: finish",
    "    text: Finish here",
    "    ai_tags: [cautious]",
    "    goto: finish",
    "  - id: unlock",
    "    text: Open the other route",
    "    ai_tags: [bold]",
    "    effects:",
    "      switches: { other_route: true }",
    "    goto: unlock",
    "```",
    "",
    "# finish",
    "",
    "The first route ends.",
    "",
    "[end]",
    "",
    "# unlock",
    "",
    "The other route opens.",
    "",
    "[end]",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "scripts", "target.md"), [
    "---",
    "id: target",
    "title: Other ending",
    "characters: []",
    "requires: { switch: { name: other_route } }",
    "---",
    "",
    "The road continues.",
    "",
    "? Other ending? {id: other-ending}",
    "- Stay {id: stay, ai: social}",
    "- Leave {id: leave, ai: independent}",
    "",
  ].join("\n"), "utf-8");
  return dir;
}

async function temporaryGame(impossible: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-reach-choice-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(
    path.join(dir, "game.yaml"),
    impossible
      ? [
          "title: Reach test",
          "switches:",
          "  impossible: { initial: false }",
          "",
        ].join("\n")
      : "title: Reach test\n",
    "utf-8",
  );
  await writeFile(
    path.join(dir, "scripts", "target.md"),
    [
      "---",
      "id: target",
      "title: Target",
      ...(impossible ? ["requires: { switch: { name: impossible } }"] : []),
      "characters: []",
      "---",
      "",
      "Approach.",
      "",
      "? Where? {id: crossroads}",
      "- Left {id: left}",
      "- Right {id: right}",
      "",
    ].join("\n"),
    "utf-8",
  );
  return dir;
}

async function seedSession(gameDir: string, session: string): Promise<void> {
  const game = await loadGame(gameDir);
  await saveSession(gameDir, session, createInitialState(game));
}
