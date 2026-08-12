import { describe, expect, test } from "bun:test";
import type { HubSnapshot } from "@rpg-harness/engine";
import { formatHubCalendar } from "./hub";

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
