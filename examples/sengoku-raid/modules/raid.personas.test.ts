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
});

function decide(name: "extractor" | "delver", output: Output, state: unknown) {
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
