import { describe, expect, test } from "bun:test";
import type { ComposedState, Output } from "@rpg-harness/engine";
import { personas } from "./personas";

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
  test("takes a recommended public action before its usual last activity", async () => {
    const output = objectiveHub();
    output.snapshot.activities[0]!.recommended = true;
    await expect(
      personas.charmer!(output, {} as ComposedState, 0),
    ).resolves.toEqual({ type: "doActivity", id: "invite:kagari" });
  });

  test("prefers the last unvisited map target over a visited back edge", async () => {
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
      id: "move:burnt_temple",
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
