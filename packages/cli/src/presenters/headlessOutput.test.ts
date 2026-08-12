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
      primaryActivityId: "depart",
      primaryInput: { type: "doActivity", id: "depart" },
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
    });
  });
});
