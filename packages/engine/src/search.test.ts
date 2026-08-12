import { describe, expect, test } from "bun:test";
import { searchForChoice } from "./search";
import { makeCharacter, makeGame, makeScript, makeState } from "./test-utils";

describe("choice state-space search", () => {
  test("finds the shortest public-input path to a stable authored choice", async () => {
    const game = makeGame({
      characters: [makeCharacter("alice")],
      scripts: [
        makeScript("detour", {
          beats: [{ type: "narration", text: "Long way" }],
        }),
        makeScript("target", {
          beats: [
            { type: "narration", text: "Approach" },
            {
              type: "choice",
              id: "crossroads",
              prompt: "Where?",
              options: [
                { id: "left", text: "Left" },
                { id: "right", text: "Right" },
              ],
            },
          ],
        }),
      ],
    });

    const result = await searchForChoice(
      game,
      makeState(game),
      { scriptId: "target", choiceId: "crossroads" },
      { maxNodes: 20, maxSteps: 20 },
    );

    expect(result.found).toBe(true);
    expect(result.reason).toBe("found");
    expect(result.inputs).toEqual([
      { type: "select", scriptId: "target" },
      { type: "next" },
    ]);
    expect(result.output).toMatchObject({
      type: "choice",
      scriptId: "target",
      choiceId: "crossroads",
    });
  });

  test("reports a bounded miss without mutating the source state", async () => {
    const game = makeGame({
      characters: [makeCharacter("alice")],
      scripts: [makeScript("only", {
        beats: [{ type: "narration", text: "Nothing" }],
      })],
    });
    const state = makeState(game);
    const before = structuredClone(state);
    const result = await searchForChoice(
      game,
      state,
      { scriptId: "missing", choiceId: "missing" },
      { maxNodes: 10, maxSteps: 10 },
    );

    expect(result.found).toBe(false);
    expect(result.reason).toBe("exhausted");
    expect(state).toEqual(before);
  });

  test("explains the closest state's satisfied and blocked requirements", async () => {
    const game = makeGame({
      characters: [makeCharacter("alice")],
      variables: [{ id: "pulse", type: "number", initial: 2 }],
      scripts: [makeScript("target", {
        requires: {
          all: [
            { variable: { name: "pulse", min: 5 } },
            { switch: { name: "loyal" } },
          ],
        },
        beats: [{
          type: "choice",
          id: "crossroads",
          options: [{ id: "only", text: "Only" }],
        }],
      })],
    });
    const state = makeState(game);
    state.baseline.switches.loyal = false;
    const result = await searchForChoice(
      game,
      state,
      { scriptId: "target", choiceId: "crossroads" },
      { maxNodes: 1, maxSteps: 10 },
    );

    expect(result.found).toBe(false);
    expect(result.closest).toMatchObject({
      satisfiedRequirements: 0,
      totalRequirements: 2,
      targetScriptActive: false,
      requirements: [
        {
          satisfied: false,
          progress: 0.25,
          reason: "pulse ≥ 5 が要る (現在 2)",
        },
        {
          satisfied: false,
          progress: 0,
          reason: "switch.loyal が要る",
        },
      ],
    });
  });
});
