import { describe, expect, test } from "bun:test";
import {
  activityDecisionContext,
  choiceDecisionContext,
  resolveChoiceInput,
} from "./decision";

describe("choice decision context", () => {
  test("binds a choose input to stable script, choice and option ids", () => {
    expect(choiceDecisionContext({
      type: "choice",
      scriptId: "ending",
      scriptRevision: "rev-2",
      choiceId: "route",
      options: [{ id: "friends", text: "Friends", available: true }],
    }, { type: "choose", index: 0 })).toEqual({
      scriptId: "ending",
      scriptRevision: "rev-2",
      choiceId: "route",
      optionId: "friends",
    });
  });

  test("does not invent identity for legacy choices", () => {
    expect(choiceDecisionContext({
      type: "choice",
      options: [{ text: "Legacy", available: true }],
    }, { type: "choose", index: 0 })).toBeUndefined();
  });

  test("logs stable choice input without translating through a caller-owned index", () => {
    expect(choiceDecisionContext({
      type: "choice",
      scriptId: "ending",
      choiceId: "route",
      options: [
        { id: "alone", text: "Alone", available: true },
        { id: "friends", text: "Friends", available: true },
      ],
    }, {
      type: "choose",
      choiceId: "route",
      optionId: "friends",
    })).toEqual({
      scriptId: "ending",
      choiceId: "route",
      optionId: "friends",
    });
  });

  test("rejects stale, locked, and ambiguous stable inputs", () => {
    const target = {
      choiceId: "route",
      options: [
        { id: "alone", available: true },
        { id: "friends", available: false },
      ],
    };
    expect(resolveChoiceInput(target, {
      type: "choose",
      choiceId: "old-route",
      optionId: "alone",
    })).toBeUndefined();
    expect(resolveChoiceInput(target, {
      type: "choose",
      choiceId: "route",
      optionId: "friends",
    })).toBeUndefined();
    expect(resolveChoiceInput(target, {
      type: "choose",
      index: 0,
      choiceId: "route",
      optionId: "alone",
    } as never)).toBeUndefined();
  });
});

describe("activity decision context", () => {
  test("binds a Hub selection to public authored semantics without payload", () => {
    expect(activityDecisionContext({
      type: "hubMenu",
      snapshot: {
        day: 1,
        maxDay: 1,
        slot: 0,
        slotName: "",
        slotsPerDay: 1,
        stats: [],
        affections: [],
        objectives: [{
          id: "remember-the-oni",
          title: "Remember",
          status: "active",
          scope: "side",
          terminal: false,
          relatedActivityIds: ["release"],
        }],
        activities: [{
          id: "release",
          kind: "action",
          title: "Release the oni",
          category: "combat",
          aiTags: ["nonlethal", "mercy", "memory"],
          recommended: true,
          cost: 0,
          available: true,
          actionKind: "raid:release",
          pacingInstanceId: "encounter-1",
          payload: { enemyId: "private-oni" },
        }],
      },
    }, { type: "doActivity", id: "release" })).toEqual({
      activityId: "release",
      title: "Release the oni",
      kind: "action",
      category: "combat",
      aiTags: ["nonlethal", "mercy", "memory"],
      recommended: true,
      actionKind: "raid:release",
      pacingInstanceId: "encounter-1",
      relatedObjectiveIds: ["remember-the-oni"],
    });
  });

  test("rejects stale and locked Hub activity inputs", () => {
    const output = {
      type: "hubMenu" as const,
      snapshot: {
        day: 1,
        maxDay: 1,
        slot: 0,
        slotName: "",
        slotsPerDay: 1,
        stats: [],
        affections: [],
        activities: [{
          id: "locked",
          kind: "action" as const,
          title: "Locked",
          cost: 0,
          available: false,
        }],
      },
    };
    expect(activityDecisionContext(output, {
      type: "doActivity",
      id: "locked",
    })).toBeUndefined();
    expect(activityDecisionContext(output, {
      type: "doActivity",
      id: "stale",
    })).toBeUndefined();
  });
});
