import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  createInitialState,
  type ChoiceSearchCheckpoint,
  type Game,
} from "@rpg-harness/engine";
import type { ForkSource } from "./fork";
import {
  currentSearchInputRevision,
  loadSearchCheckpoint,
  persistSearchCheckpoint,
  searchCheckpointIsUsable,
} from "./search-checkpoints";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("content-addressed search checkpoints", () => {
  test("round-trips a complete queue and rejects content tampering", async () => {
    const gameDir = await temporaryGame();
    const inputRevision = await currentSearchInputRevision(gameDir);
    const source = testSource();
    const checkpoint = testCheckpoint(source);
    const reference = await persistSearchCheckpoint({
      gameDir,
      operation: "reach",
      workKey: "choice-authoring/intro/route",
      sourceSession: "player",
      source,
      checkpoint,
      inputRevision,
    });

    expect(reference).toMatchObject({
      schemaVersion: 1,
      inputRevision,
      queueNodes: 1,
      totalExploredNodes: 7,
    });
    expect(reference.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(reference.file).toBe(
      `.rpg-harness/evidence/search/objects/${reference.revision}.json.gz`,
    );
    expect(await loadSearchCheckpoint({
      gameDir,
      revision: reference.revision,
      operation: "reach",
      workKey: "choice-authoring/intro/route",
    })).toEqual({
      schemaVersion: 1,
      operation: "reach",
      workKey: "choice-authoring/intro/route",
      inputRevision,
      sourceSession: "player",
      source,
      checkpoint,
    });
    expect(await searchCheckpointIsUsable({
      gameDir,
      reference,
      operation: "reach",
      workKey: "choice-authoring/intro/route",
      inputRevision,
    })).toBe(true);

    await writeFile(
      path.join(gameDir, reference.file),
      gzipSync('{"schemaVersion":1,"tampered":true}'),
    );
    await expect(loadSearchCheckpoint({
      gameDir,
      revision: reference.revision,
      operation: "reach",
      workKey: "choice-authoring/intro/route",
    })).rejects.toThrow("content hash mismatch");
    expect(await searchCheckpointIsUsable({
      gameDir,
      reference,
      operation: "reach",
      workKey: "choice-authoring/intro/route",
      inputRevision,
    })).toBe(false);
  });

  test("invalidates a complete queue after authored inputs change", async () => {
    const gameDir = await temporaryGame();
    const inputRevision = await currentSearchInputRevision(gameDir);
    const source = testSource();
    const reference = await persistSearchCheckpoint({
      gameDir,
      operation: "reach-script",
      workKey: "story/ending",
      sourceSession: "player",
      source,
      checkpoint: testCheckpoint(source),
      inputRevision,
    });

    await writeFile(
      path.join(gameDir, "game.yaml"),
      "title: Search checkpoint edited\nscripts: []\n",
      "utf-8",
    );
    const currentInputRevision = await currentSearchInputRevision(gameDir);
    expect(currentInputRevision).not.toBe(inputRevision);
    await expect(loadSearchCheckpoint({
      gameDir,
      revision: reference.revision,
      operation: "reach-script",
      workKey: "story/ending",
    })).rejects.toThrow("current revision is");
    expect(await searchCheckpointIsUsable({
      gameDir,
      reference,
      operation: "reach-script",
      workKey: "story/ending",
      inputRevision: currentInputRevision,
    })).toBe(false);
  });
});

async function temporaryGame(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "rpgh-search-checkpoint-"));
  temporaryDirectories.push(root);
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "game.yaml"),
    "title: Search checkpoint\nscripts: []\n",
    "utf-8",
  );
  return root;
}

function testSource(): ForkSource {
  const game: Game = { title: "Search checkpoint", characters: [], scripts: [] };
  return {
    state: createInitialState(game, { seed: 17 }),
    selectedEntry: 3,
    sourceEntries: 5,
    mode: "checkpoint",
  };
}

function testCheckpoint(source: ForkSource): ChoiceSearchCheckpoint {
  const node = {
    state: structuredClone(source.state),
    inputs: [{ type: "next" as const }],
    guidanceGates: [],
    satisfiedGuidanceLeaves: [],
  };
  return {
    schemaVersion: 1,
    target: { kind: "choice", scriptId: "intro", choiceId: "route" },
    maxSteps: 10,
    initialState: structuredClone(source.state),
    queue: [node],
    visited: ["visited-state"],
    totalExploredNodes: 7,
    deepestSteps: 3,
    closestNode: structuredClone(node),
  };
}
