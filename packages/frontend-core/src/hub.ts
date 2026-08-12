import type { HubSnapshot } from "@rpg-harness/engine";

// HubSnapshot is shared by calendar/training games and free-form map hubs.
// The latter use zeroes as "not applicable" sentinels, so renderers must not
// leak those implementation defaults as a fictional Day 0/0.
export function formatHubCalendar(snapshot: HubSnapshot): string | null {
  if (snapshot.maxDay <= 0 || snapshot.slotsPerDay <= 0) return null;
  const day = `Day ${snapshot.day}/${snapshot.maxDay}`;
  return snapshot.slotName ? `${day} · ${snapshot.slotName}` : day;
}
