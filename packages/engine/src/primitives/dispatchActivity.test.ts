import { describe, expect, test } from "bun:test";
import {
  makeAction,
  makeCharacter,
  makeCtx,
  makeGame,
  makeScript,
  trackerModule,
} from "../test-utils";
import type { Module } from "../types";
import { collectMapActivities } from "./buildMapHub";
import { dispatchActivity } from "./dispatchActivity";

// Helper: drain the activity generator. Returns the final return value
// ("ok" | "quit") and any yielded outputs (usually empty since these
// primitives don't yield directly — that's runScript / runLoop's job).
async function drain(
  gen: ReturnType<typeof dispatchActivity>,
): Promise<{ outputs: unknown[]; ret: "ok" | "quit" }> {
  const outputs: unknown[] = [];
  let r = await gen.next();
  while (!r.done) {
    outputs.push(r.value);
    r = await gen.next();
  }
  return { outputs, ret: r.value };
}

describe("dispatchActivity — script:", () => {
  test("sets baseline.currentScriptId on a known, uncompleted script", async () => {
    const game = makeGame({
      characters: [makeCharacter("alice")],
      scripts: [makeScript("001_intro")],
    });
    const ctx = makeCtx(game);

    const { ret } = await drain(dispatchActivity(ctx, "script:001_intro"));

    expect(ret).toBe("ok");
    expect(ctx.state.baseline.currentScriptId).toBe("001_intro");
    expect(ctx.state.baseline.beatIndex).toBe(0);
  });

  test("ignores unknown script id (no error, no state change)", async () => {
    const game = makeGame({
      characters: [makeCharacter("alice")],
      scripts: [makeScript("001_intro")],
    });
    const ctx = makeCtx(game);

    const { ret } = await drain(dispatchActivity(ctx, "script:nonexistent"));

    expect(ret).toBe("ok");
    expect(ctx.state.baseline.currentScriptId).toBeNull();
  });

  test("ignores already-completed script", async () => {
    const game = makeGame({
      characters: [makeCharacter("alice")],
      scripts: [makeScript("001_intro")],
    });
    const ctx = makeCtx(game);
    ctx.state.baseline.scripts["001_intro"] = { completed: true, selfSwitches: { A: false, B: false, C: false, D: false } };

    await drain(dispatchActivity(ctx, "script:001_intro"));

    expect(ctx.state.baseline.currentScriptId).toBeNull();
  });

  test("cannot dispatch a script whose authored requirements are locked", async () => {
    const game = makeGame({
      characters: [makeCharacter("alice")],
      scripts: [makeScript("secret", { requires: { switch: { name: "secret" } } })],
    });
    const ctx = makeCtx(game);

    await drain(dispatchActivity(ctx, "script:secret"));

    expect(ctx.state.baseline.currentScriptId).toBeNull();
  });

  test("onScriptSelect first-wins redirects to a different script", async () => {
    const redirector: Module = {
      id: "redirector",
      onScriptSelect: (_ctx, requested) =>
        requested === "001_intro" ? "001_intro_alt" : undefined,
    };
    const game = makeGame({
      characters: [makeCharacter("alice")],
      scripts: [makeScript("001_intro"), makeScript("001_intro_alt")],
      modules: [redirector],
    });
    const ctx = makeCtx(game);

    await drain(dispatchActivity(ctx, "script:001_intro"));

    expect(ctx.state.baseline.currentScriptId).toBe("001_intro_alt");
  });

  test("redirector targeting an unknown script id falls back to no-op", async () => {
    const redirector: Module = {
      id: "redirector",
      onScriptSelect: () => "phantom",
    };
    const game = makeGame({
      characters: [makeCharacter("alice")],
      scripts: [makeScript("001_intro")],
      modules: [redirector],
    });
    const ctx = makeCtx(game);

    await drain(dispatchActivity(ctx, "script:001_intro"));

    expect(ctx.state.baseline.currentScriptId).toBeNull();
  });
});

describe("dispatchActivity — action:", () => {
  test("dispatches kindless action by applying effects directly", async () => {
    const action = makeAction("gift_flower", {
      effects: { characterStats: { alice: { affection: 1 } } },
    });
    const game = makeGame({
      characters: [makeCharacter("alice")],
      actions: [action],
    });
    const ctx = makeCtx(game);

    await drain(dispatchActivity(ctx, "action:gift_flower"));

    expect(ctx.state.baseline.characters.alice!.stats.affection).toBe(1);
  });

  test("dispatches kinded action through actionHandlerRegistry", async () => {
    let handlerCallCount = 0;
    const mod: Module = {
      id: "mymod",
      actionHandlers: {
        custom: ({ action }) => {
          handlerCallCount++;
          return {
            deltas: { characterStats: { alice: { affection: 2 } } },
            narrations: [`handler ran for ${action.id}`],
          };
        },
      },
    };
    const game = makeGame({
      characters: [makeCharacter("alice")],
      actions: [makeAction("special", { kind: "useItem" as const })],
      modules: [
        // alias `useItem` to `custom` — but useItem is already taken by
        // baseline. Use a fresh non-conflicting kind via cast.
      ],
    });
    // Build a fresh game with the custom-kind action
    const game2 = makeGame({
      characters: [makeCharacter("alice")],
      actions: [
        // Cast: engine's Action.kind is a string-literal union, but the
        // engine dispatch logic accepts any string. Tests confirm that.
        { id: "do_thing", title: "t", cost: 1, kind: "custom" as never },
      ],
      modules: [mod],
    });
    void game;
    const ctx = makeCtx(game2);

    await drain(dispatchActivity(ctx, "action:do_thing"));

    expect(handlerCallCount).toBe(1);
    expect(ctx.state.baseline.characters.alice!.stats.affection).toBe(2);
    expect(ctx.state.runtime.pendingNarrations).toContain(
      "handler ran for do_thing",
    );
  });

  test("ignores unknown action id", async () => {
    const ctx = makeCtx(
      makeGame({
        characters: [makeCharacter("alice")],
        actions: [makeAction("rest")],
      }),
    );

    const { ret } = await drain(dispatchActivity(ctx, "action:nonexistent"));

    expect(ret).toBe("ok");
    expect(ctx.state.baseline.characters.alice!.stats.affection).toBe(0);
  });

  test("respects requires — gated action does not run", async () => {
    const action = makeAction("vip_gift", {
      effects: { characterStats: { alice: { affection: 5 } } },
      requires: { affection: { character: "alice", min: 3 } },
    });
    const game = makeGame({
      characters: [makeCharacter("alice")],
      actions: [action],
    });
    const ctx = makeCtx(game);

    await drain(dispatchActivity(ctx, "action:vip_gift"));
    expect(ctx.state.baseline.characters.alice!.stats.affection).toBe(0);
  });

  test("respects requires — gate satisfied, action runs", async () => {
    const action = makeAction("vip_gift", {
      effects: { characterStats: { alice: { affection: 5 } } },
      requires: { affection: { character: "alice", min: 3 } },
    });
    const game = makeGame({
      characters: [
        makeCharacter("alice", { stats: { affection: { initial: 3 } } }),
      ],
      actions: [action],
    });
    const ctx = makeCtx(game);

    await drain(dispatchActivity(ctx, "action:vip_gift"));
    expect(ctx.state.baseline.characters.alice!.stats.affection).toBe(8);
  });
});

describe("dispatchActivity — hook composition", () => {
  test("onActionDispatch can cancel the action", async () => {
    const tracker = trackerModule();
    const canceller: Module = {
      id: "canceller",
      onActionDispatch: () => "cancel",
    };
    const action = makeAction("forbidden", {
      effects: { characterStats: { alice: { affection: 100 } } },
    });
    const game = makeGame({
      characters: [makeCharacter("alice")],
      actions: [action],
      modules: [tracker.module, canceller],
    });
    const ctx = makeCtx(game);

    await drain(dispatchActivity(ctx, "action:forbidden"));

    expect(ctx.state.baseline.characters.alice!.stats.affection).toBe(0);
    // onActionComplete should NOT fire on cancel
    expect(
      tracker.events.find((e) => e.hook === "onActionComplete"),
    ).toBeUndefined();
  });

  test("onActionDispatch can substitute an alternate action", async () => {
    const substitute = makeAction("alt", {
      effects: { characterStats: { alice: { affection: 7 } } },
    });
    const subber: Module = {
      id: "subber",
      onActionDispatch: () => substitute,
    };
    const game = makeGame({
      characters: [makeCharacter("alice")],
      actions: [
        makeAction("original", { effects: { characterStats: { alice: { affection: 1 } } } }),
        substitute,
      ],
      modules: [subber],
    });
    const ctx = makeCtx(game);

    await drain(dispatchActivity(ctx, "action:original"));

    expect(ctx.state.baseline.characters.alice!.stats.affection).toBe(7);
  });

  test("hook ordering: dispatch → mutate → complete", async () => {
    const tracker = trackerModule();
    const action = makeAction("rest", {
      effects: { characterStats: { alice: { affection: 1 } } },
    });
    const game = makeGame({
      characters: [makeCharacter("alice")],
      actions: [action],
      modules: [tracker.module],
    });
    const ctx = makeCtx(game);

    await drain(dispatchActivity(ctx, "action:rest"));

    const seq = tracker.events.map((e) => e.hook);
    expect(seq).toEqual([
      "onActionDispatch",
      "onStateMutated",
      "onActionComplete",
    ]);
  });
});

describe("dispatchActivity — dynamic activity resolution via lastHubActivities", () => {
  test("synthesizes Action from HubActivity (actionKind + payload)", async () => {
    let received: { kind?: string; payload?: unknown; aiTags?: string[] } = {};
    const mod: Module = {
      id: "mymod",
      provides: ["sengoku-raid:move"],
      actionHandlers: {
        "sengoku-raid:move": ({ action }) => {
          received = {
            kind: action.kind,
            payload: action.payload,
            aiTags: action.aiTags,
          };
          return {};
        },
      },
    };
    const game = makeGame({
      characters: [makeCharacter("alice")],
      modules: [mod],
    });
    const ctx = makeCtx(game);
    // Simulate fireOnHubBuild recording the snapshot:
    ctx.state.runtime.lastHubActivities = [
      {
        id: "move:crossroads",
        kind: "action",
        title: "→ crossroads",
        cost: 0,
        available: true,
        actionKind: "sengoku-raid:move",
        aiTags: ["exploration", "progression"],
        payload: { zoneId: "crossroads" },
      },
    ];

    await drain(dispatchActivity(ctx, "move:crossroads"));

    expect(received.kind).toBe("sengoku-raid:move");
    expect(received.payload).toEqual({ zoneId: "crossroads" });
    expect(received.aiTags).toEqual(["exploration", "progression"]);
  });

  test("dispatches even when available:false — handler decides denial", async () => {
    // The HubActivity's `available: false` is for UI display. The
    // handler still runs when the player picks the activity, so it
    // can surface a denial narration explaining WHY it's locked.
    let called = 0;
    const mod: Module = {
      id: "mymod",
      provides: ["m:rest"],
      actionHandlers: {
        "m:rest": () => {
          called++;
          return { narrations: ["denied: not actually unavailable"] };
        },
      },
    };
    const ctx = makeCtx(
      makeGame({
        characters: [makeCharacter("alice")],
        modules: [mod],
      }),
    );
    ctx.state.runtime.lastHubActivities = [
      {
        id: "rest",
        kind: "action",
        title: "rest",
        cost: 0,
        available: false,
        actionKind: "m:rest",
      },
    ];

    await drain(dispatchActivity(ctx, "rest"));
    expect(called).toBe(1);
    expect(ctx.state.runtime.pendingNarrations).toContain(
      "denied: not actually unavailable",
    );
  });

  test("unknown activity id is silent no-op", async () => {
    const ctx = makeCtx(
      makeGame({ characters: [makeCharacter("alice")] }),
    );
    const { ret } = await drain(dispatchActivity(ctx, "ghost-activity"));
    expect(ret).toBe("ok");
  });
});

describe("dispatchActivity — moveToMap (baseline-provided handler)", () => {
  test("dispatches the selected event page when two routes share one target", async () => {
    const game = makeGame({
      characters: [makeCharacter("alice")],
      switches: [{ id: "sealed_door_open", initial: false }],
      maps: [
        {
          id: "gate",
          name: "門",
          description: "",
          placements: [
            {
              id: "sealed-door",
              at: { x: 0, y: 0 },
              z: 0,
              footprint: { width: 1, height: 1 },
              collision: "trigger",
              visible: true,
              resource: { kind: "map", id: "inner" },
              events: [{
                id: "enter",
                trigger: "interact",
                label: "封じた扉",
                requires: { switch: { name: "sealed_door_open", eq: true } },
                lockedHint: "この扉は閉ざされている。",
                order: 0,
              }],
            },
            {
              id: "open-door",
              at: { x: 1, y: 0 },
              z: 0,
              footprint: { width: 1, height: 1 },
              collision: "trigger",
              visible: true,
              resource: { kind: "map", id: "inner" },
              events: [{ id: "enter", trigger: "interact", label: "開いた扉", order: 0 }],
            },
          ],
        },
        { id: "inner", name: "内側", description: "" },
      ],
    });
    const ctx = makeCtx(game);
    ctx.state.baseline.currentMapId = "gate";
    const activities = collectMapActivities(ctx);
    const sealed = activities.find((activity) => activity.title === "封じた扉")!;
    const open = activities.find((activity) => activity.title === "開いた扉")!;
    expect(sealed.id).not.toBe(open.id);
    expect(sealed.payload?.routeKey).not.toBe(open.payload?.routeKey);

    ctx.state.runtime.lastHubActivities = activities;
    await drain(dispatchActivity(ctx, open.id));
    expect(ctx.state.baseline.currentMapId).toBe("inner");

    ctx.state.baseline.currentMapId = "gate";
    ctx.state.runtime.lastHubActivities = activities;
    await drain(dispatchActivity(ctx, sealed.id));
    expect(ctx.state.baseline.currentMapId).toBe("gate");
    expect(ctx.state.runtime.pendingNarrations).toContain("この扉は閉ざされている。");
  });

  test("synthesized move activity transitions currentMapId", async () => {
    const game = makeGame({
      characters: [makeCharacter("alice")],
      maps: [
        {
          id: "home",
          name: "家",
          description: "",
          connections: [{ dir: "外", target: "street" }],
        },
        {
          id: "street",
          name: "街",
          description: "",
          bg: "assets/backgrounds/street",
        },
      ],
    });
    const ctx = makeCtx(game);
    ctx.state.baseline.currentMapId = "home";
    // Simulate the hub having yielded a move activity (what
    // buildMapHubSnapshot would emit) so dynamic-activity resolution
    // can find it.
    ctx.state.runtime.lastHubActivities = [
      {
        id: "move:street",
        kind: "action",
        title: "→ 街",
        cost: 0,
        available: true,
        actionKind: "moveToMap",
        payload: { to: "street" },
      },
    ];
    const { ret } = await drain(dispatchActivity(ctx, "move:street"));
    expect(ret).toBe("ok");
    expect(ctx.state.baseline.currentMapId).toBe("street");
    expect(ctx.state.baseline.visuals.bg).toBe("assets/backgrounds/street");
  });

  test("a locked connection cannot be crossed by submitting its activity id", async () => {
    const game = makeGame({
      characters: [makeCharacter("alice")],
      switches: [{ id: "gate_open", initial: false }],
      maps: [
        {
          id: "gate",
          name: "門",
          description: "",
          connections: [{
            dir: "奥",
            target: "inner",
            requires: { switch: { name: "gate_open" } },
            lockedHint: "門は閉ざされている。",
          }],
        },
        { id: "inner", name: "内側", description: "" },
      ],
    });
    const ctx = makeCtx(game);
    ctx.state.baseline.currentMapId = "gate";
    ctx.state.runtime.lastHubActivities = [{
      id: "move:inner",
      kind: "action",
      title: "→ 内側",
      cost: 0,
      available: false,
      lockedReason: "門は閉ざされている。",
      actionKind: "moveToMap",
      payload: { to: "inner" },
    }];

    await drain(dispatchActivity(ctx, "move:inner"));

    expect(ctx.state.baseline.currentMapId).toBe("gate");
    expect(ctx.state.runtime.pendingNarrations).toEqual(["門は閉ざされている。"]);
  });
});
