import { describe, expect, test } from "bun:test";
import type { HubSnapshot } from "@rpg-harness/engine";
import { buildHubView, formatHubCalendar } from "./hub";

function snapshot(overrides: Partial<HubSnapshot> = {}): HubSnapshot {
  return {
    day: 0,
    maxDay: 0,
    slot: 0,
    slotName: "",
    slotsPerDay: 0,
    stats: [],
    affections: [],
    activities: [],
    ...overrides,
  };
}

describe("formatHubCalendar", () => {
  test("hides zero sentinels for non-calendar hubs", () => {
    expect(formatHubCalendar(snapshot())).toBeNull();
  });

  test("formats day and slot for training/calendar hubs", () => {
    expect(
      formatHubCalendar(
        snapshot({ day: 3, maxDay: 7, slotsPerDay: 3, slotName: "night" }),
      ),
    ).toBe("Day 3/7 · night");
  });

  test("does not leave a dangling separator when slotName is empty", () => {
    expect(
      formatHubCalendar(snapshot({ day: 1, maxDay: 5, slotsPerDay: 1 })),
    ).toBe("Day 1/5");
  });
});

describe("buildHubView", () => {
  test("groups and prioritizes the primary loop without hiding locked rows", () => {
    const view = buildHubView(
      snapshot({
        activities: [
          activity("upgrade", "shop", false),
          activity("intel", "story", true),
          activity("buy", "shop", true),
          activity("depart", "raid", true),
        ],
      }),
    );

    expect(view.sections.map((section) => section.category)).toEqual([
      "story",
      "raid",
      "shop",
    ]);
    expect(view.activities.map((activity) => activity.id)).toEqual([
      "intel",
      "depart",
      "buy",
      "upgrade",
    ]);
    expect(view.primaryActivityId).toBe("intel");
    expect(view.primaryInput).toEqual({ type: "doActivity", id: "intel" });
    expect(view.sections[2]).toMatchObject({ availableCount: 1, lockedCount: 1 });
  });

  test("moves fully locked sections behind actionable sections", () => {
    const view = buildHubView(
      snapshot({
        activities: [
          activity("depart", "raid", false),
          activity("rest", "rest", true),
        ],
      }),
    );
    expect(view.sections.map((section) => section.category)).toEqual([
      "rest",
      "raid",
    ]);
    expect(view.primaryActivityId).toBe("rest");
    expect(view.primaryReason).toBe("only_available_in_focus_section");
  });

  test("leaves meaningful multi-action branches for the player or AI to decide", () => {
    const view = buildHubView(
      snapshot({
        activities: [
          activity("extract", "raid", true),
          activity("continue", "raid", true),
        ],
      }),
    );
    expect(view).toMatchObject({
      focusCategory: "raid",
      decisionRequired: true,
      candidateActivityIds: ["extract", "continue"],
      primaryActivityId: null,
      primaryInput: null,
      primaryReason: null,
    });
    expect(view.candidateInputs).toEqual([
      { type: "doActivity", id: "extract" },
      { type: "doActivity", id: "continue" },
    ]);
  });

  test("an authored recommendation can identify one action without relying on order", () => {
    const continueActivity = {
      ...activity("continue", "raid", true),
      recommended: true,
    };
    const view = buildHubView(
      snapshot({
        activities: [activity("extract", "raid", true), continueActivity],
      }),
    );
    expect(view).toMatchObject({
      decisionRequired: false,
      candidateActivityIds: ["continue"],
      primaryActivityId: "continue",
      primaryInput: { type: "doActivity", id: "continue" },
      primaryReason: "authored_recommendation",
    });
    expect(view.activities.map((item) => item.id)).toEqual([
      "continue",
      "extract",
    ]);
  });

  test("preserves first-seen order for custom categories", () => {
    const view = buildHubView(
      snapshot({
        activities: [
          activity("craft", "alchemy", true),
          activity("fish", "fishing", true),
        ],
      }),
    );
    expect(view.sections.map((section) => section.category)).toEqual([
      "alchemy",
      "fishing",
    ]);
    expect(view.sections[0]?.label).toBe("Alchemy");
  });
});

function activity(id: string, category: string, available: boolean) {
  return {
    id,
    kind: "action" as const,
    title: id,
    category,
    cost: 0,
    available,
  };
}
