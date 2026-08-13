import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import type { HubSnapshot } from "@rpg-harness/engine";
import { HubMenu } from "./HubMenu";

describe("HubMenu player projection", () => {
  test("does not render machine effects hints while keeping player prose", () => {
    const snapshot: HubSnapshot = {
      day: 0,
      maxDay: 0,
      slot: 0,
      slotName: "",
      slotsPerDay: 0,
      stats: [],
      affections: [],
      activities: [{
        id: "bond:kagari",
        kind: "action",
        title: "篝に贈り物をする",
        description: "親密度 +1（50 両）",
        category: "social",
        cost: 0,
        available: true,
        effectsHint: "affection.kagari+1 ryo-50",
        forecast: {
          metrics: [{
            id: "inventory:ryo",
            label: "両",
            value: 11,
            unit: "item",
            polarity: "benefit",
          }],
        },
      }],
    };

    const screen = render(<HubMenu snapshot={snapshot} cursor={0} />);
    expect(screen.lastFrame()).toContain("篝に贈り物をする");
    expect(screen.lastFrame()).toContain("親密度 +1（50 両）");
    expect(screen.lastFrame()).not.toContain("affection.kagari+1");
    expect(screen.lastFrame()).not.toContain("ryo-50");
    expect(screen.lastFrame()).toContain("両 +11");
    expect(screen.lastFrame()).not.toContain("item");
  });
});
