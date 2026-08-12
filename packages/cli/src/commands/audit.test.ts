import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState } from "@rpg-harness/engine";
import { loadGame } from "../loader";
import { loadSession, saveSession, sessionDir } from "../session";
import { runAudit } from "./audit";
import { readSessionLog } from "./fork";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("autoplay audit matrix", () => {
  test("forks isolated persona lanes and returns a compact ending matrix", async () => {
    const gameDir = await temporaryGame();
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "player", createInitialState(game));
    const sourceBefore = await readFile(
      path.join(sessionDir(gameDir, "player"), "state.json"),
      "utf-8",
    );

    const summary = await runAudit({
      gameDir,
      fromSession: "player",
      sessionPrefix: "matrix",
      personas: ["objective", "greedy"],
      maxSteps: 10,
      reportOnStop: true,
      pretty: false,
    });

    expect(summary).toMatchObject({
      source: { session: "player" },
      sessionPrefix: "matrix",
      totals: {
        lanes: 2,
        completed: 2,
        stalled: 0,
        behaviorCycles: 0,
        errors: 0,
        rejectedInputs: 0,
        openReports: 0,
      },
      endings: { intro: 2 },
    });
    expect(summary.lanes.map((lane) => ({
      persona: lane.persona,
      session: lane.session,
      webPath: lane.webPath,
      reason: lane.reason,
      ending: lane.ending,
    }))).toEqual([
      { persona: "objective", session: "matrix-objective", webPath: "/?session=matrix-objective", reason: "completed", ending: "intro" },
      { persona: "greedy", session: "matrix-greedy", webPath: "/?session=matrix-greedy", reason: "completed", ending: "intro" },
    ]);
    expect(await readFile(
      path.join(sessionDir(gameDir, "player"), "state.json"),
      "utf-8",
    )).toBe(sourceBefore);
  });

  test("preflights every target before creating the first lane", async () => {
    const gameDir = await temporaryGame();
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "player", createInitialState(game));
    await saveSession(gameDir, "matrix-greedy", createInitialState(game));

    await expect(runAudit({
      gameDir,
      fromSession: "player",
      sessionPrefix: "matrix",
      personas: ["objective", "greedy"],
      maxSteps: 10,
      reportOnStop: true,
      pretty: false,
    })).rejects.toThrow("Target session already exists: matrix-greedy");
    await expect(readFile(
      path.join(sessionDir(gameDir, "matrix-objective"), "state.json"),
    )).rejects.toThrow();
  });

  test("pins one source snapshot even when the player advances between lanes", async () => {
    const gameDir = await temporaryGame();
    const game = await loadGame(gameDir);
    const auditStart = createInitialState(game);
    await saveSession(gameDir, "player", auditStart);

    const summary = await runAudit({
      gameDir,
      fromSession: "player",
      sessionPrefix: "concurrent-matrix",
      personas: ["objective", "greedy"],
      maxSteps: 10,
      reportOnStop: true,
      pretty: false,
    }, {
      onLaneComplete: async (_lane, index) => {
        if (index !== 0) return;
        const playerAdvanced = structuredClone(auditStart);
        playerAdvanced.baseline.inventory.player_moved_during_audit = 1;
        await saveSession(gameDir, "player", playerAdvanced);
      },
    });

    const laneLogs = await Promise.all(
      ["concurrent-matrix-objective", "concurrent-matrix-greedy"]
        .map((session) => readSessionLog(gameDir, session)),
    );
    const revisions = laneLogs.map((entries) => {
      const checkpoint = entries[0]?.checkpoint as { revision?: string } | undefined;
      return checkpoint?.revision;
    });
    expect(revisions).toEqual([summary.source.stateRevision, summary.source.stateRevision]);
    expect(summary.source).toMatchObject({
      session: "player",
      at: 0,
      entries: 0,
      mode: "current-state",
    });
    expect((await loadSession(gameDir, "player", game)).baseline.inventory)
      .toEqual({ player_moved_during_audit: 1 });
    expect((await loadSession(gameDir, "concurrent-matrix-greedy", game)).baseline.inventory)
      .toEqual({});
  });

  test("requires a seed when random is part of a reproducible matrix", async () => {
    const gameDir = await temporaryGame();
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "player", createInitialState(game));
    await expect(runAudit({
      gameDir,
      fromSession: "player",
      sessionPrefix: "matrix",
      personas: ["random"],
      maxSteps: 10,
      reportOnStop: true,
      pretty: false,
    })).rejects.toThrow("random requires --seed");
  });

  test("scopes seeded randomness to each audit lane and restores the host RNG", async () => {
    const gameDir = await temporaryGame();
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "player", createInitialState(game));
    const before = Math.random;
    const summary = await runAudit({
      gameDir,
      fromSession: "player",
      sessionPrefix: "random-matrix",
      personas: ["random"],
      maxSteps: 10,
      seed: 17,
      reportOnStop: true,
      pretty: false,
    });
    expect(summary.totals.completed).toBe(1);
    expect(Math.random).toBe(before);
  });
});

async function temporaryGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-audit-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), "title: Audit test\n", "utf-8");
  await writeFile(path.join(dir, "scripts", "intro.md"), [
    "---",
    "id: intro",
    "title: Intro",
    "characters: []",
    "---",
    "",
    "One beat.",
    "",
    "[end]",
    "",
  ].join("\n"), "utf-8");
  return dir;
}
