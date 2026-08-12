import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyzeChoiceCoverage, collectAuthoredChoices, collectChoiceCoverage, formatChoiceCoverage } from "./choice-coverage";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true })
  ));
});

const checkpoint = (revision: string) => ({
  schemaVersion: 1 as const,
  file: `checkpoints/${revision}.json`,
  revision,
});

const choice = {
  type: "choice",
  scriptId: "ending",
  choiceId: "final-tether",
  prompt: "Who remains?",
  options: [
    { id: "alone", text: "Alone", available: true },
    { id: "friends", text: "With friends", available: true },
    { id: "secret", text: "Secret", available: false },
  ],
};

describe("choice branch coverage", () => {
  test("separates authored identity debt from runtime branch coverage", () => {
    const game = {
      title: "Inventory",
      characters: [],
      scripts: [{
        id: "story",
        title: "Story",
        source: "/game/scripts/story.md",
        beats: [
          { type: "choice", prompt: "Continue?", options: [{ text: "Continue" }] },
          { type: "choice", prompt: "Legacy?", options: [{ text: "old" }, { text: "other" }] },
          {
            type: "choice",
            id: "stable",
            prompt: "Stable?",
            options: [{ id: "yes", text: "Yes" }, { id: "no", text: "No" }],
          },
        ],
      }],
    } as const;
    const authored = collectAuthoredChoices(game as never, "/game");
    const report = analyzeChoiceCoverage([], [], authored);

    expect(report.authoring.summary).toEqual({
      choices: 2,
      stableChoices: 1,
      legacyChoices: 1,
      options: 4,
      stableOptions: 2,
      observedStableChoices: 0,
      unseenStableChoices: 1,
    });
    expect(report.authoring.workItems).toEqual([
      expect.objectContaining({
        kind: "stabilize-choice",
        key: "story/beat-1",
        source: "scripts/story.md",
      }),
      expect.objectContaining({ kind: "reach-choice", key: "story/stable" }),
    ]);
    expect(formatChoiceCoverage(report, "pending")).toContain("1/2 choices stable");
    expect(formatChoiceCoverage(report, "pending")).toContain("stabilize story/beat-1");
    expect(formatChoiceCoverage(report, "covered")).not.toContain("AUTHORING WORK");
  });

  test("turns an unselected available option into an executable work item", () => {
    const revision = "a".repeat(64);
    const report = analyzeChoiceCoverage([{
      session: "ai-run",
      entries: [
        { input: { type: "next" }, output: choice, checkpoint: checkpoint(revision) },
        { input: { type: "choose", index: 0 }, output: { type: "narration" } },
      ],
    }]);

    expect(report.summary).toEqual({
      choices: 1,
      covered: 0,
      partial: 1,
      uncovered: 0,
      locked: 0,
      options: 3,
      selectedOptions: 1,
      pendingOptions: 1,
      lockedOptions: 1,
      untrackedChoiceEvents: 0,
    });
    expect(report.workItems).toEqual([{
      key: "ending/final-tether/friends",
      scriptId: "ending",
      choiceId: "final-tether",
      optionId: "friends",
      optionText: "With friends",
      evidence: {
        session: "ai-run",
        logEntry: 1,
        checkpoint: checkpoint(revision),
        input: { type: "choose", index: 1 },
        fork: { from: "ai-run", at: 1 },
        webPathTemplate: "/?session=<new-session>",
      },
    }]);
    expect(formatChoiceCoverage(report, "pending")).toContain(
      "fork ai-run@1, then choose 1",
    );
  });

  test("aggregates selections across sessions by stable ids, not option order", () => {
    const one = "b".repeat(64);
    const reordered = {
      ...choice,
      options: [choice.options[1], choice.options[0], choice.options[2]],
    };
    const report = analyzeChoiceCoverage([
      {
        session: "first",
        entries: [
          { input: { type: "next" }, output: choice, checkpoint: checkpoint(one) },
          { input: { type: "choose", index: 0 }, output: { type: "narration" } },
        ],
      },
      {
        session: "second",
        entries: [
          { input: { type: "next" }, output: reordered, checkpoint: checkpoint(one) },
          { input: { type: "choose", index: 0 }, output: { type: "narration" } },
        ],
      },
    ]);

    expect(report.summary.covered).toBe(1);
    expect(report.summary.pendingOptions).toBe(0);
    expect(report.choices[0]?.options).toEqual([
      expect.objectContaining({ id: "friends", status: "selected", selectedSessions: ["second"] }),
      expect.objectContaining({ id: "alone", status: "selected", selectedSessions: ["first"] }),
      expect.objectContaining({ id: "secret", status: "locked" }),
    ]);
  });

  test("counts legacy choices without stable ids but never guesses work items", () => {
    const report = analyzeChoiceCoverage([{
      session: "legacy",
      entries: [{
        input: { type: "next" },
        output: {
          type: "choice",
          options: [
            { text: "old", available: true },
            { text: "other", available: true },
          ],
        },
      }],
    }]);

    expect(report.summary.untrackedChoiceEvents).toBe(1);
    expect(report.choices).toEqual([]);
    expect(report.workItems).toEqual([]);
  });

  test("ignores one-button pacing prompts in runtime and authored branch debt", () => {
    const game = {
      title: "Pacing",
      characters: [],
      scripts: [{
        id: "story",
        title: "Story",
        beats: [{ type: "choice", prompt: "Continue?", options: [{ text: "Continue" }] }],
      }],
    } as const;
    const authored = collectAuthoredChoices(game as never);
    const report = analyzeChoiceCoverage([{
      session: "pacing",
      entries: [{
        input: { type: "next" },
        output: { type: "choice", prompt: "Continue?", options: [{ text: "Continue", available: true }] },
      }],
    }], [], authored);

    expect(authored).toEqual([]);
    expect(report.summary.choices).toBe(0);
    expect(report.summary.untrackedChoiceEvents).toBe(0);
    expect(report.authoring.workItems).toEqual([]);
  });

  test("counts an explicit decision after a checkpoint fork", () => {
    const revision = "c".repeat(64);
    const report = analyzeChoiceCoverage([{
      session: "seed",
      entries: [{ input: { type: "next" }, output: choice, checkpoint: checkpoint(revision) }],
    }, {
      session: "branch",
      entries: [{
        input: { type: "choose", index: 1 },
        decision: { scriptId: "ending", choiceId: "final-tether", optionId: "friends" },
        output: { type: "narration" },
      }],
    }]);

    expect(report.choices[0]?.options).toEqual([
      expect.objectContaining({ id: "alone", status: "pending" }),
      expect.objectContaining({ id: "friends", status: "selected", selectedSessions: ["branch"] }),
      expect.objectContaining({ id: "secret", status: "locked" }),
    ]);
  });

  test("a single branch report follows fork ancestry only to its checkpoint", async () => {
    const gameDir = await mkdtemp(path.join(tmpdir(), "rpgh-choice-lineage-"));
    temporaryDirectories.push(gameDir);
    await writeFile(path.join(gameDir, "game.yaml"), "title: Choice lineage test\n");
    const parentDir = path.join(gameDir, ".rpg-harness", "sessions", "parent");
    const branchDir = path.join(gameDir, ".rpg-harness", "sessions", "branch");
    await mkdir(parentDir, { recursive: true });
    await mkdir(branchDir, { recursive: true });
    await writeFile(path.join(parentDir, "log.jsonl"), [
      JSON.stringify({ input: { type: "next" }, output: choice, checkpoint: checkpoint("d".repeat(64)) }),
      JSON.stringify({ input: { type: "choose", index: 0 }, output: { type: "narration" } }),
    ].join("\n") + "\n");
    await writeFile(path.join(branchDir, "fork.json"), JSON.stringify({
      fromSession: "parent",
      sourceLogEntry: 1,
    }));
    await writeFile(path.join(branchDir, "log.jsonl"), JSON.stringify({
      input: { type: "choose", index: 1 },
      decision: { scriptId: "ending", choiceId: "final-tether", optionId: "friends" },
      output: { type: "narration" },
    }) + "\n");

    const report = await collectChoiceCoverage(gameDir, "branch");
    expect(report.sessions).toEqual(["branch", "parent"]);
    expect(report.choices[0]?.options).toEqual([
      expect.objectContaining({ id: "alone", status: "pending" }),
      expect.objectContaining({ id: "friends", status: "selected", selectedSessions: ["branch"] }),
      expect.objectContaining({ id: "secret", status: "locked" }),
    ]);
  });
});
