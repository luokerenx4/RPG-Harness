import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scriptRevision } from "@rpg-harness/engine";
import { withSessionLock } from "@rpg-harness/session-store";
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
  test("incrementally indexes appended global logs without losing response traces", async () => {
    const gameDir = await temporaryChoiceGame("incremental");
    const sessionDir = path.join(gameDir, ".rpg-harness", "sessions", "web");
    await mkdir(sessionDir, { recursive: true });
    const logFile = path.join(sessionDir, "log.jsonl");
    await writeFile(logFile, [
      JSON.stringify({ output: choice, checkpoint: checkpoint("1".repeat(64)) }),
      JSON.stringify({
        input: { type: "choose", index: 0 },
        decision: {
          scriptId: "ending",
          choiceId: "final-tether",
          optionId: "alone",
        },
        output: { type: "narration", text: "The first response." },
      }),
    ].join("\n") + "\n");

    const first = await collectChoiceCoverage(gameDir);
    expect(first.choices[0]?.options).toEqual([
      expect.objectContaining({ id: "alone", status: "selected" }),
      expect.objectContaining({ id: "friends", status: "pending" }),
      expect.objectContaining({ id: "secret", status: "locked" }),
    ]);

    await appendFile(logFile, [
      JSON.stringify({ output: { type: "dialogue", speakerId: "friend", text: "Still answering." } }),
      JSON.stringify({
        decision: {
          scriptId: "ending",
          choiceId: "final-tether",
          optionId: "friends",
        },
        output: { type: "narration", text: "A different response." },
      }),
    ].join("\n") + "\n");
    const second = await collectChoiceCoverage(gameDir);

    expect(second.summary.selectedOptions).toBe(2);
    expect(second.summary.pendingOptions).toBe(0);
    expect(second.authoring.summary.convergedResponses).toBe(0);
    expect(second.choices[0]?.options).toEqual([
      expect.objectContaining({ id: "alone", status: "selected", selectedSessions: ["web"] }),
      expect.objectContaining({ id: "friends", status: "selected", selectedSessions: ["web"] }),
      expect.objectContaining({ id: "secret", status: "locked" }),
    ]);
  });

  test("waits for a transactionally appended partial JSONL tail", async () => {
    const gameDir = await temporaryChoiceGame("partial-tail");
    const sessionDir = path.join(gameDir, ".rpg-harness", "sessions", "web");
    await mkdir(sessionDir, { recursive: true });
    const logFile = path.join(sessionDir, "log.jsonl");
    let partialWritten!: () => void;
    const partialWrittenGate = new Promise<void>((resolve) => {
      partialWritten = resolve;
    });
    let finishAppend!: () => void;
    const finishAppendGate = new Promise<void>((resolve) => {
      finishAppend = resolve;
    });
    const writer = withSessionLock(gameDir, "web", async () => {
      const serialized = JSON.stringify({
        output: choice,
        checkpoint: checkpoint("8".repeat(64)),
      }) + "\n";
      const split = Math.floor(serialized.length / 2);
      await writeFile(logFile, serialized.slice(0, split));
      partialWritten();
      await finishAppendGate;
      await appendFile(logFile, serialized.slice(split));
    });
    await partialWrittenGate;

    const coverage = collectChoiceCoverage(gameDir);
    await new Promise((resolve) => setTimeout(resolve, 10));
    finishAppend();
    const report = await coverage;
    await writer;

    expect(report.sessionErrors).toEqual([]);
    expect(report.summary.choices).toBe(1);
    expect(report.workItems).toHaveLength(2);
  });

  test("rebuilds one cached session after its log is truncated in place", async () => {
    const gameDir = await temporaryChoiceGame("truncate");
    const sessionDir = path.join(gameDir, ".rpg-harness", "sessions", "web");
    await mkdir(sessionDir, { recursive: true });
    const logFile = path.join(sessionDir, "log.jsonl");
    await writeFile(logFile, JSON.stringify({
      output: choice,
      checkpoint: checkpoint("2".repeat(64)),
    }) + "\n");
    expect((await collectChoiceCoverage(gameDir)).summary.choices).toBe(1);

    await writeFile(logFile, "");
    const rebuilt = await collectChoiceCoverage(gameDir);

    expect(rebuilt.summary.choices).toBe(0);
    expect(rebuilt.sessions).toEqual(["web"]);
  });

  test("links a lexically earlier fork decision to its later parent observation", async () => {
    const gameDir = await temporaryChoiceGame("fork-order");
    const sessionsRoot = path.join(gameDir, ".rpg-harness", "sessions");
    await mkdir(path.join(sessionsRoot, "a-child"), { recursive: true });
    await mkdir(path.join(sessionsRoot, "z-parent"), { recursive: true });
    await writeFile(path.join(sessionsRoot, "a-child", "log.jsonl"), JSON.stringify({
      decision: {
        scriptId: "ending",
        choiceId: "final-tether",
        optionId: "friends",
      },
      output: { type: "narration", text: "Together." },
    }) + "\n");
    await writeFile(path.join(sessionsRoot, "z-parent", "log.jsonl"), JSON.stringify({
      output: choice,
      checkpoint: checkpoint("4".repeat(64)),
    }) + "\n");

    const report = await collectChoiceCoverage(gameDir);

    expect(report.choices[0]?.options).toContainEqual(expect.objectContaining({
      id: "friends",
      status: "selected",
      selectedSessions: ["a-child"],
    }));
  });

  test("self-heals a malformed derived choice-log index", async () => {
    const gameDir = await temporaryChoiceGame("cache-recovery");
    const sessionDir = path.join(gameDir, ".rpg-harness", "sessions", "web");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(path.join(sessionDir, "log.jsonl"), JSON.stringify({
      output: choice,
      checkpoint: checkpoint("3".repeat(64)),
    }) + "\n");
    await collectChoiceCoverage(gameDir);
    const indexFile = path.join(
      gameDir,
      ".rpg-harness",
      "cache",
      "choice-coverage-log-index-v1.json",
    );
    await writeFile(indexFile, "{broken");

    const recovered = await collectChoiceCoverage(gameDir);

    expect(recovered.summary.choices).toBe(1);
    expect(JSON.parse(await readFile(indexFile, "utf-8"))).toMatchObject({
      schemaVersion: 1,
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      sessions: { web: { summary: { entryCount: 1 } } },
    });
  });

  test("rejects a syntactically valid cache whose derived content was edited", async () => {
    const gameDir = await temporaryChoiceGame("cache-integrity");
    const sessionDir = path.join(gameDir, ".rpg-harness", "sessions", "web");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(path.join(sessionDir, "log.jsonl"), JSON.stringify({
      output: choice,
      checkpoint: checkpoint("5".repeat(64)),
    }) + "\n");
    await collectChoiceCoverage(gameDir);
    const indexFile = path.join(
      gameDir,
      ".rpg-harness",
      "cache",
      "choice-coverage-log-index-v1.json",
    );
    const edited = JSON.parse(await readFile(indexFile, "utf-8"));
    edited.sessions.web.summary.observations = [];
    await writeFile(indexFile, JSON.stringify(edited));

    const recovered = await collectChoiceCoverage(gameDir);

    expect(recovered.summary.choices).toBe(1);
  });

  test("rejects a hash-valid cache with an invalid derived schema", async () => {
    const gameDir = await temporaryChoiceGame("cache-schema");
    const sessionDir = path.join(gameDir, ".rpg-harness", "sessions", "web");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(path.join(sessionDir, "log.jsonl"), JSON.stringify({
      output: choice,
      checkpoint: checkpoint("7".repeat(64)),
    }) + "\n");
    await collectChoiceCoverage(gameDir);
    const indexFile = path.join(
      gameDir,
      ".rpg-harness",
      "cache",
      "choice-coverage-log-index-v1.json",
    );
    const edited = JSON.parse(await readFile(indexFile, "utf-8"));
    edited.sessions.web.summary.entryCount = "not-a-count";
    const { createHash } = await import("node:crypto");
    edited.contentHash = createHash("sha256")
      .update(JSON.stringify(edited.sessions))
      .digest("hex");
    await writeFile(indexFile, JSON.stringify(edited));

    const recovered = await collectChoiceCoverage(gameDir);

    expect(recovered.summary.choices).toBe(1);
  });

  test("keeps coverage readable when the derived cache cannot be published", async () => {
    const gameDir = await temporaryChoiceGame("cache-read-only");
    const sessionDir = path.join(gameDir, ".rpg-harness", "sessions", "web");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(path.join(sessionDir, "log.jsonl"), JSON.stringify({
      output: choice,
      checkpoint: checkpoint("6".repeat(64)),
    }) + "\n");
    // A file where the cache directory belongs makes mkdir fail deterministically,
    // including in privileged test environments where chmod is not authoritative.
    await writeFile(path.join(gameDir, ".rpg-harness", "cache"), "read-only boundary");

    const report = await collectChoiceCoverage(gameDir);

    expect(report.summary.choices).toBe(1);
    expect(report.choices[0]?.options).toContainEqual(expect.objectContaining({
      id: "friends",
      status: "pending",
    }));
  });

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
            options: [
              { id: "yes", text: "Yes", aiTags: ["affirmative"] },
              { id: "no", text: "No" },
            ],
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
      convergedResponses: 0,
      intentCompleteChoices: 0,
      intentPartialChoices: 1,
      intentMissingChoices: 0,
      taggedOptions: 1,
      untaggedOptions: 1,
    });
    expect(report.authoring.workItems).toEqual([
      expect.objectContaining({
        kind: "stabilize-choice",
        key: "story/beat-1",
        source: "scripts/story.md",
      }),
      expect.objectContaining({ kind: "reach-choice", key: "story/stable" }),
      expect.objectContaining({
        kind: "annotate-choice-intent",
        key: "story/stable/ai-intent",
        missingOptionIds: ["no"],
      }),
    ]);
    expect(formatChoiceCoverage(report, "pending")).toContain("1/2 choices stable");
    expect(formatChoiceCoverage(report, "pending")).toContain("0/1 stable choices complete");
    expect(formatChoiceCoverage(report, "pending")).toContain("annotate intent story/stable");
    expect(formatChoiceCoverage(report, "pending")).toContain("stabilize story/beat-1");
    expect(formatChoiceCoverage(report, "covered")).not.toContain("AUTHORING WORK");
  });

  test("treats explicit neutral intent as complete and empty tags as missing", () => {
    const game = {
      title: "Intent inventory",
      characters: [],
      scripts: [{
        id: "story",
        title: "Story",
        beats: [{
          type: "choice",
          id: "tone",
          prompt: "Tone?",
          options: [
            { id: "plain", text: "Plain", aiTags: ["neutral"] },
            { id: "silent", text: "Silent", aiTags: [] },
          ],
        }],
      }],
    } as const;
    const report = analyzeChoiceCoverage([], [], collectAuthoredChoices(game as never));

    expect(report.authoring.summary).toMatchObject({
      intentCompleteChoices: 0,
      intentPartialChoices: 1,
      intentMissingChoices: 0,
      taggedOptions: 1,
      untaggedOptions: 1,
    });
    expect(report.authoring.workItems).toContainEqual(expect.objectContaining({
      kind: "annotate-choice-intent",
      missingOptionIds: ["silent"],
    }));
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
      staleChoiceEvents: 0,
      unversionedChoiceEvents: 1,
    });
    expect(report.workItems).toEqual([{
      key: "ending/final-tether/friends",
      scriptId: "ending",
      choiceId: "final-tether",
      prompt: "Who remains?",
      optionId: "friends",
      optionText: "With friends",
      evidence: {
        session: "ai-run",
        logEntry: 1,
        checkpoint: checkpoint(revision),
        input: {
          type: "choose",
          choiceId: "final-tether",
          optionId: "friends",
        },
        fork: { from: "ai-run", at: 1 },
        webPathTemplate: "/?session=<new-session>",
      },
    }]);
    expect(formatChoiceCoverage(report, "pending")).toContain(
      "fork ai-run@1, then choose final-tether/friends",
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

  test("ignores old branch evidence after a current authored revision is observed", () => {
    const game = {
      title: "Fresh choices",
      characters: [],
      scripts: [{
        id: "ending",
        title: "Ending",
        beats: [{
          type: "choice",
          id: "final-tether",
          prompt: "Who remains now?",
          options: [
            { id: "alone", text: "Alone", aiTags: ["independent"] },
            { id: "friends", text: "With friends", aiTags: ["social"] },
          ],
        }],
      }],
    } as const;
    const currentRevision = scriptRevision(game.scripts[0] as never);
    const current = {
      ...choice,
      scriptRevision: currentRevision,
      prompt: "Who remains now?",
      options: choice.options.slice(0, 2),
    };
    const report = analyzeChoiceCoverage([{
      session: "old",
      entries: [{
        input: { type: "next" },
        output: { ...choice, scriptRevision: "old-revision" },
        checkpoint: checkpoint("d".repeat(64)),
      }],
    }, {
      session: "current",
      entries: [{
        input: { type: "next" },
        output: current,
        checkpoint: checkpoint("e".repeat(64)),
      }, {
        input: { type: "choose", index: 0 },
        decision: {
          scriptId: "ending",
          scriptRevision: currentRevision,
          choiceId: "final-tether",
          optionId: "alone",
        },
        output: { type: "narration", text: "Current response" },
      }],
    }], [], collectAuthoredChoices(game as never));

    expect(report.summary.staleChoiceEvents).toBe(1);
    expect(report.choices[0]?.options).toEqual([
      expect.objectContaining({ id: "alone", status: "selected" }),
      expect.objectContaining({ id: "friends", status: "pending" }),
    ]);
  });

  test("unversioned stable choices are stale and unseen against authored inventory", () => {
    const authored = [{
      key: "ending/final-tether",
      scriptId: "ending",
      scriptRevision: "current",
      scriptTitle: "Ending",
      beatIndex: 0,
      prompt: "Who remains?",
      choiceId: "final-tether",
      optionCount: 3,
      optionIds: ["alone", "friends", "secret"],
      optionIntents: [],
      intentStatus: "missing" as const,
      status: "unseen" as const,
    }];
    const report = analyzeChoiceCoverage([{
      session: "legacy",
      entries: [{ input: { type: "next" }, output: choice }],
    }], [], authored);

    expect(report.summary).toMatchObject({
      choices: 1,
      pendingOptions: 0,
      staleChoiceEvents: 1,
      unversionedChoiceEvents: 1,
    });
    expect(report.authoring.choices[0]?.status).toBe("unseen");
    expect(report.authoring.workItems).toContainEqual(expect.objectContaining({
      kind: "reach-choice",
      key: "ending/final-tether",
    }));
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

  test("turns identical covered branch responses into an author review item", () => {
    const authored = [{
      key: "ending/final-tether",
      scriptId: "ending",
      scriptTitle: "Ending",
      source: "scripts/ending.md",
      beatIndex: 4,
      prompt: "Who remains?",
      choiceId: "final-tether",
      optionCount: 2,
      optionIds: ["alone", "friends"],
      optionIntents: [
        { optionId: "alone", text: "Alone", aiTags: ["independent"] },
        { optionId: "friends", text: "With friends", aiTags: ["social"] },
      ],
      intentStatus: "complete" as const,
      status: "unseen" as const,
    }];
    const report = analyzeChoiceCoverage([{
      session: "seed",
      entries: [{ input: { type: "next" }, output: choice, checkpoint: checkpoint("e".repeat(64)) }],
    }, {
      session: "alone",
      entries: [{
        input: { type: "choose", index: 0 },
        decision: { scriptId: "ending", choiceId: "final-tether", optionId: "alone" },
        output: { type: "dialogue", speakerId: "mio", text: "I understand." },
      }],
    }, {
      session: "friends",
      entries: [{
        input: { type: "choose", index: 1 },
        decision: { scriptId: "ending", choiceId: "final-tether", optionId: "friends" },
        output: { type: "dialogue", speakerId: "mio", text: "I understand." },
      }],
    }], [], authored);

    expect(report.authoring.summary.convergedResponses).toBe(1);
    expect(report.authoring.workItems).toContainEqual({
      kind: "review-converged-response",
      key: "ending/final-tether/shared-response/alone+friends",
      scriptId: "ending",
      choiceId: "final-tether",
      source: "scripts/ending.md",
      beatIndex: 4,
      prompt: "Who remains?",
      optionIds: ["alone", "friends"],
      responseTrace: [{ type: "dialogue", speakerId: "mio", text: "I understand." }],
      action: "review whether distinct options should share the same narrative response trace",
    });
    expect(formatChoiceCoverage(report, "pending")).toContain("review shared response");
  });

  test("flags a converged subset when another option has a distinct response", () => {
    const threeWayChoice = {
      ...choice,
      options: [
        ...choice.options,
        { id: "wait", text: "Wait", available: true },
      ],
    };
    const authored = [{
      key: "ending/final-tether",
      scriptId: "ending",
      scriptTitle: "Ending",
      source: "scripts/ending.md",
      beatIndex: 4,
      prompt: "Who remains?",
      choiceId: "final-tether",
      optionCount: 3,
      optionIds: ["alone", "friends", "wait"],
      optionIntents: [
        { optionId: "alone", text: "Alone", aiTags: ["independent"] },
        { optionId: "friends", text: "With friends", aiTags: ["social"] },
        { optionId: "wait", text: "Wait", aiTags: ["restrained"] },
      ],
      intentStatus: "complete" as const,
      status: "unseen" as const,
    }];
    const report = analyzeChoiceCoverage([{
      session: "seed",
      entries: [{ input: { type: "next" }, output: threeWayChoice, checkpoint: checkpoint("3".repeat(64)) }],
    }, ...[
      ["alone", 0, "Shared response"],
      ["friends", 1, "Shared response"],
      ["wait", 2, "Distinct response"],
    ].map(([optionId, index, text]) => ({
      session: String(optionId),
      entries: [{
        input: { type: "choose", index: Number(index) },
        decision: { scriptId: "ending", choiceId: "final-tether", optionId: String(optionId) },
        output: { type: "narration", text: String(text) },
      }],
    }))], [], authored);

    expect(report.authoring.summary.convergedResponses).toBe(1);
    expect(report.authoring.workItems).toContainEqual(expect.objectContaining({
      kind: "review-converged-response",
      key: "ending/final-tether/shared-response/alone+friends",
      optionIds: ["alone", "friends"],
      responseTrace: [{ type: "narration", text: "Shared response" }],
    }));
  });

  test("does not flag a choice whose covered options receive distinct responses", () => {
    const report = analyzeChoiceCoverage([{
      session: "seed",
      entries: [{ input: { type: "next" }, output: choice, checkpoint: checkpoint("f".repeat(64)) }],
    }, {
      session: "alone",
      entries: [{
        input: { type: "choose", index: 0 },
        decision: { scriptId: "ending", choiceId: "final-tether", optionId: "alone" },
        output: { type: "narration", text: "You walk alone." },
      }],
    }, {
      session: "friends",
      entries: [{
        input: { type: "choose", index: 1 },
        decision: { scriptId: "ending", choiceId: "final-tether", optionId: "friends" },
        output: { type: "narration", text: "They walk with you." },
      }],
    }]);

    expect(report.authoring.summary.convergedResponses).toBe(0);
    expect(report.authoring.workItems).toEqual([]);
  });

  test("does not flag branches that share staging but diverge one beat later", () => {
    const report = analyzeChoiceCoverage([{
      session: "seed",
      entries: [{ input: { type: "next" }, output: choice, checkpoint: checkpoint("1".repeat(64)) }],
    }, {
      session: "alone",
      entries: [{
        input: { type: "choose", index: 0 },
        decision: { scriptId: "ending", choiceId: "final-tether", optionId: "alone" },
        output: { type: "narration", text: "A long silence." },
      }, {
        input: { type: "next" },
        output: { type: "dialogue", speakerId: "mio", text: "Then go alone." },
      }, {
        input: { type: "next" },
        output: { type: "hubMenu", snapshot: {} },
      }],
    }, {
      session: "friends",
      entries: [{
        input: { type: "choose", index: 1 },
        decision: { scriptId: "ending", choiceId: "final-tether", optionId: "friends" },
        output: { type: "narration", text: "A long silence." },
      }, {
        input: { type: "next" },
        output: { type: "dialogue", speakerId: "mio", text: "Then we go together." },
      }],
    }]);

    expect(report.authoring.summary.convergedResponses).toBe(0);
  });

  test("follows a selected response through one-button pacing prompts", () => {
    const pacing = {
      type: "choice",
      prompt: "Enter?",
      options: [{ text: "Enter", available: true }],
    };
    const report = analyzeChoiceCoverage([{
      session: "seed",
      entries: [{ input: { type: "next" }, output: choice, checkpoint: checkpoint("2".repeat(64)) }],
    }, {
      session: "alone",
      entries: [{
        input: { type: "choose", index: 0 },
        decision: { scriptId: "ending", choiceId: "final-tether", optionId: "alone" },
        output: { type: "narration", text: "A shared threshold." },
      }, {
        input: { type: "next" },
        output: pacing,
      }, {
        input: { type: "choose", index: 0 },
        output: { type: "narration", text: "You enter alone." },
      }],
    }, {
      session: "friends",
      entries: [{
        input: { type: "choose", index: 1 },
        decision: { scriptId: "ending", choiceId: "final-tether", optionId: "friends" },
        output: { type: "narration", text: "A shared threshold." },
      }, {
        input: { type: "next" },
        output: pacing,
      }, {
        input: { type: "choose", index: 0 },
        output: { type: "narration", text: "You enter together." },
      }],
    }]);

    expect(report.authoring.summary.convergedResponses).toBe(0);
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

  test("a development scope aggregates source and transitive descendant logs", async () => {
    const gameDir = await mkdtemp(path.join(tmpdir(), "rpgh-choice-family-"));
    temporaryDirectories.push(gameDir);
    await writeFile(path.join(gameDir, "game.yaml"), "title: Choice family test\n");
    const sessionsRoot = path.join(gameDir, ".rpg-harness", "sessions");
    for (const name of ["player", "child", "grandchild", "unrelated"]) {
      await mkdir(path.join(sessionsRoot, name), { recursive: true });
    }
    const revision = "9".repeat(64);
    await writeFile(path.join(sessionsRoot, "player", "log.jsonl"),
      JSON.stringify({ input: { type: "next" }, output: choice, checkpoint: checkpoint(revision) }) + "\n");
    await writeFile(path.join(sessionsRoot, "child", "fork.json"), JSON.stringify({
      fromSession: "player",
      sourceLogEntry: 1,
    }));
    await writeFile(path.join(sessionsRoot, "child", "log.jsonl"), JSON.stringify({
      input: { type: "choose", index: 0 },
      decision: { scriptId: "ending", choiceId: "final-tether", optionId: "alone" },
      output: { type: "narration", text: "Alone." },
    }) + "\n");
    await writeFile(path.join(sessionsRoot, "grandchild", "fork.json"), JSON.stringify({
      fromSession: "child",
      sourceLogEntry: 1,
    }));
    await writeFile(path.join(sessionsRoot, "grandchild", "log.jsonl"), JSON.stringify({
      input: { type: "choose", index: 1 },
      decision: { scriptId: "ending", choiceId: "final-tether", optionId: "friends" },
      output: { type: "narration", text: "Together." },
    }) + "\n");
    await writeFile(path.join(sessionsRoot, "unrelated", "log.jsonl"), JSON.stringify({
      input: { type: "choose", index: 2 },
      decision: { scriptId: "ending", choiceId: "final-tether", optionId: "secret" },
      output: { type: "narration", text: "Secret." },
    }) + "\n");

    const sourceOnly = await collectChoiceCoverage(gameDir, "player");
    const family = await collectChoiceCoverage(gameDir, "player", true);

    expect(sourceOnly.summary.selectedOptions).toBe(0);
    expect(family.sessions).toEqual(["child", "grandchild", "player"]);
    expect(family.choices[0]?.options).toEqual([
      expect.objectContaining({ id: "alone", status: "selected", selectedSessions: ["child"] }),
      expect.objectContaining({ id: "friends", status: "selected", selectedSessions: ["grandchild"] }),
      expect.objectContaining({ id: "secret", status: "locked", selectedSessions: [] }),
    ]);
  });
});

async function temporaryChoiceGame(label: string): Promise<string> {
  const gameDir = await mkdtemp(path.join(tmpdir(), `rpgh-choice-${label}-`));
  temporaryDirectories.push(gameDir);
  await writeFile(path.join(gameDir, "game.yaml"), `title: Choice ${label} test\n`);
  return gameDir;
}
