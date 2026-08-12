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
});
