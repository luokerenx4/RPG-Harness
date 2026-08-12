import { describe, expect, test } from "bun:test";
import {
  compareChoiceSearchAssessment,
  searchForChoice,
  searchForScript,
} from "./search";
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

  test("finds and completes a script with no authored choice", async () => {
    const game = makeGame({
      characters: [makeCharacter("alice")],
      scripts: [
        makeScript("detour", { beats: [{ type: "narration", text: "Detour" }] }),
        makeScript("target", {
          beats: [
            { type: "narration", text: "First" },
            { type: "narration", text: "Last" },
          ],
        }),
      ],
    });

    const result = await searchForScript(
      game,
      makeState(game),
      { scriptId: "target" },
      { maxNodes: 20, maxSteps: 20 },
    );

    expect(result.found).toBe(true);
    expect(result.inputs).toEqual([
      { type: "select", scriptId: "target" },
      { type: "next" },
      { type: "next" },
    ]);
    expect(result.state.baseline.scripts.target?.completed).toBe(true);
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

  test("reports renderer-neutral progress at a caller-selected node interval", async () => {
    const game = makeGame({
      characters: [makeCharacter("alice")],
      scripts: [makeScript("only", {
        beats: [{
          type: "choice",
          id: "fork",
          options: [{ id: "a", text: "A" }, { id: "b", text: "B" }],
        }],
      })],
    });
    const updates: number[] = [];

    await searchForChoice(
      game,
      makeState(game),
      { scriptId: "missing", choiceId: "missing" },
      {
        maxNodes: 10,
        maxSteps: 3,
        progressEvery: 1,
        onProgress: (progress) => updates.push(progress.exploredNodes),
      },
    );

    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0]).toBe(1);
  });

  test("follows explicit-requirement plateaus deeply enough to change state", async () => {
    const shallow = {
      inputs: [{ type: "next" as const }],
      steps: 1,
      progress: 0,
      satisfiedRequirements: 0,
      totalRequirements: 1,
      targetScriptCompleted: false,
      targetScriptActive: false,
      requirements: [],
      outputType: "hubMenu" as const,
    };
    const deep = { ...shallow, inputs: Array(5).fill({ type: "next" as const }), steps: 5 };

    expect(compareChoiceSearchAssessment(deep, shallow)).toBeGreaterThan(0);
    expect(compareChoiceSearchAssessment(
      { ...deep, totalRequirements: 0 },
      { ...shallow, totalRequirements: 0 },
    )).toBeLessThan(0);
    expect(compareChoiceSearchAssessment(
      { ...deep, outputType: "gameEnd" },
      deep,
    )).toBeLessThan(0);
    expect(compareChoiceSearchAssessment(
      { ...deep, targetScriptCompleted: true },
      deep,
      true,
    )).toBeGreaterThan(0);
    expect(compareChoiceSearchAssessment(
      { ...shallow, guidanceProgress: 3 },
      { ...deep, guidanceProgress: 1 },
      true,
    )).toBeGreaterThan(0);
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
