import { describe, expect, test } from "bun:test";
import { createInitialState } from "./state";
import { runLoop } from "./runLoop";
import { makeGame } from "./test-utils";
import type { Game } from "./types";
import { dispatchActivity } from "./primitives";

const terminalGame: Game = {
  title: "terminal",
  characters: [],
  scripts: [],
  actions: [],
  modules: [],
  items: [],
  enemies: [],
  weapons: [],
  skills: [],
  maps: [],
  runFn: async function* () {
    yield { type: "gameEnd" as const };
  },
};

describe("runLoop terminal output", () => {
  test("retains the failed public action outside the successful trace", async () => {
    const game = makeGame({
      modules: [{
        id: "broken-actions",
        actionHandlers: {
          explode: ({ state }) => {
            state.runtime.lastHubActivities[0]!.title = "Corrupted after dispatch";
            throw new TypeError("forge overheated");
          },
        },
      }],
      runFn: async function* (ctx) {
        ctx.state.runtime.lastHubActivities = [{
          id: "forge",
          kind: "action",
          title: "Use forge",
          cost: 0,
          available: true,
          actionKind: "broken-actions:explode",
        }];
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
              id: "forge",
              kind: "action" as const,
              title: "Use forge",
              cost: 0,
              available: true,
              actionKind: "broken-actions:explode",
            }],
          },
        };
        if (input.type === "doActivity") yield* dispatchActivity(ctx, input.id);
      },
    });
    const result = await runLoop(
      game,
      createInitialState(game),
      async () => ({ type: "doActivity", id: "forge" }),
    );

    expect(result.reason).toBe("error");
    expect(result.error).toBe("forge overheated");
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]?.input).toBeNull();
    expect(result.failure).toMatchObject({
      phase: "input",
      name: "TypeError",
      message: "forge overheated",
      input: { type: "doActivity", id: "forge" },
      output: { type: "hubMenu" },
      activityDecision: {
        activityId: "forge",
        title: "Use forge",
        kind: "action",
        actionKind: "broken-actions:explode",
      },
    });
    expect(result.failure?.output?.type === "hubMenu" &&
      result.failure.output.snapshot.activities[0]?.title).toBe("Use forge");
    expect(result.finalState.runtime.lastHubActivities[0]?.title).toBe(
      "Corrupted after dispatch",
    );
    expect(result.failure?.stack).toContain("forge overheated");
  });

  test("stops at a caller-owned observable condition without claiming game completion", async () => {
    const game = makeGame({
      runFn: async function* (ctx) {
        yield { type: "narration" as const, text: "before" };
        ctx.state.baseline.variables.reached = 1;
        yield { type: "narration" as const, text: "boundary" };
        yield { type: "narration" as const, text: "after" };
      },
    });
    const result = await runLoop(
      game,
      createInitialState(game),
      async () => ({ type: "next" }),
      {
        stopWhen: (_entry, state) => state.baseline.variables.reached === 1,
      },
    );

    expect(result.reason).toBe("condition-met");
    expect(result.done).toBe(false);
    expect(result.trace.map(({ output }) =>
      output.type === "narration" ? output.text : output.type
    )).toEqual(["before", "boundary"]);
  });

  test("classifies gameEnd as completed without requesting another input", async () => {
    let inputCalls = 0;
    const result = await runLoop(
      terminalGame,
      createInitialState(terminalGame),
      async () => {
        inputCalls += 1;
        return null;
      },
    );
    expect(result.reason).toBe("completed");
    expect(result.done).toBe(true);
    expect(result.trace.at(-1)?.output.type).toBe("gameEnd");
    expect(inputCalls).toBe(0);
  });

  test("terminal output takes precedence over a matching local stop condition", async () => {
    const result = await runLoop(
      terminalGame,
      createInitialState(terminalGame),
      async () => ({ type: "next" }),
      { stopWhen: () => true },
    );

    expect(result.reason).toBe("completed");
    expect(result.done).toBe(true);
    expect(result.trace.at(-1)?.output.type).toBe("gameEnd");
  });

  test("does not request a decision after the input budget is exhausted", async () => {
    const twoBeatGame: Game = {
      ...terminalGame,
      runFn: async function* () {
        yield { type: "narration" as const, text: "first" };
        yield { type: "narration" as const, text: "second" };
        yield { type: "gameEnd" as const };
      },
    };
    let inputCalls = 0;
    const result = await runLoop(
      twoBeatGame,
      createInitialState(twoBeatGame),
      async () => {
        inputCalls += 1;
        return { type: "next" };
      },
      { maxSteps: 1 },
    );

    expect(result.reason).toBe("max-steps");
    expect(result.trace).toHaveLength(2);
    expect(inputCalls).toBe(1);
  });

  test("zero input budget still exposes the initial output without asking", async () => {
    const visibleGame: Game = {
      ...terminalGame,
      runFn: async function* () {
        yield { type: "narration" as const, text: "visible" };
      },
    };
    let inputCalls = 0;
    const result = await runLoop(
      visibleGame,
      createInitialState(visibleGame),
      async () => {
        inputCalls += 1;
        return { type: "next" };
      },
      { maxSteps: 0 },
    );

    expect(result.reason).toBe("max-steps");
    expect(result.trace).toHaveLength(1);
    expect(inputCalls).toBe(0);
  });
});

describe("runLoop input diagnostics", () => {
  test("freezes accepted Hub activity semantics on the resulting trace entry", async () => {
    const game: Game = {
      ...terminalGame,
      runFn: async function* () {
        yield {
          type: "hubMenu" as const,
          snapshot: {
            day: 1,
            maxDay: 1,
            slot: 0,
            slotName: "",
            slotsPerDay: 1,
            stats: [],
            affections: [],
            activities: [{
              id: "release",
              kind: "action" as const,
              title: "Release the oni",
              category: "combat",
              aiTags: ["nonlethal", "mercy", "memory"],
              recommended: true,
              cost: 0,
              available: true,
              actionKind: "raid:release",
            }],
          },
        };
        yield { type: "narration" as const, text: "The oni leaves alive." };
      },
    };
    const result = await runLoop(game, createInitialState(game), [
      { type: "doActivity", id: "release" },
    ]);

    expect(result.trace[1]?.activityDecision).toEqual({
      activityId: "release",
      title: "Release the oni",
      kind: "action",
      category: "combat",
      aiTags: ["nonlethal", "mercy", "memory"],
      recommended: true,
      actionKind: "raid:release",
    });
    expect(result.trace[1]?.inputResult).toMatchObject({
      accepted: true,
      expected: [{ type: "next" }, { type: "quit" }],
    });
  });

  test("records a rejected input without delivering it to the generator", async () => {
    const received: string[] = [];
    const game: Game = {
      ...terminalGame,
      runFn: async function* () {
        let input = yield { type: "narration" as const, text: "first" };
        received.push(input.type);
        input = yield { type: "narration" as const, text: "second" };
        received.push(input.type);
        yield { type: "gameEnd" as const };
      },
    };
    const result = await runLoop(game, createInitialState(game), [
      { type: "doActivity", id: "rest" },
      { type: "next" },
      { type: "next" },
    ]);

    expect(received).toEqual(["next", "next"]);
    expect(result.trace[1]).toMatchObject({
      input: { type: "doActivity", id: "rest" },
      output: { type: "narration", text: "first" },
      inputResult: { accepted: false, code: "unexpected-input" },
    });
    expect(result.reason).toBe("completed");
  });
});

describe("runLoop stall diagnostics", () => {
  test("stops on the shortest exact state/output cycle when explicitly enabled", async () => {
    const game: Game = {
      ...terminalGame,
      runFn: async function* () {
        while (true) {
          yield { type: "hubMenu" as const, snapshot: {
            day: 1,
            maxDay: 1,
            slot: 0,
            slotName: "day",
            slotsPerDay: 1,
            stats: [],
            affections: [],
            activities: [{ id: "toggle", kind: "action" as const, title: "Toggle", cost: 0, available: true }],
          } };
          yield { type: "narration" as const, text: "Nothing changes." };
        }
      },
    };
    const result = await runLoop(
      game,
      createInitialState(game),
      async (output) => output.type === "hubMenu"
        ? { type: "doActivity", id: "toggle" }
        : { type: "next" },
      { maxSteps: 100, stallDetection: { repetitions: 3, maxCycleLength: 5 } },
    );

    expect(result.reason).toBe("stalled");
    expect(result.trace).toHaveLength(6);
    expect(result.stall).toEqual({
      cycleLength: 2,
      repetitions: 3,
      firstTraceIndex: 0,
      lastTraceIndex: 5,
      cycle: [
        { traceIndex: 4, input: { type: "next" }, output: "hub available=[toggle]" },
        { traceIndex: 5, input: { type: "doActivity", id: "toggle" }, output: "narration: Nothing changes." },
      ],
    });
  });

  test("does not detect cycles unless the caller opts in", async () => {
    const game: Game = {
      ...terminalGame,
      runFn: async function* () {
        while (true) yield { type: "narration" as const, text: "Again" };
      },
    };
    const result = await runLoop(
      game,
      createInitialState(game),
      async () => ({ type: "next" }),
      { maxSteps: 4 },
    );
    expect(result.reason).toBe("max-steps");
    expect(result.stall).toBeUndefined();
  });

  test("does not call repeated public prose a stall while engine state progresses", async () => {
    const game: Game = {
      ...terminalGame,
      runFn: async function* (ctx) {
        while (true) {
          ctx.state.baseline.characters.player!.stats.progress =
            (ctx.state.baseline.characters.player!.stats.progress ?? 0) + 1;
          yield { type: "narration" as const, text: "Grinding..." };
        }
      },
    };
    game.characters = [{ id: "player", name: "Player", stats: { progress: { initial: 0 } } }];
    const result = await runLoop(
      game,
      createInitialState(game),
      async () => ({ type: "next" }),
      { maxSteps: 8, stallDetection: { repetitions: 3, maxCycleLength: 4 } },
    );
    expect(result.reason).toBe("max-steps");
    expect(result.finalState.baseline.characters.player?.stats.progress).toBe(9);
    expect(result.behaviorCycle).toEqual({
      cycleLength: 1,
      repetitions: 3,
      firstTraceIndex: 6,
      lastTraceIndex: 8,
      cycle: [{ traceIndex: 8, input: { type: "next" }, output: "narration: Grinding..." }],
      changingStatePaths: ["baseline.characters.player.stats.progress"],
    });
  });
});
