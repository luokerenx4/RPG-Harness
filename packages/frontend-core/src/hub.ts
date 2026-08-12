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
  recommendedCount: number;
}

export interface HubView {
  sections: HubSectionView[];
  // Flattened presentation order. ScreenModel installs this order so keyboard
  // cursor movement and visible rows never disagree.
  activities: HubActivity[];
  focusCategory: string | null;
  decisionRequired: boolean;
  candidateActivityIds: string[];
  candidateInputs: Array<{ type: "doActivity"; id: string }>;
  primaryActivityId: string | null;
  primaryInput: { type: "doActivity"; id: string } | null;
  primaryReason:
    | "authored_recommendation"
    | "only_available_in_focus_section"
    | null;
  selectionRule: "authored_recommendation_or_only_candidate";
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
          Number(b.activity.recommended === true) -
            Number(a.activity.recommended === true) ||
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
        recommendedCount: activities.filter(
          ({ activity }) => activity.available && activity.recommended === true,
        ).length,
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
      const recommendation =
        Number(b.recommendedCount > 0) - Number(a.recommendedCount > 0);
      if (recommendation !== 0) return recommendation;
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
  const availableRecommended = activities.filter(
    (activity) => activity.available && activity.recommended === true,
  );
  const focusSection = sections.find((section) => section.availableCount > 0);
  const focusCandidates =
    focusSection?.activities
      .map(({ activity }) => activity)
      .filter((activity) => activity.available) ?? [];
  const candidates =
    availableRecommended.length > 0 ? availableRecommended : focusCandidates;
  const primary =
    availableRecommended.length === 1
      ? availableRecommended[0]!
      : availableRecommended.length === 0 && focusCandidates.length === 1
        ? focusCandidates[0]!
        : null;
  const primaryReason = primary
    ? primary.recommended === true
      ? "authored_recommendation"
      : "only_available_in_focus_section"
    : null;
  return {
    sections,
    activities,
    focusCategory: focusSection?.category ?? null,
    decisionRequired: primary === null && candidates.length > 1,
    candidateActivityIds: candidates.map((activity) => activity.id),
    candidateInputs: candidates.map((activity) => ({
      type: "doActivity",
      id: activity.id,
    })),
    primaryActivityId: primary?.id ?? null,
    primaryInput: primary ? { type: "doActivity", id: primary.id } : null,
    primaryReason,
    selectionRule: "authored_recommendation_or_only_candidate",
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
