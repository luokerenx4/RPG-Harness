import { describe, expect, test } from "bun:test";
import { Engine } from "./engine";
import { OutputContractError, validateOutput } from "./output";
import type { Game, HubObjectiveSnapshot, Output } from "./types";

describe("AI-facing output contract", () => {
  test("accepts explicit objective semantics with executable links", () => {
    expect(() => validateOutput(hub({
      id: "campaign",
      title: "Campaign",
      scope: "main",
      terminal: true,
      status: "active",
      relatedActivityIds: ["conclude"],
    }))).not.toThrow();
  });

  test("rejects missing scope even from dynamically loaded JavaScript", () => {
    const output = hub({
      id: "campaign",
      title: "Campaign",
      terminal: true,
      status: "active",
      relatedActivityIds: ["conclude"],
    } as never);
    expect(() => validateOutput(output)).toThrow(OutputContractError);
    expect(() => validateOutput(output)).toThrow(/invalid scope/);
  });

  test("rejects objective guidance that is not executable from the same hub", () => {
    const output = hub({
      id: "campaign",
      title: "Campaign",
      scope: "main",
      terminal: false,
      status: "active",
      relatedActivityIds: ["missing"],
    });
    expect(() => validateOutput(output)).toThrow(/activities not present.*missing/);
  });

  test("Engine.run enforces the contract before exposing custom preset output", async () => {
    const game: Game = {
      title: "Dynamic output",
      characters: [],
      scripts: [],
      runFn: async function* () {
        yield hub({
          id: "campaign",
          title: "Campaign",
          scope: "wrong" as "main",
          terminal: false,
          status: "active",
          relatedActivityIds: ["conclude"],
        });
      },
    };
    const runner = new Engine(game).run();
    await expect(runner.next()).rejects.toThrow(/invalid scope wrong/);
  });

  test("rejects an unstable explicit terminal identity but keeps legacy gameEnd valid", () => {
    expect(() => validateOutput({ type: "gameEnd" })).not.toThrow();
    expect(() => validateOutput({ type: "gameEnd", endingId: "ending-pure" }))
      .not.toThrow();
    expect(() => validateOutput({ type: "gameEnd", endingId: "  " }))
      .toThrow(/endingId must be a non-empty, trimmed string/);
    expect(() => validateOutput({ type: "gameEnd", endingId: " ending-pure " }))
      .toThrow(/endingId must be a non-empty, trimmed string/);
  });
});

function hub(objective: HubObjectiveSnapshot): Output {
  return {
    type: "hubMenu",
    snapshot: {
      day: 0,
      maxDay: 0,
      slot: 0,
      slotName: "",
      slotsPerDay: 0,
      stats: [],
      affections: [],
      objectives: [objective],
      activities: [{
        id: "conclude",
        kind: "action",
        title: "Conclude",
        cost: 0,
        available: true,
      }],
    },
  };
}
