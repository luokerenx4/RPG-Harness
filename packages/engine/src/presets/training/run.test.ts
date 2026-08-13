import { describe, expect, test } from "bun:test";
import { makeCtx, makeGame } from "../../test-utils";
import { trainingPreset } from "./module";
import { trainingRun } from "./run";

describe("training preset terminal identity", () => {
  test("emits a generic gameEnd for a legal end condition without goto", async () => {
    const game = makeGame({
      modules: [trainingPreset],
      training: {
        slotsPerDay: 1,
        slotNames: ["day"],
        startDay: 1,
        maxDay: 1,
        stats: [],
        decayPerDay: 0,
        decayStatId: "",
        sleepActionId: "sleep",
        huntActionId: "hunt",
        endConditions: [{
          reason: "calendar ended",
          when: { switch: { name: "finished" } },
        }],
      },
    });
    const ctx = makeCtx(game);
    ctx.state.baseline.switches.finished = true;
    ctx.state.baseline.completionOrder.push("ordinary-scene");

    expect((await trainingRun(ctx).next()).value).toEqual({
      type: "gameEnd",
      endingId: "game-end",
      reason: "calendar ended",
    });
  });
});
