import type {
  ActivityForecast,
  AssetSpec,
  Output,
} from "@rpg-harness/engine";
import { buildHubView } from "@rpg-harness/frontend-core";
import { joinVisualState, type JoinedVisualState } from "./visualSummary";

interface HeadlessActivityCandidate {
  activityId: string;
  input: { type: "doActivity"; id: string };
  title: string;
  description?: string;
  pacingInstanceId?: string;
  forecast?: ActivityForecast;
}

export interface HeadlessHubView {
  heuristic: true;
  selectionRule: "main_objective_or_authored_recommendation_or_only_candidate";
  focusCategory: string | null;
  strategyDecisionRequired: boolean;
  objectiveGuidance: ReturnType<typeof buildHubView>["objectiveGuidance"];
  candidateScope: "main_objective" | "authored_recommendations" | "focus_section";
  decisionRequired: boolean;
  candidateActivityIds: string[];
  candidateInputs: Array<{ type: "doActivity"; id: string }>;
  candidates: HeadlessActivityCandidate[];
  opportunityGroups: Array<{
    category: string;
    label: string;
    decisionRequired: boolean;
    candidates: HeadlessActivityCandidate[];
    primaryActivityId: string | null;
    primaryInput: { type: "doActivity"; id: string } | null;
    primaryReason:
      | "authored_recommendation"
      | "only_available_in_opportunity_group"
      | null;
  }>;
  primaryActivityId: string | null;
  primaryInput: { type: "doActivity"; id: string } | null;
  primaryReason:
    | "main_objective"
    | "authored_recommendation"
    | "only_available_in_focus_section"
    | null;
  resourceGroups: Array<{
    id: string;
    title: string;
    description?: string;
    resources: Array<{ id: string; name: string; quantity: number }>;
  }>;
  objectives: NonNullable<Extract<Output, { type: "hubMenu" }>["snapshot"]["objectives"]>;
  sections: Array<{
    category: string;
    label: string;
    availableCount: number;
    lockedCount: number;
    activityIds: string[];
    availableActivityIds: string[];
  }>;
}

export type HeadlessOutput = Output & {
  visualStateResolved?: JoinedVisualState;
  hubView?: HeadlessHubView;
};

export interface CompactHeadlessHubOutput {
  type: "hubMenu";
  context: {
    day: number;
    maxDay: number;
    slot: number;
    slotName: string;
    slotsPerDay: number;
    stats: Extract<Output, { type: "hubMenu" }>["snapshot"]["stats"];
    affections: Extract<Output, { type: "hubMenu" }>["snapshot"]["affections"];
    resourceGroups: NonNullable<
      Extract<Output, { type: "hubMenu" }>["snapshot"]["resourceGroups"]
    >;
    objectives: NonNullable<
      Extract<Output, { type: "hubMenu" }>["snapshot"]["objectives"]
    >;
  };
  decision: Pick<
    HeadlessHubView,
    | "selectionRule"
    | "focusCategory"
    | "strategyDecisionRequired"
    | "objectiveGuidance"
    | "candidateScope"
    | "decisionRequired"
    | "candidateActivityIds"
    | "candidateInputs"
    | "candidates"
    | "primaryActivityId"
    | "primaryInput"
    | "primaryReason"
  >;
  opportunityGroups: HeadlessHubView["opportunityGroups"];
  sections: Array<{
    category: string;
    label: string;
    availableCount: number;
    lockedCount: number;
  }>;
  visualState?: Extract<Output, { type: "hubMenu" }>["visualState"];
  visualStateResolved?: JoinedVisualState;
}

export type CompactHeadlessOutput =
  | CompactHeadlessHubOutput
  | (Exclude<Output, { type: "hubMenu" }> & {
      visualStateResolved?: JoinedVisualState;
    });

// Add renderer-neutral affordances to the raw engine event. The original
// Output fields stay intact; clients that know only the engine protocol can
// ignore these additions, while AI players get a directly executable input.
export function presentHeadlessOutput(
  output: Output | null,
  assetMap: Map<string, AssetSpec>,
): HeadlessOutput | null {
  if (!output) return null;
  const visualStateResolved = output.visualState
    ? joinVisualState(output.visualState, assetMap)
    : undefined;
  const hubView =
    output.type === "hubMenu" ? summarizeHubView(output) : undefined;
  return {
    ...output,
    ...(visualStateResolved ? { visualStateResolved } : {}),
    ...(hubView ? { hubView } : {}),
  };
}

/**
 * Keep the interactive Headless loop focused on the same actionable surface
 * rendered by GUI/TUI clients. A raw hub embeds every locked activity and then
 * repeats the available subset in hubView; that is useful diagnostic data, but
 * it is the wrong default context for one AI decision. `peek --full` and
 * `step --full` retain the lossless representation.
 */
export function compactHeadlessOutput(
  output: HeadlessOutput | null,
): CompactHeadlessOutput | null {
  if (!output || output.type !== "hubMenu") {
    return output as CompactHeadlessOutput | null;
  }
  const view = output.hubView ?? summarizeHubView(output);
  return {
    type: "hubMenu",
    context: {
      day: output.snapshot.day,
      maxDay: output.snapshot.maxDay,
      slot: output.snapshot.slot,
      slotName: output.snapshot.slotName,
      slotsPerDay: output.snapshot.slotsPerDay,
      stats: output.snapshot.stats,
      affections: output.snapshot.affections,
      resourceGroups: output.snapshot.resourceGroups ?? [],
      objectives: output.snapshot.objectives ?? [],
    },
    decision: {
      selectionRule: view.selectionRule,
      focusCategory: view.focusCategory,
      strategyDecisionRequired: view.strategyDecisionRequired,
      objectiveGuidance: view.objectiveGuidance,
      candidateScope: view.candidateScope,
      decisionRequired: view.decisionRequired,
      candidateActivityIds: view.candidateActivityIds,
      candidateInputs: view.candidateInputs,
      candidates: view.candidates,
      primaryActivityId: view.primaryActivityId,
      primaryInput: view.primaryInput,
      primaryReason: view.primaryReason,
    },
    opportunityGroups: view.opportunityGroups,
    sections: view.sections.map((section) => ({
      category: section.category,
      label: section.label,
      availableCount: section.availableCount,
      lockedCount: section.lockedCount,
    })),
    ...(output.visualState !== undefined
      ? { visualState: output.visualState }
      : {}),
    ...(output.visualStateResolved !== undefined
      ? { visualStateResolved: output.visualStateResolved }
      : {}),
  };
}

function summarizeHubView(output: Extract<Output, { type: "hubMenu" }>): HeadlessHubView {
  const view = buildHubView(output.snapshot);
  const activityById = new Map(
    output.snapshot.activities.map((activity) => [activity.id, activity]),
  );
  return {
    heuristic: true,
    selectionRule: view.selectionRule,
    focusCategory: view.focusCategory,
    strategyDecisionRequired: view.strategyDecisionRequired,
    candidateScope: view.candidateScope,
    decisionRequired: view.decisionRequired,
    candidateActivityIds: view.candidateActivityIds,
    candidateInputs: view.candidateInputs,
    candidates: summarizeCandidates(view.candidateActivityIds, activityById),
    opportunityGroups: view.opportunityGroups.map((group) => ({
      category: group.category,
      label: group.label,
      decisionRequired: group.decisionRequired,
      candidates: summarizeCandidates(group.candidateActivityIds, activityById),
      primaryActivityId: group.primaryActivityId,
      primaryInput: group.primaryInput,
      primaryReason: group.primaryReason,
    })),
    objectiveGuidance: view.objectiveGuidance,
    primaryActivityId: view.primaryActivityId,
    primaryInput: view.primaryInput,
    primaryReason: view.primaryReason,
    resourceGroups: output.snapshot.resourceGroups ?? [],
    objectives: output.snapshot.objectives ?? [],
    sections: view.sections.map((section) => ({
      category: section.category,
      label: section.label,
      availableCount: section.availableCount,
      lockedCount: section.lockedCount,
      activityIds: section.activities.map(({ activity }) => activity.id),
      availableActivityIds: section.activities
        .filter(({ activity }) => activity.available)
        .map(({ activity }) => activity.id),
    })),
  };
}

function summarizeCandidates(
  activityIds: string[],
  activityById: Map<
    string,
    Extract<Output, { type: "hubMenu" }>["snapshot"]["activities"][number]
  >,
): HeadlessActivityCandidate[] {
  return activityIds.flatMap((activityId) => {
    const activity = activityById.get(activityId);
    if (!activity) return [];
    return [
      {
        activityId,
        input: { type: "doActivity" as const, id: activityId },
        title: activity.title,
        ...(activity.description !== undefined
          ? { description: activity.description }
          : {}),
        ...(activity.pacingInstanceId !== undefined
          ? { pacingInstanceId: activity.pacingInstanceId }
          : {}),
        ...(activity.forecast !== undefined
          ? { forecast: activity.forecast }
          : {}),
      },
    ];
  });
}
