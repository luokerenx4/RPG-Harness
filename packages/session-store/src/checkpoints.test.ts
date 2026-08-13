import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendCheckpointedSessionEvent,
  compactSessionCheckpoints,
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

  test("deduplicates identical state bodies across sessions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rpgh-checkpoint-"));
    temporaryDirectories.push(root);
    const state = { shared: true };
    const first = await appendCheckpointedSessionEvent(root, "one", { t: 1 }, state);
    const second = await appendCheckpointedSessionEvent(root, "two", { t: 2 }, state);
    expect(second).toEqual(first);
    const object = path.join(
      root,
      ".rpg-harness/objects/checkpoints",
      first.revision.slice(0, 2),
      `${first.revision}.json`,
    );
    expect(JSON.parse(await readFile(object, "utf-8"))).toEqual(state);
    await expect(access(path.join(root, ".rpg-harness/sessions/one/checkpoints")))
      .rejects.toThrow();
    expect(await loadSessionCheckpoint(root, "two", second)).toEqual(state);
  });

  test("preflights and compacts legacy session checkpoint copies", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rpgh-checkpoint-"));
    temporaryDirectories.push(root);
    const serialized = JSON.stringify({ migrated: true });
    const revision = createHash("sha256").update(serialized).digest("hex");
    for (const session of ["one", "two"]) {
      const directory = path.join(
        root,
        ".rpg-harness/sessions",
        session,
        "checkpoints",
      );
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, `${revision}.json`), serialized, "utf-8");
    }

    const preview = await compactSessionCheckpoints(root);
    expect(preview).toEqual({
      mode: "dry-run",
      legacyFiles: 2,
      uniqueRevisions: 1,
      objectsAlreadyPresent: 0,
      objectsCreated: 0,
      legacyFilesRemoved: 0,
      legacyBytes: Buffer.byteLength(serialized) * 2,
      objectBytesRequired: Buffer.byteLength(serialized),
      reclaimableBytes: Buffer.byteLength(serialized),
    });
    expect((await compactSessionCheckpoints(root, { apply: true })).objectsCreated)
      .toBe(1);
    expect((await compactSessionCheckpoints(root)).legacyFiles).toBe(0);
    const checkpoint = {
      schemaVersion: 1 as const,
      file: `checkpoints/${revision}.json`,
      revision,
    };
    expect(await loadSessionCheckpoint(root, "one", checkpoint)).toEqual({
      migrated: true,
    });
  });
});
