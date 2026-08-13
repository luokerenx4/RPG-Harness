import { describe, expect, test } from "bun:test";
import type { ComposedState, Output } from "@rpg-harness/engine";
import { raidAiPersonas } from "./raid";

describe("sengoku-raid project personas", () => {
  test("extractor follows cautious choice tags", async () => {
    await expect(decide("extractor", routeChoice(), {})).resolves.toEqual({
      type: "choose",
      choiceId: "route",
      optionId: "silent",
    });
  });

  test("delver follows aggressive choice tags", async () => {
    await expect(decide("delver", routeChoice(), {})).resolves.toEqual({
      type: "choose",
      choiceId: "route",
      optionId: "defy",
    });
  });

  test("extractor honors the authored ending pulse", async () => {
    const output = hub([
      activity("imbue:mundane"),
      activity("imbue:pure"),
    ]);
    output.snapshot.objectives = [{
      id: "ending_pure",
      title: "Pure ending",
      status: "active",
      relatedActivityIds: ["imbue:pure"],
    }];
    await expect(decide("extractor", output, {})).resolves.toEqual({
      type: "doActivity",
      id: "imbue:pure",
    });
  });

  test("extractor finds an ending behind an optional deep objective", async () => {
    const output = hub([
      activity("depart:hell_gate"),
      activity("script:ending_mundane_seal"),
    ]);
    output.snapshot.objectives = [
      {
        id: "hell_gate_mastery",
        title: "Hell gate",
        status: "active",
        relatedActivityIds: ["depart:hell_gate"],
      },
      {
        id: "ending_mundane_seal",
        title: "Ending",
        status: "active",
        relatedActivityIds: ["script:ending_mundane_seal"],
      },
    ];
    await expect(decide("extractor", output, {})).resolves.toEqual({
      type: "doActivity",
      id: "script:ending_mundane_seal",
    });
  });

  test("extractor understands one-at-a-time material sales", async () => {
    const output = hub([
      activity("sell_material:soul_shard"),
      activity("depart:kuro_swamp"),
    ]);
    await expect(decide("extractor", output, {})).resolves.toEqual({
      type: "doActivity",
      id: "sell_material:soul_shard",
    });
  });

  test("delver reads its module state and chooses an unvisited edge", async () => {
    const output = hub([activity("move:temple"), activity("move:vent")]);
    const state = {
      "sengoku-raid": {
        raid: {
          visited: {
            temple: { visited: true },
            vent: { visited: false },
          },
        },
      },
    };
    await expect(decide("delver", output, state)).resolves.toEqual({
      type: "doActivity",
      id: "move:vent",
    });
  });

  test("delver extracts only after every known zone is visited", async () => {
    const output = hub([activity("extract"), activity("move:temple")]);
    const state = {
      "sengoku-raid": {
        raid: { visited: { temple: { visited: true } } },
      },
    };
    await expect(decide("delver", output, state)).resolves.toEqual({
      type: "doActivity",
      id: "extract",
    });
  });

  test("delver finds an ending behind an optional deep objective", async () => {
    const output = hub([
      activity("depart:hell_gate"),
      activity("script:ending_oni_self"),
    ]);
    output.snapshot.objectives = [
      {
        id: "hell_gate_mastery",
        title: "Hell gate",
        status: "active",
        relatedActivityIds: ["depart:hell_gate"],
      },
      {
        id: "ending_oni_self",
        title: "Ending",
        status: "active",
        relatedActivityIds: ["script:ending_oni_self"],
      },
    ];
    await expect(decide("delver", output, {})).resolves.toEqual({
      type: "doActivity",
      id: "script:ending_oni_self",
    });
  });

  test("completionist defers an ending for the public three-flowers objective", async () => {
    const output = hub([
      activity("script:ending_oni_self"),
      activity("invite:kagari"),
    ]);
    output.snapshot.objectives = [
      {
        id: "three_flowers_alliance",
        title: "Three flowers",
        status: "active",
        relatedActivityIds: ["invite:kagari"],
      },
      {
        id: "ending_oni_self",
        title: "Ending",
        status: "active",
        relatedActivityIds: ["script:ending_oni_self"],
      },
    ];
    await expect(decide("completionist", output, {
      baseline: { scripts: {} },
      "sengoku-raid": { achievementLog: [] },
    })).resolves.toEqual({ type: "doActivity", id: "invite:kagari" });
  });

  test("completionist preserves a companion by fleeing before exploring", async () => {
    const output = hub([
      activity("attack"),
      activity("flee"),
      activity("move:shrine"),
    ]);
    await expect(decide("completionist", output, {
      baseline: { scripts: {} },
      "sengoku-raid": {
        companion: "kagari",
        achievementLog: [],
        raid: { visited: { shrine: { visited: false } } },
      },
    })).resolves.toEqual({ type: "doActivity", id: "flee" });
  });
});

function decide(
  name: "extractor" | "delver" | "completionist",
  output: Output,
  state: unknown,
) {
  return raidAiPersonas[name]!.decide(output, state as ComposedState, 0);
}

function activity(id: string) {
  return { id, kind: "action" as const, title: id, cost: 0, available: true };
}

function hub(
  activities: ReturnType<typeof activity>[],
): Extract<Output, { type: "hubMenu" }> {
  return {
    type: "hubMenu",
    snapshot: {
      day: 1,
      stats: [],
      affections: [],
      activities,
      objectives: [],
    },
  };
}

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
