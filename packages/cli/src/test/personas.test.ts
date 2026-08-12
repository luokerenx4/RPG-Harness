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

describe("extraction personas", () => {
  test("extractor follows authored cautious independence at a story choice", async () => {
    const output = routeChoice();
    await expect(
      personas.extractor!(output, {} as ComposedState, 0),
    ).resolves.toEqual({
      type: "choose",
      choiceId: "route",
      optionId: "silent",
    });
  });

  test("delver follows authored aggression at a story choice", async () => {
    const output = routeChoice();
    await expect(
      personas.delver!(output, {} as ComposedState, 0),
    ).resolves.toEqual({
      type: "choose",
      choiceId: "route",
      optionId: "defy",
    });
  });

  test("extractor follows the authored ending pulse instead of a generic imbue", async () => {
    const output = objectiveHub();
    output.snapshot.activities = [
      { id: "imbue:mundane", kind: "action", title: "Mundane", cost: 0, available: true },
      { id: "imbue:pure", kind: "action", title: "Pure", cost: 0, available: true },
    ];
    output.snapshot.objectives = [{
      id: "ending_pure_rite",
      title: "Pure ending",
      status: "active",
      relatedActivityIds: ["imbue:pure"],
    }];

    await expect(
      personas.extractor!(output, {} as ComposedState, 0),
    ).resolves.toEqual({ type: "doActivity", id: "imbue:pure" });
  });

  test("extractor understands one-at-a-time material sales", async () => {
    const output = objectiveHub();
    output.snapshot.activities = [
      { id: "sell_material:soul_shard", kind: "action", title: "Sell", cost: 0, available: true },
      { id: "depart:kuro_swamp", kind: "action", title: "Depart", cost: 0, available: true },
    ];

    await expect(
      personas.extractor!(output, {} as ComposedState, 0),
    ).resolves.toEqual({ type: "doActivity", id: "sell_material:soul_shard" });
  });

  test("delver reads the live visited-map schema when choosing an unexplored edge", async () => {
    const output = objectiveHub();
    output.snapshot.activities = [
      { id: "move:temple", kind: "action", title: "Temple", cost: 0, available: true },
      { id: "move:vent", kind: "action", title: "Vent", cost: 0, available: true },
    ];
    const state = {
      "sengoku-raid": {
        raid: {
          visited: {
            temple: { visited: true },
            vent: { visited: false },
          },
        },
      },
    } as unknown as ComposedState;

    await expect(personas.delver!(output, state, 0)).resolves.toEqual({
      type: "doActivity",
      id: "move:vent",
    });
  });

  test("delver extracts after every map in the live visited schema is explored", async () => {
    const output = objectiveHub();
    output.snapshot.activities = [
      { id: "extract", kind: "action", title: "Extract", cost: 0, available: true },
      { id: "move:temple", kind: "action", title: "Temple", cost: 0, available: true },
    ];
    const state = {
      "sengoku-raid": {
        raid: { visited: { temple: { visited: true } } },
      },
    } as unknown as ComposedState;

    await expect(personas.delver!(output, state, 0)).resolves.toEqual({
      type: "doActivity",
      id: "extract",
    });
  });

  test("delver closes an authored ending before redeploying", async () => {
    const output = objectiveHub();
    output.snapshot.activities = [
      { id: "script:ending_oni_self", kind: "script", title: "End", cost: 0, available: true },
      { id: "depart:hell_gate", kind: "action", title: "Depart", cost: 0, available: true },
    ];
    output.snapshot.objectives = [{
      id: "ending_oni_self",
      title: "Oni ending",
      status: "active",
      relatedActivityIds: ["script:ending_oni_self"],
    }];

    await expect(
      personas.delver!(output, {} as ComposedState, 0),
    ).resolves.toEqual({ type: "doActivity", id: "script:ending_oni_self" });
  });
});

function routeChoice(): Extract<Output, { type: "choice" }> {
  return {
    type: "choice",
    scriptId: "route",
    choiceId: "route",
    options: [
      { id: "loyal", text: "Loyal", available: true, aiTags: ["loyal", "cautious"] },
      { id: "defy", text: "Defy", available: true, aiTags: ["defiant", "aggressive"] },
      { id: "silent", text: "Silent", available: true, aiTags: ["independent", "cautious"] },
    ],
  };
}

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
