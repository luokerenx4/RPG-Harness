import type { Input, Output } from "./types";

export interface ChoiceDecisionContext {
  scriptId: string;
  scriptRevision?: string;
  choiceId: string;
  optionId: string;
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
