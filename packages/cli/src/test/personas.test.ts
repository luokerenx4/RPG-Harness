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
