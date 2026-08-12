import type { AssetSpec, Output } from "@rpg-harness/engine";
import { buildHubView } from "@rpg-harness/frontend-core";
import { joinVisualState, type JoinedVisualState } from "./visualSummary";

export interface HeadlessHubView {
  heuristic: true;
  selectionRule: "first_available_in_prioritized_sections";
  primaryActivityId: string | null;
  primaryInput: { type: "doActivity"; id: string } | null;
  resourceGroups: Array<{
    id: string;
    title: string;
    description?: string;
    resources: Array<{ id: string; name: string; quantity: number }>;
  }>;
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

function summarizeHubView(output: Extract<Output, { type: "hubMenu" }>): HeadlessHubView {
  const view = buildHubView(output.snapshot);
  return {
    heuristic: true,
    selectionRule: view.selectionRule,
    primaryActivityId: view.primaryActivityId,
    primaryInput: view.primaryInput,
    resourceGroups: output.snapshot.resourceGroups ?? [],
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
