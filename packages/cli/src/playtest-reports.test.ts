import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState, type Game } from "@rpg-harness/engine";
import { withSessionLock } from "@rpg-harness/session-store";
import {
  capturePlaytestEvidenceSnapshot,
  formatPlaytestReports,
  listPlaytestReports,
  recordPlaytestReport,
  reproducePlaytestReport,
  resolvePlaytestReport,
  resolveVerifiedPlaytestReport,
  supersedePlaytestReport,
  type ResolvePlaytestReportArgs,
  type PlaytestAutoplayVerification,
} from "./playtest-reports";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

describe("playtest reports", () => {
  test("records a coding issue with compact evidence from the latest step", async () => {
    const gameDir = await temporaryGame();
    const session = "ai-kagari";
    const dir = path.join(gameDir, ".rpg-harness", "sessions", session);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "state.json"),
      JSON.stringify({
        baseline: {
          currentScriptId: "bond_kagari_04",
          completionOrder: ["000_intro", "bond_kagari_01"],
          visuals: {
            bg: "assets/backgrounds/inn-veranda-night",
            portraits: {
              left: "assets/portraits/kagari-default",
              right: null,
            },
            cg: "assets/cgs/bond-kagari-03",
          },
        },
      }),
    );
    await writeFile(
      path.join(dir, "log.jsonl"),
      [
        JSON.stringify({
          input: { type: "next" },
          output: { type: "narration", text: "first" },
        }),
        JSON.stringify({
          input: { type: "next" },
          output: {
            type: "dialogue",
            speakerId: "kagari",
            speakerName: "篝",
            text: "お主、あたしに訊いたな。",
            visualState: { bg: "a-heavy-field-we-do-not-copy" },
          },
        }),
      ].join("\n") + "\n",
    );

    const report = await recordPlaytestReport({
      gameDir,
      session,
      area: "narrative",
      severity: "major",
      title: "Silent choice is remembered as spoken dialogue",
      details: "bond_kagari_04 contradicts the earlier choice.",
      target: "scripts/bond_kagari_04.md",
    });

    expect(report.id).toMatch(/^pt-\d{14}-[a-f0-9]{8}$/);
    expect(report.evidence.currentScriptId).toBe("bond_kagari_04");
    expect(report.evidence.lastCompletedScriptId).toBe("bond_kagari_01");
    expect(report.evidence.logEntry).toBe(2);
    expect(report.evidence.visualState).toEqual({
      bg: "assets/backgrounds/inn-veranda-night",
      portraits: {
        left: "assets/portraits/kagari-default",
        right: null,
      },
      cg: "assets/cgs/bond-kagari-03",
    });
    expect(report.evidence.checkpoint).toMatchObject({
      schemaVersion: 1,
      file: expect.stringMatching(/^issue-checkpoints\/[a-f0-9]{64}\.json$/),
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(report.evidence.lastEvent).toEqual({
      input: { type: "next" },
      output: {
        type: "dialogue",
        speakerId: "kagari",
        speakerName: "篝",
        text: "お主、あたしに訊いたな。",
      },
    });

    const stored = await listPlaytestReports(gameDir, session);
    expect(stored).toEqual([report]);
    const raw = await readFile(path.join(dir, "issues.jsonl"), "utf-8");
    expect(raw.trim().split("\n")).toHaveLength(1);
  });

  test("reproduces the issue snapshot after the live save and log are gone", async () => {
    const gameDir = await temporaryGame();
    const session = "web-bug";
    const dir = path.join(gameDir, ".rpg-harness", "sessions", session);
    const state = {
      baseline: {
        currentScriptId: "ending_mundane_seal",
        completionOrder: [],
        visuals: { bg: "assets/backgrounds/edo-castle", portraits: {}, cg: null },
      },
      runtime: {},
    };
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "state.json"), JSON.stringify(state));
    await writeFile(
      path.join(dir, "log.jsonl"),
      JSON.stringify({ input: { type: "next" }, output: { type: "choice" } }) + "\n",
    );
    const report = await recordPlaytestReport({
      gameDir,
      session,
      area: "ui",
      severity: "minor",
      title: "Wrong background under the ending CG",
    });
    await rm(path.join(dir, "state.json"));
    await rm(path.join(dir, "log.jsonl"));

    const result = await reproducePlaytestReport({
      gameDir,
      id: report.id,
      to: "repro-bg",
    });

    expect(result).toMatchObject({
      session: "repro-bg",
      fromReport: report.id,
      fromSession: session,
      sourceLogEntry: 1,
      mode: "playtest-checkpoint",
      webPath: "/?session=repro-bg",
    });
    expect(JSON.parse(await readFile(
      path.join(gameDir, ".rpg-harness/sessions/repro-bg/state.json"),
      "utf-8",
    ))).toEqual(state);
  });

  test("can report a broken session even when state and log JSON are invalid", async () => {
    const gameDir = await temporaryGame();
    const session = "broken-engine";
    const dir = path.join(gameDir, ".rpg-harness", "sessions", session);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "state.json"), "{ definitely broken");
    await writeFile(path.join(dir, "log.jsonl"), "not json\n");

    const report = await recordPlaytestReport({
      gameDir,
      session,
      area: "engine",
      severity: "blocker",
      title: "Session cannot be resumed",
    });

    expect(report.evidence.currentScriptId).toBeNull();
    expect(report.evidence.lastEvent).toBeNull();
    expect(report.evidence.captureErrors).toHaveLength(2);
  });

  test("captures hub telemetry instead of reducing evidence to activity ids", async () => {
    const gameDir = await temporaryGame();
    const session = "hub-ui";
    const dir = path.join(gameDir, ".rpg-harness", "sessions", session);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "log.jsonl"),
      JSON.stringify({
        input: { type: "next" },
        output: {
          type: "hubMenu",
          snapshot: {
            day: 0,
            maxDay: 0,
            slot: 0,
            slotName: "",
            stats: [{ id: "hp", value: 30, max: 30 }],
            affections: [{ id: "kagari", value: 2 }],
            activities: [
              {
                id: "depart:kuro_swamp",
                kind: "action",
                title: "出立 — 黒沼地",
                description: "Cross into the authored raid module.",
                category: "raid",
                aiTags: ["exploration", "progression"],
                effectsHint: "opens kuro_swamp",
                available: false,
                recommended: true,
                lockedReason: "need a key",
                requires: { inventory: { itemId: "key", min: 1 } },
                actionKind: "raid:depart",
                payload: { mapId: "kuro_swamp" },
              },
            ],
          },
        },
      }) + "\n",
    );
    const report = await recordPlaytestReport({
      gameDir,
      session,
      area: "ui",
      severity: "minor",
      title: "Non-calendar hub shows Day 0/0",
    });
    expect(report.evidence.lastEvent?.output).toEqual({
      type: "hubMenu",
      day: 0,
      maxDay: 0,
      slot: 0,
      slotName: "",
      stats: [{ id: "hp", value: 30, max: 30 }],
      affections: [{ id: "kagari", value: 2 }],
      activities: [
        {
          id: "depart:kuro_swamp",
          kind: "action",
          title: "出立 — 黒沼地",
          description: "Cross into the authored raid module.",
          category: "raid",
          aiTags: ["exploration", "progression"],
          effectsHint: "opens kuro_swamp",
          available: false,
          recommended: true,
          lockedReason: "need a key",
          requires: { inventory: { itemId: "key", min: 1 } },
          actionKind: "raid:depart",
          payload: { mapId: "kuro_swamp" },
        },
      ],
    });
  });

  test("retains stable authored choice coordinates in compact evidence", async () => {
    const gameDir = await temporaryGame();
    const session = "choice-contract";
    const dir = path.join(gameDir, ".rpg-harness", "sessions", session);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "log.jsonl"), JSON.stringify({
      input: { type: "next" },
      output: {
        type: "choice",
        scriptId: "bond_kagari_04",
        scriptRevision: "a".repeat(64),
        choiceId: "answer",
        prompt: "答える？",
        options: [{ id: "yes", text: "はい", available: true }],
      },
    }) + "\n");

    const report = await recordPlaytestReport({
      gameDir,
      session,
      area: "narrative",
      severity: "major",
      title: "Choice route stalls",
    });

    expect(report.evidence.lastEvent?.output).toMatchObject({
      type: "choice",
      scriptId: "bond_kagari_04",
      scriptRevision: "a".repeat(64),
      choiceId: "answer",
    });
  });

  test("retains selected Hub semantics in compact incident evidence", async () => {
    const gameDir = await temporaryGame();
    const session = "activity-contract";
    const dir = path.join(gameDir, ".rpg-harness", "sessions", session);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "log.jsonl"), JSON.stringify({
      input: { type: "doActivity", id: "release-private-id" },
      activityDecision: {
        activityId: "release-private-id",
        title: "Release the oni",
        kind: "action",
        category: "combat",
        aiTags: ["nonlethal", "mercy", "memory"],
        actionKind: "raid:release",
        pacingInstanceId: "encounter:oni-1",
        relatedObjectiveIds: ["remember-the-oni"],
        focusedObjectiveId: "remember-the-oni",
        payload: { private: true },
      },
      output: { type: "narration", text: "The oni leaves alive." },
    }) + "\n");

    const report = await recordPlaytestReport({
      gameDir,
      session,
      area: "tooling",
      severity: "minor",
      title: "Headless loses the nonlethal intent",
    });

    expect(report.evidence.lastEvent?.activityDecision).toEqual({
      activityId: "release-private-id",
      title: "Release the oni",
      kind: "action",
      category: "combat",
      aiTags: ["nonlethal", "mercy", "memory"],
      actionKind: "raid:release",
      pacingInstanceId: "encounter:oni-1",
      relatedObjectiveIds: ["remember-the-oni"],
      focusedObjectiveId: "remember-the-oni",
    });
  });

  test("lists reports across sessions and formats a compact human view", async () => {
    const gameDir = await temporaryGame();
    await recordPlaytestReport({
      gameDir,
      session: "one",
      area: "ui",
      severity: "minor",
      title: "Choice text wraps awkwardly",
    });
    await recordPlaytestReport({
      gameDir,
      session: "two",
      area: "gameplay",
      severity: "note",
      title: "Raid pacing feels slow",
    });

    const reports = await listPlaytestReports(gameDir);
    expect(reports).toHaveLength(2);
    const table = formatPlaytestReports(reports);
    expect(table).toContain("SEVERITY");
    expect(table).toContain("STATUS");
    expect(table).toContain("Choice text wraps awkwardly");
    expect(table).toContain("Raid pacing feels slow");
  });

  test("resolves a report by id while preserving its captured evidence", async () => {
    const gameDir = await temporaryGame();
    const open = await recordPlaytestReport({
      gameDir,
      session: "web",
      area: "ui",
      severity: "minor",
      title: "Narrator label leaks",
    });

    const resolved = await resolvePlaytestReport({
      gameDir,
      id: open.id,
      resolution: "Narrator beats now use narration output.",
    });

    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedAt).toBeString();
    expect(resolved.resolution).toBe(
      "Narrator beats now use narration output.",
    );
    expect(resolved.evidence).toEqual(open.evidence);
    expect(await listPlaytestReports(gameDir, "web")).toEqual([resolved]);
  });

  for (const lookup of ["scoped", "global"] as const) {
    test(`waits for a partial concurrent append before ${lookup} resolution lookup`, async () => {
      const gameDir = await temporaryGame();
      const session = "web";
      const open = await recordPlaytestReport({
        gameDir,
        session,
        area: "ui",
        severity: "minor",
        title: "First issue",
      });
      const reportFile = path.join(
        gameDir,
        ".rpg-harness",
        "sessions",
        session,
        "issues.jsonl",
      );
      let writerStarted!: () => void;
      const writerReady = new Promise<void>((resolve) => {
        writerStarted = resolve;
      });
      let releaseWriter!: () => void;
      const writerGate = new Promise<void>((resolve) => {
        releaseWriter = resolve;
      });
      const concurrent = {
        ...open,
        id: `${open.id}-concurrent`,
        createdAt: new Date(Date.now() + 1).toISOString(),
        title: "Concurrent issue",
      };
      const encoded = JSON.stringify(concurrent);
      const split = Math.floor(encoded.length / 2);
      const writer = withSessionLock(gameDir, session, async () => {
        const before = await readFile(reportFile, "utf-8");
        // Deliberately expose invalid JSONL while retaining the owning lock.
        // A resolver that performs its initial parse before locking fails here.
        await writeFile(reportFile, before + encoded.slice(0, split), "utf-8");
        writerStarted();
        await writerGate;
        await writeFile(reportFile, encoded.slice(split) + "\n", {
          flag: "a",
        });
      });
      await writerReady;

      let resolutionSettled = false;
      const resolving = resolvePlaytestReport({
        gameDir,
        id: open.id,
        ...(lookup === "scoped" ? { session } : {}),
        resolution: "Fixed without dropping concurrent work.",
      }).finally(() => {
        resolutionSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(resolutionSettled).toBe(false);

      releaseWriter();
      await Promise.all([writer, resolving]);
      expect(await listPlaytestReports(gameDir, session)).toEqual([
        expect.objectContaining({ id: open.id, status: "resolved" }),
        expect.objectContaining({ id: concurrent.id, status: "open" }),
      ]);
    });
  }

  test("global resolution does not wait for an unrelated locked report session", async () => {
    const gameDir = await temporaryGame();
    await recordPlaytestReport({
      gameDir,
      session: "aaa-unrelated",
      area: "ui",
      severity: "minor",
      title: "Unrelated issue",
    });
    const target = await recordPlaytestReport({
      gameDir,
      session: "zzz-target",
      area: "gameplay",
      severity: "major",
      title: "Target issue",
    });
    let heldStarted!: () => void;
    const heldReady = new Promise<void>((resolve) => {
      heldStarted = resolve;
    });
    let releaseHeld!: () => void;
    const heldGate = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    const held = withSessionLock(gameDir, "aaa-unrelated", async () => {
      heldStarted();
      await heldGate;
    });
    await heldReady;

    const resolving = resolvePlaytestReport({
      gameDir,
      id: target.id,
      resolution: "Found without waiting for unrelated work.",
    });
    const outcome = await Promise.race([
      resolving.then(() => "resolved" as const),
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 100)
      ),
    ]);
    releaseHeld();
    await held;
    await resolving;

    expect(outcome).toBe("resolved");
    expect((await listPlaytestReports(gameDir, "zzz-target"))[0]?.status)
      .toBe("resolved");
  });

  test("does not let manual resolve bypass a structured autoplay verifier", async () => {
    const gameDir = await temporaryGame();
    const session = "structured-autoplay";
    const state = createInitialState({
      title: "Structured report guard",
      characters: [],
      scripts: [],
    } as Game);
    const dir = path.join(gameDir, ".rpg-harness", "sessions", session);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "state.json"), JSON.stringify(state, null, 2));
    const evidenceSnapshot = await capturePlaytestEvidenceSnapshot(gameDir, session);
    const open = await recordPlaytestReport({
      gameDir,
      session,
      area: "tooling",
      severity: "major",
      title: "Autoplay stopped",
      evidenceSnapshot,
      autoplay: {
        replayState: state,
        replayLogEntry: 0,
        persona: "greedy",
        maxSteps: 20,
        seed: 17,
        stopReason: "stalled",
        decisions: 5,
        rejectedInputs: 0,
        steps: 6,
        decisionPathRevision: "a".repeat(64),
      },
    });

    await expect(resolvePlaytestReport({
      gameDir,
      id: open.id,
      resolution: "Trust me, it is fixed.",
    })).rejects.toThrow("requires causal autoplay verification");
    await expect(resolvePlaytestReport({
      gameDir,
      id: open.id,
      session,
      verification: {
        kind: "autoplay",
        verifiedAt: new Date().toISOString(),
        replayCheckpointRevision: open.evidence.autoplay!.replayCheckpoint.revision,
        issueCheckpointRevision: open.evidence.checkpoint!.revision,
        originalStopReason: "stalled",
        persona: "greedy",
        maxSteps: 20,
        seed: 17,
        session: "forged-verification",
        webPath: "/?session=forged-verification",
        result: {
          reason: "completed",
          ending: null,
          decisions: 0,
          rejectedInputs: 0,
          steps: 0,
          decisionPathRevision: "0".repeat(64),
          completedScripts: [],
          objectiveChanges: 0,
        },
      } as unknown as PlaytestAutoplayVerification,
    } as unknown as ResolvePlaytestReportArgs)).rejects.toThrow(
      "does not accept verification evidence",
    );
    const validVerification: PlaytestAutoplayVerification = {
      kind: "autoplay",
      verifiedAt: new Date().toISOString(),
      replayCheckpointRevision: open.evidence.autoplay!.replayCheckpoint.revision,
      issueCheckpointRevision: open.evidence.checkpoint!.revision,
      originalStopReason: "stalled",
      persona: "greedy",
      maxSteps: 20,
      seed: 17,
      session: "verified-run",
      webPath: "/?session=verified-run",
      result: {
        reason: "completed",
        ending: "fixed-ending",
        decisions: 2,
        rejectedInputs: 0,
        steps: 3,
        decisionPathRevision: "b".repeat(64),
        completedScripts: ["fixed-ending"],
        objectiveChanges: 1,
      },
    };
    await resolveVerifiedPlaytestReport({
      gameDir,
      id: open.id,
      session,
      verification: validVerification,
    });
    await expect(resolveVerifiedPlaytestReport({
      gameDir,
      id: open.id,
      session,
      verification: {
        ...validVerification,
        verifiedAt: new Date(Date.now() + 1).toISOString(),
        session: "concurrent-run",
      },
    })).rejects.toThrow("resolved concurrently by another verification");
    expect((await listPlaytestReports(gameDir, session))[0]).toMatchObject({
      status: "resolved",
      verification: validVerification,
    });
  });

  test("supersedes unreplayable structured evidence without claiming a fix", async () => {
    const gameDir = await temporaryGame();
    const session = "missing-persona";
    const state = createInitialState({
      title: "Supersession lifecycle",
      characters: [],
      scripts: [],
    } as Game);
    const dir = path.join(gameDir, ".rpg-harness", "sessions", session);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "state.json"), JSON.stringify(state));
    const evidenceSnapshot = await capturePlaytestEvidenceSnapshot(gameDir, session);
    const open = await recordPlaytestReport({
      gameDir,
      session,
      area: "tooling",
      severity: "major",
      title: "Removed persona cannot be replayed",
      evidenceSnapshot,
      autoplay: {
        replayState: state,
        replayLogEntry: 0,
        persona: "removed-persona",
        maxSteps: 20,
        seed: 19,
        stopReason: "stalled",
        decisions: 5,
        rejectedInputs: 0,
        steps: 6,
        decisionPathRevision: "c".repeat(64),
      },
    });

    await expect(supersedePlaytestReport({
      gameDir,
      id: open.id,
      reason: "   ",
    })).rejects.toThrow("requires a reason");
    const superseded = await supersedePlaytestReport({
      gameDir,
      id: open.id,
      reason: "The authored persona was intentionally removed.",
    });

    expect(superseded).toMatchObject({
      status: "superseded",
      supersededReason: "The authored persona was intentionally removed.",
    });
    expect(superseded.supersededAt).toBeString();
    expect(superseded.resolvedAt).toBeUndefined();
    expect(superseded.verification).toBeUndefined();
    expect(await supersedePlaytestReport({
      gameDir,
      id: open.id,
      reason: "The authored persona was intentionally removed.",
    })).toEqual(superseded);
    await expect(resolvePlaytestReport({
      gameDir,
      id: open.id,
      resolution: "fixed",
    })).rejects.toThrow("already superseded");
  });

  test("snapshots manual resolution authority before waiting for the session lock", async () => {
    const gameDir = await temporaryGame();
    const session = "manual-authority-snapshot";
    const state = createInitialState({
      title: "Manual authority snapshot",
      characters: [],
      scripts: [],
    } as Game);
    const dir = path.join(gameDir, ".rpg-harness", "sessions", session);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "state.json"), JSON.stringify(state, null, 2));
    const evidenceSnapshot = await capturePlaytestEvidenceSnapshot(gameDir, session);
    const open = await recordPlaytestReport({
      gameDir,
      session,
      area: "tooling",
      severity: "major",
      title: "Structured finding",
      evidenceSnapshot,
      autoplay: {
        replayState: state,
        replayLogEntry: 0,
        persona: "greedy",
        maxSteps: 20,
        seed: 17,
        stopReason: "stalled",
        decisions: 5,
        rejectedInputs: 0,
        steps: 6,
        decisionPathRevision: "a".repeat(64),
      },
    });
    let release!: () => void;
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => { locked = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = withSessionLock(gameDir, session, async () => {
      locked();
      await gate;
    });
    await acquired;
    const mutableArgs: ResolvePlaytestReportArgs & {
      verification?: PlaytestAutoplayVerification;
    } = { gameDir, id: open.id, session };
    const resolving = resolvePlaytestReport(mutableArgs);
    mutableArgs.verification = {
      kind: "autoplay",
      verifiedAt: new Date().toISOString(),
      replayCheckpointRevision: open.evidence.autoplay!.replayCheckpoint.revision,
      issueCheckpointRevision: open.evidence.checkpoint!.revision,
      originalStopReason: "stalled",
      persona: "greedy",
      maxSteps: 20,
      seed: 17,
      session: "forged-after-call",
      webPath: "/?session=forged-after-call",
      result: {
        reason: "completed",
        ending: "forged",
        decisions: 0,
        rejectedInputs: 0,
        steps: 1,
        decisionPathRevision: "b".repeat(64),
        completedScripts: [],
        objectiveChanges: 0,
      },
    };
    release();
    await holder;
    await expect(resolving).rejects.toThrow("requires causal autoplay verification");
    expect((await listPlaytestReports(gameDir, session))[0]?.status).toBe("open");
  });

  test("lets an explicitly reviewed legacy autoplay finding be resolved manually", async () => {
    const gameDir = await temporaryGame();
    const session = "legacy-autoplay";
    const open = await recordPlaytestReport({
      gameDir,
      session,
      area: "tooling",
      severity: "major",
      title: "Legacy autoplay stop",
    });
    const file = path.join(
      gameDir,
      ".rpg-harness",
      "sessions",
      session,
      "issues.jsonl",
    );
    const legacy = JSON.parse((await readFile(file, "utf-8")).trim());
    legacy.evidence.autoplay = {
      persona: "greedy",
      maxSteps: 20,
      seed: 17,
      stopReason: "stalled",
      decisions: 5,
      rejectedInputs: 0,
      steps: 6,
    };
    await writeFile(file, JSON.stringify(legacy) + "\n", "utf-8");

    await expect(resolvePlaytestReport({
      gameDir,
      id: open.id,
      session,
    })).rejects.toThrow("needs an explicit review or supersession reason");

    const resolved = await resolvePlaytestReport({
      gameDir,
      id: open.id,
      session,
      resolution: "Reviewed and superseded; this predates causal replay evidence.",
    });

    expect(resolved).toMatchObject({
      status: "resolved",
      resolution: "Reviewed and superseded; this predates causal replay evidence.",
    });
    expect(resolved.verification).toBeUndefined();
  });

  test("does not let manual resolve bypass a structured audit verifier", async () => {
    const gameDir = await temporaryGame();
    const session = "structured-audit";
    const state = createInitialState({
      title: "Structured audit guard",
      characters: [],
      scripts: [],
    } as Game);
    const dir = path.join(gameDir, ".rpg-harness", "sessions", session);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "state.json"), JSON.stringify(state, null, 2));
    const sourceRevision = createHash("sha256")
      .update(JSON.stringify(state))
      .digest("hex");
    const evidenceSnapshot = await capturePlaytestEvidenceSnapshot(gameDir, session);
    const open = await recordPlaytestReport({
      gameDir,
      session,
      area: "gameplay",
      severity: "major",
      title: "Audit paths collapsed",
      evidenceSnapshot,
      auditMatrix: {
        sourceRevision,
        sessionPrefix: "collapsed",
        maxSteps: 20,
        seed: 17,
        policy: { minUniqueDecisionPaths: 2 },
        observed: { uniqueEndings: 1, uniqueDecisionPaths: 1 },
        classification: "identical-path",
        violations: ["unique decision paths 1 < required 2"],
        lanes: [{
          persona: "greedy",
          deterministic: true,
          session: "collapsed-greedy",
          webPath: "/?session=collapsed-greedy",
          ending: "ending",
          reason: "completed",
          pathRevision: "a".repeat(64),
        }],
        choiceDivergences: [],
      },
    });

    await expect(resolvePlaytestReport({
      gameDir,
      id: open.id,
      resolution: "The threshold no longer matters.",
    })).rejects.toThrow("requires audit verification");
    expect((await listPlaytestReports(gameDir, session))[0]?.status).toBe("open");
  });

  test("rejects reports that combine two incompatible structured causes", async () => {
    const gameDir = await temporaryGame();
    const session = "conflicting-structured-evidence";
    const state = createInitialState({
      title: "Conflicting evidence",
      characters: [],
      scripts: [],
    } as Game);
    const dir = path.join(gameDir, ".rpg-harness", "sessions", session);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "state.json"), JSON.stringify(state, null, 2));
    const evidenceSnapshot = await capturePlaytestEvidenceSnapshot(gameDir, session);
    await expect(recordPlaytestReport({
      gameDir,
      session,
      area: "tooling",
      severity: "major",
      title: "Two unrelated causes",
      evidenceSnapshot,
      autoplay: {
        replayState: state,
        replayLogEntry: 0,
        persona: "greedy",
        maxSteps: 10,
        seed: 1,
        stopReason: "stalled",
        decisions: 1,
        rejectedInputs: 0,
        steps: 2,
        decisionPathRevision: "a".repeat(64),
      },
      auditMatrix: {
        sourceRevision: "b".repeat(64),
        sessionPrefix: "conflict",
        maxSteps: 10,
        seed: 1,
        policy: { minUniqueEndings: 2 },
        observed: { uniqueEndings: 1, uniqueDecisionPaths: 1 },
        classification: "identical-path",
        violations: ["unique endings 1 < required 2"],
        lanes: [],
        choiceDivergences: [],
      },
    })).rejects.toThrow("cannot combine multiple structured causes");
    expect(await listPlaytestReports(gameDir, session)).toEqual([]);
  });

  test("fails loudly when resolving an unknown report id", async () => {
    const gameDir = await temporaryGame();
    expect(
      resolvePlaytestReport({ gameDir, id: "pt-missing" }),
    ).rejects.toThrow("not found");
  });
});

async function temporaryGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-playtest-report-"));
  temporaryDirectories.push(dir);
  return dir;
}
