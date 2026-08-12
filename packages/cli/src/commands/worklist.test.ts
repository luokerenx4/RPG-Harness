import { describe, expect, test } from "bun:test";
import type { PlaytestReport } from "../playtest-reports";
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
      byActionability: { executable: 3, diagnostic: 4, authoring: 1 },
      openReports: 2,
      sessionErrors: 1,
      storyPending: 2,
      choiceBranches: 1,
      authoringItems: 2,
    });
    expect(report.items.map((item) => item.key)).toEqual([
      "session-error/broken",
      "report/pt-blocker",
      "story/started",
      "report/pt-minor",
      "story/unseen",
      "choice-branch/ending/coda/friends",
      "choice-authoring/ending/unseen-choice",
      "choice-authoring/ending/coda/ai-intent",
    ]);
    expect(report.items[0]?.operation).toEqual({
      command: "inspect-session",
      args: { session: "broken", surfaces: ["log", "state"] },
    });
    expect(report.items[0]?.actionability).toBe("diagnostic");
    expect(report.items.find((item) => item.key === "report/pt-blocker"))
      .toMatchObject({ actionability: "executable" });
    expect(report.items.find((item) => item.kind === "choice-branch")?.operation)
      .toEqual({
        command: "cover",
        args: {
          key: "ending/coda/friends",
          session: "<new-session>",
          sourceSession: "player",
        },
      });
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
    expect(formatDevelopmentWorklist(report)).toContain(
      "Development worklist: 8 items",
    );
    expect(formatDevelopmentWorklist(report)).toContain("next: cover");
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
    expect(formatDevelopmentWorklist(report)).toContain("no actionable development work");
  });

  test("prefers an exact reach operation over a duplicate uncovered-script hint", () => {
    const story = storyReport();
    story.scripts[1] = {
      id: "ending",
      title: "Ending",
      status: "uncovered",
      completedSessions: [],
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
    },
  };
}

function storyReport(): ScriptCoverageReport {
  return {
    summary: {
      total: 2,
      tracked: 2,
      completed: 0,
      started: 1,
      uncovered: 1,
      ignored: 0,
      completionPercent: 0,
    },
    sessions: ["player"],
    sessionErrors: [{ session: "broken", error: "bad state" }],
    scripts: [
      {
        id: "started",
        title: "Started",
        status: "started",
        completedSessions: [],
        startedSessions: ["player"],
      },
      {
        id: "unseen",
        title: "Unseen",
        status: "uncovered",
        completedSessions: [],
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
    },
    sessions: ["player"],
    sessionErrors: [{ session: "broken", error: "bad log" }],
    choices: [],
    workItems: [{
      key: "ending/coda/friends",
      scriptId: "ending",
      choiceId: "coda",
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
