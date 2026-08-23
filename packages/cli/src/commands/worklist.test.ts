import { describe, expect, test } from "bun:test";
import type {
  PlaytestAutoplayEvidence,
  PlaytestReport,
} from "../playtest-reports";
import type { ScriptCoverageReport } from "./coverage";
import type { ChoiceCoverageReport } from "./choice-coverage";
import {
  analyzeDevelopmentWorklist,
  formatDevelopmentWorklist,
} from "./worklist";

describe("AI development worklist", () => {
  test("merges, prioritizes, and preserves operations across development signals", () => {
    const report = analyzeDevelopmentWorklist({
      session: "player",
      story: storyReport(),
      choices: choiceReport(),
      reports: [playtestReport("minor"), playtestReport("blocker", "pt-blocker")],
    });

    expect(report.summary).toEqual({
      status: "critical",
      total: 8,
      byPriority: { P0: 2, P1: 1, P2: 4, P3: 1 },
      byKind: {
        "session-error": 1,
        "playtest-report": 2,
        "story-coverage": 2,
        "choice-branch": 1,
        "choice-authoring": 2,
      },
      byActionability: { executable: 5, diagnostic: 2, authoring: 1 },
      openReports: 2,
      sessionErrors: 1,
      storyPending: 2,
      choiceBranches: 1,
      authoringItems: 2,
    });
    expect(report.evidenceSessions).toEqual(["player"]);
    expect(report.items.map((item) => item.key)).toEqual([
      "session-error/broken",
      "report/pt-blocker",
      "story/started",
      "report/pt-minor",
      "choice-branch/ending/coda/friends",
      "story/unseen",
      "choice-authoring/ending/unseen-choice",
      "choice-authoring/ending/coda/ai-intent",
    ]);
    expect(report.items.find((item) => item.kind === "choice-branch"))
      .toMatchObject({ executionCost: "checkpoint" });
    expect(report.items.find((item) => item.key === "story/unseen"))
      .toMatchObject({ executionCost: "search" });
    expect(report.items[0]?.operation).toEqual({
      command: "inspect-session",
      args: { session: "broken", surfaces: ["log", "state"] },
    });
    expect(report.items[0]?.actionability).toBe("diagnostic");
    expect(report.items.find((item) => item.key === "report/pt-blocker"))
      .toMatchObject({ actionability: "executable" });
    expect(report.items.find((item) => item.key === "report/pt-blocker")?.coordinates)
      .toMatchObject({
        sourceTargets: [{
          kind: "module-action",
          file: "modules/raid.ts",
          moduleId: "raid",
          actionKind: "raid:depart",
          activityId: "depart:kuro",
        }],
      });
    expect(report.items.find((item) => item.kind === "choice-branch")?.operation)
      .toEqual({
        command: "cover",
        args: {
          key: "ending/coda/friends",
          session: "<new-session>",
          sourceSession: "player",
        },
      });
    expect(report.items.find((item) => item.kind === "choice-branch")?.target)
      .toBe("scripts/ending.md");
    expect(report.items.find((item) => item.key === "report/pt-minor")?.operation)
      .toEqual({
        command: "inspect-report",
        args: { reportId: "pt-minor", session: "player" },
      });
    expect(report.items.find((item) => item.key.endsWith("unseen-choice"))?.operation)
      .toEqual({
        command: "reach",
        args: {
          key: "ending/unseen-choice",
          fromSession: "player",
          session: "<new-session>",
        },
      });
    expect(report.items.find((item) => item.key === "story/unseen")?.operation)
      .toEqual({
        command: "reach-script",
        args: {
          scriptId: "unseen",
          fromSession: "player",
          session: "<new-session>",
        },
      });
    expect(formatDevelopmentWorklist(report)).toContain(
      "Development worklist: 8 items",
    );
    expect(formatDevelopmentWorklist(report)).toContain(
      "next: work --key 'choice-branch/ending/coda/friends' --session 'player' --new-session <new-session>",
    );
    expect(report.items.find((item) => item.kind === "choice-branch")?.executor)
      .toEqual({
        command: "work",
        args: {
          key: "choice-branch/ending/coda/friends",
          session: "player",
          newSession: "<new-session>",
        },
      });
  });

  test("reports a clean project without inventing work", () => {
    const story = storyReport();
    story.summary.started = 0;
    story.summary.uncovered = 0;
    story.sessionErrors = [];
    story.scripts = [];
    const choices = choiceReport();
    choices.sessionErrors = [];
    choices.workItems = [];
    choices.authoring.workItems = [];

    const report = analyzeDevelopmentWorklist({ story, choices, reports: [] });

    expect(report.summary.status).toBe("clean");
    expect(report.items).toEqual([]);
    expect(report.evidenceSessions).toEqual(["player"]);
    expect(formatDevelopmentWorklist(report)).toContain("no actionable development work");
  });

  test("keeps the default work view bounded when history contains many evidence sessions", () => {
    const story = storyReport();
    story.summary.started = 0;
    story.summary.uncovered = 0;
    story.sessionErrors = [];
    story.scripts = [];
    const choices = choiceReport();
    choices.sessionErrors = [];
    choices.workItems = [];
    choices.authoring.workItems = [];
    const report = analyzeDevelopmentWorklist({ story, choices, reports: [] });
    report.evidenceSessions = Array.from(
      { length: 12 },
      (_, index) => `evidence-${String(index + 1).padStart(2, "0")}`,
    );

    const formatted = formatDevelopmentWorklist(report);

    expect(formatted).toContain(
      "Evidence sessions: evidence-01, evidence-02, evidence-03, evidence-04, evidence-05 · … 7 more",
    );
    expect(formatted).toContain("use --format json for complete provenance");
    expect(formatted).not.toContain("evidence-06");
    // The machine-readable contract remains lossless; only the table view is compact.
    expect(JSON.parse(JSON.stringify(report)).evidenceSessions).toHaveLength(12);
  });

  test("keeps legacy audit findings reproducible when replay parameters are absent", () => {
    const story = storyReport();
    story.summary.started = 0;
    story.summary.uncovered = 0;
    story.sessionErrors = [];
    story.scripts = [];
    const choices = choiceReport();
    choices.sessionErrors = [];
    choices.workItems = [];
    choices.authoring.workItems = [];
    const legacy = playtestReport("major", "pt-blocker");
    legacy.evidence.auditMatrix = {
      sourceRevision: "a".repeat(64),
      sessionPrefix: "old-matrix",
      policy: { minUniqueEndings: 2 },
      observed: { uniqueEndings: 1, uniqueDecisionPaths: 1 },
      classification: "identical-path",
      violations: ["unique endings 1 < required 2"],
      lanes: [{
        persona: "objective",
        session: "old-matrix-objective",
        webPath: "/?session=old-matrix-objective",
        ending: "intro",
        reason: "completed",
        pathRevision: "b".repeat(64),
      }],
      choiceDivergences: [],
    };

    const result = analyzeDevelopmentWorklist({
      story,
      choices,
      reports: [legacy],
    });

    expect(result.items[0]?.operation).toEqual({
      command: "reproduce",
      args: {
        reportId: legacy.id,
        session: legacy.session,
        to: "<new-session>",
      },
    });
  });

  test("does not route legacy autoplay evidence into a verifier that cannot replay it", () => {
    const story = storyReport();
    story.summary.started = 0;
    story.summary.uncovered = 0;
    story.sessionErrors = [];
    story.scripts = [];
    const choices = choiceReport();
    choices.sessionErrors = [];
    choices.workItems = [];
    choices.authoring.workItems = [];
    const legacy = playtestReport("major", "pt-blocker");
    legacy.evidence.autoplay = {
      persona: "greedy",
      maxSteps: 20,
      seed: 17,
      stopReason: "stalled",
      decisions: 5,
      rejectedInputs: 0,
      steps: 6,
    } as unknown as PlaytestAutoplayEvidence;

    const result = analyzeDevelopmentWorklist({
      story,
      choices,
      reports: [legacy],
    });

    expect(result.items[0]?.operation).toEqual({
      command: "reproduce",
      args: {
        reportId: legacy.id,
        session: legacy.session,
        to: "<new-session>",
      },
    });
  });

  test("treats complete autoplay parameters without an issue checkpoint as diagnostic", () => {
    const story = storyReport();
    story.summary.started = 0;
    story.summary.uncovered = 0;
    story.sessionErrors = [];
    story.scripts = [];
    const choices = choiceReport();
    choices.sessionErrors = [];
    choices.workItems = [];
    choices.authoring.workItems = [];
    const report = playtestReport("major", "pt-no-incident");
    report.evidence.autoplay = {
      replayCheckpoint: {
        schemaVersion: 1,
        file: `issue-checkpoints/${"a".repeat(64)}.json`,
        revision: "a".repeat(64),
      },
      replayLogEntry: 0,
      persona: "greedy",
      maxSteps: 20,
      seed: 17,
      stopReason: "stalled",
      decisions: 5,
      rejectedInputs: 0,
      steps: 6,
      decisionPathRevision: "c".repeat(64),
    };

    const result = analyzeDevelopmentWorklist({ story, choices, reports: [report] });

    expect(result.items[0]).toMatchObject({
      actionability: "diagnostic",
      operation: {
        command: "inspect-report",
        args: { reportId: report.id, session: report.session },
      },
    });
  });

  test("prefers an exact reach operation over a duplicate uncovered-script hint", () => {
    const story = storyReport();
    story.scripts[1] = {
      id: "ending",
      title: "Ending",
      status: "uncovered",
      completedSessions: [],
      staleSessions: [],
      legacySessions: [],
      startedSessions: [],
    };
    const choices = choiceReport();
    choices.workItems = [];
    choices.authoring.workItems = choices.authoring.workItems.filter(
      (item) => item.kind === "reach-choice",
    );

    const report = analyzeDevelopmentWorklist({
      story,
      choices,
      reports: [],
      session: "player",
    });

    expect(report.summary.storyPending).toBe(2);
    expect(report.items.some((item) => item.key === "story/ending")).toBe(false);
    expect(report.items).toContainEqual(expect.objectContaining({
      key: "choice-authoring/ending/unseen-choice",
      actionability: "executable",
      operation: expect.objectContaining({ command: "reach" }),
    }));
  });

  test("executes a branch from the session that owns its checkpoint evidence", () => {
    const choices = choiceReport();
    choices.workItems[0]!.evidence.session = "ai-descendant";
    choices.workItems[0]!.evidence.fork.from = "ai-descendant";
    const report = analyzeDevelopmentWorklist({
      story: storyReport(),
      choices,
      reports: [],
      session: "player",
    });

    expect(report.items.find((item) => item.kind === "choice-branch")?.operation)
      .toEqual({
        command: "cover",
        args: {
          key: "ending/coda/friends",
          session: "<new-session>",
          sourceSession: "ai-descendant",
        },
      });
  });

  test("delegates pending script completion to one exact choice branch", () => {
    const story = storyReport();
    story.summary = {
      ...story.summary,
      started: 0,
      uncovered: 0,
      stale: 1,
    };
    story.sessionErrors = [];
    story.scripts = [{
      id: "ending",
      title: "Edited ending",
      source: "scripts/ending.md",
      status: "stale",
      completedSessions: [],
      staleSessions: ["old-proof"],
      legacySessions: ["old-proof"],
      startedSessions: [],
    }];
    const choices = choiceReport();
    choices.sessionErrors = [];
    choices.authoring.workItems = [];

    const report = analyzeDevelopmentWorklist({
      story,
      choices,
      reports: [],
      session: "player",
    });

    expect(report.summary.storyPending).toBe(1);
    expect(report.summary.byKind["story-coverage"]).toBe(0);
    expect(report.items.some((item) => item.key === "story/ending")).toBe(false);
    expect(report.items[0]).toMatchObject({
      key: "choice-branch/ending/coda/friends",
      priority: "P1",
      title: "Exercise choice branch and finish edited script: Friends",
      operation: { command: "cover" },
      coordinates: {
        alsoResolves: {
          kind: "story-coverage",
          scriptId: "ending",
          status: "stale",
        },
      },
    });
  });

  test("re-verifies stale scripts from a session that owns old completion evidence", () => {
    const story = storyReport();
    story.summary.started = 0;
    story.summary.uncovered = 0;
    story.summary.stale = 1;
    story.scripts = [{
      id: "edited",
      title: "Edited",
      status: "stale",
      completedSessions: [],
      staleSessions: ["ai-old-proof"],
      legacySessions: ["ai-old-proof"],
      startedSessions: [],
    }];
    story.sessionErrors = [];

    const report = analyzeDevelopmentWorklist({
      session: "player",
      story,
      choices: { ...choiceReport(), sessionErrors: [], workItems: [], authoring: {
        ...choiceReport().authoring,
        workItems: [],
      } },
      reports: [],
    });

    expect(report.items[0]).toMatchObject({
      key: "story/edited",
      title: "Re-verify edited script: Edited",
      operation: {
        command: "reach-script",
        args: { scriptId: "edited", fromSession: "ai-old-proof" },
      },
    });
  });

  test("reaches unseen choices from a session with current script evidence", () => {
    const story = storyReport();
    story.summary = {
      total: 1,
      tracked: 1,
      completed: 1,
      stale: 0,
      started: 0,
      uncovered: 0,
      ignored: 0,
      legacyCompletions: 0,
      completionPercent: 100,
    };
    story.sessionErrors = [];
    story.scripts = [{
      id: "ending",
      title: "Ending",
      status: "completed",
      completedSessions: ["ai-current-proof"],
      staleSessions: [],
      legacySessions: [],
      startedSessions: [],
    }];
    const choices = choiceReport();
    choices.sessionErrors = [];
    choices.workItems = [];
    choices.authoring.workItems = choices.authoring.workItems.filter(
      (item) => item.kind === "reach-choice",
    );

    const report = analyzeDevelopmentWorklist({
      session: "player",
      story,
      choices,
      reports: [],
    });

    expect(report.items[0]?.operation).toEqual({
      command: "reach",
      args: {
        key: "ending/unseen-choice",
        fromSession: "ai-current-proof",
        session: "<new-session>",
      },
    });
  });

  test("continues exact frontier branches without mixing work targets", () => {
    const report = analyzeDevelopmentWorklist({
      session: "player",
      story: storyReport(),
      choices: choiceReport(),
      reports: [],
      continuationSources: new Map([
        ["story/unseen", {
          session: "ai-story-closest",
          logEntry: 17,
          checkpointRevision: "a".repeat(64),
        }],
        ["choice-authoring/ending/unseen-choice", {
          session: "ai-choice-closest",
          logEntry: 23,
          checkpointRevision: "b".repeat(64),
        }],
        ["story/not-this-item", {
          session: "ai-wrong-target",
          logEntry: 99,
          checkpointRevision: "c".repeat(64),
        }],
      ]),
    });

    expect(report.items.find((item) => item.key === "story/unseen")?.operation)
      .toEqual({
        command: "reach-script",
        args: {
          scriptId: "unseen",
          fromSession: "ai-story-closest",
          fromLogEntry: 17,
          searchCheckpointRevision: "a".repeat(64),
          session: "<new-session>",
        },
      });
    expect(report.items.find((item) =>
      item.key === "choice-authoring/ending/unseen-choice"
    )?.operation).toEqual({
      command: "reach",
      args: {
        key: "ending/unseen-choice",
        fromSession: "ai-choice-closest",
        fromLogEntry: 23,
        searchCheckpointRevision: "b".repeat(64),
        session: "<new-session>",
      },
    });
  });
});

function playtestReport(
  severity: PlaytestReport["severity"],
  id = `pt-${severity}`,
): PlaytestReport {
  const checkpoint = id === "pt-blocker"
    ? {
        schemaVersion: 1 as const,
        file: `issue-checkpoints/${"b".repeat(64)}.json`,
        revision: "b".repeat(64),
      }
    : undefined;
  return {
    schemaVersion: 1,
    id,
    createdAt: "2026-08-13T00:00:00.000Z",
    status: "open",
    session: "player",
    area: "engine",
    severity,
    title: `${severity} finding`,
    target: "scripts/ending.md",
    evidence: {
      statePath: "state.json",
      logPath: "log.jsonl",
      logEntry: 7,
      currentScriptId: "ending",
      lastCompletedScriptId: null,
      lastEvent: null,
      ...(checkpoint ? { checkpoint } : {}),
      sourceTargets: [{
        kind: "module-action",
        file: "modules/raid.ts",
        moduleId: "raid",
        actionKind: "raid:depart",
        activityId: "depart:kuro",
      }],
    },
  };
}

function storyReport(): ScriptCoverageReport {
  return {
    summary: {
      total: 2,
      tracked: 2,
      completed: 0,
      stale: 0,
      started: 1,
      uncovered: 1,
      ignored: 0,
      legacyCompletions: 0,
      completionPercent: 0,
    },
    sessions: ["player"],
    sessionErrors: [{ session: "broken", error: "bad state" }],
    scripts: [
      {
        id: "started",
        title: "Started",
        source: "scripts/started.md",
        status: "started",
        completedSessions: [],
        staleSessions: [],
        legacySessions: [],
        startedSessions: ["player"],
      },
      {
        id: "unseen",
        title: "Unseen",
        source: "scripts/unseen.md",
        status: "uncovered",
        completedSessions: [],
        staleSessions: [],
        legacySessions: [],
        startedSessions: [],
      },
    ],
  };
}

function choiceReport(): ChoiceCoverageReport {
  const checkpoint = {
    schemaVersion: 1 as const,
    file: `checkpoints/${"a".repeat(64)}.json`,
    revision: "a".repeat(64),
  };
  return {
    summary: {
      choices: 1,
      covered: 0,
      partial: 1,
      uncovered: 0,
      locked: 0,
      options: 2,
      selectedOptions: 1,
      pendingOptions: 1,
      lockedOptions: 0,
      untrackedChoiceEvents: 0,
      staleChoiceEvents: 0,
      unversionedChoiceEvents: 0,
    },
    sessions: ["player"],
    sessionErrors: [{ session: "broken", error: "bad log" }],
    choices: [],
    workItems: [{
      key: "ending/coda/friends",
      scriptId: "ending",
      source: "scripts/ending.md",
      choiceId: "coda",
      prompt: "What comes next?",
      optionId: "friends",
      optionText: "Friends",
      evidence: {
        session: "player",
        logEntry: 4,
        checkpoint,
        input: { type: "choose", choiceId: "coda", optionId: "friends" },
        fork: { from: "player", at: 4 },
        webPathTemplate: "/?session=<new-session>",
      },
    }],
    authoring: {
      summary: {
        choices: 2,
        stableChoices: 2,
        legacyChoices: 0,
        options: 4,
        stableOptions: 4,
        observedStableChoices: 1,
        unseenStableChoices: 1,
        convergedResponses: 0,
        intentCompleteChoices: 0,
        intentPartialChoices: 1,
        intentMissingChoices: 1,
        taggedOptions: 1,
        untaggedOptions: 3,
      },
      choices: [],
      workItems: [
        {
          kind: "reach-choice",
          key: "ending/unseen-choice",
          scriptId: "ending",
          choiceId: "unseen-choice",
          source: "scripts/ending.md",
          beatIndex: 3,
          prompt: "Unseen?",
          action: "reach this authored choice in a recoverable session",
        },
        {
          kind: "annotate-choice-intent",
          key: "ending/coda/ai-intent",
          scriptId: "ending",
          choiceId: "coda",
          source: "scripts/ending.md",
          beatIndex: 7,
          prompt: "Who remains?",
          missingOptionIds: ["friends"],
          action: "add at least one aiTag to every stable option; use neutral explicitly when intended",
        },
      ],
    },
  };
}
