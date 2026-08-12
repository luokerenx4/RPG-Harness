import { describe, expect, test } from "bun:test";
import type { Input, Output } from "@rpg-harness/engine";
import { submitWebInput } from "../src/WebPlayScreen";

describe("Web input boundary", () => {
  test("does not deliver rejected input to the live generator", async () => {
    const received: Input[] = [];
    const runner: AsyncGenerator<Output, void, Input> = (async function* () {
      const input: Input = yield { type: "narration", text: "Wait." };
      received.push(input);
      yield { type: "gameEnd" };
    })();
    await runner.next();

    const submitted = await submitWebInput(
      { type: "narration", text: "Wait." },
      { type: "doActivity", id: "rest" },
      runner,
    );

    expect(submitted).toMatchObject({
      inputResult: { accepted: false, code: "unexpected-input" },
    });
    expect(submitted.result).toBeUndefined();
    expect(received).toEqual([]);
  });

  test("delivers accepted stable choice identity unchanged", async () => {
    const received: Input[] = [];
    const runner: AsyncGenerator<Output, void, Input> = (async function* () {
      const input: Input = yield { type: "choice", choiceId: "route", options: [
        { id: "friends", text: "Friends", available: true },
      ] };
      received.push(input);
      yield { type: "gameEnd" };
    })();
    await runner.next();
    const output: Output = {
      type: "choice",
      choiceId: "route",
      options: [{ id: "friends", text: "Friends", available: true }],
    };

    const submitted = await submitWebInput(
      output,
      { type: "choose", choiceId: "route", optionId: "friends" },
      runner,
    );

    expect(submitted.inputResult.accepted).toBe(true);
    expect(submitted.result?.value).toEqual({ type: "gameEnd" });
    expect(received).toEqual([
      { type: "choose", choiceId: "route", optionId: "friends" },
    ]);
  });
});
