import { describe, expect, test } from "bun:test";
import { detectTerminalScriptId } from "./autoplay";

describe("autoplay ending summary", () => {
  test("uses the terminal state's last completed script without naming guesses", () => {
    expect(detectTerminalScriptId({
      done: true,
      trace: [{ output: { type: "gameEnd" } }],
      finalState: { baseline: { completionOrder: ["intro", "ending_oni_self"] } },
    })).toBe("ending_oni_self");
  });

  test("does not call an unfinished run an ending", () => {
    expect(detectTerminalScriptId({
      done: false,
      trace: [],
      finalState: { baseline: { completionOrder: ["scene_005"] } },
    })).toBeNull();
  });
});
