import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSessionCheckpoint } from "@rpg-harness/session-store";
import {
  clearBridgeSession,
  createBridgeExploration,
  createBridgeFeedback,
  developmentStatusInvalidation,
  installDevelopmentStatusInvalidation,
  loadBridgeBranchContext,
  loadBridgeDevelopmentStatus,
  loadBridgeExplorationStatus,
  loadBridgeFeedbackFeed,
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
    const replayState = { baseline: { currentScriptId: "000_intro", beatIndex: 1 } };
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
        activityDecision: {
          activityId: "release",
          title: "Release",
          kind: "action",
          category: "combat",
          aiTags: ["nonlethal", "mercy"],
        },
        replayState,
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
    const entries = log.trim().split("\n").map((line) => JSON.parse(line));
    expect(entries).toEqual([
      {
        t: 1234,
        source: "web",
        input: { type: "next" },
        output: { type: "dialogue", text: "同じ一歩。" },
        inputResult: { accepted: true, code: "accepted", message: "Input accepted.", expected: [] },
        decision: { scriptId: "ending", choiceId: "route", optionId: "friends" },
        activityDecision: {
          activityId: "release",
          title: "Release",
          kind: "action",
          category: "combat",
          aiTags: ["nonlethal", "mercy"],
        },
        replayCheckpoint: expect.objectContaining({
          schemaVersion: 1,
          file: expect.stringMatching(/^checkpoints\/[a-f0-9]{64}\.json$/),
          revision: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        checkpoint: expect.objectContaining({
          schemaVersion: 1,
          file: expect.stringMatching(/^checkpoints\/[a-f0-9]{64}\.json$/),
          revision: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      },
    ]);
    expect(await loadSessionCheckpoint(gameDir, "web", entries[0].replayCheckpoint))
      .toEqual(replayState);
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

  test("turns player feedback into a reproducible coding issue at the live GUI checkpoint", async () => {
    const gameDir = await temporaryGame();
    const replayState = {
      baseline: {
        currentScriptId: "bond_mio_03",
        beatIndex: 7,
        completionOrder: ["bond_mio_02"],
        visuals: { bg: "bg/river", portraits: {}, cg: null },
      },
    };
    await saveBridgeSession({
      gameDir,
      session: "player-branch",
      state: {
        baseline: {
          currentScriptId: "bond_mio_03",
          completionOrder: ["bond_mio_02"],
          visuals: { bg: "bg/river", portraits: {}, cg: null },
        },
      },
    });
    await saveBridgeSession({
      gameDir,
      session: "player-branch",
      state: {
        baseline: {
          currentScriptId: "bond_mio_03",
          beatIndex: 8,
          completionOrder: ["bond_mio_02"],
          visuals: { bg: "bg/river", portraits: {}, cg: null },
        },
      },
      event: {
        input: { type: "next" },
        output: { type: "dialogue", speakerId: "mio", text: "The current line." },
        replayState,
      },
      now: () => 1234,
    });

    const report = await createBridgeFeedback({
      gameDir,
      session: "player-branch",
      area: "narrative",
      severity: "minor",
      title: "This answer sounds too explanatory",
      details: "Keep Mio guarded and let the image do more work.",
      target: "scripts/bond_mio_03.md",
    });

    expect(report).toMatchObject({
      status: "open",
      origin: { kind: "player-feedback", surface: "web" },
      session: "player-branch",
      area: "narrative",
      severity: "minor",
      title: "This answer sounds too explanatory",
      details: "Keep Mio guarded and let the image do more work.",
      target: "scripts/bond_mio_03.md",
      evidence: {
        logEntry: 1,
        currentScriptId: "bond_mio_03",
        lastCompletedScriptId: "bond_mio_02",
        lastEvent: {
          input: { type: "next" },
          output: { type: "dialogue", speakerId: "mio", text: "The current line." },
        },
        checkpoint: {
          schemaVersion: 1,
          file: expect.stringMatching(/^issue-checkpoints\/[a-f0-9]{64}\.json$/),
          revision: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        replayCheckpoint: {
          schemaVersion: 1,
          file: expect.stringMatching(/^issue-checkpoints\/[a-f0-9]{64}\.json$/),
          revision: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
    expect(report.evidence.replayCheckpoint?.revision)
      .not.toBe(report.evidence.checkpoint?.revision);
    const stored = JSON.parse(
      (await readFile(
        path.join(gameDir, ".rpg-harness", "sessions", "player-branch", "issues.jsonl"),
        "utf-8",
      )).trim(),
    );
    expect(stored.id).toBe(report.id);
    expect(await loadBridgeSession(gameDir, "player-branch")).toMatchObject({
      baseline: { currentScriptId: "bond_mio_03", beatIndex: 8 },
    });

    const openFeed = await loadBridgeFeedbackFeed(gameDir, "player-branch");
    expect(openFeed).toMatchObject({
      revision: expect.stringMatching(/^[a-f0-9]{16}$/),
      open: 1,
      resolved: 0,
      items: [{
        id: report.id,
        status: "open",
        title: "This answer sounds too explanatory",
        evidence: {
          logEntry: 1,
          currentScriptId: "bond_mio_03",
          checkpoint: { revision: report.evidence.checkpoint?.revision },
        },
      }],
    });

    const automaticReport = {
      ...report,
      id: "pt-automatic",
      title: "Automated audit finding",
      origin: undefined,
    };
    const resolvedReport = {
      ...report,
      status: "resolved",
      resolvedAt: "2026-08-13T01:00:00.000Z",
      resolution: "Made Mio pause before answering and replayed the choice.",
      verification: {
        kind: "player-feedback",
        verifiedAt: "2026-08-13T00:59:00.000Z",
        originalInputRevision: "a".repeat(64),
        fixedInputRevision: "b".repeat(64),
        certificateRevision: "c".repeat(64),
        certificateCreatedAt: "2026-08-13T00:58:00.000Z",
        worklistRevision: "d".repeat(16),
        unrelatedWorkItems: 0,
      },
    };
    await writeFile(
      path.join(gameDir, ".rpg-harness", "sessions", "player-branch", "issues.jsonl"),
      [resolvedReport, automaticReport].map((value) => JSON.stringify(value)).join("\n") + "\n",
      "utf-8",
    );
    const resolvedFeed = await loadBridgeFeedbackFeed(gameDir, "player-branch");
    expect(resolvedFeed).toMatchObject({
      open: 0,
      resolved: 1,
      items: [{
        id: report.id,
        status: "resolved",
        resolution: "Made Mio pause before answering and replayed the choice.",
        verification: {
          kind: "player-feedback",
          originalInputRevision: "a".repeat(64),
          fixedInputRevision: "b".repeat(64),
          certificateRevision: "c".repeat(64),
        },
      }],
    });
    expect(resolvedFeed.revision).not.toBe(openFeed.revision);
  });

  test("continues a completed playthrough on an isolated AI choice branch", async () => {
    const gameDir = await temporaryChoiceGame();
    await runCli(gameDir, [
      "autoplay", gameDir,
      "--persona", "greedy",
      "--session", "finished-player",
      "--max-steps", "20",
    ]);
    const sourceDir = path.join(gameDir, ".rpg-harness", "sessions", "finished-player");
    const sourceState = await readFile(path.join(sourceDir, "state.json"), "utf-8");
    const sourceLog = await readFile(path.join(sourceDir, "log.jsonl"), "utf-8");

    const status = await loadBridgeExplorationStatus(gameDir, "finished-player");
    expect(status).toMatchObject({
      revision: expect.stringMatching(/^[a-f0-9]{16}$/),
      pendingOptions: 1,
      next: {
        key: "intro/opening/beta",
        scriptId: "intro",
        choiceId: "opening",
        optionId: "beta",
        optionText: "Beta",
      },
    });

    const branch = await createBridgeExploration(
      gameDir,
      "finished-player",
      status.next!.key,
      () => 1234,
    );
    expect(branch.sourceSession).toBe("finished-player");
    expect(branch.session).toMatch(/^explore-finished-player-ya-[a-f0-9]{8}$/);
    expect(branch.proofSession).toBe(`${branch.session}-proof`);
    expect(branch.workItem).toEqual(status.next);
    expect(branch.webPath).toBe(
      `/?session=${branch.session}&game=${encodeURIComponent(path.basename(gameDir))}`,
    );
    expect(await readFile(path.join(sourceDir, "state.json"), "utf-8")).toBe(sourceState);
    expect(await readFile(path.join(sourceDir, "log.jsonl"), "utf-8")).toBe(sourceLog);
    expect(await loadBridgeBranchContext(gameDir, branch.session)).toMatchObject({
      fromSession: branch.proofSession,
      sourceLogEntry: 2,
      mode: "checkpoint",
      handoff: {
        workKey: "choice-branch/intro/opening/beta",
        kind: "choice-branch",
        operation: "cover",
        state: "covered",
        coordinates: {
          scriptId: "intro",
          choiceId: "opening",
          optionId: "beta",
        },
        premiere: {
          prompt: "Pick one.",
          optionText: "Beta",
        },
      },
      // The premiere branch begins on the first authored response; selection
      // evidence remains in the autonomous proof parent.
      outcome: null,
    });
    const premiere = await runCli(gameDir, [
      "peek", gameDir,
      "--session", branch.session,
    ]) as { output: { type: string; text?: string }; done: boolean };
    expect(premiere).toMatchObject({
      output: { type: "narration", text: "After." },
      done: false,
    });
    expect((await readFile(
      path.join(gameDir, ".rpg-harness", "sessions", branch.session, "log.jsonl"),
      "utf-8",
    )).trim().split("\n")).toHaveLength(1);
    // A child lineage stops its source evidence at the fork checkpoint, so it
    // still offers the original sibling answer. The player's family combines
    // both branches and is complete.
    expect((await loadBridgeExplorationStatus(gameDir, branch.session)).pendingOptions).toBe(1);
    expect((await loadBridgeExplorationStatus(gameDir, "finished-player")).pendingOptions).toBe(0);
  });

  test("rejects malformed player feedback before writing an issue", async () => {
    const gameDir = await temporaryGame();
    await expect(createBridgeFeedback({
      gameDir,
      session: "web",
      area: "combat" as never,
      severity: "minor",
      title: "Bad area",
    })).rejects.toThrow("Invalid feedback area");
    await expect(createBridgeFeedback({
      gameDir,
      session: "web",
      area: "ui",
      severity: "minor",
      title: "   ",
    })).rejects.toThrow("Feedback title cannot be empty");
  });

  test("projects AI work intent from fork metadata without reading save internals", async () => {
    const gameDir = await temporaryGame();
    const branchDir = path.join(gameDir, ".rpg-harness", "sessions", "ai-branch");
    await mkdir(branchDir, { recursive: true });
    await writeFile(path.join(branchDir, "fork.json"), JSON.stringify({
      schemaVersion: 1,
      fromSession: "player",
      sourceLogEntry: 7,
      sourceLogEntries: 10,
      mode: "checkpoint",
      createdAt: "2026-08-13T00:00:00.000Z",
      handoff: {
        schemaVersion: 1,
        workKey: "choice-authoring/scene/reply",
        priority: "P2",
        kind: "choice-authoring",
        title: "Reach authored choice: Reply?",
        operation: "reach",
        state: "target-reached",
        preparedAt: "2026-08-13T00:00:01.000Z",
        target: "scripts/scene.md",
      },
    }), "utf-8");

    expect(await loadBridgeBranchContext(gameDir, "ai-branch")).toEqual({
      fromSession: "player",
      sourceLogEntry: 7,
      mode: "checkpoint",
      handoff: {
        schemaVersion: 1,
        workKey: "choice-authoring/scene/reply",
        priority: "P2",
        kind: "choice-authoring",
        title: "Reach authored choice: Reply?",
        operation: "reach",
        state: "target-reached",
        preparedAt: "2026-08-13T00:00:01.000Z",
        target: "scripts/scene.md",
      },
      playerControl: null,
      outcome: null,
    });
    await writeFile(path.join(branchDir, "fork.json"), JSON.stringify({
      schemaVersion: 1,
      fromSession: "player",
      sourceLogEntry: 7,
      mode: "checkpoint",
    }), "utf-8");
    expect(await loadBridgeBranchContext(gameDir, "ai-branch")).toEqual({
      fromSession: "player",
      sourceLogEntry: 7,
      mode: "checkpoint",
      handoff: null,
      playerControl: null,
      outcome: null,
    });
    await writeFile(path.join(branchDir, "fork.json"), JSON.stringify({
      schemaVersion: 1,
      fromSession: "../player",
      sourceLogEntry: 7,
      mode: "checkpoint",
    }), "utf-8");
    await expect(loadBridgeBranchContext(gameDir, "ai-branch"))
      .rejects.toThrow("Invalid source session");
  });

  test("derives a player choice outcome from stable handoff coordinates", async () => {
    const gameDir = await temporaryGame();
    const branchDir = path.join(gameDir, ".rpg-harness", "sessions", "ai-choice");
    await mkdir(branchDir, { recursive: true });
    await writeFile(path.join(branchDir, "fork.json"), JSON.stringify({
      schemaVersion: 1,
      fromSession: "player",
      sourceLogEntry: 4,
      mode: "checkpoint",
      handoff: {
        schemaVersion: 1,
        workKey: "choice-authoring/scene/reply",
        priority: "P2",
        kind: "choice-authoring",
        title: "Reach authored choice: Reply?",
        operation: "reach",
        state: "target-reached",
        preparedAt: "2026-08-13T00:00:01.000Z",
        coordinates: { scriptId: "scene", choiceId: "reply" },
      },
    }), "utf-8");
    await writeFile(path.join(branchDir, "log.jsonl"), [
      JSON.stringify({
        source: "reach-choice",
        output: {
          type: "choice",
          scriptId: "scene",
          choiceId: "reply",
          options: [{ id: "leave", text: "Old answer" }],
        },
      }),
      JSON.stringify({
        source: "reach-choice",
        decision: { scriptId: "scene", choiceId: "reply", optionId: "leave" },
      }),
      JSON.stringify({
        source: "reach-choice:checkpoint",
        output: {
          type: "choice",
          scriptId: "scene",
          choiceId: "reply",
          options: [
            { id: "stay", text: "Stay together" },
            { id: "leave", text: "Walk away" },
          ],
        },
      }),
      JSON.stringify({
        source: "web",
        input: { type: "choose", choiceId: "reply", optionId: "stay" },
        decision: { scriptId: "scene", choiceId: "reply", optionId: "stay" },
        output: { type: "dialogue", text: "Then stay." },
      }),
      "",
    ].join("\n"), "utf-8");

    expect(await loadBridgeBranchContext(gameDir, "ai-choice")).toMatchObject({
      handoff: { coordinates: { scriptId: "scene", choiceId: "reply" } },
      playerControl: { source: "web", logEntry: 4 },
      outcome: {
        kind: "choice-selected",
        scriptId: "scene",
        choiceId: "reply",
        optionId: "stay",
        optionText: "Stay together",
        source: "web",
        logEntry: 4,
      },
    });
  });

  test("hands an AI premiere to the first accepted GUI or TUI input", async () => {
    const gameDir = await temporaryGame();
    const branchDir = path.join(gameDir, ".rpg-harness", "sessions", "premiere");
    await mkdir(branchDir, { recursive: true });
    await writeFile(path.join(branchDir, "fork.json"), JSON.stringify({
      schemaVersion: 1,
      fromSession: "proof",
      sourceLogEntry: 2,
      mode: "checkpoint",
      handoff: {
        schemaVersion: 1,
        workKey: "choice-branch/scene/reply/stay",
        priority: "P3",
        kind: "choice-branch",
        title: "Explore Stay",
        operation: "cover",
        state: "covered",
        preparedAt: "2026-08-13T00:00:01.000Z",
        premiere: { optionText: "Stay" },
      },
    }), "utf-8");
    await writeFile(path.join(branchDir, "log.jsonl"), [
      JSON.stringify({ source: "fork", output: { type: "dialogue", text: "First." } }),
      JSON.stringify({
        source: "web",
        input: { type: "doActivity", id: "stale" },
        inputResult: { accepted: false },
        output: { type: "dialogue", text: "First." },
      }),
      JSON.stringify({ source: "autoplay:objective", input: { type: "next" } }),
      JSON.stringify({ source: "tui", input: { type: "next" } }),
      "",
    ].join("\n"), "utf-8");

    expect(await loadBridgeBranchContext(gameDir, "premiere")).toMatchObject({
      playerControl: { source: "tui", logEntry: 4 },
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
        seeds: [],
        fuzzPersonas: [],
        fuzzLanes: 0,
        fuzzMaxDecisions: null,
        maxActivityRepetitions: null,
        maxActivityRepetitionsByKind: null,
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
  await writeFile(
    path.join(dir, "game.yaml"),
    "title: Web bridge fixture\n",
    "utf-8",
  );
  return dir;
}

async function temporaryChoiceGame(): Promise<string> {
  const dir = await temporaryGame();
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(path.join(dir, "scripts", "intro.md"), [
    "---",
    "id: intro",
    "title: Intro",
    "characters: []",
    "---",
    "",
    "Before.",
    "",
    "? Pick one. {id: opening}",
    "- Alpha {id: alpha}",
    "- Beta {id: beta}",
    "",
    "After.",
    "",
    "[end]",
    "",
  ].join("\n"), "utf-8");
  return dir;
}

async function runCli(gameDir: string, args: string[]): Promise<unknown> {
  const child = Bun.spawn([
    process.execPath,
    path.resolve(import.meta.dir, "../../cli/src/bin.ts"),
    ...args,
  ], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`CLI failed for ${gameDir}: ${stderr}`);
  return JSON.parse(stdout);
}
