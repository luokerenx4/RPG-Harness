import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState, peek, step } from "@rpg-harness/engine";
import { withSessionLock } from "@rpg-harness/session-store";
import { loadGame } from "../loader";
import { appendLog, saveSession, sessionDir } from "../session";
import { forkSession } from "./fork";
import { runReachScript } from "./reach-script";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true })
  ));
});

describe("reach-script", () => {
  test("rewinds a terminal GUI lineage and completes an alternative script", async () => {
    const gameDir = await temporaryReachScriptGame(false);
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
    await forkSession({
      gameDir,
      from: "gui-player",
      to: "finished-branch",
      pretty: false,
    });

    const result = await runReachScript({
      gameDir,
      fromSession: "finished-branch",
      session: "ai-target",
      scriptId: "target",
      maxNodes: 100,
      maxSteps: 20,
      pretty: false,
    });

    expect(result).toMatchObject({
      status: "reached",
      found: true,
      replayVerified: true,
      source: {
        session: "gui-player",
        logEntry: 2,
        historyFallback: true,
      },
      target: { scriptId: "target" },
      path: { choices: 1, scriptSelections: 1 },
      fork: { sourceLogEntry: 2 },
    });
    expect(result.inputs).toContainEqual({ type: "choose", index: 1 });
    expect(result.inputs).toContainEqual({ type: "select", scriptId: "target" });
    const saved = JSON.parse(await Bun.file(
      path.join(sessionDir(gameDir, "ai-target"), "state.json"),
    ).text());
    expect(saved.baseline.scripts.target.completed).toBe(true);
    expect(JSON.parse(await Bun.file(
      path.join(sessionDir(gameDir, "ai-target"), "fork.json"),
    ).text())).toMatchObject({ fromSession: "gui-player", sourceLogEntry: 2 });

    const exact = await runReachScript({
      gameDir,
      fromSession: "finished-branch",
      fromLogEntry: 1,
      session: "ai-exact-terminal",
      scriptId: "target",
      maxNodes: 100,
      maxSteps: 20,
      pretty: false,
    });
    expect(exact).toMatchObject({
      status: "not-reached",
      found: false,
      search: { attemptedSources: 1 },
      source: {
        session: "finished-branch",
        logEntry: 1,
        historyFallback: false,
      },
      fork: { fromSession: "finished-branch", sourceLogEntry: 1 },
    });
  });

  test("CLI exhausted miss preserves its closest GUI branch and exits non-zero", async () => {
    const gameDir = await temporaryReachScriptGame(true);
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "player", createInitialState(game));
    const child = Bun.spawn([
      process.execPath,
      path.resolve(import.meta.dir, "../bin.ts"),
      "reach-script",
      gameDir,
      "--script",
      "target",
      "--from-session",
      "player",
      "--session",
      "ai-miss",
      "--max-nodes",
      "20",
      "--max-steps",
      "10",
    ], { stdout: "pipe", stderr: "pipe" });

    expect(await child.exited).toBe(1);
    expect(JSON.parse(await new Response(child.stdout).text())).toMatchObject({
      status: "not-reached",
      found: false,
      replayVerified: true,
      session: "ai-miss",
      webPath: "/?session=ai-miss",
    });
    expect(await readdir(sessionDir(gameDir, "ai-miss"))).toContain("state.json");
  });

  test("keeps fork initialization and replay in one target transaction", async () => {
    const gameDir = await temporaryReachScriptGame(false);
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "player", createInitialState(game));
    let contenderEntered = false;
    let contender: Promise<void> | undefined;
    let observedFence = false;

    const result = await runReachScript({
      gameDir,
      fromSession: "player",
      session: "atomic-target",
      scriptId: "target",
      maxNodes: 100,
      maxSteps: 20,
      pretty: false,
    }, {
      afterForkInitializedWhileLocked: async () => {
        contender = withSessionLock(gameDir, "atomic-target", async () => {
          contenderEntered = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        observedFence = !contenderEntered;
      },
    });

    expect(result).toMatchObject({ found: true, replayVerified: true });
    expect(observedFence).toBe(true);
    await contender;
    expect(contenderEntered).toBe(true);
  });
});

async function temporaryReachScriptGame(impossible: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-reach-script-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), [
    "title: Script reach test",
    "switches:",
    "  unlocked: { initial: false }",
    "  impossible: { initial: false }",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "scripts", "route.md"), [
    "---",
    "id: route",
    "title: Route",
    "characters: []",
    "---",
    "",
    "Choose.",
    "",
    "```yaml",
    "type: choice",
    "id: route-choice",
    "options:",
    "  - id: finish",
    "    text: Finish",
    "    goto: finish",
    "  - id: unlock",
    "    text: Unlock",
    "    effects:",
    "      switches: { unlocked: true }",
    "    goto: unlock",
    "```",
    "",
    "# finish",
    "Done.",
    "[end]",
    "",
    "# unlock",
    "Open.",
    "[end]",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "scripts", "target.md"), [
    "---",
    "id: target",
    "title: Target",
    "characters: []",
    `requires: { switch: { name: ${impossible ? "impossible" : "unlocked"} } }`,
    "---",
    "",
    "The target is complete.",
    "",
    "[end]",
    "",
  ].join("\n"), "utf-8");
  return dir;
}
