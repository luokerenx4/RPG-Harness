import type { Input, Output } from "./types";

export interface ChoiceDecisionContext {
  scriptId: string;
  scriptRevision?: string;
  choiceId: string;
  optionId: string;
}

/**
 * Renderer-neutral meaning of an accepted Hub activity selection.
 *
 * The activity id remains useful for exact replay, while the remaining fields
 * preserve why an AI or player chose it after the surrounding Hub snapshot has
 * been truncated from a log or crossed a fork boundary. Payload is deliberately
 * excluded: it is dispatch-private data, not authored decision semantics.
 */
export interface ActivityDecisionContext {
  activityId: string;
  title: string;
  kind: "script" | "action";
  category?: string;
  aiTags?: string[];
  recommended?: boolean;
  actionKind?: string;
  pacingInstanceId?: string;
  relatedObjectiveIds?: string[];
}

interface ChoiceSelectionTarget {
  choiceId?: string;
  options: ReadonlyArray<{ id?: string; available?: boolean }>;
}

/** Resolve either a legacy presentation index or a stable authored identity. */
export function resolveChoiceInput(
  target: ChoiceSelectionTarget,
  input: Input,
): number | undefined {
  if (input.type !== "choose") return undefined;
  const candidate = input as Record<string, unknown>;
  const hasIndex = Number.isInteger(candidate.index);
  const hasIdentity =
    typeof candidate.choiceId === "string" && typeof candidate.optionId === "string";
  // Ambiguous or malformed JSON must fail closed instead of guessing.
  if (hasIndex === hasIdentity) return undefined;
  const index = hasIndex
    ? candidate.index as number
    : target.choiceId === candidate.choiceId
      ? target.options.findIndex((option) => option.id === candidate.optionId)
      : -1;
  const option = target.options[index];
  return option !== undefined && option.available !== false ? index : undefined;
}

export function choiceDecisionContext(
  output: Output | null,
  input: Input,
): ChoiceDecisionContext | undefined {
  if (
    output?.type !== "choice" ||
    input.type !== "choose" ||
    output.scriptId === undefined ||
    output.choiceId === undefined
  ) return undefined;
  const index = resolveChoiceInput(output, input);
  const optionId = index === undefined ? undefined : output.options[index]?.id;
  return optionId === undefined
    ? undefined
    : {
        scriptId: output.scriptId,
        ...(output.scriptRevision !== undefined
          ? { scriptRevision: output.scriptRevision }
          : {}),
        choiceId: output.choiceId,
        optionId,
      };
}

export function activityDecisionContext(
  output: Output | null,
  input: Input,
): ActivityDecisionContext | undefined {
  if (output?.type !== "hubMenu" || input.type !== "doActivity") return undefined;
  const activity = output.snapshot.activities.find(({ id }) => id === input.id);
  if (!activity || activity.available !== true) return undefined;
  const relatedObjectiveIds = output.snapshot.objectives
    ?.filter((objective) =>
      objective.status === "active" &&
      objective.relatedActivityIds?.includes(activity.id)
    )
    .map(({ id }) => id);
  return {
    activityId: activity.id,
    title: activity.title,
    kind: activity.kind,
    ...(activity.category !== undefined ? { category: activity.category } : {}),
    ...(activity.aiTags !== undefined ? { aiTags: [...activity.aiTags] } : {}),
    ...(activity.recommended !== undefined
      ? { recommended: activity.recommended }
      : {}),
    ...(activity.actionKind !== undefined ? { actionKind: activity.actionKind } : {}),
    ...(activity.pacingInstanceId !== undefined
      ? { pacingInstanceId: activity.pacingInstanceId }
      : {}),
    ...(relatedObjectiveIds?.length ? { relatedObjectiveIds } : {}),
  };
}
