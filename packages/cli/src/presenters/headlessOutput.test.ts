import { describe, expect, test } from "bun:test";
import type { HubSnapshot } from "@rpg-harness/engine";
import { compactHeadlessOutput, presentHeadlessOutput } from "./headlessOutput";

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
      objectives: [
        {
          id: "main",
          title: "Reach the gate",
          scope: "main",
          terminal: false,
          status: "active",
          requirements: [
            { id: "raids", label: "Raids", current: 2, target: 3, satisfied: false },
          ],
          relatedActivityIds: ["depart"],
        },
      ],
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
      selectionRule: "main_objective_or_authored_recommendation_or_only_candidate",
      focusCategory: "raid",
      strategyDecisionRequired: false,
      candidateScope: "main_objective",
      decisionRequired: false,
      candidateActivityIds: ["depart"],
      primaryActivityId: "depart",
      primaryInput: { type: "doActivity", id: "depart" },
      primaryReason: "main_objective",
      objectiveGuidance: {
        objectiveId: "main",
        scope: "main",
        terminal: false,
        candidateActivityIds: ["depart"],
        primaryActivityId: "depart",
      },
      resourceGroups: [
        {
          id: "carried-loot",
          resources: [{ id: "ryo", quantity: 8 }],
        },
      ],
      objectives: [
        {
          id: "main",
          title: "Reach the gate",
          scope: "main",
          terminal: false,
          relatedActivityIds: ["depart"],
          requirements: [
            { id: "raids", current: 2, target: 3, satisfied: false },
          ],
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

  test("compacts a hub to its GUI-visible context and available decisions", () => {
    const snapshot: HubSnapshot = {
      day: 2,
      maxDay: 7,
      slot: 1,
      slotName: "Evening",
      slotsPerDay: 2,
      stats: [{ id: "hp", name: "HP", value: 8, min: 0, max: 10 }],
      affections: [{ id: "ally", name: "Ally", value: 3 }],
      objectives: [{
        id: "main",
        title: "Leave town",
        scope: "main",
        terminal: false,
        status: "active",
        relatedActivityIds: ["depart", "move"],
      }],
      activities: [
        {
          id: "depart",
          kind: "action",
          title: "Depart",
          category: "raid",
          cost: 0,
          available: true,
          recommended: true,
        },
        {
          id: "move",
          kind: "action",
          title: "Move onward",
          category: "raid",
          cost: 0,
          available: true,
        },
        ...Array.from({ length: 100 }, (_, index) => ({
          id: `locked-${index}`,
          kind: "action" as const,
          title: `Locked ${index}`,
          category: "shop",
          cost: 0,
          available: false,
          lockedReason: `need-key-${index}`,
        })),
      ],
    };
    const compact = compactHeadlessOutput(
      presentHeadlessOutput({ type: "hubMenu", snapshot }, new Map()),
    );

    expect(compact).toMatchObject({
      type: "hubMenu",
      context: {
        day: 2,
        stats: [{ id: "hp", value: 8 }],
        objectives: [{ id: "main", title: "Leave town" }],
      },
      decision: {
        candidateActivityIds: ["depart", "move"],
        candidateInputs: [
          { type: "doActivity", id: "depart" },
          { type: "doActivity", id: "move" },
        ],
        candidates: [
          { activityId: "depart", title: "Depart" },
          { activityId: "move", title: "Move onward" },
        ],
        primaryActivityId: null,
      },
      opportunityGroups: [{
        category: "raid",
        candidates: [{ activityId: "depart", title: "Depart" }],
      }],
      sections: [
        { category: "raid", availableCount: 2, lockedCount: 0 },
        { category: "shop", availableCount: 0, lockedCount: 100 },
      ],
    });
    expect(compact).not.toHaveProperty("snapshot");
    expect(compact).not.toHaveProperty("hubView");
    expect(JSON.stringify(compact)).not.toContain("need-key-99");
    expect(JSON.stringify(compact).length).toBeLessThan(2_000);
  });
});
