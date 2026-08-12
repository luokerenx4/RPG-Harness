import { describe, expect, test } from "bun:test";
import type { HubSnapshot } from "@rpg-harness/engine";
import { presentHeadlessOutput } from "./headlessOutput";

describe("presentHeadlessOutput", () => {
  test("adds grouped hub semantics and a directly executable heuristic input", () => {
    const snapshot: HubSnapshot = {
      day: 0,
      maxDay: 0,
      slot: 0,
      slotName: "",
      slotsPerDay: 0,
      stats: [],
      affections: [],
      resourceGroups: [
        {
          id: "carried-loot",
          title: "Carried loot",
          resources: [{ id: "ryo", name: "Ryo", quantity: 8 }],
        },
      ],
      activities: [
        {
          id: "upgrade",
          kind: "action",
          title: "Upgrade",
          category: "shop",
          cost: 0,
          available: false,
          lockedReason: "need loot",
        },
        {
          id: "depart",
          kind: "action",
          title: "Depart",
          category: "raid",
          cost: 0,
          available: true,
        },
      ],
    };

    const output = presentHeadlessOutput(
      { type: "hubMenu", snapshot },
      new Map(),
    );
    expect(output?.hubView).toMatchObject({
      heuristic: true,
      selectionRule: "authored_recommendation_or_only_candidate",
      focusCategory: "raid",
      strategyDecisionRequired: false,
      candidateScope: "focus_section",
      decisionRequired: false,
      candidateActivityIds: ["depart"],
      primaryActivityId: "depart",
      primaryInput: { type: "doActivity", id: "depart" },
      primaryReason: "only_available_in_focus_section",
      resourceGroups: [
        {
          id: "carried-loot",
          resources: [{ id: "ryo", quantity: 8 }],
        },
      ],
      sections: [
        { category: "raid", availableActivityIds: ["depart"] },
        { category: "shop", availableActivityIds: [] },
      ],
      opportunityGroups: [
        {
          category: "raid",
          candidates: [
            {
              activityId: "depart",
              input: { type: "doActivity", id: "depart" },
              title: "Depart",
            },
          ],
        },
      ],
    });
  });

  test("keeps non-focus strategic opportunities self-contained", () => {
    const snapshot: HubSnapshot = {
      day: 0,
      maxDay: 0,
      slot: 0,
      slotName: "",
      slotsPerDay: 0,
      stats: [],
      affections: [],
      activities: [
        {
          id: "depart-one",
          kind: "action",
          title: "Depart one",
          category: "raid",
          cost: 0,
          available: true,
        },
        {
          id: "depart-two",
          kind: "action",
          title: "Depart two",
          category: "raid",
          cost: 0,
          available: true,
        },
        {
          id: "bond",
          kind: "action",
          title: "Spend time together",
          description: "Affection +1",
          category: "social",
          cost: 0,
          available: true,
          forecast: {
            metrics: [{ id: "affection", label: "Affection", value: 1 }],
          },
        },
        {
          id: "intel",
          kind: "action",
          title: "Buy intel",
          category: "shop",
          cost: 0,
          available: true,
        },
      ],
    };
    const output = presentHeadlessOutput(
      { type: "hubMenu", snapshot },
      new Map(),
    );

    expect(output?.hubView).toMatchObject({
      focusCategory: "raid",
      strategyDecisionRequired: true,
      candidateActivityIds: ["depart-one", "depart-two"],
      opportunityGroups: [
        {
          category: "raid",
          decisionRequired: true,
          candidates: [
            { activityId: "depart-one" },
            { activityId: "depart-two" },
          ],
        },
        {
          category: "social",
          candidates: [
            {
              activityId: "bond",
              input: { type: "doActivity", id: "bond" },
              title: "Spend time together",
              description: "Affection +1",
              forecast: {
                metrics: [{ id: "affection", value: 1 }],
              },
            },
          ],
        },
        { category: "shop", candidates: [{ activityId: "intel" }] },
      ],
    });
  });

  test("returns candidate inputs instead of inventing a primary for a branch", () => {
    const snapshot: HubSnapshot = {
      day: 0,
      maxDay: 0,
      slot: 0,
      slotName: "",
      slotsPerDay: 0,
      stats: [],
      affections: [],
      activities: [
        {
          id: "extract",
          kind: "action",
          title: "Extract",
          category: "raid",
          cost: 0,
          available: true,
          forecast: {
            metrics: [
              {
                id: "success_chance",
                label: "Success",
                value: 100,
                unit: "percent",
              },
            ],
          },
        },
        {
          id: "continue",
          kind: "action",
          title: "Continue",
          category: "raid",
          cost: 0,
          available: true,
        },
      ],
    };
    const output = presentHeadlessOutput(
      { type: "hubMenu", snapshot },
      new Map(),
    );
    expect(output?.hubView).toMatchObject({
      decisionRequired: true,
      candidateActivityIds: ["extract", "continue"],
      candidateInputs: [
        { type: "doActivity", id: "extract" },
        { type: "doActivity", id: "continue" },
      ],
      candidates: [
        {
          activityId: "extract",
          forecast: {
            metrics: [{ id: "success_chance", value: 100 }],
          },
        },
        { activityId: "continue" },
      ],
      primaryActivityId: null,
      primaryInput: null,
    });
  });
});
