import { describe, expect, test } from "bun:test";
import { cloneState } from "./state";
import { ensurePersistedRng, persistedRng } from "./rng";
import { step } from "./step";
import { makeGame, makeState } from "./test-utils";
import type { RunFunction } from "./types";

describe("persisted RNG", () => {
  test("forked checkpoint states produce the same random stream", () => {
    const checkpoint = makeState(makeGame());
    checkpoint.runtime.rng = { algorithm: "mulberry32", state: 123456 };
    const left = cloneState(checkpoint);
    const right = cloneState(checkpoint);
    const leftRng = persistedRng(left.runtime);
    const rightRng = persistedRng(right.runtime);

    expect([leftRng(), leftRng(), leftRng()]).toEqual([
      rightRng(),
      rightRng(),
      rightRng(),
    ]);
    expect(left.runtime.rng).toEqual(right.runtime.rng);
    expect(left.runtime.rng?.state).not.toBe(123456);
  });

  test("legacy checkpoints receive a deterministic state-derived cursor", () => {
    const checkpoint = makeState(makeGame());
    delete checkpoint.runtime.rng;
    const left = cloneState(checkpoint);
    const right = cloneState(checkpoint);

    ensurePersistedRng(left);
    ensurePersistedRng(right);

    expect(left.runtime.rng).toEqual(right.runtime.rng);
    expect(persistedRng(left.runtime)()).toBe(persistedRng(right.runtime)());
  });

  test("the same engine input replays random outcomes from a checkpoint", async () => {
    const randomRun: RunFunction = async function* (ctx) {
      const input = yield {
        type: "scriptComplete",
        completedId: null,
        nextAvailable: [{ id: "roll", title: "Roll" }],
      };
      if (input.type !== "select") return;
      ctx.state.baseline.variables.roll = Math.floor(ctx.rng() * 1_000_000);
      yield { type: "narration", text: "Rolled" };
    };
    const game = makeGame({ runFn: randomRun });
    const checkpoint = makeState(game);
    checkpoint.runtime.rng = { algorithm: "mulberry32", state: 987654321 };

    const left = await step(game, cloneState(checkpoint), {
      type: "select",
      scriptId: "roll",
    });
    const right = await step(game, cloneState(checkpoint), {
      type: "select",
      scriptId: "roll",
    });

    expect(left.state.baseline.variables.roll).toBe(
      right.state.baseline.variables.roll,
    );
    expect(left.state.runtime.rng).toEqual(right.state.runtime.rng);
  });
});
