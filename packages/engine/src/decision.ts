import type { Input, Output } from "./types";

export interface ChoiceDecisionContext {
  scriptId: string;
  choiceId: string;
  optionId: string;
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
  const optionId = output.options[input.index]?.id;
  return optionId === undefined
    ? undefined
    : {
        scriptId: output.scriptId,
        choiceId: output.choiceId,
        optionId,
      };
}
