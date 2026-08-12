import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendCheckpointedSessionEvent,
  loadSessionCheckpoint,
} from "./index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

describe("session checkpoints", () => {
  test("logs a content-addressed, recoverable state reference", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rpgh-checkpoint-"));
    temporaryDirectories.push(root);
    const state = { baseline: { currentScriptId: "choice", beatIndex: 4 } };
    const checkpoint = await appendCheckpointedSessionEvent(
      root,
      "web",
      { t: 123, source: "web", input: { type: "next" } },
      state,
    );
    expect(await loadSessionCheckpoint(root, "web", checkpoint)).toEqual(state);
    const log = JSON.parse(
      (await readFile(
        path.join(root, ".rpg-harness/sessions/web/log.jsonl"),
        "utf-8",
      )).trim(),
    );
    expect(log.checkpoint).toEqual(checkpoint);
    expect(log.state).toBeUndefined();
  });

  test("deduplicates identical state bodies while preserving both events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rpgh-checkpoint-"));
    temporaryDirectories.push(root);
    const state = { value: 2 };
    const first = await appendCheckpointedSessionEvent(root, "s", { t: 1 }, state);
    const second = await appendCheckpointedSessionEvent(root, "s", { t: 2 }, state);
    expect(second).toEqual(first);
    const lines = (await readFile(
      path.join(root, ".rpg-harness/sessions/s/log.jsonl"),
      "utf-8",
    )).trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});
