import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState } from "@rpg-harness/engine";
import { loadGame } from "../loader";
import { saveSession, sessionDir } from "../session";
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
});

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
