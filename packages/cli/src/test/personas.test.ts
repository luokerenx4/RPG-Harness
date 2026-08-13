import { describe, expect, test } from "bun:test";
import type { ComposedState, Game, Output } from "@rpg-harness/engine";
import { collectAiPersonas, personas } from "./personas";

describe("AI persona registry", () => {
  test("merges an author-owned module persona with built-ins", async () => {
    const game = {
      modules: [{
        id: "test-module",
        aiPersonas: {
          explorer: {
            description: "Explore the project",
            decide: async () => ({ type: "next" as const }),
          },
        },
      }],
    } as unknown as Game;
    const registry = collectAiPersonas(game);
    expect(registry.objective?.source).toBe("builtin");
    expect(registry.explorer?.source).toBe("module:test-module");
    await expect(
      registry.explorer!.decide({ type: "narration", text: "go" }, {} as ComposedState, 0),
    ).resolves.toEqual({ type: "next" });
  });

  test("rejects project personas that shadow a built-in policy", () => {
    const game = {
      modules: [{
        id: "test-module",
        aiPersonas: {
          objective: {
            description: "Shadow",
            decide: async () => null,
          },
        },
      }],
    } as unknown as Game;
    expect(() => collectAiPersonas(game)).toThrow("conflicts with builtin");
  });
});

describe("objective persona choice preference", () => {
  test("picks the highest available authored AI priority", async () => {
    const output: Output = {
      type: "choice",
      options: [
        { text: "first", available: true },
        { text: "locked high", available: false, aiPriority: 100 },
        { text: "available high", available: true, aiPriority: 20 },
      ],
    };

    await expect(
      personas.objective!(output, {} as ComposedState, 0),
    ).resolves.toEqual({ type: "choose", index: 2 });
  });

  test("keeps first-available behavior when priorities tie", async () => {
    const output: Output = {
      type: "choice",
      options: [
        { text: "locked", available: false },
        { text: "first available", available: true },
        { text: "same priority", available: true, aiPriority: 0 },
      ],
    };

    await expect(
      personas.objective!(output, {} as ComposedState, 0),
    ).resolves.toEqual({ type: "choose", index: 1 });
  });
});

describe("hunter persona progress fallback", () => {
  test("follows a public objective before a reversible first activity", async () => {
    const output: Output = {
      type: "hubMenu",
      snapshot: {
        day: 1,
        maxDay: 10,
        slot: 0,
        slotName: "day",
        slotsPerDay: 2,
        stats: [],
        affections: [],
        activities: [
          { id: "invite:kagari", kind: "action", title: "Invite", cost: 0, available: true },
          { id: "depart:kuro_swamp", kind: "action", title: "Depart", cost: 0, available: true },
        ],
        objectives: [{
          id: "raid",
          title: "Complete a raid",
          status: "active",
          relatedActivityIds: ["depart:kuro_swamp"],
        }],
      },
    };

    await expect(
      personas.hunter!(output, {} as ComposedState, 0),
    ).resolves.toEqual({ type: "doActivity", id: "depart:kuro_swamp" });
  });
});

describe("greedy persona progress tie-breaker", () => {
  test("uses the public objective when zero-value activities tie", async () => {
    const output = objectiveHub();
    await expect(
      personas.greedy!(output, {} as ComposedState, 0),
    ).resolves.toEqual({ type: "doActivity", id: "depart:kuro_swamp" });
  });

  test("keeps a higher numeric reward ahead of the objective", async () => {
    const output = objectiveHub();
    output.snapshot.activities[0]!.effectsHint = "affection+1";
    await expect(
      personas.greedy!(output, {} as ComposedState, 0),
    ).resolves.toEqual({ type: "doActivity", id: "invite:kagari" });
  });
});

describe("charmer persona exploration", () => {
  test("uses authored social intent instead of presentation position", async () => {
    const output: Output = {
      type: "choice",
      scriptId: "ending",
      choiceId: "coda",
      options: [
        { id: "alone", text: "Alone", available: true, aiTags: ["independent"] },
        { id: "friend", text: "Friend", available: true, aiTags: ["social"] },
        { id: "wait", text: "Wait", available: true },
      ],
    };
    await expect(
      personas.charmer!(output, {} as ComposedState, 0),
    ).resolves.toEqual({ type: "choose", choiceId: "coda", optionId: "friend" });
  });

  test("takes a recommended public action before its usual last activity", async () => {
    const output = objectiveHub();
    output.snapshot.activities[0]!.recommended = true;
    await expect(
      personas.charmer!(output, {} as ComposedState, 0),
    ).resolves.toEqual({ type: "doActivity", id: "invite:kagari" });
  });

  test("follows semantic activity intent before a non-social main objective", async () => {
    const output = objectiveHub();
    output.snapshot.activities[0]!.aiTags = ["social", "story"];
    await expect(
      personas.charmer!(output, {} as ComposedState, 0),
    ).resolves.toEqual({ type: "doActivity", id: "invite:kagari" });
  });

  test("stays renderer-neutral when module-private visited state is present", async () => {
    const output = objectiveHub();
    output.snapshot.activities = [
      { id: "move:burnt_temple", kind: "action", title: "Temple", cost: 0, available: true },
      { id: "move:foothills", kind: "action", title: "Foothills", cost: 0, available: true },
    ];
    const state = {
      "sengoku-raid": {
        raid: {
          visited: {
            burnt_temple: { visited: false },
            foothills: { visited: true },
          },
        },
      },
    } as unknown as ComposedState;
    await expect(personas.charmer!(output, state, 0)).resolves.toEqual({
      type: "doActivity",
      id: "move:foothills",
    });
  });

  test("follows a public objective before a reversible final hub toggle", async () => {
    const output = objectiveHub();
    output.snapshot.activities = [
      { id: "depart:kuro_swamp", kind: "action", title: "Depart", cost: 0, available: true },
      { id: "invite:mio", kind: "action", title: "Invite", cost: 0, available: true },
    ];
    output.snapshot.objectives![0]!.relatedActivityIds = ["depart:kuro_swamp"];
    await expect(
      personas.charmer!(output, {} as ComposedState, 0),
    ).resolves.toEqual({ type: "doActivity", id: "depart:kuro_swamp" });
  });
});

describe("rude persona progression", () => {
  test("uses authored defiant intent instead of presentation position", async () => {
    const output: Output = {
      type: "choice",
      scriptId: "ending",
      choiceId: "coda",
      options: [
        { id: "friend", text: "Friend", available: true, aiTags: ["social"] },
        { id: "wait", text: "Wait", available: true },
        { id: "alone", text: "Alone", available: true, aiTags: ["independent"] },
      ],
    };
    await expect(
      personas.rude!(output, {} as ComposedState, 0),
    ).resolves.toEqual({ type: "choose", choiceId: "coda", optionId: "alone" });
  });

  test("keeps second-choice dialogue behavior but follows the hub objective", async () => {
    const output = objectiveHub();
    await expect(
      personas.rude!(output, {} as ComposedState, 0),
    ).resolves.toEqual({ type: "doActivity", id: "depart:kuro_swamp" });
  });
});

function objectiveHub(): Extract<Output, { type: "hubMenu" }> {
  return {
    type: "hubMenu",
    snapshot: {
      day: 1,
      maxDay: 10,
      slot: 0,
      slotName: "day",
      slotsPerDay: 2,
      stats: [],
      affections: [],
      activities: [
        { id: "invite:kagari", kind: "action", title: "Invite", cost: 0, available: true },
        { id: "depart:kuro_swamp", kind: "action", title: "Depart", cost: 0, available: true },
      ],
      objectives: [{
        id: "raid",
        title: "Complete a raid",
        status: "active",
        relatedActivityIds: ["depart:kuro_swamp"],
      }],
    },
  };
}
