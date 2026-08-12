import { describe, expect, test } from "bun:test";
import { makeCtx, makeGame, makeScript } from "../../test-utils";
import { vnRun } from "./run";

describe("vn preset selection authorization", () => {
  test("direct generator use cannot select a script outside nextAvailable", async () => {
    const game = makeGame({
      scripts: [
        makeScript("open"),
        makeScript("locked", { requires: { switch: { name: "secret" } } }),
      ],
    });
    const ctx = makeCtx(game);
    const run = vnRun(ctx);
    expect((await run.next()).value).toMatchObject({
      type: "scriptComplete",
      nextAvailable: [{ id: "open" }],
    });
    expect((await run.next({ type: "select", scriptId: "locked" })).value).toMatchObject({
      type: "scriptComplete",
      nextAvailable: [{ id: "open" }],
    });
    expect(ctx.state.baseline.currentScriptId).toBeNull();
  });
});
