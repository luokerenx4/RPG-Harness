import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectSessionTranscript, formatSessionTranscript } from "./transcript";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true })
  ));
});

describe("session transcript", () => {
  test("compacts a fork lineage without leaking full hub/state payloads", async () => {
    const gameDir = await mkdtemp(path.join(tmpdir(), "rpgh-transcript-"));
    temporaryDirectories.push(gameDir);
    await writeLog(gameDir, "parent", [
      {
        source: "web",
        input: { type: "next" },
        output: {
          type: "choice",
          scriptId: "ending",
          choiceId: "tether",
          prompt: "Who remains?",
          options: [
            { id: "alone", text: "Alone", available: true, consequence: { goto: "alone" } },
            { id: "friend", text: "Friend", available: false, lockedReason: "bond too low", aiPriority: 20, aiTags: ["social"] },
          ],
          visualState: { bg: "huge.png", portraits: {} },
        },
        checkpoint: checkpoint("a"),
      },
      {
        source: "web",
        input: { type: "choose", index: 0 },
        output: { type: "narration", text: "parent future" },
      },
    ]);
    await writeLog(gameDir, "branch", [
      { source: "fork", fork: { fromSession: "parent", sourceLogEntry: 1, mode: "checkpoint" } },
      {
        source: "autoplay:objective",
        input: { type: "choose", index: 1 },
        inputResult: {
          accepted: false,
          code: "option-locked",
          message: "The requested option is locked: bond too low",
          expected: [{ type: "choose", ids: ["alone"] }],
        },
        decision: { scriptId: "ending", choiceId: "tether", optionId: "friend" },
        output: { type: "narration", text: "friend branch", visualState: { cg: "large.png" } },
        checkpoint: checkpoint("b"),
      },
      { input: { type: "next" }, output: { type: "gameEnd", endingId: "ending-alone" } },
    ]);
    await writeFile(path.join(sessionDir(gameDir, "branch"), "fork.json"), JSON.stringify({
      fromSession: "parent",
      sourceLogEntry: 1,
    }));

    const transcript = await collectSessionTranscript(gameDir, "branch", 0);

    expect(transcript.lineage).toEqual([
      { session: "parent", includedEntries: 1, totalEntries: 2 },
      { session: "branch", includedEntries: 3, totalEntries: 3 },
    ]);
    expect(transcript.summary).toEqual({
      totalEvents: 4,
      returnedEvents: 4,
      omittedEvents: 0,
      narration: 1,
      dialogue: 0,
      choices: 1,
      decisions: 1,
      activities: 0,
      rejectedInputs: 1,
      scriptsCompleted: 0,
      terminal: true,
    });
    expect(transcript.events[0]?.output).toEqual({
      type: "choice",
      scriptId: "ending",
      choiceId: "tether",
      prompt: "Who remains?",
      options: [
        { index: 0, id: "alone", text: "Alone", available: true },
        { index: 1, id: "friend", text: "Friend", available: false, lockedReason: "bond too low", aiPriority: 20, aiTags: ["social"] },
      ],
    });
    expect(transcript.events[2]).toMatchObject({
      session: "branch",
      logEntry: 2,
      decision: { scriptId: "ending", choiceId: "tether", optionId: "friend" },
      inputResult: {
        accepted: false,
        code: "option-locked",
        message: "The requested option is locked: bond too low",
      },
      output: { type: "narration", text: "friend branch" },
    });
    expect(transcript.events[3]?.output).toEqual({
      type: "gameEnd",
      endingId: "ending-alone",
    });
    expect(JSON.stringify(transcript)).not.toContain("large.png");
    expect(JSON.stringify(transcript)).not.toContain("parent future");
    expect(formatSessionTranscript(transcript)).toContain(
      "decision=ending/tether/friend",
    );
    expect(formatSessionTranscript(transcript)).toContain("rejected=option-locked");
  });

  test("tail bounds returned evidence but summary still describes the full lineage", async () => {
    const gameDir = await mkdtemp(path.join(tmpdir(), "rpgh-transcript-tail-"));
    temporaryDirectories.push(gameDir);
    await writeLog(gameDir, "run", [
      { input: { type: "next" }, output: { type: "narration", text: "one" } },
      { input: { type: "next" }, output: { type: "dialogue", speakerId: "a", speakerName: "A", text: "two" } },
      { input: { type: "next" }, output: { type: "gameEnd" } },
    ]);

    const transcript = await collectSessionTranscript(gameDir, "run", 2);
    expect(transcript.events.map((event) => event.index)).toEqual([2, 3]);
    expect(transcript.summary).toMatchObject({
      totalEvents: 3,
      returnedEvents: 2,
      omittedEvents: 1,
      narration: 1,
      dialogue: 1,
      terminal: true,
    });
  });

  test("does not invent calendar labels for a mode-less hub", async () => {
    const gameDir = await mkdtemp(path.join(tmpdir(), "rpgh-transcript-hub-"));
    temporaryDirectories.push(gameDir);
    await writeLog(gameDir, "run", [{
      input: { type: "next" },
      output: {
        type: "hubMenu",
        snapshot: {
          day: 0,
          slotName: "",
          activities: [{ id: "depart", available: true }],
        },
      },
    }]);
    const formatted = formatSessionTranscript(
      await collectSessionTranscript(gameDir, "run", 0),
    );
    expect(formatted).toContain("hub available=[depart]");
    expect(formatted).not.toContain("day=0 slot=");
  });

  test("keeps selected Hub meaning when surrounding menus are outside the tail", async () => {
    const gameDir = await mkdtemp(path.join(tmpdir(), "rpgh-transcript-activity-"));
    temporaryDirectories.push(gameDir);
    await writeLog(gameDir, "run", [{
      input: { type: "doActivity", id: "release-private-id" },
      activityDecision: {
        activityId: "release-private-id",
        title: "Release the oni",
        kind: "action",
        category: "combat",
        aiTags: ["nonlethal", "mercy", "memory"],
        recommended: true,
        actionKind: "private:release",
        relatedObjectiveIds: ["remember-the-oni"],
      },
      output: { type: "narration", text: "The oni leaves alive." },
    }]);

    const transcript = await collectSessionTranscript(gameDir, "run", 1);
    expect(transcript.events[0]?.activityDecision).toEqual({
      activityId: "release-private-id",
      title: "Release the oni",
      kind: "action",
      category: "combat",
      aiTags: ["nonlethal", "mercy", "memory"],
      recommended: true,
      actionKind: "private:release",
      relatedObjectiveIds: ["remember-the-oni"],
    });
    expect(formatSessionTranscript(transcript)).toContain(
      'activity release-private-id "Release the oni" [category=combat; tags=nonlethal,mercy,memory; objectives=remember-the-oni; recommended]',
    );
  });

  test("rejects path traversal and invalid tail sizes", async () => {
    await expect(collectSessionTranscript("/tmp/game", "../escape", 80)).rejects.toThrow(
      "Invalid session name",
    );
    await expect(collectSessionTranscript("/tmp/game", "safe", -1)).rejects.toThrow(
      "--tail must be a non-negative integer",
    );
    await expect(collectSessionTranscript("/tmp/game", "missing", 80)).rejects.toThrow(
      "Session does not exist: missing",
    );
  });
});

function checkpoint(seed: string) {
  const revision = seed.repeat(64);
  return { schemaVersion: 1, file: `checkpoints/${revision}.json`, revision };
}

function sessionDir(gameDir: string, session: string): string {
  return path.join(gameDir, ".rpg-harness", "sessions", session);
}

async function writeLog(gameDir: string, session: string, entries: unknown[]): Promise<void> {
  const dir = sessionDir(gameDir, session);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "log.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
}
