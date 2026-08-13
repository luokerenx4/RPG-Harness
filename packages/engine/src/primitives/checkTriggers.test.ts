import { describe, expect, test } from "bun:test";
import { applyDelta } from "../state";
import {
  makeCharacter,
  makeCtx,
  makeGame,
  twoCharGame,
} from "../test-utils";
import type { Module, Trigger } from "../types";
import { checkTriggers, TriggerExecutionError } from "./checkTriggers";
import { mutateState } from "./mutateState";

// Helper: build a game with a tracker module exposing one or more
// triggers, plus a counter inside the trigger's `do` so tests can assert
// fire counts.
function gameWithTriggers(
  triggers: Trigger[],
  extraModules: Module[] = [],
): {
  game: ReturnType<typeof makeGame>;
  fires: Record<string, number>;
  narrations: Record<string, string[]>;
} {
  const fires: Record<string, number> = {};
  const narrations: Record<string, string[]> = {};
  const wrapped: Trigger[] = triggers.map((t) => {
    fires[t.id] = 0;
    narrations[t.id] = [];
    return {
      ...t,
      do: (ctx) => {
        fires[t.id] = (fires[t.id] ?? 0) + 1;
        const result = t.do(ctx);
        if (result.narrations) {
          (narrations[t.id] ?? []).push(...result.narrations);
        }
        return result;
      },
    };
  });
  const module: Module = { id: "test-triggers", triggers: wrapped };
  const game = makeGame({
    characters: [makeCharacter("alice"), makeCharacter("bob")],
    modules: [module, ...extraModules],
  });
  return { game, fires, narrations };
}

describe("checkTriggers — edge detection", () => {
  test("rising edge fires (false → true)", () => {
    const { game, fires } = gameWithTriggers([
      {
        id: "alice_likes_you",
        when: { affection: { character: "alice", min: 5 } },
        do: () => ({ deltas: { switches: { friended: true } } }),
      },
    ]);
    const ctx = makeCtx(game);

    expect(fires.alice_likes_you).toBe(0);
    mutateState(ctx, { characterStats: { alice: { affection: 5 } } }, "action");
    expect(fires.alice_likes_you).toBe(1);
    expect(ctx.state.baseline.switches.friended).toBe(true);
  });

  test("true → true (no edge) does not re-fire", () => {
    const { game, fires } = gameWithTriggers([
      {
        id: "alice_high",
        when: { affection: { character: "alice", min: 5 } },
        do: () => ({}),
      },
    ]);
    const ctx = makeCtx(game);

    mutateState(ctx, { characterStats: { alice: { affection: 5 } } }, "action");
    expect(fires.alice_high).toBe(1);

    mutateState(ctx, { characterStats: { alice: { affection: 1 } } }, "action");
    expect(fires.alice_high).toBe(1);
  });

  test("falling edge re-arms (true → false → true fires twice)", () => {
    const { game, fires } = gameWithTriggers([
      {
        id: "spectral_bad",
        when: { affection: { character: "alice", min: 5 } },
        do: () => ({}),
      },
    ]);
    const ctx = makeCtx(game);

    mutateState(ctx, { characterStats: { alice: { affection: 5 } } }, "action");
    expect(fires.spectral_bad).toBe(1);

    mutateState(ctx, { characterStats: { alice: { affection: -3 } } }, "action");
    expect(fires.spectral_bad).toBe(1);

    mutateState(ctx, { characterStats: { alice: { affection: 3 } } }, "action");
    expect(fires.spectral_bad).toBe(2);
  });

  test("once: true does not re-fire on subsequent rising edges", () => {
    const { game, fires } = gameWithTriggers([
      {
        id: "once_only",
        when: { affection: { character: "alice", min: 3 } },
        do: () => ({}),
        once: true,
      },
    ]);
    const ctx = makeCtx(game);

    mutateState(ctx, { characterStats: { alice: { affection: 3 } } }, "action");
    expect(fires.once_only).toBe(1);

    mutateState(ctx, { characterStats: { alice: { affection: -2 } } }, "action");
    mutateState(ctx, { characterStats: { alice: { affection: 5 } } }, "action");
    expect(fires.once_only).toBe(1);
    expect(ctx.state.runtime.firedTriggers).toContain("once_only");
  });

  test("once trigger fires at most once even if condition is satisfied at init", () => {
    const { game, fires } = gameWithTriggers([
      {
        id: "init_match",
        when: { affection: { character: "alice", max: 999 } },
        do: () => ({}),
        once: true,
      },
    ]);
    const ctx = makeCtx(game);

    // Direct check (no mutation). The trigger was never active, so the
    // first checkTriggers call constitutes a rising edge.
    checkTriggers(ctx);
    expect(fires.init_match).toBe(1);

    checkTriggers(ctx);
    expect(fires.init_match).toBe(1);
  });
});

describe("checkTriggers — cascade bounding", () => {
  test("trigger A's mutations do NOT recursively fire B in same wave; B fires on next mutation", () => {
    // A fires when alice.affection >= 3 and sets flag `cascaded`. B fires
    // when `cascaded === true`. Engine bounds recursion: A's
    // applyTriggerResult uses applyDelta (NOT mutateState), so B does
    // not fire in the same wave. But on the next externally-driven
    // mutation, the snapshot from A's wave has activeTriggers=[A] only,
    // so B is now a rising edge and fires once.
    const { game, fires } = gameWithTriggers([
      {
        id: "A",
        when: { affection: { character: "alice", min: 3 } },
        do: () => ({ deltas: { switches: { cascaded: true } } }),
      },
      {
        id: "B",
        when: { switch: { name: "cascaded", eq: true } },
        do: () => ({}),
      },
    ]);
    const ctx = makeCtx(game);

    mutateState(ctx, { characterStats: { alice: { affection: 3 } } }, "action");
    expect(fires.A).toBe(1);
    expect(fires.B).toBe(0); // bounded — B did not fire this wave
    expect(ctx.state.runtime.activeTriggers).toEqual(["A"]);

    // Any next mutation lets B see itself as a rising edge.
    mutateState(ctx, { characterStats: { alice: { affection: 0 } } }, "action");
    expect(fires.B).toBe(1);
  });
});

describe("checkTriggers — fired and active bookkeeping", () => {
  test("activeTriggers updates on every check", () => {
    const { game } = gameWithTriggers([
      {
        id: "high",
        when: { affection: { character: "alice", min: 5 } },
        do: () => ({}),
      },
    ]);
    const ctx = makeCtx(game);

    expect(ctx.state.runtime.activeTriggers).toEqual([]);
    mutateState(ctx, { characterStats: { alice: { affection: 5 } } }, "action");
    expect(ctx.state.runtime.activeTriggers).toContain("high");
    mutateState(ctx, { characterStats: { alice: { affection: -10 } } }, "action");
    expect(ctx.state.runtime.activeTriggers).not.toContain("high");
  });

  test("firedTriggers only records once-triggers", () => {
    const { game } = gameWithTriggers([
      {
        id: "recurring",
        when: { affection: { character: "alice", min: 1 } },
        do: () => ({}),
      },
      {
        id: "once_only",
        when: { affection: { character: "bob", min: 1 } },
        do: () => ({}),
        once: true,
      },
    ]);
    const ctx = makeCtx(game);

    mutateState(ctx, { characterStats: { alice: { affection: 2 }, bob: { affection: 2 } } }, "action");
    expect(ctx.state.runtime.firedTriggers).toEqual(["once_only"]);
  });
});

describe("checkTriggers — trigger result application", () => {
  test("trigger's narrations queue into pendingNarrations", () => {
    const { game } = gameWithTriggers([
      {
        id: "say_hi",
        when: { affection: { character: "alice", min: 3 } },
        do: () => ({
          narrations: ["alice 朝你点头致意"],
        }),
      },
    ]);
    const ctx = makeCtx(game);
    mutateState(ctx, { characterStats: { alice: { affection: 3 } } }, "action");
    expect(ctx.state.runtime.pendingNarrations).toEqual([
      "alice 朝你点头致意",
    ]);
  });

  test("trigger's customLog appends to module log", () => {
    const { game } = gameWithTriggers([
      {
        id: "log_milestone",
        when: { affection: { character: "alice", min: 3 } },
        do: () => ({
          customLog: { moduleId: "milestones", entry: { name: "first" } },
        }),
      },
    ]);
    const ctx = makeCtx(game);
    mutateState(ctx, { characterStats: { alice: { affection: 3 } } }, "action");
    const log = (ctx.state.milestones as { log: unknown[] }).log;
    expect(log).toEqual([{ name: "first" }]);
  });
});

describe("checkTriggers — author-owned failures", () => {
  test("distinguishes malformed condition evaluation", () => {
    const game = makeGame({
      modules: [{
        id: "broken-events",
        triggers: [{
          id: "bad_condition",
          when: null as never,
          do: () => ({}),
        }],
      }],
    });
    const ctx = makeCtx(game);

    try {
      checkTriggers(ctx);
      throw new Error("expected trigger condition failure");
    } catch (error) {
      expect(error).toMatchObject({
        moduleId: "broken-events",
        triggerId: "bad_condition",
        stage: "condition",
        causeName: "TypeError",
      });
    }
  });

  test("retains the owner and handler stage", () => {
    const game = makeGame({
      modules: [{
        id: "broken-events",
        triggers: [{
          id: "bad_omen",
          when: { switch: { name: "omen", eq: true } },
          do: () => {
            throw new RangeError("omen handler broke");
          },
          once: true,
        }],
      }],
    });
    const ctx = makeCtx(game);
    ctx.state.baseline.switches.omen = true;

    expect(() => checkTriggers(ctx)).toThrow(TriggerExecutionError);
    try {
      checkTriggers(ctx);
    } catch (error) {
      expect(error).toMatchObject({
        moduleId: "broken-events",
        triggerId: "bad_omen",
        stage: "handler",
        causeName: "RangeError",
        causeMessage: "omen handler broke",
      });
    }
  });

  test("rejects async handlers instead of silently treating them as empty", () => {
    const game = makeGame({
      modules: [{
        id: "async-events",
        triggers: [{
          id: "late_omen",
          when: { switch: { name: "omen", eq: true } },
          do: (() => Promise.resolve({})) as never,
        }],
      }],
    });
    const ctx = makeCtx(game);
    ctx.state.baseline.switches.omen = true;

    expect(() => checkTriggers(ctx)).toThrow(TriggerExecutionError);
    try {
      checkTriggers(ctx);
    } catch (error) {
      expect(error).toMatchObject({
        moduleId: "async-events",
        triggerId: "late_omen",
        stage: "handler",
        causeName: "TypeError",
      });
    }
  });

  test("attributes a broken thenable contract to the owning handler", () => {
    const game = makeGame({
      modules: [{
        id: "thenable-events",
        triggers: [{
          id: "hostile_omen",
          when: { switch: { name: "omen", eq: true } },
          do: (() => Object.defineProperty({}, "then", {
            get() {
              throw new SyntaxError("then getter broke");
            },
          })) as never,
        }],
      }],
    });
    const ctx = makeCtx(game);
    ctx.state.baseline.switches.omen = true;

    try {
      checkTriggers(ctx);
      throw new Error("expected trigger handler failure");
    } catch (error) {
      expect(error).toMatchObject({
        moduleId: "thenable-events",
        triggerId: "hostile_omen",
        stage: "handler",
        causeName: "SyntaxError",
        causeMessage: "then getter broke",
      });
    }
  });

  test("distinguishes an invalid handler result", () => {
    const game = makeGame({
      modules: [{
        id: "broken-events",
        triggers: [{
          id: "bad_result",
          when: { switch: { name: "omen", eq: true } },
          do: (() => null) as never,
        }],
      }],
    });
    const ctx = makeCtx(game);
    ctx.state.baseline.switches.omen = true;

    try {
      checkTriggers(ctx);
      throw new Error("expected trigger result failure");
    } catch (error) {
      expect(error).toMatchObject({
        moduleId: "broken-events",
        triggerId: "bad_result",
        stage: "result",
        causeName: "TypeError",
      });
    }
  });
});

describe("checkTriggers — zero triggers, zero work", () => {
  test("no triggers registered → no-op", () => {
    const ctx = makeCtx(twoCharGame());
    expect(() => checkTriggers(ctx)).not.toThrow();
    expect(ctx.state.runtime.activeTriggers).toEqual([]);
  });
});

// Applies a delta WITHOUT going through mutateState, then manually invokes
// checkTriggers. Verifies checkTriggers is independent of applyDelta.
test("checkTriggers works as a standalone primitive", () => {
  const { game, fires } = gameWithTriggers([
    {
      id: "trip",
      when: { affection: { character: "alice", min: 3 } },
      do: () => ({}),
    },
  ]);
  const ctx = makeCtx(game);
  applyDelta(ctx.state, { characterStats: { alice: { affection: 5 } } });
  checkTriggers(ctx);
  expect(fires.trip).toBe(1);
});
