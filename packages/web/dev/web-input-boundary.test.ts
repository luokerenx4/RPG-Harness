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
    expect(submitted.inputResult.expected).toEqual([]);
    expect(submitted.result?.value).toEqual({ type: "gameEnd" });
    expect(received).toEqual([
      { type: "choose", choiceId: "route", optionId: "friends" },
    ]);
  });

  test("accepted Hub input reports expectations for the resulting narration", async () => {
    const runner: AsyncGenerator<Output, void, Input> = (async function* () {
      yield { type: "hubMenu", snapshot: {
        day: 1,
        maxDay: 1,
        slot: 0,
        slotName: "",
        slotsPerDay: 1,
        stats: [],
        affections: [],
        activities: [{ id: "memory", kind: "action", title: "Recall", cost: 0, available: true }],
      } };
      yield { type: "narration", text: "The memory returns." };
    })();
    const current = await runner.next();
    const submitted = await submitWebInput(
      current.value!,
      { type: "doActivity", id: "memory" },
      runner,
    );

    expect(submitted.result?.value).toMatchObject({ type: "narration" });
    expect(submitted.inputResult).toMatchObject({
      accepted: true,
      expected: [{ type: "next" }, { type: "quit" }],
    });
  });
});
