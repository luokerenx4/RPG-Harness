import type {
  ActivityForecastMetric,
  HubActivity,
  HubObjectiveRequirement,
  HubSnapshot,
} from "@rpg-harness/engine";

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

export interface HubOpportunityGroupView {
  category: string;
  label: string;
  activities: HubActivityView[];
  decisionRequired: boolean;
  candidateActivityIds: string[];
  candidateInputs: Array<{ type: "doActivity"; id: string }>;
  primaryActivityId: string | null;
  primaryInput: { type: "doActivity"; id: string } | null;
  primaryReason:
    | "authored_recommendation"
    | "only_available_in_opportunity_group"
    | null;
}

export interface HubObjectiveGuidanceView {
  objectiveId: string;
  scope: "main";
  terminal: boolean;
  decisionRequired: boolean;
  candidateActivityIds: string[];
  candidateInputs: Array<{ type: "doActivity"; id: string }>;
  primaryActivityId: string | null;
  primaryInput: { type: "doActivity"; id: string } | null;
}

export interface HubView {
  sections: HubSectionView[];
  // Flattened presentation order. ScreenModel installs this order so keyboard
  // cursor movement and visible rows never disagree.
  activities: HubActivity[];
  focusCategory: string | null;
  // True when actionable categories compete for the next move. This is a
  // strategic decision; decisionRequired below describes only the narrowed
  // candidate set selected by candidateScope.
  strategyDecisionRequired: boolean;
  opportunityGroups: HubOpportunityGroupView[];
  objectiveGuidance: HubObjectiveGuidanceView | null;
  candidateScope: "main_objective" | "authored_recommendations" | "focus_section";
  decisionRequired: boolean;
  candidateActivityIds: string[];
  candidateInputs: Array<{ type: "doActivity"; id: string }>;
  primaryActivityId: string | null;
  primaryInput: { type: "doActivity"; id: string } | null;
  primaryReason:
    | "main_objective"
    | "authored_recommendation"
    | "only_available_in_focus_section"
    | null;
  selectionRule: "main_objective_or_authored_recommendation_or_only_candidate";
}

// HubSnapshot is shared by calendar/training games and free-form map hubs.
// The latter use zeroes as "not applicable" sentinels, so renderers must not
// leak those implementation defaults as a fictional Day 0/0.
export function formatHubCalendar(snapshot: HubSnapshot): string | null {
  if (snapshot.maxDay <= 0 || snapshot.slotsPerDay <= 0) return null;
  const day = `Day ${snapshot.day}/${snapshot.maxDay}`;
  return snapshot.slotName ? `${day} · ${snapshot.slotName}` : day;
}

export function formatActivityForecast(activity: HubActivity): string | null {
  const metrics = activity.forecast?.metrics ?? [];
  if (metrics.length === 0) return activity.forecast?.summary ?? null;
  return metrics
    .map((metric) => {
      const value = formatForecastMetricValue(metric);
      return value ? `${metric.label} ${value}` : metric.label;
    })
    .join(" · ");
}

/**
 * Project a lossless machine forecast metric into player language. `unit` is
 * an AI/runtime identifier, not display text: known semantic units receive a
 * shared rendering, custom units require an explicit `unitLabel`, and unknown
 * ids remain hidden instead of leaking implementation vocabulary.
 */
export function formatForecastMetricValue(
  metric: ActivityForecastMetric,
): string {
  const suffix = formatMetricUnit(metric);
  const prefix = metric.unit === "item" && metric.polarity === "benefit" ? "+" : "";
  if (metric.value !== undefined) {
    return `${typeof metric.value === "number" ? prefix : ""}${String(metric.value)}${suffix}`;
  }
  if (metric.min !== undefined && metric.max !== undefined) {
    return `${prefix}${metric.min}–${metric.max}${suffix}`;
  }
  if (metric.min !== undefined) return `≥${prefix}${metric.min}${suffix}`;
  if (metric.max !== undefined) return `≤${prefix}${metric.max}${suffix}`;
  return "";
}

/**
 * Keep objective data lossless for AI/Headless consumers while projecting it
 * into player language for GUI shells. The leading ✓/○ already communicates a
 * boolean gate, so repeating `false / true` is diagnostic noise. Numeric and
 * string requirements retain their exact progress.
 */
export function formatObjectiveRequirement(
  requirement: HubObjectiveRequirement,
): string {
  const progress = objectiveRequirementProgress(requirement);
  return `${requirement.satisfied ? "✓" : "○"} ${requirement.label}${
    progress === null ? "" : ` ${progress}`
  }`;
}

export function objectiveRequirementProgress(
  requirement: HubObjectiveRequirement,
): string | null {
  if (
    typeof requirement.current === "boolean" &&
    typeof requirement.target === "boolean"
  ) return null;
  return `${String(requirement.current)} / ${String(requirement.target)}`;
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
  const actionableSectionCount = sections.filter(
    (section) => section.availableCount > 0,
  ).length;
  const availableById = new Map(
    activities
      .filter((activity) => activity.available)
      .map((activity) => [activity.id, activity]),
  );
  const guidedObjective = (snapshot.objectives ?? [])
    .filter((objective) => objective.scope === "main" && objective.status === "active")
    .map((objective) => ({
      objective,
      activities: (objective.relatedActivityIds ?? []).flatMap((id) => {
        const activity = availableById.get(id);
        return activity ? [activity] : [];
      }),
    }))
    .find(({ activities: guided }) => guided.length > 0);
  const guidedActivities = guidedObjective?.activities ?? [];
  const candidates = guidedActivities.length > 0
    ? guidedActivities
    : availableRecommended.length > 0
      ? availableRecommended
      : focusCandidates;
  const candidateScope = guidedActivities.length > 0
    ? "main_objective" as const
    : availableRecommended.length > 0
      ? "authored_recommendations" as const
      : "focus_section" as const;
  const primary =
    guidedActivities.length === 1
      ? guidedActivities[0]!
      : guidedActivities.length > 1
        ? null
        : availableRecommended.length === 1
          ? availableRecommended[0]!
          : availableRecommended.length === 0 &&
              actionableSectionCount === 1 &&
              focusCandidates.length === 1
            ? focusCandidates[0]!
            : null;
  const primaryReason = primary
    ? guidedActivities.includes(primary)
      ? "main_objective" as const
      : primary.recommended === true
        ? "authored_recommendation"
        : "only_available_in_focus_section"
    : null;
  const opportunityGroups = sections.flatMap((section) => {
    const available = section.activities.filter(
      ({ activity }) => activity.available,
    );
    if (available.length === 0) return [];
    const recommended = available.filter(
      ({ activity }) => activity.recommended === true,
    );
    const groupCandidates = recommended.length > 0 ? recommended : available;
    const groupPrimary =
      recommended.length === 1
        ? recommended[0]!.activity
        : recommended.length === 0 && available.length === 1
          ? available[0]!.activity
          : null;
    return [
      {
        category: section.category,
        label: section.label,
        activities: available,
        decisionRequired: groupPrimary === null && groupCandidates.length > 1,
        candidateActivityIds: groupCandidates.map(({ activity }) => activity.id),
        candidateInputs: groupCandidates.map(({ activity }) => ({
          type: "doActivity" as const,
          id: activity.id,
        })),
        primaryActivityId: groupPrimary?.id ?? null,
        primaryInput: groupPrimary
          ? { type: "doActivity" as const, id: groupPrimary.id }
          : null,
        primaryReason: groupPrimary
          ? groupPrimary.recommended === true
            ? ("authored_recommendation" as const)
            : ("only_available_in_opportunity_group" as const)
          : null,
      },
    ];
  });
  const strategicActivities =
    guidedActivities.length > 0
      ? guidedActivities
      : availableRecommended.length > 0
      ? availableRecommended
      : opportunityGroups.flatMap((group) =>
          group.activities.map(({ activity }) => activity),
        );
  const strategicCategories = new Set(
    strategicActivities.map((activity) => normalizeCategory(activity.category)),
  );
  return {
    sections,
    activities,
    focusCategory: focusSection?.category ?? null,
    strategyDecisionRequired: strategicCategories.size > 1,
    opportunityGroups,
    objectiveGuidance: guidedObjective
      ? {
          objectiveId: guidedObjective.objective.id,
          scope: "main",
          terminal: guidedObjective.objective.terminal,
          decisionRequired: guidedActivities.length > 1,
          candidateActivityIds: guidedActivities.map((activity) => activity.id),
          candidateInputs: guidedActivities.map((activity) => ({
            type: "doActivity" as const,
            id: activity.id,
          })),
          primaryActivityId: guidedActivities.length === 1
            ? guidedActivities[0]!.id
            : null,
          primaryInput: guidedActivities.length === 1
            ? { type: "doActivity" as const, id: guidedActivities[0]!.id }
            : null,
        }
      : null,
    candidateScope,
    decisionRequired: primary === null && candidates.length > 1,
    candidateActivityIds: candidates.map((activity) => activity.id),
    candidateInputs: candidates.map((activity) => ({
      type: "doActivity",
      id: activity.id,
    })),
    primaryActivityId: primary?.id ?? null,
    primaryInput: primary ? { type: "doActivity", id: primary.id } : null,
    primaryReason,
    selectionRule: "main_objective_or_authored_recommendation_or_only_candidate",
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

function formatMetricUnit(metric: ActivityForecastMetric): string {
  if (metric.unitLabel !== undefined) return metric.unitLabel;
  if (metric.unit === "percent") return "%";
  if (metric.unit === "HP") return " HP";
  return "";
}
