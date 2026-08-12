import { describe, expect, test } from "bun:test";
import { createInitialState } from "./state";
import { runLoop } from "./runLoop";
import type { Game } from "./types";

const terminalGame: Game = {
  title: "terminal",
  characters: [],
  scripts: [],
  actions: [],
  modules: [],
  items: [],
  enemies: [],
  weapons: [],
  skills: [],
  maps: [],
  runFn: async function* () {
    yield { type: "gameEnd" as const };
  },
};

describe("runLoop terminal output", () => {
  test("classifies gameEnd as completed without requesting another input", async () => {
    let inputCalls = 0;
    const result = await runLoop(
      terminalGame,
      createInitialState(terminalGame),
      async () => {
        inputCalls += 1;
        return null;
      },
    );
    expect(result.reason).toBe("completed");
    expect(result.done).toBe(true);
    expect(result.trace.at(-1)?.output.type).toBe("gameEnd");
    expect(inputCalls).toBe(0);
  });

  test("does not request a decision after the input budget is exhausted", async () => {
    const twoBeatGame: Game = {
      ...terminalGame,
      runFn: async function* () {
        yield { type: "narration" as const, text: "first" };
        yield { type: "narration" as const, text: "second" };
        yield { type: "gameEnd" as const };
      },
    };
    let inputCalls = 0;
    const result = await runLoop(
      twoBeatGame,
      createInitialState(twoBeatGame),
      async () => {
        inputCalls += 1;
        return { type: "next" };
      },
      { maxSteps: 1 },
    );

    expect(result.reason).toBe("max-steps");
    expect(result.trace).toHaveLength(2);
    expect(inputCalls).toBe(1);
  });

  test("zero input budget still exposes the initial output without asking", async () => {
    const visibleGame: Game = {
      ...terminalGame,
      runFn: async function* () {
        yield { type: "narration" as const, text: "visible" };
      },
    };
    let inputCalls = 0;
    const result = await runLoop(
      visibleGame,
      createInitialState(visibleGame),
      async () => {
        inputCalls += 1;
        return { type: "next" };
      },
      { maxSteps: 0 },
    );

    expect(result.reason).toBe("max-steps");
    expect(result.trace).toHaveLength(1);
    expect(inputCalls).toBe(0);
  });
});
