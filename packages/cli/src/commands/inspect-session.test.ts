import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendCheckpointedSessionEvent } from "@rpg-harness/session-store";
import { inspectSession } from "./inspect-session";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true })
  ));
});

describe("read-only session inspection", () => {
  test("finds a verified checkpoint behind a corrupt current state", async () => {
    const gameDir = await mkdtemp(path.join(tmpdir(), "rpgh-inspect-session-"));
    temporaryDirectories.push(gameDir);
    const state = minimalState("scene");
    await appendCheckpointedSessionEvent(
      gameDir,
      "broken",
      { input: { type: "next" }, output: { type: "narration", text: "line" } },
      state,
    );
    const stateFile = path.join(gameDir, ".rpg-harness/sessions/broken/state.json");
    await writeFile(stateFile, "{not-json", "utf-8");
    const beforeLog = await readFile(
      path.join(gameDir, ".rpg-harness/sessions/broken/log.jsonl"),
      "utf-8",
    );

    const result = await inspectSession({
      gameDir,
      session: "broken",
      pretty: false,
    });

    expect(result.state.status).toBe("invalid");
    expect(result.log.status).toBe("valid");
    expect(result.recovery.latestCheckpoint).toMatchObject({
      logEntry: 1,
      valid: true,
    });
    expect(result.recovery.note).toContain("fork that entry");
    expect(await readFile(stateFile, "utf-8")).toBe("{not-json");
    expect(await readFile(
      path.join(gameDir, ".rpg-harness/sessions/broken/log.jsonl"),
      "utf-8",
    )).toBe(beforeLog);
  });

  test("pinpoints malformed JSONL while retaining earlier checkpoint evidence", async () => {
    const gameDir = await mkdtemp(path.join(tmpdir(), "rpgh-inspect-session-"));
    temporaryDirectories.push(gameDir);
    const state = minimalState(null);
    await appendCheckpointedSessionEvent(gameDir, "broken-log", { input: null }, state);
    const root = path.join(gameDir, ".rpg-harness/sessions/broken-log");
    await writeFile(path.join(root, "state.json"), JSON.stringify(state), "utf-8");
    await writeFile(path.join(root, "log.jsonl"), "{bad\n", { flag: "a" });

    const result = await inspectSession({
      gameDir,
      session: "broken-log",
      pretty: false,
    });

    expect(result.state.status).toBe("valid");
    expect(result.log).toMatchObject({
      status: "invalid",
      entries: 2,
      validEntries: 1,
      invalidEntries: [{ entry: 2 }],
    });
    expect(result.recovery.latestCheckpoint?.valid).toBe(true);
    expect(result.recovery.note).toContain("malformed log data");
  });
});

function minimalState(currentScriptId: string | null) {
  return {
    baseline: {
      currentScriptId,
      completionOrder: [],
      scripts: {},
    },
    runtime: {},
  };
}
