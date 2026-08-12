import { describe, expect, test } from "bun:test";
import { choiceDecisionContext } from "./decision";

describe("choice decision context", () => {
  test("binds a choose input to stable script, choice and option ids", () => {
    expect(choiceDecisionContext({
      type: "choice",
      scriptId: "ending",
      choiceId: "route",
      options: [{ id: "friends", text: "Friends", available: true }],
    }, { type: "choose", index: 0 })).toEqual({
      scriptId: "ending",
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
});
