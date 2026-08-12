import { describe, expect, test } from "bun:test";
import { peek, step } from "./step";
import { markScriptCompleted } from "./state";
import {
  makeCharacter,
  makeGame,
  makeScript,
  makeState,
} from "./test-utils";

// Helper: a 2-script game where one script auto-ends after completing.
// We seed both scripts as completed to land at the "no more scripts"
// gameEnd state.
function exhaustedGame() {
  const game = makeGame({
    characters: [makeCharacter("alice")],
    scripts: [makeScript("001"), makeScript("002")],
  });
  const state = makeState(game);
  markScriptCompleted(state, "001");
  markScriptCompleted(state, "002");
  return { game, state };
}

describe("step / peek — gameEnd terminality", () => {
  test("peek at gameEnd reports done:true (not done:false with gameEnd output)", async () => {
    const { game, state } = exhaustedGame();
    const r = await peek(game, state);
    expect(r.output).toMatchObject({ type: "gameEnd" });
    expect(r.done).toBe(true);
  });

  test("step at gameEnd is idempotent: returns gameEnd, done:true", async () => {
    const { game, state } = exhaustedGame();
    const r = await step(game, state, { type: "next" });
    expect(r.output).toMatchObject({ type: "gameEnd" });
    expect(r.done).toBe(true);
  });

  test("step at gameEnd does NOT return output:null (regression)", async () => {
    const { game, state } = exhaustedGame();
    const r = await step(game, state, { type: "next" });
    expect(r.output).not.toBeNull();
  });

  test("step at gameEnd ignores all input types (no-op past end)", async () => {
    const { game, state } = exhaustedGame();
    for (const input of [
      { type: "next" as const },
      { type: "quit" as const },
      { type: "choose" as const, index: 0 },
      { type: "select" as const, scriptId: "001" },
    ]) {
      const r = await step(game, state, input);
      expect(r.output).toMatchObject({ type: "gameEnd" });
      expect(r.done).toBe(true);
    }
  });
});

describe("step input diagnostics", () => {
  test("rejects an out-of-order input without advancing or changing state", async () => {
    const game = makeGame({
      scripts: [makeScript("intro", { beats: [
        { type: "narration", text: "first" },
        { type: "narration", text: "second" },
      ] })],
    });
    const state = makeState(game);
    state.baseline.currentScriptId = "intro";
    const normalized = await peek(game, structuredClone(state));
    const result = await step(game, state, { type: "doActivity", id: "rest" });

    expect(result.output).toMatchObject({ type: "narration", text: "first" });
    expect(result.inputResult).toMatchObject({
      accepted: false,
      code: "unexpected-input",
    });
    expect(result.state).toEqual(normalized.state);
  });

  test("returns accepted diagnostics for a valid input", async () => {
    const game = makeGame({
      scripts: [makeScript("intro", { beats: [
        { type: "narration", text: "first" },
        { type: "narration", text: "second" },
      ] })],
    });
    const state = makeState(game);
    state.baseline.currentScriptId = "intro";
    const result = await step(game, state, { type: "next" });
    expect(result.output).toMatchObject({ type: "narration", text: "second" });
    expect(result.inputResult?.accepted).toBe(true);
  });
});
