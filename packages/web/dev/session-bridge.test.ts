import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clearBridgeSession,
  developmentStatusInvalidation,
  installDevelopmentStatusInvalidation,
  loadBridgeDevelopmentStatus,
  loadBridgeSession,
  loadBridgeSnapshot,
  saveBridgeSession,
} from "./session-bridge";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

describe("Web development session bridge", () => {
  test("writes the same state.json and log.jsonl shape used by the CLI", async () => {
    const gameDir = await temporaryGame();
    await saveBridgeSession({
      gameDir,
      session: "web",
      state: { baseline: { currentScriptId: "000_intro" } },
    });
    await saveBridgeSession({
      gameDir,
      session: "web",
      state: { baseline: { currentScriptId: "000_intro", beatIndex: 2 } },
      event: {
        input: { type: "next" },
        output: { type: "dialogue", text: "同じ一歩。" },
        inputResult: { accepted: true, code: "accepted", message: "Input accepted.", expected: [] },
        decision: { scriptId: "ending", choiceId: "route", optionId: "friends" },
      },
      now: () => 1234,
    });

    expect(await loadBridgeSession(gameDir, "web")).toEqual({
      baseline: { currentScriptId: "000_intro", beatIndex: 2 },
    });
    const log = await readFile(
      path.join(gameDir, ".rpg-harness", "sessions", "web", "log.jsonl"),
      "utf-8",
    );
    expect(log.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      {
        t: 1234,
        source: "web",
        input: { type: "next" },
        output: { type: "dialogue", text: "同じ一歩。" },
        inputResult: { accepted: true, code: "accepted", message: "Input accepted.", expected: [] },
        decision: { scriptId: "ending", choiceId: "route", optionId: "friends" },
        checkpoint: expect.objectContaining({
          schemaVersion: 1,
          file: expect.stringMatching(/^checkpoints\/[a-f0-9]{64}\.json$/),
          revision: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      },
    ]);
  });

  test("fresh start clears replay data but preserves captured issues", async () => {
    const gameDir = await temporaryGame();
    const sessionDir = path.join(
      gameDir,
      ".rpg-harness",
      "sessions",
      "web",
    );
    await mkdir(sessionDir, { recursive: true });
    await writeFile(path.join(sessionDir, "state.json"), "{}", "utf-8");
    await writeFile(path.join(sessionDir, "log.jsonl"), "{}\n", "utf-8");
    await writeFile(path.join(sessionDir, "issues.jsonl"), "{\"id\":\"pt-1\"}\n", "utf-8");
    await mkdir(path.join(sessionDir, "checkpoints"));
    await writeFile(path.join(sessionDir, "checkpoints", "old.json"), "{}", "utf-8");

    await clearBridgeSession(gameDir, "web");

    expect(await loadBridgeSession(gameDir, "web")).toBeNull();
    expect(
      await readFile(path.join(sessionDir, "issues.jsonl"), "utf-8"),
    ).toContain("pt-1");
    await expect(readFile(path.join(sessionDir, "checkpoints", "old.json"))).rejects.toThrow();
  });

  test("rejects path traversal in session names", async () => {
    const gameDir = await temporaryGame();
    expect(
      saveBridgeSession({ gameDir, session: "../outside", state: {} }),
    ).rejects.toThrow("Invalid session");
  });

  test("rejects a stale writer instead of overwriting a newer session", async () => {
    const gameDir = await temporaryGame();
    const initialRevision = await saveBridgeSession({
      gameDir,
      session: "web",
      state: { value: 1 },
      expectedRevision: null,
    });
    const nextRevision = await saveBridgeSession({
      gameDir,
      session: "web",
      state: { value: 2 },
      expectedRevision: initialRevision,
    });

    expect(nextRevision).not.toBe(initialRevision);
    expect(
      saveBridgeSession({
        gameDir,
        session: "web",
        state: { value: 999 },
        expectedRevision: initialRevision,
      }),
    ).rejects.toThrow("revision conflict");
    expect(await loadBridgeSnapshot(gameDir, "web")).toEqual({
      state: { value: 2 },
      revision: nextRevision,
    });
  });

  test("projects the global AI development state without writing the player session", async () => {
    const gameDir = await temporaryGame();
    await writeFile(
      path.join(gameDir, "game.yaml"),
      "title: Development status test\n",
      "utf-8",
    );
    await saveBridgeSession({
      gameDir,
      session: "web",
      state: { baseline: { currentScriptId: null } },
    });
    const before = await readFile(
      path.join(gameDir, ".rpg-harness", "sessions", "web", "state.json"),
      "utf-8",
    );

    const status = await loadBridgeDevelopmentStatus(gameDir);

    expect(status).toEqual({
      revision: expect.stringMatching(/^[a-f0-9]{16}$/),
      worklist: {
        total: 0,
        executable: 0,
        diagnostic: 0,
        authoring: 0,
        highestPriority: null,
        next: null,
      },
      quality: {
        status: "uncertified",
        inputRevision: null,
        certificateRevision: null,
        createdAt: null,
        endings: 0,
        paths: 0,
        maxActivityRepetitions: null,
        maxActivityRepetition: null,
      },
    });
    expect(await readFile(
      path.join(gameDir, ".rpg-harness", "sessions", "web", "state.json"),
      "utf-8",
    )).toBe(before);
  });

  test("invalidates development status for project evidence, authored files, and evaluator code", () => {
    const root = path.resolve("/repo/examples");
    expect(developmentStatusInvalidation(
      path.join(root, "sengoku/.rpg-harness/evidence/quality/inputs/a.json"),
      root,
    )).toEqual({
      scope: "game",
      gameDir: path.join(root, "sengoku"),
      immediate: true,
    });
    expect(developmentStatusInvalidation(
      path.join(root, "sengoku/scripts/ending.md"),
      root,
    )).toEqual({
      scope: "game",
      gameDir: path.join(root, "sengoku"),
      immediate: true,
    });
    expect(developmentStatusInvalidation(
      path.resolve("/repo/packages/engine/src/runLoop.ts"),
      root,
    )).toEqual({ scope: "all" });
    expect(developmentStatusInvalidation(
      path.resolve("/repo/packages/web/src/WebPlayScreen.tsx"),
      root,
    )).toEqual({ scope: "all" });
    expect(developmentStatusInvalidation(
      path.resolve("/repo/packages/web/dev/session-bridge.ts"),
      root,
    )).toEqual({ scope: "all" });
    expect(developmentStatusInvalidation(
      path.resolve("/repo/packages/web/vite.config.ts"),
      root,
    )).toEqual({ scope: "all" });
    expect(developmentStatusInvalidation(
      path.resolve("/repo/packages/web/dist/index.html"),
      root,
    )).toBeNull();
    expect(developmentStatusInvalidation(
      path.resolve("/repo/README.md"),
      root,
    )).toBeNull();
  });

  test("registers cache invalidation for add, change, and unlink events", () => {
    const events: string[] = [];
    const watched: Array<string | string[]> = [];
    installDevelopmentStatusInvalidation({
      add: (files) => watched.push(files),
      on: (event) => events.push(event),
    }, "/repo/examples");
    expect(events).toEqual(["add", "change", "unlink"]);
    expect(watched.flat()).toEqual(expect.arrayContaining([
      "/repo/examples",
      "/repo/packages/cli/src",
      "/repo/packages/engine/src",
      "/repo/packages/frontend-core/src",
      "/repo/packages/parser/src",
      "/repo/packages/session-store/src",
      "/repo/packages/web/src",
      "/repo/packages/web/dev",
      "/repo/packages/web/vite.config.ts",
      "/repo/packages/web/package.json",
      "/repo/packages/web/index.html",
    ]));
  });
});

async function temporaryGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-web-bridge-"));
  temporaryDirectories.push(dir);
  return dir;
}
