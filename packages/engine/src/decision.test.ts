import { describe, expect, test } from "bun:test";
import { choiceDecisionContext, resolveChoiceInput } from "./decision";

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
