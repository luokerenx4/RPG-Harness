import { describe, expect, test } from "bun:test";
import type { HubSnapshot } from "@rpg-harness/engine";
import {
  buildHubView,
  formatActivityForecast,
  formatForecastMetricValue,
  formatHubCalendar,
  formatObjectiveRequirement,
  objectiveRequirementProgress,
} from "./hub";

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

describe("formatObjectiveRequirement", () => {
  test("uses the status marker instead of leaking boolean diagnostics", () => {
    const pending = {
      id: "survived",
      label: "篝と生還",
      current: false,
      target: true,
      satisfied: false,
    };
    const completed = { ...pending, current: true, satisfied: true };

    expect(formatObjectiveRequirement(pending)).toBe("○ 篝と生還");
    expect(formatObjectiveRequirement(completed)).toBe("✓ 篝と生還");
    expect(objectiveRequirementProgress(pending)).toBeNull();
  });

  test("keeps exact numeric progress without adding a second colon", () => {
    const requirement = {
      id: "pulse",
      label: "脈絡: 鬼",
      current: 0,
      target: 6,
      satisfied: false,
    };

    expect(formatObjectiveRequirement(requirement)).toBe("○ 脈絡: 鬼 0 / 6");
    expect(objectiveRequirementProgress(requirement)).toBe("0 / 6");
  });
});

describe("buildHubView", () => {
  test("uses explicit main-objective guidance ahead of mastery and menu order", () => {
    const view = buildHubView(
      snapshot({
        objectives: [
          {
            id: "deep-boss",
            title: "Optional deep boss",
            scope: "mastery",
            terminal: false,
            status: "active",
            relatedActivityIds: ["deep"],
          },
          {
            id: "campaign",
            title: "Finish campaign",
            scope: "main",
            terminal: true,
            status: "active",
            relatedActivityIds: ["conclude"],
          },
        ],
        activities: [
          activity("deep", "raid", true),
          activity("conclude", "story", true),
        ],
      }),
    );

    expect(view).toMatchObject({
      candidateScope: "main_objective",
      candidateActivityIds: ["conclude"],
      primaryActivityId: "conclude",
      primaryReason: "main_objective",
      objectiveGuidance: {
        objectiveId: "campaign",
        scope: "main",
        terminal: true,
        decisionRequired: false,
        primaryInput: { type: "doActivity", id: "conclude" },
      },
    });
  });

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
    expect(view.primaryActivityId).toBeNull();
    expect(view.primaryInput).toBeNull();
    expect(view.sections[2]).toMatchObject({ availableCount: 1, lockedCount: 1 });
    expect(view).toMatchObject({
      strategyDecisionRequired: true,
      candidateScope: "focus_section",
    });
    expect(view.opportunityGroups.map((group) => group.category)).toEqual([
      "story",
      "raid",
      "shop",
    ]);
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
      strategyDecisionRequired: false,
      candidateScope: "authored_recommendations",
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

  test("exposes every actionable category as a self-contained opportunity group", () => {
    const view = buildHubView(
      snapshot({
        activities: [
          activity("depart-one", "raid", true),
          activity("depart-two", "raid", true),
          activity("bond", "social", true),
          activity("intel", "shop", true),
          activity("upgrade", "shop", false),
        ],
      }),
    );

    expect(view).toMatchObject({
      focusCategory: "raid",
      strategyDecisionRequired: true,
      candidateScope: "focus_section",
      candidateActivityIds: ["depart-one", "depart-two"],
    });
    expect(view.opportunityGroups).toMatchObject([
      {
        category: "raid",
        decisionRequired: true,
        candidateActivityIds: ["depart-one", "depart-two"],
        primaryInput: null,
      },
      {
        category: "social",
        decisionRequired: false,
        candidateInputs: [{ type: "doActivity", id: "bond" }],
        primaryInput: { type: "doActivity", id: "bond" },
      },
      {
        category: "shop",
        decisionRequired: false,
        candidateActivityIds: ["intel"],
        primaryReason: "only_available_in_opportunity_group",
      },
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

describe("formatActivityForecast", () => {
  test("formats exact percentages and numeric ranges", () => {
    expect(
      formatActivityForecast({
        ...activity("attack", "combat", true),
        forecast: {
          metrics: [
            { id: "damage", label: "Damage", min: 4, max: 6, unit: "HP" },
            {
              id: "critical",
              label: "Critical",
              value: 1.4,
              unit: "percent",
            },
          ],
        },
      }),
    ).toBe("Damage 4–6 HP · Critical 1.4%");
  });

  test("keeps machine units out of player prose", () => {
    expect(formatForecastMetricValue({
      id: "inventory:ryo",
      label: "両",
      value: 11,
      unit: "item",
      polarity: "benefit",
    })).toBe("+11");
    expect(formatForecastMetricValue({
      id: "reputation",
      label: "評判",
      value: 2,
      unit: "internal_points",
      unitLabel: " 点",
    })).toBe("2 点");
    expect(formatForecastMetricValue({
      id: "mystery",
      label: "謎",
      value: 3,
      unit: "private_enum",
    })).toBe("3");
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
