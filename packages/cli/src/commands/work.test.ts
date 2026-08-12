import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState, peek, step } from "@rpg-harness/engine";
import { loadGame } from "../loader";
import { recordPlaytestReport } from "../playtest-reports";
import { appendLog, saveSession, sessionDir } from "../session";
import { runDevelopmentWorkItem } from "./work";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true })
  ));
});

describe("structured development work execution", () => {
  test("executes the highest-priority uncovered script in an isolated branch", async () => {
    const gameDir = await temporaryWorkGame(false);
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "player", createInitialState(game));
    const before = await snapshotTree(sessionDir(gameDir, "player"));
    const result = await runDevelopmentWorkItem({
      gameDir,
      session: "player",
      newSession: "ai-reach-scene",
      maxNodes: 20,
      maxSteps: 20,
      pretty: false,
    });

    expect(result).toMatchObject({
      status: "executed",
      selection: { key: "story/scene", actionability: "executable" },
      operation: { command: "reach-script", args: { scriptId: "scene" } },
      safety: {
        mode: "isolated-session",
        writes: true,
        targetSession: "ai-reach-scene",
      },
      result: {
        status: "reached",
        found: true,
        replayVerified: true,
        target: { scriptId: "scene" },
        session: "ai-reach-scene",
      },
    });
    expect(await snapshotTree(sessionDir(gameDir, "player"))).toEqual(before);
  });

  test("prepares authoring context instead of pretending an edit was applied", async () => {
    const gameDir = await temporaryWorkGame(true);
    const result = await runDevelopmentWorkItem({
      gameDir,
      key: "choice-authoring/scene/beat-0",
      pretty: false,
    });

    expect(result).toMatchObject({
      status: "prepared",
      selection: { actionability: "authoring" },
      operation: { command: "edit", args: { target: "scripts/scene.md" } },
      safety: { mode: "authoring", writes: false },
      result: {
        coordinates: { kind: "stabilize-choice", scriptId: "scene" },
        context: { script: { id: "scene" } },
        note: expect.stringContaining("no source files were changed"),
      },
    });
  });

  test("fails with available keys instead of silently choosing a different item", async () => {
    const gameDir = await temporaryWorkGame(false);
    await expect(runDevelopmentWorkItem({
      gameDir,
      key: "missing",
      pretty: false,
    })).rejects.toThrow("Available work items:\n  story/scene");
  });

  test("requires an explicit fresh branch and never mutates the source session", async () => {
    const gameDir = await temporaryExecutableChoiceGame();
    const sourceBefore = await snapshotTree(sessionDir(gameDir, "player"));

    await expect(runDevelopmentWorkItem({
      gameDir,
      session: "player",
      key: "choice-branch/scene/reply/stay",
      pretty: false,
    })).rejects.toThrow("pass --new-session NAME");
    expect(await snapshotTree(sessionDir(gameDir, "player"))).toEqual(sourceBefore);

    const result = await runDevelopmentWorkItem({
      gameDir,
      session: "player",
      key: "choice-branch/scene/reply/stay",
      newSession: "ai-cover-stay",
      maxSteps: 5,
      pretty: false,
    });

    expect(result).toMatchObject({
      status: "executed",
      safety: {
        mode: "isolated-session",
        writes: true,
        targetSession: "ai-cover-stay",
      },
      result: {
        targetChoice: { status: "selected", optionId: "stay" },
        workItem: { key: "scene/reply/stay" },
        inputs: 1,
        visibleOutputs: 2,
      },
    });
    expect(result.result).not.toHaveProperty("finalState");
    expect(result.result).not.toHaveProperty("choiceCoverage.pendingBranches");
    expect(await snapshotTree(sessionDir(gameDir, "player"))).toEqual(sourceBefore);
    expect(Object.keys(await snapshotTree(sessionDir(gameDir, "ai-cover-stay"))))
      .toEqual(expect.arrayContaining(["fork.json", "log.jsonl", "state.json"]));
  });

  test("routes a broken-session P0 into read-only state and log diagnosis", async () => {
    const gameDir = await temporaryWorkGame(false);
    const brokenRoot = sessionDir(gameDir, "broken");
    await mkdir(brokenRoot, { recursive: true });
    await writeFile(path.join(brokenRoot, "state.json"), "{bad-state", "utf-8");
    await writeFile(path.join(brokenRoot, "log.jsonl"), "{bad-log\n", "utf-8");
    const before = await snapshotTree(brokenRoot);

    const result = await runDevelopmentWorkItem({ gameDir, pretty: false });

    expect(result).toMatchObject({
      status: "executed",
      selection: { key: "session-error/broken", priority: "P0" },
      operation: {
        command: "inspect-session",
        args: { session: "broken", surfaces: ["log", "state"] },
      },
      safety: { mode: "read-only", writes: false },
      result: {
        state: { status: "invalid" },
        log: { status: "invalid", invalidEntries: [{ entry: 1 }] },
        evaluation: "read-only",
      },
    });
    expect(await snapshotTree(brokenRoot)).toEqual(before);
  });

  test("routes a diagnostic report into complete evidence inspection", async () => {
    const gameDir = await temporaryWorkGame(false);
    const report = await recordPlaytestReport({
      gameDir,
      session: "missing-save",
      area: "tooling",
      severity: "major",
      title: "Missing save evidence",
    });

    const result = await runDevelopmentWorkItem({
      gameDir,
      key: `report/${report.id}`,
      pretty: false,
    });

    expect(result).toMatchObject({
      status: "executed",
      selection: { key: `report/${report.id}`, actionability: "diagnostic" },
      operation: { command: "inspect-report", args: { reportId: report.id } },
      safety: { mode: "read-only", writes: false },
      result: { id: report.id, title: "Missing save evidence" },
    });
  });

  test("reproduces checkpointed reports only into an explicitly named branch", async () => {
    const gameDir = await temporaryWorkGame(false);
    const game = await loadGame(gameDir);
    const sourceState = createInitialState(game);
    await saveSession(gameDir, "player", sourceState);
    const report = await recordPlaytestReport({
      gameDir,
      session: "player",
      area: "engine",
      severity: "blocker",
      title: "Checkpointed blocker",
    });
    const sourceBefore = await snapshotTree(sessionDir(gameDir, "player"));

    await expect(runDevelopmentWorkItem({
      gameDir,
      key: `report/${report.id}`,
      pretty: false,
    })).rejects.toThrow("pass --new-session NAME");

    const result = await runDevelopmentWorkItem({
      gameDir,
      key: `report/${report.id}`,
      newSession: "ai-repro-blocker",
      pretty: false,
    });

    expect(result).toMatchObject({
      status: "executed",
      operation: { command: "reproduce", args: { reportId: report.id } },
      safety: {
        mode: "isolated-session",
        writes: true,
        targetSession: "ai-repro-blocker",
      },
      result: {
        session: "ai-repro-blocker",
        fromReport: report.id,
        webPath: "/?session=ai-repro-blocker",
      },
    });
    expect(await snapshotTree(sessionDir(gameDir, "player"))).toEqual(sourceBefore);
  });

  test("continues a started script to completion in an isolated branch", async () => {
    const gameDir = await temporaryWorkGame(false);
    const game = await loadGame(gameDir);
    const state = createInitialState(game);
    state.baseline.currentScriptId = "scene";
    await saveSession(gameDir, "player", state);
    await appendLog(
      gameDir,
      "player",
      { input: { type: "select", scriptId: "scene" }, output: { type: "narration", text: "An uncovered line." } },
      state,
    );

    const result = await runDevelopmentWorkItem({
      gameDir,
      key: "story/scene",
      session: "player",
      newSession: "ai-finish-scene",
      pretty: false,
    });

    expect(result).toMatchObject({
      status: "executed",
      operation: {
        command: "reach-script",
        args: { scriptId: "scene", fromSession: "player" },
      },
      safety: { mode: "isolated-session", writes: true },
      result: {
        found: true,
        replayVerified: true,
        session: "ai-finish-scene",
      },
    });
  });

  test("reaches an unseen authored choice through a verified isolated replay", async () => {
    const gameDir = await temporaryExecutableChoiceGame();
    const game = await loadGame(gameDir);
    const sourceState = createInitialState(game);
    await saveSession(gameDir, "fresh-player", sourceState);
    const sourceBefore = await snapshotTree(sessionDir(gameDir, "fresh-player"));

    const result = await runDevelopmentWorkItem({
      gameDir,
      session: "fresh-player",
      key: "choice-authoring/scene/reply",
      newSession: "ai-reach-reply",
      maxNodes: 50,
      maxSteps: 10,
      pretty: false,
    });

    expect(result).toMatchObject({
      status: "executed",
      operation: {
        command: "reach",
        args: { key: "scene/reply", fromSession: "fresh-player" },
      },
      safety: {
        mode: "isolated-session",
        writes: true,
        targetSession: "ai-reach-reply",
      },
      result: {
        found: true,
        replayVerified: true,
        session: "ai-reach-reply",
        webPath: "/?session=ai-reach-reply",
        path: { inputs: 1, decisions: 1, forcedAdvances: 0 },
        output: { type: "choice", scriptId: "scene", choiceId: "reply" },
      },
    });
    expect(result.result).not.toHaveProperty("inputs");
    expect(result.result).not.toHaveProperty("closest");
    expect(await snapshotTree(sessionDir(gameDir, "fresh-player"))).toEqual(sourceBefore);
  });

  test("reports an unreachable authored choice as failed without creating a branch", async () => {
    const gameDir = await temporaryImpossibleReachGame();
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "player", createInitialState(game));

    const result = await runDevelopmentWorkItem({
      gameDir,
      session: "player",
      key: "choice-authoring/target/reply",
      newSession: "ai-unreachable",
      maxNodes: 20,
      maxSteps: 10,
      pretty: false,
    });

    expect(result).toMatchObject({
      status: "failed",
      safety: { mode: "read-only", writes: false, targetSession: null },
      result: {
        status: "not-reached",
        found: false,
        replayVerified: false,
        closest: {
          path: { inputs: 0, decisions: 0, forcedAdvances: 0 },
        },
      },
    });
    expect(result.result).not.toHaveProperty("closest.inputs");
    await expect(readdir(sessionDir(gameDir, "ai-unreachable"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("exits non-zero when structured work cannot reach its target", async () => {
    const gameDir = await temporaryImpossibleReachGame();
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "player", createInitialState(game));
    const child = Bun.spawn([
      process.execPath,
      path.resolve(import.meta.dir, "../bin.ts"),
      "work",
      gameDir,
      "--session",
      "player",
      "--key",
      "choice-authoring/target/reply",
      "--new-session",
      "ai-unreachable-cli",
      "--max-nodes",
      "20",
      "--max-steps",
      "10",
    ], { stdout: "pipe", stderr: "pipe" });

    expect(await child.exited).toBe(1);
    expect(JSON.parse(await new Response(child.stdout).text())).toMatchObject({
      status: "failed",
      result: { status: "not-reached", found: false },
    });
    expect(await new Response(child.stderr).text()).toBe("");
  });
});

async function temporaryImpossibleReachGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-work-unreachable-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), [
    "title: Unreachable work test",
    "switches:",
    "  impossible: { initial: false }",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "scripts", "target.md"), [
    "---",
    "id: target",
    "title: Target",
    "characters: []",
    "requires: { switch: { name: impossible } }",
    "---",
    "",
    "Approach.",
    "",
    "? Reply? {id: reply}",
    "- Stay {id: stay, ai: social}",
    "- Leave {id: leave, ai: independent}",
    "",
  ].join("\n"), "utf-8");
  return dir;
}

async function temporaryWorkGame(withLegacyChoice: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-work-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), "title: Work executor test\n", "utf-8");
  await writeFile(
    path.join(dir, "scripts", "scene.md"),
    [
      "---",
      "id: scene",
      "title: Scene",
      "characters: []",
      "---",
      "",
      ...(withLegacyChoice
        ? ["? Reply.", "  - Stay", "  - Leave", ""]
        : ["An uncovered line.", ""]),
      "[end]",
      "",
    ].join("\n"),
    "utf-8",
  );
  return dir;
}

async function temporaryExecutableChoiceGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-work-executable-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), "title: Executable work test\n", "utf-8");
  await writeFile(
    path.join(dir, "scripts", "scene.md"),
    [
      "---",
      "id: scene",
      "title: Scene",
      "characters: []",
      "---",
      "",
      "? Reply. {id: reply}",
      "  - Stay {id: stay, ai: social}",
      "  - Leave {id: leave, ai: independent}",
      "",
      "[end]",
      "",
    ].join("\n"),
    "utf-8",
  );
  const game = await loadGame(dir);
  const initial = createInitialState(game);
  const ready = await peek(game, initial);
  const presented = await step(game, ready.state, { type: "select", scriptId: "scene" });
  await saveSession(dir, "player", presented.state);
  await appendLog(
    dir,
    "player",
    { input: { type: "select", scriptId: "scene" }, output: presented.output },
    presented.state,
  );
  return dir;
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function visit(dir: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else snapshot[path.relative(root, absolute)] = await Bun.file(absolute).text();
    }
  }
  await visit(root);
  return snapshot;
}
