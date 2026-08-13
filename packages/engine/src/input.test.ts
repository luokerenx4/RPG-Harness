import { describe, expect, test } from "bun:test";
import { classifyInput } from "./input";
import type { Output } from "./types";

describe("public output/input contract", () => {
  test("turns malformed JSON payloads into recoverable diagnostics", () => {
    const output: Output = { type: "narration", text: "Wait." };
    expect(classifyInput(output, null)).toMatchObject({
      accepted: false,
      code: "malformed-input",
    });
    expect(classifyInput(output, {})).toMatchObject({
      accepted: false,
      code: "malformed-input",
    });
    expect(classifyInput(hub(), { type: "doActivity" })).toMatchObject({
      accepted: false,
      code: "malformed-input",
      message: "doActivity input requires a string id.",
    });
  });

  test("explains an activity sent while narration is pending", () => {
    expect(classifyInput({
      type: "narration",
      text: "Wait for the narration.",
      pendingCount: 2,
    }, { type: "doActivity", id: "rest" })).toEqual({
      accepted: false,
      code: "unexpected-input",
      message: "narration expects next; received doActivity.",
      expected: [{ type: "next" }, { type: "quit" }],
    });
  });

  test("distinguishes stale, missing, and locked choice targets", () => {
    const output: Output = {
      type: "choice",
      scriptId: "ending",
      choiceId: "route",
      options: [
        { id: "alone", text: "Alone", available: true },
        { id: "friends", text: "Friends", available: false, lockedReason: "Trust 5 required" },
      ],
    };
    expect(classifyInput(output, {
      type: "choose",
      choiceId: "old-route",
      optionId: "alone",
    }).code).toBe("stale-choice");
    expect(classifyInput(output, {
      type: "choose",
      choiceId: "route",
      optionId: "missing",
    }).code).toBe("option-not-found");
    expect(classifyInput(output, {
      type: "choose",
      choiceId: "route",
      optionId: "friends",
    })).toMatchObject({
      accepted: false,
      code: "option-locked",
      message: "The requested option is locked: Trust 5 required",
    });
  });

  test("rejects scripts and activities absent from the current screen", () => {
    expect(classifyInput({
      type: "scriptComplete",
      completedId: null,
      nextAvailable: [{ id: "intro", title: "Intro" }],
    }, { type: "select", scriptId: "secret-ending" }).code).toBe("script-not-available");
    expect(classifyInput(hub(), {
      type: "doActivity",
      id: "secret-ending",
    }).code).toBe("activity-not-present");
  });

  test("keeps GUI availability and expected Headless activity ids identical", () => {
    const output = hub();
    expect(classifyInput(output, {
      type: "doActivity",
      id: "script:bond",
    }).code).toBe("activity-locked");
    expect(classifyInput(output, {
      type: "doActivity",
      id: "rest",
    })).toMatchObject({
      accepted: false,
      code: "activity-locked",
      expected: [
        { type: "doActivity", ids: ["depart"] },
        { type: "quit" },
      ],
    });
    expect(classifyInput(output, {
      type: "doActivity",
      id: "study",
    }).code).toBe("activity-locked");
    expect(classifyInput(output, {
      type: "doActivity",
      id: "depart",
    }).accepted).toBe(true);
  });
});

function hub(): Extract<Output, { type: "hubMenu" }> {
  return {
    type: "hubMenu",
    snapshot: {
      day: 1,
      maxDay: 10,
      slot: 0,
      slotName: "day",
      slotsPerDay: 2,
      stats: [],
      affections: [],
      activities: [
        {
          id: "script:bond",
          kind: "script",
          title: "Bond",
          cost: 0,
          available: false,
          lockedReason: "Affection 5 required",
        },
        {
          id: "rest",
          kind: "action",
          actionKind: "rest",
          title: "Rest",
          cost: 0,
          available: false,
          lockedReason: "Already rested",
        },
        {
          id: "study",
          kind: "action",
          title: "Study",
          cost: 1,
          available: false,
          lockedReason: "Library closed",
        },
        {
          id: "depart",
          kind: "action",
          actionKind: "depart",
          title: "Depart",
          cost: 0,
          available: true,
        },
      ],
    },
  };
}
