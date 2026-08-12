import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState } from "@rpg-harness/engine";
import { loadGame } from "../loader";
import { saveSession, sessionDir } from "../session";
import { runDevelopmentSweep } from "./sweep";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true })
  ));
});

describe("bounded development sweep", () => {
  test("executes a frozen budget and returns exact resume keys", async () => {
    const gameDir = await temporarySweepGame();
    const sourceBefore = await snapshotTree(sessionDir(gameDir, "player"));

    const result = await runDevelopmentSweep({
      gameDir,
      session: "player",
      sessionPrefix: "ai-sweep",
      limit: 1,
      maxNodes: 20,
      maxSteps: 20,
      pretty: false,
    });

    expect(result).toMatchObject({
      status: "completed",
      reason: "budget-exhausted",
      snapshot: {
        sourceSession: "player",
        file: expect.stringMatching(/^\.rpg-harness\/sweeps\/[a-f0-9]{64}\.json$/),
        totalItems: 2,
        selectedItems: 1,
        completedItems: 1,
        remainingItems: 1,
        nextKey: "story/scene-b",
        remainingKeys: ["story/scene-b"],
      },
      safety: {
        immutableWorklist: true,
        preflightedTargets: ["ai-sweep-001"],
        sourceWrites: false,
      },
      resume: {
        fromKey: "story/scene-b",
        snapshotRevision: expect.any(String),
      },
      runs: [{
        index: 1,
        key: "story/scene-a",
        targetSession: "ai-sweep-001",
        status: "executed",
        result: {
          safety: { mode: "isolated-session", targetSession: "ai-sweep-001" },
          result: { found: true, replayVerified: true },
        },
      }],
    });
    expect(result.snapshot.revision).toHaveLength(64);
    expect(await snapshotTree(sessionDir(gameDir, "player"))).toEqual(sourceBefore);
  });

  test("preflights every target before the first branch write", async () => {
    const gameDir = await temporarySweepGame();
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "reserved-002", createInitialState(game));

    await expect(runDevelopmentSweep({
      gameDir,
      session: "player",
      sessionPrefix: "reserved",
      limit: 2,
      pretty: false,
    })).rejects.toThrow("Target session already exists: reserved-002");
    await expect(readdir(sessionDir(gameDir, "reserved-001"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readdir(path.join(gameDir, ".rpg-harness", "sweeps")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("shares one search-node budget across the frozen batch", async () => {
    const gameDir = await temporarySweepGame();
    const result = await runDevelopmentSweep({
      gameDir,
      session: "player",
      sessionPrefix: "budgeted",
      limit: 2,
      maxNodes: 20,
      maxTotalNodes: 2,
      maxSteps: 20,
      pretty: false,
    });

    expect(result).toMatchObject({
      status: "paused",
      reason: "search-budget-exhausted",
      snapshot: {
        completedItems: 1,
        nextKey: "story/scene-b",
        remainingKeys: ["story/scene-b"],
      },
      safety: {
        nodeBudget: { limit: 2, used: 2, remaining: 0 },
      },
    });
    expect(result.runs).toHaveLength(1);
  });

  test("resumes from an exact key only while the snapshot revision matches", async () => {
    const gameDir = await temporarySweepGame();
    const first = await runDevelopmentSweep({
      gameDir,
      session: "player",
      sessionPrefix: "first",
      limit: 1,
      maxNodes: 20,
      maxSteps: 20,
      pretty: false,
    });
    const resumed = await runDevelopmentSweep({
      gameDir,
      session: "player",
      sessionPrefix: "second",
      fromKey: "story/scene-b",
      snapshotRevision: first.snapshot.revision,
      limit: 1,
      maxNodes: 20,
      maxSteps: 20,
      pretty: false,
    });
    expect(resumed).toMatchObject({
      status: "completed",
      reason: "snapshot-completed",
      snapshot: { totalItems: 2, startIndex: 1, completedItems: 1, remainingItems: 0 },
      resume: null,
      runs: [{ key: "story/scene-b", targetSession: "second-002" }],
    });
    expect((await readdir(path.join(gameDir, ".rpg-harness", "sweeps"))))
      .toContain(`${first.snapshot.revision}.json`);

    await expect(runDevelopmentSweep({
      gameDir,
      session: "player",
      sessionPrefix: "stale",
      fromKey: "story/scene-b",
      snapshotRevision: "0".repeat(64),
      limit: 1,
      pretty: false,
    })).rejects.toThrow("Sweep snapshot changed");
  });

  test("resume skips snapshot items already resolved by other descendant evidence", async () => {
    const gameDir = await temporarySweepGame();
    const first = await runDevelopmentSweep({
      gameDir,
      session: "player",
      sessionPrefix: "resolve-a",
      limit: 1,
      maxNodes: 20,
      maxSteps: 20,
      pretty: false,
    });
    await runDevelopmentSweep({
      gameDir,
      session: "player",
      sessionPrefix: "resolve-b",
      limit: 1,
      maxNodes: 20,
      maxSteps: 20,
      pretty: false,
    });

    const resumed = await runDevelopmentSweep({
      gameDir,
      session: "player",
      sessionPrefix: "skip-resolved",
      fromKey: "story/scene-a",
      snapshotRevision: first.snapshot.revision,
      limit: 1,
      maxNodes: 20,
      maxSteps: 20,
      pretty: false,
    });

    expect(resumed).toMatchObject({
      status: "clean",
      reason: "clean",
      snapshot: {
        totalItems: 2,
        startIndex: 0,
        selectedItems: 0,
        remainingItems: 0,
        nextKey: null,
      },
      resume: null,
      runs: [],
    });
    await expect(readdir(sessionDir(gameDir, "skip-resolved-001")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function temporarySweepGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-sweep-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), "title: Sweep test\n", "utf-8");
  for (const id of ["scene-a", "scene-b"]) {
    await writeFile(path.join(dir, "scripts", `${id}.md`), [
      "---",
      `id: ${id}`,
      `title: ${id}`,
      "characters: []",
      "---",
      "",
      `Play ${id}.`,
      "",
      "[end]",
      "",
    ].join("\n"), "utf-8");
  }
  const game = await loadGame(dir);
  await saveSession(dir, "player", createInitialState(game));
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
