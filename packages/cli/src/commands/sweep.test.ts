import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState, peek, scriptRevision, step } from "@rpg-harness/engine";
import { loadGame } from "../loader";
import { appendLog, saveSession, sessionDir } from "../session";
import { runDevelopmentConvergence, runDevelopmentSweep } from "./sweep";

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
        evidence: {
          safety: { mode: "isolated-session", targetSession: "ai-sweep-001" },
          output: { found: true, replayVerified: true },
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
      },
      safety: {
        nodeBudget: { limit: 2, used: 2, remaining: 0 },
      },
    });
    expect(result.runs).toHaveLength(1);
  });

  test("pauses when one search exhausts its own node budget", async () => {
    const gameDir = await temporarySweepGame();
    const result = await runDevelopmentSweep({
      gameDir,
      session: "player",
      sessionPrefix: "per-item-budget",
      limit: 1,
      maxNodes: 1,
      maxTotalNodes: 20,
      maxSteps: 20,
      pretty: false,
    });

    expect(result).toMatchObject({
      status: "paused",
      reason: "search-budget-exhausted",
      snapshot: {
        completedItems: 0,
        nextKey: "story/scene-a",
      },
      safety: {
        nodeBudget: { limit: 20, used: 1, remaining: 19 },
      },
      resume: {
        fromKey: "story/scene-a",
        snapshotRevision: expect.any(String),
        next: {
          command: "reach-script",
          args: {
            scriptId: "scene-a",
            fromSession: "per-item-budget-001",
            session: "<new-session>",
            maxNodes: 1,
            maxSteps: 20,
          },
        },
      },
      runs: [{
        key: "story/scene-a",
        status: "paused",
        evidence: {
          safety: {
            mode: "isolated-session",
            writes: true,
            targetSession: "per-item-budget-001",
          },
          output: {
            reason: "max-nodes",
            continuation: {
              sourceSession: "per-item-budget-001",
              next: { command: "reach-script" },
            },
          },
        },
      }],
    });
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

  test("until-clean rotates searches and refuses deterministic zero-progress retries", async () => {
    const gameDir = await temporarySweepGame();
    const result = await runDevelopmentConvergence({
      gameDir,
      session: "player",
      sessionPrefix: "continued",
      limit: 2,
      maxGenerations: 2,
      maxNodes: 1,
      maxTotalNodes: 5,
      maxSteps: 20,
      untilClean: true,
      pretty: false,
    });

    expect(result.status).toBe("stopped");
    expect(result.reason).toBe("search-stalled");
    expect(result.generations).toHaveLength(1);
    expect(result.generations[0]?.result.runs).toHaveLength(2);
    expect(result.generations[0]?.result.runs.map((run) => run.key)).toEqual([
      "story/scene-a",
      "story/scene-b",
    ]);
    expect(result.budgets.nodes).toEqual({ limit: 5, used: 2, remaining: 3 });
    expect(result.safety.searchStalls).toEqual([{
      generation: 1,
      key: "story/scene-a",
      targetSession: "continued-g01-001",
      attempt: 1,
      reason: "no-state-progress",
    }, {
      generation: 1,
      key: "story/scene-b",
      targetSession: "continued-g01-002",
      attempt: 1,
      reason: "no-state-progress",
    }]);
    expect(result.liveWorklist.totalItems).toBeGreaterThan(0);
    expect(result.resume?.next?.args.fromSession).toBe("continued-g01-001");
  });

  test("until-clean freezes newly exposed choice work as a later generation", async () => {
    const gameDir = await temporaryCascadeSweepGame();
    const sourceBefore = await snapshotTree(sessionDir(gameDir, "player"));
    const result = await runDevelopmentConvergence({
      gameDir,
      session: "player",
      sessionPrefix: "cascade",
      limit: 10,
      maxGenerations: 3,
      maxNodes: 20,
      maxTotalNodes: 100,
      maxSteps: 20,
      untilClean: true,
      pretty: false,
    });

    expect(result).toMatchObject({
      mode: "until-clean",
      status: "clean",
      reason: "clean",
      sourceSession: "player",
      budgets: {
        generations: { used: 2 },
        items: { used: 3 },
      },
      safety: {
        immutableGenerations: true,
        sourceWrites: false,
      },
      liveWorklist: { totalItems: 0, nextKey: null },
      resume: null,
      generations: [{
        generation: 1,
        sessionPrefix: "cascade-g01",
        result: {
          reason: "snapshot-completed",
          snapshot: { totalItems: 1, completedItems: 1 },
          runs: [{ status: "executed" }],
        },
      }, {
        generation: 2,
        sessionPrefix: "cascade-g02",
        result: {
          reason: "snapshot-completed",
          snapshot: { totalItems: 2, completedItems: 2 },
          runs: [{ status: "executed" }, { status: "executed" }],
        },
      }],
    });
    expect(result.generations[0]?.result.snapshot.revision)
      .not.toBe(result.generations[1]?.result.snapshot.revision);
    expect(await snapshotTree(sessionDir(gameDir, "player"))).toEqual(sourceBefore);
  });

  test("until-clean closes project work whose checkpoint belongs to another lineage", async () => {
    const gameDir = await temporaryCrossLineageSweepGame();
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "other-player", createInitialState(game));

    const result = await runDevelopmentConvergence({
      gameDir,
      session: "other-player",
      sessionPrefix: "cross-lineage",
      limit: 10,
      maxGenerations: 2,
      maxTotalNodes: 100,
      maxSteps: 20,
      untilClean: true,
      pretty: false,
    });

    expect(result).toMatchObject({
      status: "clean",
      liveWorklist: { totalItems: 0 },
      generations: [{
        result: {
          snapshot: { sourceSession: "other-player", totalItems: 2 },
          runs: expect.arrayContaining([
            expect.objectContaining({
              key: expect.stringMatching(/^choice-branch\//),
              status: "executed",
            }),
          ]),
        },
      }],
      qualityGate: { status: "not-configured" },
    });
  });

  test("resuming a frozen project sweep keeps its cross-lineage scope", async () => {
    const gameDir = await temporaryCrossLineageSweepGame();
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "other-player", createInitialState(game));

    const first = await runDevelopmentConvergence({
      gameDir,
      session: "other-player",
      sessionPrefix: "cross-resume-first",
      limit: 1,
      maxGenerations: 2,
      maxTotalNodes: 100,
      maxSteps: 20,
      untilClean: true,
      pretty: false,
    });
    const resume = first.resume;
    if (!resume) throw new Error("project sweep did not return resume coordinates");
    const resumeFromKey = resume.fromKey;
    const resumeSnapshotRevision = resume.snapshotRevision;
    expect(first).toMatchObject({
      status: "paused",
      reason: "item-budget-exhausted",
      resume: {
        fromKey: expect.stringMatching(/^choice-branch\//),
        snapshotRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });

    const resumed = await runDevelopmentSweep({
      gameDir,
      session: "other-player",
      sessionPrefix: "cross-resume-second",
      limit: 10,
      fromKey: resumeFromKey,
      snapshotRevision: resumeSnapshotRevision,
      maxSteps: 20,
      pretty: false,
    });
    expect(resumed).toMatchObject({
      status: "completed",
      reason: "snapshot-completed",
      snapshot: { remainingItems: 0 },
      runs: [{ status: "executed" }],
    });
  });

  test("until-clean runs every authored fresh-world seed before declaring clean", async () => {
    const gameDir = await temporaryQualitySweepGame(1, [11, 13]);
    const sourceBefore = await snapshotTree(sessionDir(gameDir, "player"));

    const result = await runDevelopmentConvergence({
      gameDir,
      session: "player",
      sessionPrefix: "quality-pass",
      limit: 10,
      maxGenerations: 2,
      maxTotalNodes: 100,
      auditMaxSteps: 2,
      auditMaxSegments: 4,
      auditSeed: 61,
      untilClean: true,
      pretty: false,
    });

    const certificateFile = result.qualityGate?.certificate?.file;
    if (!certificateFile) throw new Error("quality gate did not emit a certificate");
    expect(result).toMatchObject({
      status: "clean",
      reason: "clean",
      liveWorklist: { totalItems: 0, nextKey: null },
      qualityGate: {
        status: "passed",
        mode: "executed",
        sessionPrefix: "quality-pass-quality-gate-g01",
        inputRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
        certificate: {
          revision: expect.stringMatching(/^[a-f0-9]{64}$/),
          file: expect.stringContaining("/.rpg-harness/evidence/quality/objects/"),
        },
        audits: [{
          seed: 11,
          maxSteps: 2,
          maxSegments: 4,
          totals: { lanes: 1, completed: 1 },
          qualityGate: { status: "passed" },
        }, {
          seed: 13,
          maxSteps: 2,
          maxSegments: 4,
          totals: { lanes: 1, completed: 1 },
          qualityGate: { status: "passed" },
        }],
      },
    });
    expect(JSON.parse(await readFile(certificateFile, "utf-8"))).toMatchObject({
      schemaVersion: 4,
      surfaces: [{
        schemaVersion: 18,
        id: "web-input-contract",
        status: "passed",
        revision: expect.stringMatching(/^[a-f0-9]{64}$/),
        interactions: [
          { surface: "narration", input: { type: "next" } },
          { surface: "choice", input: { type: "choose", choiceId: "route", optionId: "friends" } },
          { surface: "hub-activity", input: { type: "doActivity", id: "invite:kasumi" } },
          { surface: "script-select", input: { type: "select", scriptId: "ending" } },
        ],
        projections: [{
          surface: "player-feedback-proof",
          text: "検証済みproject aaaaaaaaaa → bbbbbbbbbbcertificate cccccccccc",
        }, {
          surface: "objective-requirement",
          text: "○ Vow kept○ Pulse: Oni 0 / 6",
        }, {
          surface: "locked-condition",
          text: "🔒 Kagariの親密度 4 以上（現在 0）、先に「Moonlit promise」を完了",
        }, {
          surface: "machine-effect-hidden",
          text: "親密度 +1（50 両）",
        }, {
          surface: "forecast-unit-hidden",
          text: "両 +11",
        }, {
          surface: "forecast-detail-hidden",
          text: "ダメージ 14–21 HP",
        }, {
          surface: "terminal-ai-branch",
          text: "AI BRANCH · 3 PATHS次: Remember the others",
        }, {
          surface: "ai-choice-backlog",
          text: "What do you promise?AI 選択Stay until dawn",
        }, {
          surface: "branch-control-handoff",
          text: "AI 首映 · Explore Stay玩家游玩 · AI 来源: Explore Stay",
        }, {
          surface: "bounded-ai-coplay",
          text: "执行「宿で休む」（公开证据：当步规则：体力を全回復して次の遠征を可能にする；目标关联：「地獄門の底へ」；当前 7 项可选）。下一手归玩家。",
        }, {
          surface: "choice-ai-coplay",
          text: "选择「鎮魂法で、毎晩二十押し返す」（公开证据：当步规则：公開方針に合う「loyal」の応答を選ぶ；回应意图：loyal / disciplined；同题 3 项可选）。下一手归玩家。",
        }, {
          surface: "persistent-ai-coplay",
          text: "random@2718 · web · state 56e32233d741",
        }, {
          surface: "external-headless-sync",
          text: "HEADLESS 已推进共享会话；GUI 已同步到最新画面。",
        }, {
          surface: "shareable-game-route",
          text: "/?session=ai-branch&game=sengoku-raid",
        }, {
          surface: "feedback-live-routing",
          text: "scripts/current.mdRouting: live checkpoint / current runtime",
        }],
      }],
    });
    expect(await snapshotTree(sessionDir(gameDir, "player"))).toEqual(sourceBefore);
  });

  test("certifies seeded stochastic survival separately from strategy scoring", async () => {
    const gameDir = await temporaryQualitySweepGame(1, [11, 13], ["random"]);

    const result = await runDevelopmentConvergence({
      gameDir,
      session: "player",
      sessionPrefix: "quality-fuzz-pass",
      limit: 10,
      maxGenerations: 2,
      maxTotalNodes: 100,
      auditMaxSteps: 2,
      auditMaxSegments: 4,
      untilClean: true,
      pretty: false,
    });

    expect(result).toMatchObject({
      status: "clean",
      qualityGate: {
        status: "passed",
        audits: [
          { seed: 11, totals: { lanes: 1, completed: 1 } },
          { seed: 13, totals: { lanes: 1, completed: 1 } },
        ],
        fuzzAudits: [
          { seed: 11, totals: { lanes: 1, completed: 1 }, lanes: [{ persona: "random", ending: "intro" }] },
          { seed: 13, totals: { lanes: 1, completed: 1 }, lanes: [{ persona: "random", ending: "intro" }] },
        ],
      },
    });
    const certificateFile = result.qualityGate?.certificate?.file;
    if (!certificateFile) throw new Error("quality gate did not emit a certificate");
    expect(JSON.parse(await readFile(certificateFile, "utf-8"))).toMatchObject({
      schemaVersion: 4,
      fuzzAudits: [{ seed: 11 }, { seed: 13 }],
    });
  });

  test("turns an incomplete fuzz survival lane into replayable coding work", async () => {
    const gameDir = await temporaryFuzzFailureQualityGame();

    const result = await runDevelopmentConvergence({
      gameDir,
      session: "player",
      sessionPrefix: "quality-fuzz-fail",
      limit: 10,
      maxGenerations: 2,
      maxTotalNodes: 100,
      auditMaxSteps: 2,
      auditMaxSegments: 1,
      untilClean: true,
      pretty: false,
    });

    expect(result).toMatchObject({
      status: "stopped",
      reason: "quality-gate-failed",
      liveWorklist: { totalItems: 1, nextKey: expect.stringMatching(/^report\//) },
      qualityGate: {
        status: "failed",
        fuzzAudits: [{
          seed: 11,
          totals: { lanes: 1, completed: 0, openReports: 1 },
          lanes: [{ persona: "looper", reason: "stalled", ending: null }],
        }],
      },
    });
  });

  test("one failing authored seed blocks certification and becomes coding work", async () => {
    const gameDir = await temporarySeedSensitiveQualityGame();

    const result = await runDevelopmentConvergence({
      gameDir,
      session: "player",
      sessionPrefix: "quality-seed-failure",
      limit: 10,
      maxGenerations: 2,
      maxTotalNodes: 100,
      auditMaxSteps: 10,
      auditMaxSegments: 2,
      untilClean: true,
      pretty: false,
    });

    expect(result).toMatchObject({
      status: "stopped",
      reason: "quality-gate-failed",
      liveWorklist: { totalItems: 1, nextKey: expect.stringMatching(/^report\//) },
      qualityGate: {
        status: "failed",
        audits: [{
          seed: 11,
          qualityGate: { status: "passed" },
        }, {
          seed: 13,
          qualityGate: {
            status: "failed",
            violations: [
              "activity repetition objective/search = 2 > allowed 1; linked objectives [finish]",
            ],
            report: { severity: "major" },
          },
        }],
      },
    });
    expect(result.qualityGate?.certificate).toBeUndefined();
  });

  test("preflights every authored seed before writing the first quality lane", async () => {
    const gameDir = await temporaryQualitySweepGame(1, [11, 13]);
    const game = await loadGame(gameDir);
    await saveSession(
      gameDir,
      "quality-seed-preflight-quality-gate-g01-seed-13-objective",
      createInitialState(game),
    );

    await expect(runDevelopmentConvergence({
      gameDir,
      session: "player",
      sessionPrefix: "quality-seed-preflight",
      limit: 10,
      maxGenerations: 2,
      maxTotalNodes: 100,
      auditMaxSteps: 2,
      auditMaxSegments: 2,
      untilClean: true,
      pretty: false,
    })).rejects.toThrow(
      "Target session already exists: quality-seed-preflight-quality-gate-g01-seed-13-objective",
    );
    expect(await readdir(path.join(gameDir, ".rpg-harness", "sessions")))
      .not.toContain("quality-seed-preflight-quality-gate-g01-seed-11-source");
  });

  test("until-clean reuses a valid project-quality certificate without creating audit lanes", async () => {
    const gameDir = await temporaryQualitySweepGame(1);
    const first = await runDevelopmentConvergence({
      gameDir,
      session: "player",
      sessionPrefix: "quality-cached-first",
      limit: 10,
      maxGenerations: 2,
      maxTotalNodes: 100,
      auditMaxSteps: 2,
      auditMaxSegments: 4,
      auditSeed: 71,
      untilClean: true,
      pretty: false,
    });
    expect(first.qualityGate).toMatchObject({
      status: "passed",
      mode: "executed",
    });
    const firstSessions = await readdir(path.join(gameDir, ".rpg-harness", "sessions"));

    const second = await runDevelopmentConvergence({
      gameDir,
      session: "player",
      sessionPrefix: "quality-cached-second",
      limit: 10,
      maxGenerations: 2,
      maxTotalNodes: 100,
      auditMaxSteps: 2,
      auditMaxSegments: 4,
      auditSeed: 71,
      untilClean: true,
      pretty: false,
    });

    expect(second).toMatchObject({
      status: "clean",
      qualityGate: {
        status: "passed",
        mode: "certificate",
        inputRevision: first.qualityGate?.inputRevision,
        certificate: {
          revision: first.qualityGate?.certificate?.revision,
          file: first.qualityGate?.certificate?.file,
        },
      },
    });
    expect(await readdir(path.join(gameDir, ".rpg-harness", "sessions")))
      .toEqual(firstSessions);
  });

  test("an authored behavior edit invalidates the project-quality certificate", async () => {
    const gameDir = await temporaryQualitySweepGame(1);
    const args = {
      gameDir,
      session: "player",
      limit: 10,
      maxGenerations: 2,
      maxTotalNodes: 100,
      auditMaxSteps: 2,
      auditMaxSegments: 4,
      auditSeed: 73,
      untilClean: true,
      pretty: false,
    } as const;
    const first = await runDevelopmentConvergence({
      ...args,
      sessionPrefix: "quality-edit-first",
    });
    const scriptFile = path.join(gameDir, "scripts", "intro.md");
    await writeFile(
      scriptFile,
      (await readFile(scriptFile, "utf-8")).replace("One beat.", "One changed beat."),
      "utf-8",
    );

    const second = await runDevelopmentConvergence({
      ...args,
      sessionPrefix: "quality-edit-second",
    });
    expect(second.qualityGate).toMatchObject({ status: "passed", mode: "executed" });
    expect(second.qualityGate?.inputRevision).not.toBe(first.qualityGate?.inputRevision);
    expect(await readdir(path.join(gameDir, ".rpg-harness", "sessions")))
      .toContain("quality-edit-second-quality-gate-g01-seed-73-objective");
  });

  test("force-audit bypasses a matching project-quality certificate", async () => {
    const gameDir = await temporaryQualitySweepGame(1);
    const shared = {
      gameDir,
      session: "player",
      limit: 10,
      maxGenerations: 2,
      maxTotalNodes: 100,
      auditMaxSteps: 2,
      auditMaxSegments: 4,
      auditSeed: 79,
      untilClean: true,
      pretty: false,
    } as const;
    const first = await runDevelopmentConvergence({
      ...shared,
      sessionPrefix: "quality-force-first",
    });
    const firstCertificateFile = first.qualityGate?.certificate?.file;
    if (!firstCertificateFile) throw new Error("quality gate did not emit a certificate");
    const firstCertificateBody = await readFile(firstCertificateFile, "utf-8");
    const forced = await runDevelopmentConvergence({
      ...shared,
      sessionPrefix: "quality-force-second",
      forceAudit: true,
    });

    expect(forced.qualityGate).toMatchObject({
      status: "passed",
      mode: "executed",
      inputRevision: first.qualityGate?.inputRevision,
      sessionPrefix: "quality-force-second-quality-gate-g01",
    });
    expect(await readdir(path.join(gameDir, ".rpg-harness", "sessions")))
      .toContain("quality-force-second-quality-gate-g01-seed-79-objective");
    expect(await readFile(firstCertificateFile, "utf-8")).toBe(firstCertificateBody);
    expect(forced.qualityGate?.certificate?.file).not.toBe(firstCertificateFile);
  });

  test("a tampered project-quality certificate is ignored instead of trusted", async () => {
    const gameDir = await temporaryQualitySweepGame(1);
    const shared = {
      gameDir,
      session: "player",
      limit: 10,
      maxGenerations: 2,
      maxTotalNodes: 100,
      auditMaxSteps: 2,
      auditMaxSegments: 4,
      auditSeed: 83,
      untilClean: true,
      pretty: false,
    } as const;
    const first = await runDevelopmentConvergence({
      ...shared,
      sessionPrefix: "quality-tamper-first",
    });
    const certificateFile = first.qualityGate?.certificate?.file;
    if (!certificateFile) throw new Error("quality gate did not emit a certificate");
    const certificate = JSON.parse(await readFile(certificateFile, "utf-8"));
    certificate.audits[0].endings = { forged: 99 };
    await writeFile(certificateFile, JSON.stringify(certificate), "utf-8");

    const second = await runDevelopmentConvergence({
      ...shared,
      sessionPrefix: "quality-tamper-second",
    });
    expect(second.qualityGate).toMatchObject({
      status: "passed",
      mode: "executed",
      sessionPrefix: "quality-tamper-second-quality-gate-g01",
    });
    expect(second.qualityGate?.audits?.[0]?.endings).toEqual({ intro: 1 });
  });

  test("until-clean converts a failed project matrix into the next coding issue", async () => {
    const gameDir = await temporaryQualitySweepGame(2);

    const result = await runDevelopmentConvergence({
      gameDir,
      session: "player",
      sessionPrefix: "quality-fail",
      limit: 10,
      maxGenerations: 2,
      maxTotalNodes: 100,
      auditMaxSteps: 2,
      auditMaxSegments: 4,
      auditSeed: 67,
      untilClean: true,
      pretty: false,
    });

    expect(result).toMatchObject({
      status: "stopped",
      reason: "quality-gate-failed",
      liveWorklist: {
        totalItems: 1,
        nextKey: expect.stringMatching(/^report\//),
      },
      qualityGate: {
        status: "failed",
        audits: [{
          qualityGate: {
            status: "failed",
            violations: ["unique endings 1 < required 2"],
            report: { severity: "major" },
          },
        }],
      },
    });
  });

  test("until-clean stops when a diagnostic generation cannot change the queue", async () => {
    const gameDir = await temporaryDiagnosticSweepGame();

    const result = await runDevelopmentConvergence({
      gameDir,
      session: "player",
      sessionPrefix: "stalled",
      limit: 10,
      maxGenerations: 5,
      maxTotalNodes: 100,
      untilClean: true,
      pretty: false,
    });

    expect(result).toMatchObject({
      status: "stopped",
      reason: "queue-stalled",
      budgets: {
        items: { used: 1 },
        generations: { used: 1 },
        nodes: { used: 0 },
      },
      liveWorklist: {
        totalItems: 1,
        nextKey: "session-error/player",
      },
      generations: [{
        result: {
          status: "completed",
          reason: "snapshot-completed",
          runs: [{
            key: "session-error/player",
            status: "executed",
            evidence: { safety: { mode: "read-only", writes: false } },
          }],
        },
      }],
    });
  });

  test("keeps checkpoint coverage batches bounded and points details at the branch", async () => {
    const gameDir = await temporarySweepChoiceGame();
    const child = Bun.spawn([
      process.execPath,
      path.resolve(import.meta.dir, "../bin.ts"),
      "sweep",
      gameDir,
      "--session",
      "player",
      "--session-prefix",
      "choice-sweep",
      "--limit",
      "1",
      "--max-steps",
      "20",
    ], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    const stdout = await new Response(child.stdout).text();
    const result = JSON.parse(stdout) as Awaited<ReturnType<typeof runDevelopmentSweep>>;
    expect(await new Response(child.stderr).text()).toBe("");

    expect(result).toMatchObject({
      status: "completed",
      snapshot: { remainingItems: 1, nextKey: expect.any(String) },
      runs: [{
        status: "executed",
        evidence: {
          safety: { mode: "isolated-session", writes: true },
          output: {
            reason: "completed",
            decisionPath: { revision: expect.stringMatching(/^[a-f0-9]{64}$/) },
            session: "choice-sweep-001",
            webPath: "/?session=choice-sweep-001",
            targetChoice: { status: "selected" },
            targetScriptCompleted: true,
          },
        },
      }],
    });
    expect(result.snapshot).not.toHaveProperty("remainingKeys");
    expect(result.runs[0]?.evidence.output).not.toHaveProperty("responseTrace");
    expect(result.runs[0]?.evidence.output).not.toHaveProperty("choiceCoverage");
    expect(stdout.length).toBeLessThan(2_500);
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

async function temporarySweepChoiceGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-sweep-choice-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), "title: Sweep choice test\n", "utf-8");
  await writeFile(path.join(dir, "scripts", "scene.md"), [
    "---",
    "id: scene",
    "title: Scene",
    "characters: []",
    "---",
    "",
    "? Reply. {id: reply}",
    "- Stay {id: stay, ai: social}",
    "- Leave {id: leave, ai: independent}",
    "",
    "A deliberately long response that belongs in the persisted branch transcript.",
    "",
    "[end]",
    "",
  ].join("\n"), "utf-8");
  const game = await loadGame(dir);
  const ready = await peek(game, createInitialState(game));
  const presented = await step(
    game,
    ready.state,
    { type: "select", scriptId: "scene" },
  );
  await saveSession(dir, "player", presented.state);
  await appendLog(dir, "player", {
    input: { type: "select", scriptId: "scene" },
    output: presented.output,
  }, presented.state);
  return dir;
}

async function temporaryCrossLineageSweepGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-sweep-cross-lineage-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), "title: Cross-lineage sweep test\n", "utf-8");
  await writeFile(path.join(dir, "scripts", "scene.md"), [
    "---",
    "id: scene",
    "title: Scene",
    "characters: []",
    "---",
    "",
    "? Reply. {id: reply}",
    "- Stay {id: stay, ai: social} -> goto stay_reply",
    "- Leave {id: leave, ai: independent} -> goto leave_reply",
    "",
    "# stay_reply",
    "",
    "The player stays beside the fire.",
    "",
    "[end]",
    "",
    "# leave_reply",
    "",
    "The player leaves before dawn.",
    "",
    "[end]",
    "",
  ].join("\n"), "utf-8");
  const game = await loadGame(dir);
  const ready = await peek(game, createInitialState(game));
  const presented = await step(
    game,
    ready.state,
    { type: "select", scriptId: "scene" },
  );
  await saveSession(dir, "player", presented.state);
  await appendLog(dir, "player", {
    input: { type: "select", scriptId: "scene" },
    output: presented.output,
  }, presented.state);
  return dir;
}

async function temporaryCascadeSweepGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-sweep-cascade-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), "title: Cascade sweep test\n", "utf-8");
  await writeFile(path.join(dir, "scripts", "scene.md"), [
    "---",
    "id: scene",
    "title: Scene",
    "characters: []",
    "---",
    "",
    "? Choose a route. {id: route}",
    "- Take the left trail {id: left, ai: curious} -> goto left_path",
    "- Take the right trail {id: right, ai: cautious} -> goto right_path",
    "",
    "# left_path",
    "",
    "The left trail opens beneath the moon.",
    "",
    "[end]",
    "",
    "# right_path",
    "",
    "The right trail reaches a quiet shrine.",
    "",
    "[end]",
    "",
  ].join("\n"), "utf-8");
  const game = await loadGame(dir);
  await saveSession(dir, "player", createInitialState(game));
  return dir;
}

async function temporaryDiagnosticSweepGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-sweep-diagnostic-"));
  temporaryDirectories.push(dir);
  await mkdir(sessionDir(dir, "player"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), "title: Diagnostic sweep test\n", "utf-8");
  await writeFile(path.join(sessionDir(dir, "player"), "state.json"), "{", "utf-8");
  return dir;
}

async function temporaryQualitySweepGame(
  minEndings: number,
  seeds?: number[],
  fuzzPersonas?: string[],
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-sweep-quality-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), [
    "title: Quality sweep test",
    "ai_audit:",
    `  personas: [${minEndings > 1 ? "objective, greedy" : "objective"}]`,
    ...(fuzzPersonas ? [`  fuzz_personas: [${fuzzPersonas.join(", ")}]`] : []),
    ...(seeds ? [`  seeds: [${seeds.join(", ")}]`] : []),
    `  min_unique_endings: ${minEndings}`,
    "",
  ].join("\n"), "utf-8");
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
  const game = await loadGame(dir);
  const state = createInitialState(game);
  state.baseline.completionOrder.push("intro");
  state.baseline.scripts.intro = {
    completed: true,
    completedRevision: scriptRevision(game.scripts[0]!),
    selfSwitches: { A: false, B: false, C: false, D: false },
  };
  await saveSession(dir, "player", state);
  return dir;
}

async function temporarySeedSensitiveQualityGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-sweep-seed-quality-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "modules"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), [
    "title: Seed-sensitive quality sweep test",
    "preset: ./modules/run.ts",
    "modules:",
    "  - ./modules/world-seed.ts",
    "ai_audit:",
    "  personas: [objective]",
    "  seeds: [11, 13]",
    "  max_activity_repetitions: 1",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "world-seed.ts"), [
    'import type { Module } from "@rpg-harness/engine";',
    "const module: Module = {",
    '  id: "world-seed",',
    '  version: "1",',
    "  initialize(_game, context) { return { seed: context.seed }; },",
    "};",
    "export default module;",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "run.ts"), [
    'import type { RunFunction } from "@rpg-harness/engine";',
    "const run: RunFunction = async function* (ctx) {",
    '  const seed = (ctx.state["world-seed"] as { seed: number }).seed;',
    "  const rounds = seed === 13 ? 2 : 1;",
    "  for (let index = 0; index < rounds; index += 1) {",
    '    const id = `search:zone-${index}`;',
    '    yield { type: "hubMenu", snapshot: { day: index, maxDay: rounds, slot: 0, slotName: "", slotsPerDay: 1, stats: [], affections: [], objectives: [{ id: "finish", title: "Finish", scope: "main", terminal: false, status: "active", relatedActivityIds: [id] }], activities: [{ id, kind: "action", actionKind: "search", title: "Search", cost: 0, available: true }] } };',
    "  }",
    '  yield { type: "gameEnd", reason: "done", endingId: "ending" };',
    "};",
    "export default run;",
    "",
  ].join("\n"), "utf-8");
  return dir;
}

async function temporaryFuzzFailureQualityGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-sweep-fuzz-failure-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "modules"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), [
    "title: Fuzz failure quality sweep test",
    "preset: ./modules/run.ts",
    "ai_audit:",
    "  personas: [objective]",
    "  fuzz_personas: [looper]",
    "  seeds: [11]",
    "  min_unique_endings: 1",
    "modules:",
    "  - ./modules/persona.ts",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "run.ts"), [
    'import type { RunFunction } from "@rpg-harness/engine";',
    "const run: RunFunction = async function* () {",
    "  for (;;) {",
    '    const input = yield { type: "hubMenu", snapshot: { day: 0, maxDay: 0, slot: 0, slotName: "", slotsPerDay: 0, stats: [], affections: [], objectives: [{ id: "finish", title: "Finish", scope: "main", terminal: true, status: "active", relatedActivityIds: ["end"] }], activities: [{ id: "end", kind: "action", title: "End", cost: 0, available: true }, { id: "loop", kind: "action", title: "Loop", cost: 0, available: true }] } };',
    '    if (input?.type === "doActivity" && input.id === "end") break;',
    "  }",
    '  yield { type: "gameEnd", reason: "done", endingId: "ending" };',
    "};",
    "export default run;",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "persona.ts"), [
    'import type { Module } from "@rpg-harness/engine";',
    "const module: Module = {",
    '  id: "fuzz-persona",',
    '  version: "1",',
    "  aiPersonas: { looper: {",
    '    description: "Never chooses the terminal action",',
    "    deterministic: false,",
    '    decide: async () => ({ type: "doActivity", id: "loop" }),',
    "  } },",
    "};",
    "export default module;",
    "",
  ].join("\n"), "utf-8");
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
