import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState } from "@rpg-harness/engine";
import { withSessionLock } from "@rpg-harness/session-store";
import { loadGame } from "../loader";
import { listPlaytestReports } from "../playtest-reports";
import { appendLog, loadSession, saveSession, sessionDir } from "../session";
import { runAudit } from "./audit";
import { readSessionLog } from "./fork";
import { runDevelopmentWorkItem } from "./work";
import { collectDevelopmentWorklist } from "./worklist";

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
      diversity: {
        classification: "identical-path",
        uniqueEndings: 1,
        uniqueDecisionPaths: 1,
        choiceDivergences: [],
      },
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

  test("materializes a seeded fresh source without a sacrificial player save", async () => {
    const gameDir = await temporaryGame();
    const first = await runAudit({
      gameDir,
      sessionPrefix: "fresh-matrix-a",
      personas: ["objective", "greedy"],
      maxSteps: 10,
      seed: 17,
      reportOnStop: true,
      pretty: false,
    });

    expect(first).toMatchObject({
      source: {
        session: "fresh-matrix-a-source",
        at: 0,
        entries: 0,
        mode: "initial-state",
      },
      seed: 17,
      totals: { completed: 2, errors: 0 },
    });
    expect(await readSessionLog(gameDir, "fresh-matrix-a-source")).toEqual([]);
    const game = await loadGame(gameDir);
    const source = await loadSession(gameDir, "fresh-matrix-a-source", game);
    expect(source.runtime.rng).toEqual({ algorithm: "mulberry32", state: 17 });

    const second = await runAudit({
      gameDir,
      sessionPrefix: "fresh-matrix-b",
      personas: ["objective", "greedy"],
      maxSteps: 10,
      seed: 17,
      reportOnStop: true,
      pretty: false,
    });
    expect(second.source.stateRevision).toBe(first.source.stateRevision);
    expect(second.lanes.map((lane) => lane.path.revision))
      .toEqual(first.lanes.map((lane) => lane.path.revision));
  });

  test("preflights every fresh audit target before materializing its source", async () => {
    const gameDir = await temporaryGame();
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "fresh-preflight-greedy", createInitialState(game));

    await expect(runAudit({
      gameDir,
      sessionPrefix: "fresh-preflight",
      personas: ["objective", "greedy"],
      maxSteps: 10,
      seed: 23,
      reportOnStop: true,
      pretty: false,
    })).rejects.toThrow("Target session already exists: fresh-preflight-greedy");
    await expect(readFile(
      path.join(sessionDir(gameDir, "fresh-preflight-source"), "state.json"),
    )).rejects.toThrow();
  });

  test("rejects a checkpoint coordinate without an existing source session", async () => {
    const gameDir = await temporaryGame();
    await expect(runAudit({
      gameDir,
      fromLogEntry: 0,
      sessionPrefix: "fresh-at",
      personas: ["objective"],
      maxSteps: 10,
      reportOnStop: true,
      pretty: false,
    })).rejects.toThrow("--from-at requires --from-session");
  });

  test("rejects a fresh-world seed that cannot be represented by the engine RNG", async () => {
    const gameDir = await temporaryGame();
    await expect(runAudit({
      gameDir,
      sessionPrefix: "fresh-wide-seed",
      personas: ["objective"],
      maxSteps: 10,
      seed: 0x1_0000_0000,
      reportOnStop: true,
      pretty: false,
    })).rejects.toThrow("fresh audit --seed must fit in uint32");
  });

  test("keeps persona lane seeds inside uint32 at the top of the seed space", async () => {
    const gameDir = await temporaryGame();
    const summary = await runAudit({
      gameDir,
      sessionPrefix: "fresh-max-seed",
      personas: ["objective", "greedy"],
      maxSteps: 10,
      seed: 0xffff_ffff,
      reportOnStop: true,
      pretty: false,
    });

    expect(summary.seed).toBe(0xffff_ffff);
    expect(summary.totals).toMatchObject({ completed: 2, errors: 0 });
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

  test("distinguishes convergent endings from identical persona paths", async () => {
    const gameDir = await temporaryChoiceGame();
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "player", createInitialState(game));

    const summary = await runAudit({
      gameDir,
      fromSession: "player",
      sessionPrefix: "diverse-matrix",
      personas: ["objective", "greedy", "charmer", "rude"],
      maxSteps: 10,
      reportOnStop: true,
      pretty: false,
    });

    expect(summary.endings).toEqual({ intro: 4 });
    expect(summary.diversity).toEqual({
      classification: "convergent-paths",
      uniqueEndings: 1,
      uniqueDecisionPaths: 3,
      choiceDivergences: [{
        scriptId: "intro",
        choiceId: "route",
        selections: [
          { optionId: "first", personas: ["objective", "greedy"] },
          { optionId: "third", personas: ["charmer"] },
          { optionId: "second", personas: ["rude"] },
        ],
        notReachedBy: [],
      }],
    });
    expect(new Set(summary.lanes.map((lane) => lane.path.revision)).size).toBe(3);
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

    await expect(runAudit({
      gameDir,
      fromSession: "player",
      sessionPrefix: "negative-seed-matrix",
      personas: ["objective"],
      maxSteps: 10,
      seed: -1,
      reportOnStop: true,
      pretty: false,
    })).rejects.toThrow("--seed must be a non-negative integer");
  });

  test("requires a seed for an author-owned stochastic persona", async () => {
    const gameDir = await temporaryStochasticPersonaGame();
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "player", createInitialState(game));

    await expect(runAudit({
      gameDir,
      fromSession: "player",
      sessionPrefix: "custom-random-matrix",
      personas: ["coin-flip"],
      maxSteps: 10,
      reportOnStop: true,
      pretty: false,
    })).rejects.toThrow("[coin-flip] require --seed");
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

  test("passes an author-owned diversity gate without creating work", async () => {
    const gameDir = await temporaryChoiceGame();
    await writeFile(path.join(gameDir, "game.yaml"), [
      "title: Audit choice test",
      "ai_audit:",
      "  min_unique_endings: 1",
      "  min_unique_decision_paths: 3",
    ].join("\n") + "\n", "utf-8");
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "player", createInitialState(game));

    const summary = await runAudit({
      gameDir,
      fromSession: "player",
      sessionPrefix: "passing-matrix",
      personas: ["objective", "greedy", "charmer", "rude"],
      maxSteps: 10,
      reportOnStop: true,
      pretty: false,
    });

    expect(summary.qualityGate).toEqual({
      policy: { minUniqueEndings: 1, minUniqueDecisionPaths: 3 },
      status: "passed",
      observed: { uniqueEndings: 1, uniqueDecisionPaths: 3 },
      violations: [],
    });
    expect(summary.totals.openReports).toBe(0);
    expect(await listPlaytestReports(gameDir)).toEqual([]);
  });

  test("turns a failed fresh-game gate into replayable coding work", async () => {
    const gameDir = await temporaryGame();
    await writeFile(path.join(gameDir, "game.yaml"), [
      "title: Fresh audit failure",
      "ai_audit:",
      "  min_unique_endings: 2",
    ].join("\n") + "\n", "utf-8");

    const summary = await runAudit({
      gameDir,
      sessionPrefix: "fresh-failing-matrix",
      personas: ["objective", "greedy"],
      maxSteps: 10,
      seed: 71,
      reportOnStop: true,
      pretty: false,
    });

    expect(summary.qualityGate).toMatchObject({
      status: "failed",
      evidenceSession: "fresh-failing-matrix-quality-gate",
      violations: ["unique endings 1 < required 2"],
      report: { severity: "major" },
    });
    const [report] = await listPlaytestReports(gameDir);
    expect(report).toMatchObject({
      session: "fresh-failing-matrix-quality-gate",
      status: "open",
      evidence: {
        checkpoint: {
          schemaVersion: 1,
          revision: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        auditMatrix: {
          sourceRevision: summary.source.stateRevision,
          seed: 71,
          maxSegments: 4,
          sessionPrefix: "fresh-failing-matrix",
        },
      },
    });
    expect((await collectDevelopmentWorklist(
      gameDir,
      "fresh-failing-matrix-source",
    )).items).toContainEqual(expect.objectContaining({
      key: `report/${report!.id}`,
      operation: expect.objectContaining({ command: "verify-audit" }),
    }));
  });

  test("turns an unplayed semantic activity surface into reproducible work", async () => {
    const gameDir = await temporaryActivityGame();
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "player", createInitialState(game));

    const summary = await runAudit({
      gameDir,
      fromSession: "player",
      sessionPrefix: "activity-matrix",
      personas: ["objective", "greedy", "rude"],
      maxSteps: 5,
      reportOnStop: true,
      pretty: false,
    });

    expect(summary.activityCoverage).toEqual({
      coveredTags: ["aggressive", "cautious", "economic"],
      byPersona: {
        objective: ["cautious"],
        greedy: ["economic"],
        rude: ["aggressive"],
      },
    });
    expect(summary.qualityGate).toMatchObject({
      policy: {
        personas: ["objective", "greedy", "rude"],
        minUniqueEndings: 1,
        requiredActivityTags: ["cautious", "economic", "aggressive", "social"],
      },
      status: "failed",
      observed: {
        uniqueEndings: 1,
        uniqueDecisionPaths: 3,
        coveredActivityTags: ["aggressive", "cautious", "economic"],
      },
      violations: ["required activity tags not covered: social"],
      report: { severity: "major" },
    });
    const [report] = await listPlaytestReports(gameDir);
    expect(report?.evidence.auditMatrix).toMatchObject({
      observed: {
        coveredActivityTags: ["aggressive", "cautious", "economic"],
      },
      violations: ["required activity tags not covered: social"],
      lanes: expect.arrayContaining([
        expect.objectContaining({ persona: "greedy", activityTags: ["economic"] }),
      ]),
    });

    // Removing a live requirement must not erase the immutable failure floor.
    await writeFile(path.join(gameDir, "game.yaml"), [
      "title: Audit activity test",
      "preset: ./modules/run.ts",
      "ai_audit:",
      "  personas: [objective, greedy, rude]",
      "  min_unique_endings: 1",
      "  required_activity_tags: [cautious, economic, aggressive]",
      "",
    ].join("\n"), "utf-8");
    const verification = await runDevelopmentWorkItem({
      gameDir,
      key: `report/${report!.id}`,
      newSession: "activity-verification",
      pretty: false,
    });
    expect(verification).toMatchObject({
      status: "failed",
      result: {
        qualityGate: {
          policy: {
            requiredActivityTags: ["cautious", "economic", "aggressive", "social"],
          },
          status: "failed",
          violations: ["required activity tags not covered: social"],
        },
      },
    });
    expect((await listPlaytestReports(gameDir))[0]?.status).toBe("open");
  });

  test("turns a grindy but completable activity loop into reproducible work", async () => {
    const gameDir = await temporaryRepetitionGame();
    const summary = await runAudit({
      gameDir,
      sessionPrefix: "repetition-matrix",
      personas: ["objective"],
      maxSteps: 10,
      seed: 23,
      reportOnStop: true,
      pretty: false,
    });

    expect(summary.totals.completed).toBe(1);
    expect(summary.lanes[0]?.path.semanticActivityCounts).toEqual({ search: 3 });
    expect(summary.qualityGate).toMatchObject({
      policy: { maxActivityRepetitions: 2 },
      status: "failed",
      observed: {
        maxActivityRepetition: {
          persona: "objective",
          activityKind: "search",
          count: 3,
          limit: 2,
          objectiveIds: ["search-loop"],
        },
      },
      violations: [
        "activity repetition objective/search = 3 > allowed 2; linked objectives [search-loop]",
      ],
      report: { severity: "major" },
    });
    const [report] = await listPlaytestReports(gameDir);
    expect(report?.evidence.auditMatrix).toMatchObject({
      policy: { maxActivityRepetitions: 2 },
      observed: {
        maxActivityRepetition: {
          persona: "objective",
          activityKind: "search",
          count: 3,
          limit: 2,
          objectiveIds: ["search-loop"],
        },
      },
      lanes: [{
        persona: "objective",
        semanticActivityCounts: { search: 3 },
        semanticActivityObjectives: { search: ["search-loop"] },
      }],
    });
  });

  test("applies an action-kind pacing override without weakening other activities", async () => {
    const gameDir = await temporaryRepetitionGame();
    await writeFile(path.join(gameDir, "game.yaml"), [
      "title: Audit repetition override test",
      "preset: ./modules/run.ts",
      "ai_audit:",
      "  max_activity_repetitions: 2",
      "  max_activity_repetitions_by_kind: { search: 3 }",
      "",
    ].join("\n"), "utf-8");

    const summary = await runAudit({
      gameDir,
      sessionPrefix: "repetition-override-matrix",
      personas: ["objective"],
      maxSteps: 10,
      seed: 23,
      reportOnStop: true,
      pretty: false,
    });

    expect(summary.qualityGate).toMatchObject({
      status: "passed",
      policy: {
        maxActivityRepetitions: 2,
        maxActivityRepetitionsByKind: { search: 3 },
      },
      observed: {
        maxActivityRepetition: {
          persona: "objective",
          activityKind: "search",
          count: 3,
          limit: 3,
        },
      },
      violations: [],
    });
    expect(await listPlaytestReports(gameDir)).toEqual([]);

    const otherKindGameDir = await temporaryRepetitionGame("move");
    await writeFile(path.join(otherKindGameDir, "game.yaml"), [
      "title: Audit repetition override isolation test",
      "preset: ./modules/run.ts",
      "ai_audit:",
      "  max_activity_repetitions: 2",
      "  max_activity_repetitions_by_kind: { search: 3 }",
      "",
    ].join("\n"), "utf-8");
    const otherKindSummary = await runAudit({
      gameDir: otherKindGameDir,
      sessionPrefix: "repetition-default-matrix",
      personas: ["objective"],
      maxSteps: 10,
      seed: 23,
      reportOnStop: true,
      pretty: false,
    });
    expect(otherKindSummary.qualityGate).toMatchObject({
      status: "failed",
      observed: {
        maxActivityRepetition: {
          activityKind: "move",
          count: 3,
          limit: 2,
        },
      },
      violations: [
        "activity repetition objective/move = 3 > allowed 2; linked objectives [move-loop]",
      ],
    });
  });

  test("separates multi-round action intensity from distinct pacing events", async () => {
    const gameDir = await temporaryRepetitionGame("attack", "encounter:one");
    const summary = await runAudit({
      gameDir,
      sessionPrefix: "pacing-instance-matrix",
      personas: ["objective"],
      maxSteps: 10,
      seed: 23,
      reportOnStop: true,
      pretty: false,
    });

    expect(summary.lanes[0]?.path).toMatchObject({
      semanticActivityCounts: { attack: 1 },
      semanticActivityActionCounts: { attack: 3 },
    });
    expect(summary.qualityGate).toMatchObject({
      status: "passed",
      observed: {
        maxActivityRepetition: {
          activityKind: "attack",
          count: 1,
          limit: 2,
        },
      },
      violations: [],
    });
    expect(await listPlaytestReports(gameDir)).toEqual([]);
  });

  test("fails when no acceptance lane completes a required deep script", async () => {
    const gameDir = await temporaryRequiredScriptGame();
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "player", createInitialState(game));

    const summary = await runAudit({
      gameDir,
      fromSession: "player",
      sessionPrefix: "deep-script-matrix",
      personas: ["objective"],
      maxSteps: 5,
      reportOnStop: true,
      pretty: false,
    });

    expect(summary.scriptCoverage).toEqual({
      completedScripts: ["ending"],
      byPersona: { objective: ["ending"] },
    });
    expect(summary.qualityGate).toMatchObject({
      policy: {
        personas: ["objective"],
        requiredScripts: ["deep_scene"],
      },
      status: "failed",
      observed: {
        completedScripts: ["ending"],
      },
      violations: ["required scripts not completed: deep_scene"],
      report: { severity: "major" },
    });
    const [report] = await listPlaytestReports(gameDir);
    expect(report?.evidence.auditMatrix).toMatchObject({
      observed: { completedScripts: ["ending"] },
      violations: ["required scripts not completed: deep_scene"],
      lanes: [expect.objectContaining({
        persona: "objective",
        completedScripts: ["ending"],
      })],
    });
  });

  test("turns a failed diversity gate into reproducible development work", async () => {
    const gameDir = await temporaryChoiceGame();
    await writeFile(path.join(gameDir, "game.yaml"), [
      "title: Audit choice test",
      "ai_audit:",
      "  min_unique_endings: 2",
      "  min_unique_decision_paths: 3",
    ].join("\n") + "\n", "utf-8");
    const game = await loadGame(gameDir);
    const sourceState = createInitialState(game);
    await saveSession(gameDir, "player", sourceState);

    const summary = await runAudit({
      gameDir,
      fromSession: "player",
      sessionPrefix: "failing-matrix",
      personas: ["objective", "greedy", "charmer", "rude"],
      maxSteps: 10,
      reportOnStop: true,
      pretty: false,
    }, {
      onQualityEvidenceForked: async (session) => {
        await withSessionLock(gameDir, session, async () => {
          const guiState = structuredClone(
            await loadSession(gameDir, session, game),
          );
          guiState.baseline.currentScriptId = "gui-interleaved";
          await saveSession(gameDir, session, guiState);
          await appendLog(gameDir, session, {
            t: Date.now(),
            source: "gui",
            output: { type: "text", text: "interleaved after audit fork" },
          }, guiState);
        });
      },
    });

    expect(summary.qualityGate).toMatchObject({
      policy: { minUniqueEndings: 2, minUniqueDecisionPaths: 3 },
      status: "failed",
      observed: { uniqueEndings: 1, uniqueDecisionPaths: 3 },
      violations: ["unique endings 1 < required 2"],
      evidenceSession: "failing-matrix-quality-gate",
      report: { severity: "major" },
    });
    expect(summary.totals.openReports).toBe(1);
    const reportId = summary.qualityGate?.report?.id;
    expect(reportId).toBeString();
    const reports = await listPlaytestReports(gameDir);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      id: reportId,
      session: "failing-matrix-quality-gate",
      target: "game.yaml",
      evidence: {
        checkpoint: { schemaVersion: 1 },
        auditMatrix: {
          seed: expect.any(Number),
          maxSegments: 4,
          sessionPrefix: "failing-matrix",
          policy: { minUniqueEndings: 2, minUniqueDecisionPaths: 3 },
          observed: { uniqueEndings: 1, uniqueDecisionPaths: 3 },
          classification: "convergent-paths",
          violations: ["unique endings 1 < required 2"],
          lanes: expect.arrayContaining([
            expect.objectContaining({
              persona: "charmer",
              session: "failing-matrix-charmer",
              ending: "intro",
              pathRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
          ]),
          choiceDivergences: [expect.objectContaining({
            scriptId: "intro",
            choiceId: "route",
          })],
        },
      },
    });
    const checkpoint = reports[0]?.evidence.checkpoint;
    expect(checkpoint).toBeDefined();
    if (!checkpoint) throw new Error("Expected frozen audit checkpoint");
    const checkpointState = JSON.parse(await readFile(
      path.join(
        sessionDir(gameDir, "failing-matrix-quality-gate"),
        checkpoint.file,
      ),
      "utf-8",
    ));
    expect(checkpointState).toEqual(sourceState);
    expect(reports[0]?.evidence.logEntry).toBe(1);
    expect((await readSessionLog(
      gameDir,
      "failing-matrix-quality-gate",
    ))).toHaveLength(2);
    expect((await loadSession(
      gameDir,
      "failing-matrix-quality-gate",
      game,
    )).baseline.currentScriptId).toBe("gui-interleaved");
    const worklist = await collectDevelopmentWorklist(gameDir);
    expect(worklist.items).toContainEqual(expect.objectContaining({
      key: `report/${reportId}`,
      kind: "playtest-report",
      actionability: "executable",
      operation: {
        command: "verify-audit",
        args: {
          reportId,
          sessionPrefix: "<new-session>",
        },
      },
      coordinates: expect.objectContaining({
        auditMatrix: expect.objectContaining({
          violations: ["unique endings 1 < required 2"],
        }),
      }),
    }));
  });

  test("CLI exits non-zero when the authored diversity gate fails", async () => {
    const gameDir = await temporaryGame();
    await writeFile(path.join(gameDir, "game.yaml"), [
      "title: Audit test",
      "ai_audit:",
      "  min_unique_endings: 2",
    ].join("\n") + "\n", "utf-8");
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "player", createInitialState(game));

    const child = Bun.spawn([
      process.execPath,
      path.resolve(import.meta.dir, "../bin.ts"),
      "audit",
      gameDir,
      "--from-session",
      "player",
      "--session-prefix",
      "cli-failing-matrix",
      "--personas",
      "objective,greedy",
      "--max-steps",
      "10",
    ], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      qualityGate: {
        status: "failed",
        violations: ["unique endings 1 < required 2"],
      },
    });
  });

  test("CLI defaults to the project-owned acceptance personas", async () => {
    const gameDir = await temporaryChoiceGame();
    await writeFile(path.join(gameDir, "game.yaml"), [
      "title: Audit choice test",
      "ai_audit:",
      "  personas: [charmer, rude]",
      "  min_unique_endings: 1",
      "  min_unique_decision_paths: 2",
    ].join("\n") + "\n", "utf-8");
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "player", createInitialState(game));

    const child = Bun.spawn([
      process.execPath,
      path.resolve(import.meta.dir, "../bin.ts"),
      "audit",
      gameDir,
      "--from-session",
      "player",
      "--session-prefix",
      "project-personas",
      "--max-steps",
      "10",
    ], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      lanes: [
        { persona: "charmer", reason: "completed" },
        { persona: "rude", reason: "completed" },
      ],
      qualityGate: {
        policy: {
          personas: ["charmer", "rude"],
          minUniqueEndings: 1,
          minUniqueDecisionPaths: 2,
        },
        status: "passed",
      },
    });
  });

  test("CLI audits a fresh game when --from-session is omitted", async () => {
    const gameDir = await temporaryGame();
    const child = Bun.spawn([
      process.execPath,
      path.resolve(import.meta.dir, "../bin.ts"),
      "audit",
      gameDir,
      "--session-prefix",
      "cli-fresh-matrix",
      "--personas",
      "objective",
      "--max-steps",
      "10",
      "--seed",
      "31",
    ], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      source: {
        session: "cli-fresh-matrix-source",
        mode: "initial-state",
      },
      seed: 31,
      lanes: [
        { persona: "objective", session: "cli-fresh-matrix-objective" },
      ],
    });
  });

  test("does not judge diversity or file matrix noise before every lane ends", async () => {
    const gameDir = await temporaryGame();
    await writeFile(path.join(gameDir, "game.yaml"), [
      "title: Audit test",
      "ai_audit:",
      "  min_unique_endings: 2",
    ].join("\n") + "\n", "utf-8");
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "player", createInitialState(game));

    const summary = await runAudit({
      gameDir,
      fromSession: "player",
      sessionPrefix: "incomplete-matrix",
      personas: ["objective", "greedy"],
      maxSteps: 0,
      reportOnStop: false,
      pretty: false,
    });

    expect(summary.qualityGate).toEqual({
      policy: { minUniqueEndings: 2 },
      status: "not-evaluated",
      observed: { uniqueEndings: 0, uniqueDecisionPaths: 1 },
      violations: [
        "audit lanes did not reach terminal endings: objective=max-steps, greedy=max-steps",
      ],
    });
    expect(summary.totals.openReports).toBe(0);
    expect(await listPlaytestReports(gameDir)).toEqual([]);
  });

  test("resumes progressing lanes across bounded segments before judging quality", async () => {
    const singleGameDir = await temporaryLongAuditGame();
    const single = await runAudit({
      gameDir: singleGameDir,
      sessionPrefix: "single-segment",
      personas: ["objective"],
      maxSteps: 2,
      maxSegments: 1,
      seed: 47,
      reportOnStop: false,
      pretty: false,
    });
    expect(single).toMatchObject({
      maxSegments: 1,
      lanes: [{ reason: "max-steps", segments: 1, ending: null }],
      qualityGate: {
        status: "failed",
        violations: [
          "audit lanes did not reach terminal endings: objective=max-steps",
        ],
      },
    });

    const resumedGameDir = await temporaryLongAuditGame();
    const resumed = await runAudit({
      gameDir: resumedGameDir,
      sessionPrefix: "resumed-segments",
      personas: ["objective"],
      maxSteps: 2,
      maxSegments: 4,
      seed: 47,
      reportOnStop: false,
      pretty: false,
    });
    expect(resumed).toMatchObject({
      maxSegments: 4,
      totals: { completed: 1, segments: 3, budgetCheckpoints: 0 },
      lanes: [{
        reason: "completed",
        segments: 3,
        ending: "long-intro",
        decisions: 6,
      }],
      qualityGate: { status: "passed" },
    });
  });

  test("rejects a non-positive audit segment budget", async () => {
    const gameDir = await temporaryGame();
    await expect(runAudit({
      gameDir,
      sessionPrefix: "bad-segments",
      personas: ["objective"],
      maxSteps: 10,
      maxSegments: 0,
      reportOnStop: false,
      pretty: false,
    })).rejects.toThrow("--max-segments must be a positive integer");
  });

  test("rejects a GUI write between audit segments instead of mixing evidence", async () => {
    const gameDir = await temporaryLongAuditGame();
    const game = await loadGame(gameDir);
    await expect(runAudit({
      gameDir,
      sessionPrefix: "interleaved-segments",
      personas: ["objective"],
      maxSteps: 2,
      maxSegments: 4,
      seed: 53,
      reportOnStop: false,
      pretty: false,
    }, {
      onLaneSegmentComplete: async (_persona, session, segment, summary) => {
        if (segment !== 0 || summary.reason !== "max-steps") return;
        await withSessionLock(gameDir, session, async () => {
          const changed = structuredClone(await loadSession(gameDir, session, game));
          changed.baseline.inventory.gui_interleaved = 1;
          await saveSession(gameDir, session, changed);
        });
      },
    })).rejects.toThrow("Autoplay resume ownership lost");
  });

  test("treats an explicit persona subset as diagnosis, not project acceptance", async () => {
    const gameDir = await temporaryChoiceGame();
    await writeFile(path.join(gameDir, "game.yaml"), [
      "title: Audit choice test",
      "ai_audit:",
      "  personas: [objective, greedy, charmer, rude]",
      "  min_unique_endings: 2",
      "  min_unique_decision_paths: 3",
    ].join("\n") + "\n", "utf-8");
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "player", createInitialState(game));

    const summary = await runAudit({
      gameDir,
      fromSession: "player",
      sessionPrefix: "diagnostic-subset",
      personas: ["charmer", "rude"],
      maxSteps: 10,
      reportOnStop: false,
      pretty: false,
    });

    expect(summary.qualityGate).toEqual({
      policy: {
        personas: ["objective", "greedy", "charmer", "rude"],
        minUniqueEndings: 2,
        minUniqueDecisionPaths: 3,
      },
      status: "not-evaluated",
      observed: { uniqueEndings: 1, uniqueDecisionPaths: 2 },
      violations: [
        "project acceptance requires personas [objective, greedy, charmer, rude]",
      ],
    });
    expect(await listPlaytestReports(gameDir)).toEqual([]);
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

async function temporaryLongAuditGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-audit-long-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), [
    "title: Long audit test",
    "ai_audit:",
    "  personas: [objective]",
    "  min_unique_endings: 1",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "scripts", "long-intro.md"), [
    "---",
    "id: long-intro",
    "title: Long intro",
    "characters: []",
    "---",
    "",
    "First beat.",
    "",
    "Second beat.",
    "",
    "Third beat.",
    "",
    "Fourth beat.",
    "",
    "Fifth beat.",
    "",
    "[end]",
    "",
  ].join("\n"), "utf-8");
  return dir;
}

async function temporaryChoiceGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-audit-choice-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), "title: Audit choice test\n", "utf-8");
  await writeFile(path.join(dir, "scripts", "intro.md"), [
    "---",
    "id: intro",
    "title: Intro",
    "characters: []",
    "---",
    "",
    "? Pick a route. {id: route}",
    "- First {id: first}",
    "- Second {id: second}",
    "- Third {id: third}",
    "",
    "[end]",
    "",
  ].join("\n"), "utf-8");
  return dir;
}

async function temporaryStochasticPersonaGame(): Promise<string> {
  const dir = await temporaryGame();
  await mkdir(path.join(dir, "modules"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), [
    "title: Audit stochastic persona test",
    "modules:",
    "  - ./modules/persona.ts",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "persona.ts"), [
    'import type { Module } from "@rpg-harness/engine";',
    "const module: Module = {",
    '  id: "stochastic-persona",',
    "  aiPersonas: {",
    '    "coin-flip": {',
    '      description: "Samples a runner-owned coin flip",',
    "      deterministic: false,",
    "      decide: async (output, _state, _step, context) => {",
    '        if (output.type === "scriptComplete") {',
    "          const available = output.nextAvailable;",
    "          const script = available[Math.floor((context?.rng() ?? 0) * available.length)];",
    '          return script ? { type: "select", scriptId: script.id } : null;',
    "        }",
    '        if (output.type === "gameEnd") return null;',
    '        return { type: "next" };',
    "      },",
    "    },",
    "  },",
    "};",
    "export default module;",
    "",
  ].join("\n"), "utf-8");
  return dir;
}

async function temporaryActivityGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-audit-activity-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "modules"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), [
    "title: Audit activity test",
    "preset: ./modules/run.ts",
    "ai_audit:",
    "  personas: [objective, greedy, rude]",
    "  min_unique_endings: 1",
    "  required_activity_tags: [cautious, economic, aggressive, social]",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "run.ts"), [
    'import type { RunFunction } from "@rpg-harness/engine";',
    "const run: RunFunction = async function* (ctx) {",
    '  yield { type: "hubMenu", snapshot: { day: 0, maxDay: 0, slot: 0, slotName: "", slotsPerDay: 0, stats: [], affections: [], objectives: [{ id: "approach", title: "Choose an approach", scope: "main", terminal: false, status: "active", relatedActivityIds: ["safe"] }], activities: [',
    '    { id: "safe", kind: "action", title: "Safe", cost: 0, available: true, aiTags: ["cautious"] },',
    '    { id: "profit", kind: "action", title: "Profit", cost: 0, available: true, aiTags: ["economic"] },',
    '    { id: "danger", kind: "action", title: "Danger", cost: 0, available: true, aiTags: ["aggressive"] },',
    "  ] } };",
    '  yield { type: "hubMenu", snapshot: { day: 0, maxDay: 0, slot: 0, slotName: "", slotsPerDay: 0, stats: [], affections: [], objectives: [{ id: "finish", title: "Finish", scope: "main", terminal: true, status: "active", relatedActivityIds: ["finish"] }], activities: [',
    '    { id: "finish", kind: "action", title: "Finish", cost: 0, available: true },',
    "  ] } };",
    '  ctx.state.baseline.completionOrder.push("ending");',
    '  yield { type: "gameEnd", reason: "activity selected" };',
    "};",
    "export default run;",
    "",
  ].join("\n"), "utf-8");
  return dir;
}

async function temporaryRepetitionGame(
  activityKind = "search",
  pacingInstanceId?: string,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-audit-repetition-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "modules"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), [
    "title: Audit repetition test",
    "preset: ./modules/run.ts",
    "ai_audit:",
    "  max_activity_repetitions: 2",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "run.ts"), [
    'import type { RunFunction } from "@rpg-harness/engine";',
    "const run: RunFunction = async function* (ctx) {",
    "  for (let index = 0; index < 3; index += 1) {",
    `    const id = \`${activityKind}:zone-\${index}\`;`,
    `    yield { type: "hubMenu", snapshot: { day: index, maxDay: 3, slot: 0, slotName: "", slotsPerDay: 1, stats: [], affections: [], objectives: [{ id: "${activityKind}-loop", title: "Repeat activity", scope: "main", terminal: false, status: "active", relatedActivityIds: [id] }], activities: [`,
    `      { id, kind: "action", actionKind: "${activityKind}", title: "Act", cost: 0, available: true${pacingInstanceId ? `, pacingInstanceId: "${pacingInstanceId}"` : ""} },`,
    "    ] } };",
    "  }",
    '  ctx.state.baseline.completionOrder.push("ending");',
    '  yield { type: "gameEnd", reason: "search complete", endingId: "ending" };',
    "};",
    "export default run;",
    "",
  ].join("\n"), "utf-8");
  return dir;
}

async function temporaryRequiredScriptGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-audit-required-script-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "modules"), { recursive: true });
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), [
    "title: Audit required script test",
    "preset: ./modules/run.ts",
    "ai_audit:",
    "  personas: [objective]",
    "  required_scripts: [deep_scene]",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "scripts", "deep_scene.md"), [
    "---",
    "id: deep_scene",
    "title: Deep scene",
    "characters: []",
    "---",
    "",
    "This scene is deliberately never selected by the custom run.",
    "",
    "[end]",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "run.ts"), [
    'import type { RunFunction } from "@rpg-harness/engine";',
    "const run: RunFunction = async function* (ctx) {",
    '  ctx.state.baseline.completionOrder.push("ending");',
    '  yield { type: "gameEnd", reason: "shallow ending" };',
    "};",
    "export default run;",
    "",
  ].join("\n"), "utf-8");
  return dir;
}
