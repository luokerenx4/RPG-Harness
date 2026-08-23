import { describe, expect, test } from "bun:test";
import {
  compareChoiceSearchAssessment,
  searchForChoice,
  searchForScript,
} from "./search";
import { makeCharacter, makeGame, makeScript, makeState } from "./test-utils";

describe("choice state-space search", () => {
  test("finds the shortest public-input path to a stable authored choice", async () => {
    const game = makeGame({
      characters: [makeCharacter("alice")],
      scripts: [
        makeScript("detour", {
          beats: [{ type: "narration", text: "Long way" }],
        }),
        makeScript("target", {
          beats: [
            { type: "narration", text: "Approach" },
            {
              type: "choice",
              id: "crossroads",
              prompt: "Where?",
              options: [
                { id: "left", text: "Left" },
                { id: "right", text: "Right" },
              ],
            },
          ],
        }),
      ],
    });

    const result = await searchForChoice(
      game,
      makeState(game),
      { scriptId: "target", choiceId: "crossroads" },
      { maxNodes: 20, maxSteps: 20 },
    );

    expect(result.found).toBe(true);
    expect(result.reason).toBe("found");
    expect(result.inputs).toEqual([
      { type: "select", scriptId: "target" },
      { type: "next" },
    ]);
    expect(result.output).toMatchObject({
      type: "choice",
      scriptId: "target",
      choiceId: "crossroads",
    });
  });

  test("finds and completes a script with no authored choice", async () => {
    const game = makeGame({
      characters: [makeCharacter("alice")],
      scripts: [
        makeScript("detour", { beats: [{ type: "narration", text: "Detour" }] }),
        makeScript("target", {
          beats: [
            { type: "narration", text: "First" },
            { type: "narration", text: "Last" },
          ],
        }),
      ],
    });

    const result = await searchForScript(
      game,
      makeState(game),
      { scriptId: "target" },
      { maxNodes: 20, maxSteps: 20 },
    );

    expect(result.found).toBe(true);
    expect(result.inputs).toEqual([
      { type: "select", scriptId: "target" },
      { type: "next" },
      { type: "next" },
    ]);
    expect(result.state.baseline.scripts.target?.completed).toBe(true);
  });

  test("prefers recovery over unrelated churn when an authored route is closed", async () => {
    const game = makeGame({
      variables: [
        { id: "rested", type: "number", initial: 0 },
        { id: "churn", type: "number", initial: 0 },
      ],
      scripts: [makeScript("target", {
        ai: { relatedActivityIds: ["depart:mountain"] },
      })],
      runFn: async function* (ctx) {
        while (ctx.state.baseline.scripts.target?.completed !== true) {
          const restedValue = Number(ctx.state.baseline.variables.rested ?? 0);
          const rested = restedValue >= 2;
          if (restedValue === 1) {
            yield { type: "narration" as const, text: "rest" };
            ctx.state.baseline.variables.rested = 2;
            continue;
          }
          const input = yield {
            type: "hubMenu" as const,
            snapshot: {
              day: 1,
              maxDay: 1,
              slot: 0,
              slotName: "day",
              slotsPerDay: 1,
              stats: [],
              affections: [],
              activities: rested
                ? [{
                    id: "depart:mountain",
                    kind: "action" as const,
                    title: "Depart",
                    cost: 0,
                    available: true,
                  }]
                : [
                    {
                      id: "sell:trinket",
                      kind: "action" as const,
                      title: "Sell",
                      cost: 0,
                      available: true,
                    },
                    {
                      id: "rest",
                      kind: "action" as const,
                      title: "Rest",
                      cost: 0,
                      available: true,
                    },
                  ],
            },
          };
          if (input.type !== "doActivity") continue;
          if (input.id === "rest") {
            ctx.state.baseline.variables.rested = 1;
            yield { type: "narration" as const, text: "rest" };
            ctx.state.baseline.variables.rested = 2;
            continue;
          }
          if (input.id === "sell:trinket") {
            ctx.state.baseline.variables.churn =
              Number(ctx.state.baseline.variables.churn ?? 0) + 1;
          }
          if (input.id === "depart:mountain") {
            ctx.state.baseline.scripts.target = {
              completed: true,
              selfSwitches: { A: false, B: false, C: false, D: false },
            };
          }
        }
      },
    });

    const result = await searchForScript(
      game,
      makeState(game),
      { scriptId: "target" },
      { maxNodes: 10, maxSteps: 10 },
    );

    expect(result.found).toBe(true);
    expect(result.inputs).toEqual([
      { type: "doActivity", id: "rest" },
      { type: "next" },
      { type: "doActivity", id: "depart:mountain" },
    ]);
    expect(result.state.baseline.variables.churn).toBe(0);
  });

  test("follows machine-readable gates on a locked authored activity", async () => {
    const game = makeGame({
      variables: [{ id: "churn", type: "number", initial: 0 }],
      scripts: [makeScript("target", {
        ai: { relatedActivityIds: ["buy:intel"] },
      })],
      runFn: async function* (ctx) {
        while (ctx.state.baseline.scripts.target?.completed !== true) {
          const coins = ctx.state.baseline.inventory.coin ?? 0;
          const input = yield {
            type: "hubMenu" as const,
            snapshot: {
              day: 1,
              maxDay: 1,
              slot: 0,
              slotName: "day",
              slotsPerDay: 1,
              stats: [],
              affections: [],
              activities: [
                {
                  id: "churn",
                  kind: "action" as const,
                  title: "Churn",
                  cost: 0,
                  available: true,
                },
                {
                  id: "earn:coin",
                  kind: "action" as const,
                  title: "Earn",
                  cost: 0,
                  available: true,
                },
                {
                  id: "sell:key",
                  kind: "action" as const,
                  title: "Sell required key",
                  cost: 0,
                  available: (ctx.state.baseline.inventory.key ?? 0) > 0,
                },
                {
                  id: "buy:intel",
                  kind: "action" as const,
                  title: "Buy",
                  cost: 0,
                  available: coins >= 2,
                  requires: {
                    all: [
                      { inventory: { itemId: "coin", min: 2 } },
                      { inventory: { itemId: "key", min: 1 } },
                    ],
                  },
                },
              ],
            },
          };
          if (input.type !== "doActivity") continue;
          if (input.id === "churn") {
            ctx.state.baseline.variables.churn =
              Number(ctx.state.baseline.variables.churn ?? 0) + 1;
          }
          if (input.id === "earn:coin") {
            ctx.state.baseline.inventory.coin = coins + 1;
          }
          if (input.id === "sell:key") {
            delete ctx.state.baseline.inventory.key;
            ctx.state.baseline.inventory.coin = coins + 2;
          }
          if (
            input.id === "buy:intel" &&
            coins >= 2 &&
            (ctx.state.baseline.inventory.key ?? 0) >= 1
          ) {
            ctx.state.baseline.scripts.target = {
              completed: true,
              selfSwitches: { A: false, B: false, C: false, D: false },
            };
          }
        }
      },
    });

    const result = await searchForScript(
      game,
      (() => {
        const state = makeState(game);
        state.baseline.inventory.key = 1;
        return state;
      })(),
      { scriptId: "target" },
      { maxNodes: 10, maxSteps: 10 },
    );

    expect(result.found).toBe(true);
    expect(result.inputs).toEqual([
      { type: "doActivity", id: "earn:coin" },
      { type: "doActivity", id: "earn:coin" },
      { type: "doActivity", id: "buy:intel" },
    ]);
    expect(result.state.baseline.variables.churn).toBe(0);
  });

  test("expands a guidance script gate into its authored prerequisites", async () => {
    const game = makeGame({
      characters: [makeCharacter("mio")],
      scripts: [
        makeScript("conclusion", {
          requires: { affection: { character: "mio", min: 3 } },
        }),
        makeScript("target", {
          ai: { relatedActivityIds: ["invite:kagari"] },
        }),
      ],
      runFn: async function* () {
        while (true) {
          yield {
            type: "hubMenu" as const,
            snapshot: {
              day: 1,
              maxDay: 1,
              slot: 0,
              slotName: "day",
              slotsPerDay: 1,
              stats: [],
              affections: [],
              activities: [{
                id: "invite:kagari",
                kind: "action" as const,
                title: "Invite",
                cost: 0,
                available: false,
                requires: { scriptCompleted: "conclusion" },
              }],
            },
          };
        }
      },
    });
    const state = makeState(game);
    state.baseline.characters.mio!.stats.affection = 1;

    const result = await searchForScript(
      game,
      state,
      { scriptId: "target" },
      { maxNodes: 1, maxSteps: 5 },
    );

    expect(result.closest.guidanceRequirement).toMatchObject({
      activityId: "invite:kagari",
      satisfiedRequirements: 0,
      totalRequirements: 1,
      progress: 1 / 6,
    });

    const completedState = makeState(game);
    completedState.baseline.characters.mio!.stats.affection = 0;
    completedState.baseline.scripts.conclusion = {
      completed: true,
      selfSwitches: { A: false, B: false, C: false, D: false },
    };
    const completed = await searchForScript(
      game,
      completedState,
      { scriptId: "target" },
      { maxNodes: 1, maxSteps: 5 },
    );
    expect(completed.closest.guidanceRequirement).toMatchObject({
      satisfied: true,
      progress: 1,
    });
  });

  test("prioritizes an available script that resolves the active guidance gate", async () => {
    const game = makeGame({
      scripts: [
        makeScript("conclusion"),
        makeScript("target", {
          ai: { relatedActivityIds: ["invite:kagari"] },
        }),
      ],
      runFn: async function* (ctx) {
        while (ctx.state.baseline.scripts.target?.completed !== true) {
          const concluded = ctx.state.baseline.scripts.conclusion?.completed === true;
          const input = yield {
            type: "hubMenu" as const,
            snapshot: {
              day: 1,
              maxDay: 1,
              slot: 0,
              slotName: "day",
              slotsPerDay: 1,
              stats: [],
              affections: [],
              activities: [
                {
                  id: "churn",
                  kind: "action" as const,
                  title: "Churn",
                  cost: 0,
                  available: true,
                },
                {
                  id: "script:conclusion",
                  kind: "script" as const,
                  title: "Conclude",
                  cost: 0,
                  available: !concluded,
                },
                {
                  id: "invite:kagari",
                  kind: "action" as const,
                  title: "Invite",
                  cost: 0,
                  available: concluded,
                  requires: { scriptCompleted: "conclusion" },
                },
              ],
            },
          };
          if (input.type !== "doActivity") continue;
          if (input.id === "script:conclusion") {
            ctx.state.baseline.scripts.conclusion = {
              completed: true,
              selfSwitches: { A: false, B: false, C: false, D: false },
            };
          }
          if (input.id === "invite:kagari" && concluded) {
            ctx.state.baseline.scripts.target = {
              completed: true,
              selfSwitches: { A: false, B: false, C: false, D: false },
            };
          }
        }
      },
    });

    const result = await searchForScript(
      game,
      makeState(game),
      { scriptId: "target" },
      { maxNodes: 4, maxSteps: 5 },
    );

    expect(result.found).toBe(true);
    expect(result.inputs).toEqual([
      { type: "doActivity", id: "script:conclusion" },
      { type: "doActivity", id: "invite:kagari" },
    ]);
  });

  test("remembers an authored gate while preparation moves to another surface", async () => {
    const game = makeGame({
      scripts: [makeScript("target", {
        ai: { relatedActivityIds: ["buy:intel"] },
      })],
      runFn: async function* (ctx) {
        while (ctx.state.baseline.scripts.target?.completed !== true) {
          const away = ctx.state.baseline.switches.away === true;
          const coins = ctx.state.baseline.inventory.coin ?? 0;
          const input = yield {
            type: "hubMenu" as const,
            snapshot: {
              day: 1,
              maxDay: 1,
              slot: 0,
              slotName: "day",
              slotsPerDay: 1,
              stats: [],
              affections: [],
              activities: away
                ? ctx.state.baseline.switches.carrying === true
                  ? [{ id: "return", kind: "action" as const, title: "Return", cost: 0, available: true }]
                  : [
                      { id: "churn", kind: "action" as const, title: "Churn", cost: 0, available: true },
                      {
                        id: "work",
                        kind: "action" as const,
                        title: "Work",
                        cost: 0,
                        available: true,
                        forecast: {
                          metrics: [{ id: "coin", label: "Coin", value: 1 }],
                          effects: { inventory: { coin: 1 } },
                        },
                      },
                    ]
                : [
                    { id: "depart", kind: "action" as const, title: "Depart", cost: 0, available: true },
                    {
                      id: "buy:intel",
                      kind: "action" as const,
                      title: "Buy",
                      cost: 0,
                      available: coins >= 1,
                      requires: { inventory: { itemId: "coin", min: 1 } },
                    },
                  ],
            },
          };
          if (input.type !== "doActivity") continue;
          if (input.id === "depart") ctx.state.baseline.switches.away = true;
          if (input.id === "work") {
            ctx.state.baseline.switches.carrying = true;
          }
          if (input.id === "return") {
            ctx.state.baseline.inventory.coin = 1;
            ctx.state.baseline.switches.away = false;
          }
          if (input.id === "churn") {
            ctx.state.baseline.variables.churn =
              Number(ctx.state.baseline.variables.churn ?? 0) + 1;
          }
          if (input.id === "buy:intel" && coins >= 1) {
            ctx.state.baseline.scripts.target = {
              completed: true,
              selfSwitches: { A: false, B: false, C: false, D: false },
            };
          }
        }
      },
    });

    const result = await searchForScript(
      game,
      makeState(game),
      { scriptId: "target" },
      { maxNodes: 5, maxSteps: 10 },
    );

    expect(result.found).toBe(true);
    expect(result.inputs).toEqual([
      { type: "doActivity", id: "depart" },
      { type: "doActivity", id: "work" },
      { type: "doActivity", id: "return" },
      { type: "doActivity", id: "buy:intel" },
    ]);
    expect(result.state.baseline.variables.churn ?? 0).toBe(0);
  });

  test("keeps breadcrumb progress monotonic across repeated earlier activities", async () => {
    const game = makeGame({
      scripts: [makeScript("target", {
        ai: { relatedActivityIds: ["depart", "cross", "collect", "buy"] },
      })],
      runFn: async function* (ctx) {
        while (ctx.state.baseline.scripts.target?.completed !== true) {
          const phase = Number(ctx.state.baseline.variables.phase ?? 0);
          const input = yield {
            type: "hubMenu" as const,
            snapshot: {
              day: 1,
              maxDay: 1,
              slot: 0,
              slotName: "day",
              slotsPerDay: 1,
              stats: [],
              affections: [],
              activities: phase === 0
                ? [{ id: "depart", kind: "action" as const, title: "Depart", cost: 0, available: true }]
                : phase === 1
                  ? [{ id: "cross", kind: "action" as const, title: "Cross", cost: 0, available: true }]
                  : phase === 2
                    ? [
                        { id: "depart", kind: "action" as const, title: "Old depart", cost: 0, available: true },
                        { id: "collect", kind: "action" as const, title: "Collect", cost: 0, available: true },
                      ]
                    : [{ id: "buy", kind: "action" as const, title: "Buy", cost: 0, available: true }],
            },
          };
          if (input.type !== "doActivity") continue;
          if (input.id === "depart" && phase === 0) ctx.state.baseline.variables.phase = 1;
          if (input.id === "cross") ctx.state.baseline.variables.phase = 2;
          if (input.id === "collect") ctx.state.baseline.variables.phase = 3;
          if (input.id === "buy") {
            ctx.state.baseline.scripts.target = {
              completed: true,
              selfSwitches: { A: false, B: false, C: false, D: false },
            };
          }
        }
      },
    });

    const result = await searchForScript(
      game,
      makeState(game),
      { scriptId: "target" },
      { maxNodes: 5, maxSteps: 10 },
    );

    expect(result.found).toBe(true);
    expect(result.inputs).toEqual([
      { type: "doActivity", id: "depart" },
      { type: "doActivity", id: "cross" },
      { type: "doActivity", id: "collect" },
      { type: "doActivity", id: "buy" },
    ]);
  });

  test("materializes a continuation boundary beyond a completed breadcrumb route", async () => {
    const game = makeGame({
      variables: [{ id: "phase", type: "number", initial: 0 }],
      scripts: [makeScript("target", {
        ai: { relatedActivityIds: ["invite", "depart"] },
      })],
      runFn: async function* (ctx) {
        while (true) {
          const phase = Number(ctx.state.baseline.variables.phase ?? 0);
          if (phase >= 4) {
            yield {
              type: "choice" as const,
              scriptId: "target",
              choiceId: "promise",
              prompt: "Promise?",
              options: [{ id: "yes", text: "Yes", available: true }],
            };
            continue;
          }
          const activityId = ["invite", "depart", "strike", "cross"][phase]!;
          const input = yield {
            type: "hubMenu" as const,
            snapshot: {
              day: 1,
              maxDay: 1,
              slot: 0,
              slotName: "day",
              slotsPerDay: 1,
              stats: [],
              affections: [],
              activities: [{
                id: activityId,
                kind: "action" as const,
                title: activityId,
                cost: 0,
                available: true,
              }, {
                id: "wait",
                kind: "action" as const,
                title: "wait",
                cost: 0,
                available: true,
              }],
            },
          };
          if (input.type === "doActivity" && input.id === activityId) {
            ctx.state.baseline.variables.phase = phase + 1;
          }
        }
      },
    });

    const first = await searchForChoice(
      game,
      makeState(game),
      { scriptId: "target", choiceId: "promise" },
      { maxNodes: 3, maxSteps: 20 },
    );
    expect(first).toMatchObject({
      found: false,
      reason: "max-nodes",
      closest: {
        guidanceProgress: 2,
        guidanceTotal: 2,
        guidancePlateauSteps: 1,
        guidanceBridgeProgress: 1,
        steps: 3,
      },
    });
    expect(first.closest.inputs).toEqual([
      { type: "doActivity", id: "invite" },
      { type: "doActivity", id: "depart" },
      { type: "doActivity", id: "strike" },
    ]);
    expect(first.state.baseline.variables.phase).toBe(3);
    expect(first.frontier).toMatchObject({
      closest: { outputType: "hubMenu" },
      state: { baseline: { variables: { phase: 3 } } },
    });
    expect(first.checkpoint).toMatchObject({
      schemaVersion: 1,
      totalExploredNodes: 3,
      queue: [expect.any(Object)],
    });

    const resumed = await searchForChoice(
      game,
      first.frontier!.state,
      { scriptId: "target", choiceId: "promise" },
      { maxNodes: 3, maxSteps: 20 },
    );
    expect(resumed.found).toBe(true);
    expect(resumed.inputs).toEqual([{ type: "doActivity", id: "cross" }]);
  });

  test("resumes sibling search branches after the best playable frontier is exhausted", async () => {
    const game = makeGame({
      variables: [
        { id: "phase", type: "number", initial: 0 },
        { id: "progress", type: "number", initial: 0 },
      ],
      scripts: [makeScript("target", {
        requires: { variable: { name: "progress", min: 1 } },
      })],
      runFn: async function* (ctx) {
        while (true) {
          const phase = Number(ctx.state.baseline.variables.phase ?? 0);
          if (phase === 99) {
            yield { type: "gameEnd" as const, reason: "dead branch" };
            return;
          }
          if (phase === 21) {
            yield {
              type: "choice" as const,
              scriptId: "target",
              choiceId: "answer",
              prompt: "Answer?",
              options: [{ id: "yes", text: "Yes", available: true }],
            };
            continue;
          }
          const activities = phase === 0
            ? ["promising", "winning"]
            : phase === 10
              ? ["dead-a", "dead-b"]
              : ["advance", "idle"];
          const input = yield {
            type: "hubMenu" as const,
            snapshot: {
              day: 1,
              maxDay: 1,
              slot: 0,
              slotName: "day",
              slotsPerDay: 1,
              stats: [],
              affections: [],
              activities: activities.map((id) => ({
                id,
                kind: "action" as const,
                title: id,
                cost: 0,
                available: true,
              })),
            },
          };
          if (input.type !== "doActivity") continue;
          if (input.id === "promising") {
            ctx.state.baseline.variables.progress = 1;
            ctx.state.baseline.variables.phase = 10;
          } else if (input.id === "winning") {
            ctx.state.baseline.variables.phase = 20;
          } else if (input.id.startsWith("dead-")) {
            ctx.state.baseline.variables.phase = 99;
          } else if (input.id === "advance") {
            ctx.state.baseline.variables.progress = 1;
            ctx.state.baseline.variables.phase = 21;
          }
        }
      },
    });
    const source = makeState(game);
    const target = { scriptId: "target", choiceId: "answer" };
    const first = await searchForChoice(game, source, target, {
      maxNodes: 1,
      maxSteps: 20,
    });
    expect(first).toMatchObject({
      found: false,
      reason: "max-nodes",
      frontier: {
        inputs: [{ type: "doActivity", id: "promising" }],
        closest: { satisfiedRequirements: 1 },
      },
      checkpoint: { totalExploredNodes: 1 },
    });

    const singleBranch = await searchForChoice(game, first.frontier!.state, target, {
      maxNodes: 20,
      maxSteps: 20,
    });
    expect(singleBranch).toMatchObject({ found: false, reason: "exhausted" });

    const serialized = JSON.parse(JSON.stringify(first.checkpoint));
    const resumed = await searchForChoice(game, source, target, {
      checkpoint: serialized,
      maxNodes: 20,
      maxSteps: 20,
    });
    expect(resumed).toMatchObject({ found: true, reason: "found" });
    expect(resumed.inputs).toEqual([
      { type: "doActivity", id: "winning" },
      { type: "doActivity", id: "advance" },
    ]);
  });

  test("separates a terminal diagnostic closest state from an expandable frontier", async () => {
    const game = makeGame({
      variables: [
        { id: "phase", type: "number", initial: 0 },
        { id: "progress", type: "number", initial: 0 },
      ],
      scripts: [makeScript("target", {
        requires: { variable: { name: "progress", min: 1 } },
      })],
      runFn: async function* (ctx) {
        while (true) {
          const phase = Number(ctx.state.baseline.variables.phase ?? 0);
          if (phase === 99) {
            yield { type: "gameEnd" as const, reason: "sealed" };
            return;
          }
          if (phase >= 2) {
            yield {
              type: "choice" as const,
              scriptId: "target",
              choiceId: "answer",
              prompt: "Answer?",
              options: [{ id: "yes", text: "Yes", available: true }],
            };
            continue;
          }
          const input = yield {
            type: "hubMenu" as const,
            snapshot: {
              day: 1,
              maxDay: 1,
              slot: 0,
              slotName: "day",
              slotsPerDay: 1,
              stats: [],
              affections: [],
              activities: phase === 0
                ? [
                    { id: "seal", kind: "action" as const, title: "Seal", cost: 0, available: true },
                    { id: "wait", kind: "action" as const, title: "Wait", cost: 0, available: true },
                  ]
                : [
                    { id: "advance", kind: "action" as const, title: "Advance", cost: 0, available: true },
                    { id: "idle", kind: "action" as const, title: "Idle", cost: 0, available: true },
                  ],
            },
          };
          if (input.type !== "doActivity") continue;
          if (input.id === "seal") {
            ctx.state.baseline.variables.progress = 1;
            ctx.state.baseline.variables.phase = 99;
          } else if (input.id === "wait") {
            ctx.state.baseline.variables.phase = 1;
          } else if (input.id === "advance") {
            ctx.state.baseline.variables.progress = 1;
            ctx.state.baseline.variables.phase = 2;
          }
        }
      },
    });

    const first = await searchForChoice(
      game,
      makeState(game),
      { scriptId: "target", choiceId: "answer" },
      { maxNodes: 2, maxSteps: 20 },
    );

    expect(first).toMatchObject({
      found: false,
      reason: "max-nodes",
      closest: { outputType: "gameEnd", satisfiedRequirements: 1 },
      frontier: {
        inputs: [{ type: "doActivity", id: "wait" }],
        closest: { outputType: "hubMenu", satisfiedRequirements: 0 },
      },
    });
    const resumed = await searchForChoice(
      game,
      first.frontier!.state,
      { scriptId: "target", choiceId: "answer" },
      { maxNodes: 4, maxSteps: 20 },
    );
    expect(resumed).toMatchObject({ found: true, reason: "found" });
    expect(resumed.inputs).toEqual([{ type: "doActivity", id: "advance" }]);
  });

  test("reports a bounded miss without mutating the source state", async () => {
    const game = makeGame({
      characters: [makeCharacter("alice")],
      scripts: [makeScript("only", {
        beats: [{ type: "narration", text: "Nothing" }],
      })],
    });
    const state = makeState(game);
    const before = structuredClone(state);
    const result = await searchForChoice(
      game,
      state,
      { scriptId: "missing", choiceId: "missing" },
      { maxNodes: 10, maxSteps: 10 },
    );

    expect(result.found).toBe(false);
    expect(result.reason).toBe("exhausted");
    expect(state).toEqual(before);
  });

  test("reports renderer-neutral progress at a caller-selected node interval", async () => {
    const game = makeGame({
      characters: [makeCharacter("alice")],
      scripts: [makeScript("only", {
        beats: [{
          type: "choice",
          id: "fork",
          options: [{ id: "a", text: "A" }, { id: "b", text: "B" }],
        }],
      })],
    });
    const updates: number[] = [];

    await searchForChoice(
      game,
      makeState(game),
      { scriptId: "missing", choiceId: "missing" },
      {
        maxNodes: 10,
        maxSteps: 3,
        progressEvery: 1,
        onProgress: (progress) => updates.push(progress.exploredNodes),
      },
    );

    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0]).toBe(1);
  });

  test("follows explicit-requirement plateaus deeply enough to change state", async () => {
    const shallow = {
      inputs: [{ type: "next" as const }],
      steps: 1,
      progress: 0,
      satisfiedRequirements: 0,
      totalRequirements: 1,
      targetScriptCompleted: false,
      targetScriptActive: false,
      requirements: [],
      outputType: "hubMenu" as const,
    };
    const deep = { ...shallow, inputs: Array(5).fill({ type: "next" as const }), steps: 5 };

    expect(compareChoiceSearchAssessment(
      { ...deep, searchBridgeProgress: 5 },
      { ...shallow, searchBridgeProgress: 1 },
    )).toBeGreaterThan(0);
    expect(compareChoiceSearchAssessment(
      { ...deep, inputs: Array(120).fill({ type: "next" as const }), steps: 120, searchBridgeProgress: 16 },
      { ...deep, inputs: Array(96).fill({ type: "next" as const }), steps: 96, searchBridgeProgress: 16 },
    )).toBeLessThan(0);
    expect(compareChoiceSearchAssessment(
      { ...deep, satisfiedRequirements: 1 },
      { ...shallow, satisfiedRequirements: 1 },
    )).toBeLessThan(0);
    expect(compareChoiceSearchAssessment(
      { ...deep, totalRequirements: 0 },
      { ...shallow, totalRequirements: 0 },
    )).toBeLessThan(0);
    const blockedGuidanceRequirement = {
      activityId: "invite:kagari",
      condition: { not: { switch: { name: "official_duty" } } } as const,
      satisfied: false,
      progress: 0,
      satisfiedRequirements: 0,
      totalRequirements: 1,
      regressionsFromSource: 0,
    };
    expect(compareChoiceSearchAssessment(
      {
        ...deep,
        totalRequirements: 0,
        guidanceRequirement: blockedGuidanceRequirement,
        searchBridgeProgress: 5,
      },
      {
        ...shallow,
        totalRequirements: 0,
        guidanceRequirement: blockedGuidanceRequirement,
        searchBridgeProgress: 1,
      },
    )).toBeGreaterThan(0);
    expect(compareChoiceSearchAssessment(
      {
        ...shallow,
        totalRequirements: 0,
        guidanceRequirement: blockedGuidanceRequirement,
      },
      { ...deep, totalRequirements: 0 },
    )).toBeGreaterThan(0);
    expect(compareChoiceSearchAssessment(
      { ...deep, totalRequirements: 0 },
      {
        ...shallow,
        totalRequirements: 0,
        guidanceRequirement: blockedGuidanceRequirement,
      },
    )).toBeLessThan(0);
    expect(compareChoiceSearchAssessment(
      {
        ...deep,
        totalRequirements: 0,
        guidanceProgress: 2,
        guidanceTotal: 2,
        guidanceBridgeProgress: 2,
      },
      {
        ...shallow,
        totalRequirements: 0,
        guidanceProgress: 2,
        guidanceTotal: 2,
        guidanceBridgeProgress: 0,
      },
    )).toBeGreaterThan(0);
    expect(compareChoiceSearchAssessment(
      { ...deep, outputType: "gameEnd" },
      deep,
    )).toBeLessThan(0);
    expect(compareChoiceSearchAssessment(
      { ...deep, targetScriptCompleted: true },
      deep,
      true,
    )).toBeGreaterThan(0);
    expect(compareChoiceSearchAssessment(
      { ...shallow, guidanceProgress: 3 },
      { ...deep, guidanceProgress: 1 },
      true,
    )).toBeGreaterThan(0);
  });

  test("caps repeated public decisions in a blocked search bridge", async () => {
    const game = makeGame({
      variables: [{ id: "ticks", type: "number", initial: 0 }],
      scripts: [makeScript("target", {
        requires: { switch: { name: "never" } },
      })],
      runFn: async function* (ctx) {
        while (true) {
          const input = yield {
            type: "hubMenu" as const,
            snapshot: {
              day: 1,
              maxDay: 1,
              slot: 0,
              slotName: "day",
              slotsPerDay: 1,
              stats: [],
              affections: [],
              activities: [{
                id: "wait",
                kind: "action" as const,
                title: "Wait",
                cost: 0,
                available: true,
              }],
            },
          };
          if (input.type === "doActivity" && input.id === "wait") {
            ctx.state.baseline.variables.ticks =
              Number(ctx.state.baseline.variables.ticks ?? 0) + 1;
          }
        }
      },
    });

    const result = await searchForScript(
      game,
      makeState(game),
      { scriptId: "target" },
      { maxNodes: 1, maxSteps: 6 },
    );

    expect(result.found).toBe(false);
    expect(result.closest.steps).toBe(6);
    expect(result.closest.searchBridgeProgress).toBe(3);
  });

  test("explains the closest state's satisfied and blocked requirements", async () => {
    const game = makeGame({
      characters: [makeCharacter("alice")],
      variables: [{ id: "pulse", type: "number", initial: 2 }],
      scripts: [makeScript("target", {
        requires: {
          all: [
            { variable: { name: "pulse", min: 5 } },
            { switch: { name: "loyal" } },
          ],
        },
        beats: [{
          type: "choice",
          id: "crossroads",
          options: [{ id: "only", text: "Only" }],
        }],
      })],
    });
    const state = makeState(game);
    state.baseline.switches.loyal = false;
    const result = await searchForChoice(
      game,
      state,
      { scriptId: "target", choiceId: "crossroads" },
      { maxNodes: 1, maxSteps: 10 },
    );

    expect(result.found).toBe(false);
    expect(result.closest).toMatchObject({
      satisfiedRequirements: 0,
      totalRequirements: 2,
      targetScriptActive: false,
      requirements: [
        {
          satisfied: false,
          progress: 0.25,
          reason: "pulse ≥ 5 が要る (現在 2)",
        },
        {
          satisfied: false,
          progress: 0,
          reason: "switch.loyal が要る",
        },
      ],
    });
  });
});
