import type { HubActivity, HubSnapshot } from "@rpg-harness/engine";

// Shared presentation semantics for hub-like menus. Engine modules are free to
// introduce their own categories; these well-known categories merely provide a
// useful default ordering across the DOM, TUI, autoplay and headless clients.
// This is deliberately a heuristic, not authored quest guidance.
const WELL_KNOWN_CATEGORY_ORDER = [
  "story",
  "combat",
  "raid",
  "move",
  "rest",
  "spirit",
  "social",
  "shop",
] as const;

const categoryRank = new Map<string, number>(
  WELL_KNOWN_CATEGORY_ORDER.map((category, index) => [category, index]),
);

export interface HubActivityView {
  activity: HubActivity;
  // Index in the incoming engine snapshot. Useful when a shell must correlate
  // a presented row with an engine-authored ordering.
  originalIndex: number;
}

export interface HubSectionView {
  category: string;
  label: string;
  activities: HubActivityView[];
  availableCount: number;
  lockedCount: number;
}

export interface HubView {
  sections: HubSectionView[];
  // Flattened presentation order. ScreenModel installs this order so keyboard
  // cursor movement and visible rows never disagree.
  activities: HubActivity[];
  primaryActivityId: string | null;
  primaryInput: { type: "doActivity"; id: string } | null;
  selectionRule: "first_available_in_prioritized_sections";
}

// HubSnapshot is shared by calendar/training games and free-form map hubs.
// The latter use zeroes as "not applicable" sentinels, so renderers must not
// leak those implementation defaults as a fictional Day 0/0.
export function formatHubCalendar(snapshot: HubSnapshot): string | null {
  if (snapshot.maxDay <= 0 || snapshot.slotsPerDay <= 0) return null;
  const day = `Day ${snapshot.day}/${snapshot.maxDay}`;
  return snapshot.slotName ? `${day} · ${snapshot.slotName}` : day;
}

export function buildHubView(snapshot: HubSnapshot): HubView {
  const buckets = new Map<
    string,
    { firstIndex: number; activities: HubActivityView[] }
  >();

  snapshot.activities.forEach((activity, originalIndex) => {
    const category = normalizeCategory(activity.category);
    const bucket = buckets.get(category);
    const entry = { activity, originalIndex };
    if (bucket) bucket.activities.push(entry);
    else {
      buckets.set(category, { firstIndex: originalIndex, activities: [entry] });
    }
  });

  const sections = [...buckets.entries()]
    .map(([category, bucket]) => {
      // Available actions lead each section; locked rows stay visible as
      // affordances without burying the current loop.
      const activities = [...bucket.activities].sort(
        (a, b) =>
          Number(b.activity.available) - Number(a.activity.available) ||
          a.originalIndex - b.originalIndex,
      );
      const availableCount = activities.filter(
        ({ activity }) => activity.available,
      ).length;
      return {
        category,
        label: formatCategoryLabel(category),
        activities,
        availableCount,
        lockedCount: activities.length - availableCount,
        firstIndex: bucket.firstIndex,
      };
    })
    .sort((a, b) => {
      // A completely locked section never precedes an actionable one. Among
      // peers, known categories use the shared loop-oriented order; custom
      // categories retain their authored first-seen order.
      const availability =
        Number(b.availableCount > 0) - Number(a.availableCount > 0);
      if (availability !== 0) return availability;
      const aRank = categoryRank.get(a.category);
      const bRank = categoryRank.get(b.category);
      if (aRank !== undefined || bRank !== undefined) {
        return (aRank ?? WELL_KNOWN_CATEGORY_ORDER.length) -
          (bRank ?? WELL_KNOWN_CATEGORY_ORDER.length);
      }
      return a.firstIndex - b.firstIndex;
    })
    .map(({ firstIndex: _firstIndex, ...section }) => section);

  const activities = sections.flatMap((section) =>
    section.activities.map(({ activity }) => activity),
  );
  const primary = activities.find((activity) => activity.available) ?? null;
  return {
    sections,
    activities,
    primaryActivityId: primary?.id ?? null,
    primaryInput: primary ? { type: "doActivity", id: primary.id } : null,
    selectionRule: "first_available_in_prioritized_sections",
  };
}

function normalizeCategory(category: string | undefined): string {
  const normalized = category?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : "other";
}

function formatCategoryLabel(category: string): string {
  return category
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}
