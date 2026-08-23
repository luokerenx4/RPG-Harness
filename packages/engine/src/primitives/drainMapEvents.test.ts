import { describe, expect, test } from "bun:test";
import { makeAction, makeCharacter, makeCtx, makeGame } from "../test-utils";
import { drainAutomaticMapEvents } from "./drainMapEvents";

async function drain<T>(generator: AsyncGenerator<unknown, T, unknown>): Promise<T> {
  let result = await generator.next();
  while (!result.done) result = await generator.next({ type: "next" });
  return result.value;
}

describe("drainAutomaticMapEvents", () => {
  test("runs map-enter scripts once per visit and re-arms after leaving", async () => {
    const game = makeGame({
      characters: [makeCharacter("hero")],
      scripts: [{ id: "arrival", title: "Arrival", beats: [] }],
      maps: [
        {
          id: "room",
          name: "Room",
          description: "",
          placements: [{
            id: "arrival",
            at: { x: 0, y: 0 },
            z: 0,
            footprint: { width: 1, height: 1 },
            collision: "none",
            visible: false,
            resource: { kind: "script", id: "arrival" },
            events: [{ id: "start", trigger: "map_enter", order: 0 }],
          }],
        },
        { id: "hall", name: "Hall", description: "" },
      ],
    });
    const ctx = makeCtx(game);
    ctx.state.baseline.currentMapId = "room";

    await drain(drainAutomaticMapEvents(ctx));
    expect(ctx.state.baseline.currentScriptId as string | null).toBe("arrival");
    ctx.state.baseline.currentScriptId = null;
    await drain(drainAutomaticMapEvents(ctx));
    expect(ctx.state.baseline.currentScriptId).toBeNull();

    ctx.state.baseline.currentMapId = "hall";
    await drain(drainAutomaticMapEvents(ctx));
    ctx.state.baseline.currentMapId = "room";
    await drain(drainAutomaticMapEvents(ctx));
    expect(ctx.state.baseline.currentScriptId as string | null).toBe("arrival");
  });

  test("arms an autorun action when its condition becomes true", async () => {
    const game = makeGame({
      characters: [makeCharacter("hero")],
      switches: [{ id: "ready", initial: false }],
      actions: [makeAction("reveal", {
        exposure: "placed",
        effects: { switches: { ready: false } },
        narrations: ["revealed"],
      })],
      maps: [{
        id: "room",
        name: "Room",
        description: "",
        placements: [{
          id: "secret",
          at: { x: 0, y: 0 },
          z: 0,
          footprint: { width: 1, height: 1 },
          collision: "none",
          visible: false,
          resource: { kind: "action", id: "reveal" },
          events: [{
            id: "run",
            trigger: "autorun",
            order: 0,
            requires: { switch: { name: "ready", eq: true } },
          }],
        }],
      }],
    });
    const ctx = makeCtx(game, { rng: () => 0 });
    ctx.state.baseline.currentMapId = "room";

    await drain(drainAutomaticMapEvents(ctx));
    expect(ctx.state.runtime.pendingNarrations).toEqual([]);
    ctx.state.baseline.switches.ready = true;
    await drain(drainAutomaticMapEvents(ctx));
    expect(ctx.state.runtime.pendingNarrations).toEqual(["revealed"]);
    expect(ctx.state.baseline.switches.ready).toBe(false);
  });
});
