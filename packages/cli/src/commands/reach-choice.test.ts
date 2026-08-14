import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState, peek, step } from "@rpg-harness/engine";
import { loadGame } from "../loader";
import { appendLog, saveSession, sessionDir } from "../session";
import { runReachChoice, summarizeReachPath } from "./reach-choice";
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
  test("classifies repeated two-map navigation as path churn", () => {
    const cycle = Array.from({ length: 6 }, () => [
      { type: "doActivity" as const, id: "move:stone-path" },
      { type: "next" as const },
      { type: "doActivity" as const, id: "move:foothills" },
      { type: "next" as const },
    ]).flat();

    expect(summarizeReachPath(cycle)).toMatchObject({
      quality: {
        status: "churn",
        navigationCycle: {
          activityIds: ["move:stone-path", "move:foothills"],
          repetitions: 6,
          activityStart: 1,
          activityEnd: 12,
        },
      },
    });
    expect(summarizeReachPath(cycle.slice(0, -4)).quality).toEqual({
      status: "clean",
    });
  });

  test("files a reproducible coding issue for a verified churning path", async () => {
    const gameDir = await temporaryNavigationChurnGame();
    await seedSession(gameDir, "source");

    const result = await runReachChoice({
      gameDir,
      fromSession: "source",
      session: "ai-churn",
      key: "target/crossroads",
      maxNodes: 100,
      maxSteps: 30,
      reportOnQuality: true,
      pretty: false,
    });

    expect(result).toMatchObject({
      found: true,
      replayVerified: true,
      path: {
        inputs: 12,
        decisions: 12,
        activities: 12,
        quality: {
          status: "churn",
          navigationCycle: {
            activityIds: ["move:stone-path", "move:foothills"],
            repetitions: 6,
          },
        },
      },
      report: {
        status: "open",
        area: "engine",
        severity: "minor",
        session: "ai-churn",
        target: "packages/engine/src/search.ts",
      },
    });
    expect(result.report?.title).toContain("target/crossroads");
    expect(result.report?.details).toContain("6 consecutive rounds");
    expect(result.report?.evidence.checkpoint).toBeDefined();
    expect(await listPlaytestReports(gameDir, "ai-churn")).toHaveLength(1);
  });

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

  test("materializes the closest verified state when bounded search misses", async () => {
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
    expect(result.replayVerified).toBe(true);
    expect(result.session).toBe("ai-miss");
    expect(result.webPath).toBe("/?session=ai-miss");
    expect(result.requestedSession).toBe("ai-miss");
    expect(JSON.parse(await readFile(
      path.join(sessionDir(gameDir, "ai-miss"), "state.json"),
      "utf-8",
    ))).toBeDefined();
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

  test("prioritizes historical choice effects that unlock the target gate", async () => {
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
      attemptedSources: 1,
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

    const exact = await runReachChoice({
      gameDir,
      fromSession: "gui-player",
      fromLogEntry: 4,
      session: "ai-exact-terminal",
      key: "target/other-ending",
      maxNodes: 100,
      maxSteps: 20,
      pretty: false,
    });
    expect(exact).toMatchObject({
      status: "not-reached",
      found: false,
      attemptedSources: 1,
      source: {
        session: "gui-player",
        logEntry: 4,
        historyFallback: false,
      },
      fork: { fromSession: "gui-player", sourceLogEntry: 4 },
    });
  });

  test("skips an unmigratable historical checkpoint and tries the current source", async () => {
    const gameDir = await temporaryGame(false);
    const firstGame = await loadGame(gameDir);
    const initial = await peek(firstGame, createInitialState(firstGame));
    const stale = await step(firstGame, initial.state, {
      type: "select",
      scriptId: "target",
    });
    await saveSession(gameDir, "edited-player", stale.state);
    await appendLog(gameDir, "edited-player", {
      source: "web",
      input: { type: "select", scriptId: "target" },
      output: stale.output,
    }, stale.state);

    const targetFile = path.join(gameDir, "scripts", "target.md");
    await writeFile(
      targetFile,
      (await readFile(targetFile, "utf-8"))
        .replace("Approach.", "@alice A changed approach.")
        .replace("characters: []", "characters: [alice]"),
      "utf-8",
    );
    await writeFile(
      path.join(gameDir, "characters", "alice.md"),
      "---\nid: alice\nname: Alice\n---\n",
      "utf-8",
    );
    const currentGame = await loadGame(gameDir);
    const currentState = createInitialState(currentGame);
    await saveSession(gameDir, "edited-player", currentState);
    await appendLog(gameDir, "edited-player", {
      source: "web",
      output: { type: "scriptComplete", availableScripts: ["target"] },
    }, currentState);

    const result = await runReachChoice({
      gameDir,
      fromSession: "edited-player",
      session: "ai-current-source",
      key: "target/crossroads",
      maxNodes: 20,
      maxSteps: 20,
      pretty: false,
    });

    expect(result).toMatchObject({
      status: "reached",
      found: true,
      replayVerified: true,
      attemptedSources: 2,
      source: { session: "edited-player", logEntry: 2 },
      sourceErrors: [{
        session: "edited-player",
        logEntry: 1,
        error: expect.stringContaining("script migration required"),
      }],
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

async function temporaryNavigationChurnGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-reach-churn-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "modules"), { recursive: true });
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), [
    "title: Navigation churn test",
    "preset: ./modules/run.ts",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "scripts", "target.md"), [
    "---",
    "id: target",
    "title: Target",
    "characters: []",
    "---",
    "",
    "The route finally opens.",
    "",
    "? Where? {id: crossroads}",
    "- Left {id: left}",
    "- Right {id: right}",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "run.ts"), [
    'import type { RunFunction } from "@rpg-harness/engine";',
    "const run: RunFunction = async function* (ctx) {",
    "  while (Number(ctx.state.baseline.variables.moves ?? 0) < 12) {",
    "    const moves = Number(ctx.state.baseline.variables.moves ?? 0);",
    '    const id = moves % 2 === 0 ? "move:stone-path" : "move:foothills";',
    '    const input = yield { type: "hubMenu", snapshot: { day: 1, maxDay: 1, slot: 0, slotName: "road", slotsPerDay: 1, stats: [], affections: [], activities: [{ id, kind: "move", title: id, cost: 0, available: true }] } };',
    '    if (input?.type === "doActivity" && input.id === id) {',
    "      ctx.state.baseline.variables.moves = moves + 1;",
    "    }",
    "  }",
    '  yield { type: "choice", scriptId: "target", choiceId: "crossroads", prompt: "Where?", options: [{ id: "left", text: "Left", available: true }, { id: "right", text: "Right", available: true }] };',
    "};",
    "export default run;",
    "",
  ].join("\n"), "utf-8");
  return dir;
}

async function temporaryGame(impossible: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-reach-choice-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await mkdir(path.join(dir, "characters"), { recursive: true });
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
