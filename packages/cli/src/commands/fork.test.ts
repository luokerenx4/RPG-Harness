import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendCheckpointedSessionEvent } from "@rpg-harness/session-store";
import { forkSession } from "./fork";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

describe("fork session", () => {
  test("restores the exact state attached to a selected log entry", async () => {
    const gameDir = await temporaryGame();
    const first = state("letter_03_choice", 11);
    const second = state(null, 12);
    await appendCheckpointedSessionEvent(gameDir, "source", { t: 1 }, first);
    await appendCheckpointedSessionEvent(gameDir, "source", { t: 2 }, second);

    const result = await forkSession({
      gameDir,
      from: "source",
      to: "branch",
      at: 1,
      pretty: false,
    });

    expect(result.mode).toBe("checkpoint");
    expect(JSON.parse(await readFile(
      path.join(gameDir, ".rpg-harness/sessions/branch/state.json"),
      "utf-8",
    ))).toEqual(first);
  });

  test("rejects legacy historical entries instead of guessing through RNG", async () => {
    const gameDir = await temporaryGame();
    const dir = path.join(gameDir, ".rpg-harness/sessions/legacy");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "log.jsonl"),
      JSON.stringify({ input: { type: "next" }, output: { type: "narration" } }) + "\n",
    );
    await expect(forkSession({
      gameDir,
      from: "legacy",
      to: "branch",
      at: 1,
      pretty: false,
    })).rejects.toThrow("no recoverable checkpoint");
  });

  test("never overwrites an existing target session", async () => {
    const gameDir = await temporaryGame();
    await appendCheckpointedSessionEvent(gameDir, "source", { t: 1 }, state(null, 1));
    const target = path.join(gameDir, ".rpg-harness/sessions/branch");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "state.json"), "{}", "utf-8");
    await expect(forkSession({
      gameDir,
      from: "source",
      to: "branch",
      at: 1,
      pretty: false,
    })).rejects.toThrow("already exists");
  });

  test("treats orphaned target checkpoints as an existing session", async () => {
    const gameDir = await temporaryGame();
    await appendCheckpointedSessionEvent(gameDir, "source", { t: 1 }, state(null, 1));
    await mkdir(
      path.join(gameDir, ".rpg-harness/sessions/branch/checkpoints"),
      { recursive: true },
    );
    await expect(forkSession({
      gameDir,
      from: "source",
      to: "branch",
      at: 1,
      pretty: false,
    })).rejects.toThrow("already exists");
  });
});

function state(currentScriptId: string | null, raidsCompleted: number) {
  return {
    baseline: {
      characters: {},
      switches: {},
      variables: { raidsCompleted },
      scripts: {},
      completionOrder: [],
      currentScriptId,
      beatIndex: 0,
      scriptCursor: null,
      inventory: {},
      currentMapId: null,
      weapons: {},
      equippedWeaponId: null,
      knownSkills: [],
      visuals: { portraits: {}, cg: null, bg: null },
    },
    runtime: {
      pendingNarrations: [],
      activeTriggers: [],
      firedTriggers: [],
      firedScriptStarts: [],
      lastHubActivities: [],
    },
  };
}

async function temporaryGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-fork-"));
  temporaryDirectories.push(dir);
  await writeFile(path.join(dir, "game.yaml"), "title: Fork test\n", "utf-8");
  return dir;
}
