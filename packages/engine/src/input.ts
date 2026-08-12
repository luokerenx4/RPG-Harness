import { resolveChoiceInput } from "./decision";
import type { Input, Output } from "./types";

export type InputRejectionCode =
  | "malformed-input"
  | "unexpected-input"
  | "malformed-choice"
  | "stale-choice"
  | "option-not-found"
  | "option-locked"
  | "script-not-available"
  | "activity-not-present"
  | "activity-locked"
  | "terminal";

export interface InputExpectation {
  type: Input["type"];
  choiceId?: string;
  ids?: string[];
}

export interface InputResult {
  accepted: boolean;
  code: "accepted" | InputRejectionCode;
  message: string;
  expected: InputExpectation[];
}

/**
 * Validate an input against the exact public output the caller is looking at.
 * This is deliberately output-driven: a legitimate action may make no state
 * change, so before/after diffs cannot reliably tell accepted inputs from
 * protocol mistakes.
 */
export function classifyInput(output: Output, input: unknown): InputResult {
  const expected = expectedInputs(output);
  if (!isRecord(input) || typeof input.type !== "string") {
    return rejected(
      "malformed-input",
      "Input must be an object with a string type field.",
      expected,
    );
  }
  if (output.type === "gameEnd") {
    return rejected("terminal", "The game has already ended.", expected);
  }
  if (input.type === "quit") return accepted(expected);

  if (output.type === "narration" || output.type === "dialogue" || output.type === "clear") {
    return input.type === "next"
      ? accepted(expected)
      : rejected(
        "unexpected-input",
        `${output.type} expects next; received ${input.type}.`,
        expected,
      );
  }

  if (output.type === "choice") {
    if (input.type !== "choose") {
      return rejected(
        "unexpected-input",
        `choice expects choose; received ${input.type}.`,
        expected,
      );
    }
    const candidate = input;
    const hasIndex = Number.isInteger(candidate.index);
    const hasIdentity =
      typeof candidate.choiceId === "string" && typeof candidate.optionId === "string";
    if (hasIndex === hasIdentity) {
      return rejected(
        "malformed-choice",
        "Choose input must specify either index or choiceId/optionId, but not both.",
        expected,
      );
    }
    if (hasIdentity && candidate.choiceId !== output.choiceId) {
      return rejected(
        "stale-choice",
        `Choice ${String(candidate.choiceId)} is stale; current choice is ${output.choiceId ?? "legacy"}.`,
        expected,
      );
    }
    const index = hasIndex
      ? candidate.index as number
      : output.options.findIndex((option) => option.id === candidate.optionId);
    const option = output.options[index];
    if (!option) {
      return rejected(
        "option-not-found",
        `The requested option is not present on the current choice.`,
        expected,
      );
    }
    if (!option.available) {
      return rejected(
        "option-locked",
        option.lockedReason
          ? `The requested option is locked: ${option.lockedReason}`
          : "The requested option is locked.",
        expected,
      );
    }
    // Keep execution and diagnostics on the same resolver.
    return resolveChoiceInput(output, input as Input) === undefined
      ? rejected("malformed-choice", "The choice input could not be resolved.", expected)
      : accepted(expected);
  }

  if (output.type === "scriptComplete") {
    if (input.type !== "select") {
      return rejected(
        "unexpected-input",
        `scriptComplete expects select; received ${input.type}.`,
        expected,
      );
    }
    if (typeof input.scriptId !== "string") {
      return rejected(
        "malformed-input",
        "Select input requires a string scriptId.",
        expected,
      );
    }
    return output.nextAvailable.some((script) => script.id === input.scriptId)
      ? accepted(expected)
      : rejected(
        "script-not-available",
        `Script ${input.scriptId} is not available from the current screen.`,
        expected,
      );
  }

  if (input.type !== "doActivity") {
    return rejected(
      "unexpected-input",
      `hubMenu expects doActivity; received ${input.type}.`,
      expected,
    );
  }
  if (typeof input.id !== "string") {
    return rejected(
      "malformed-input",
      "doActivity input requires a string id.",
      expected,
    );
  }
  const activity = output.snapshot.activities.find((item) => item.id === input.id);
  if (!activity) {
    return rejected(
      "activity-not-present",
      `Activity ${input.id} is not present on the current hub.`,
      expected,
    );
  }
  if (
    !activity.available &&
    (activity.kind === "script" || activity.actionKind === undefined)
  ) {
    return rejected(
      "activity-locked",
      activity.lockedReason
        ? `Activity ${input.id} is locked: ${activity.lockedReason}`
        : `Activity ${input.id} is locked.`,
      expected,
    );
  }
  return accepted(expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function expectedInputs(output: Output): InputExpectation[] {
  switch (output.type) {
    case "narration":
    case "dialogue":
    case "clear":
      return [{ type: "next" }, { type: "quit" }];
    case "choice":
      return [{
        type: "choose",
        ...(output.choiceId ? { choiceId: output.choiceId } : {}),
        ids: output.options.flatMap((option, index) =>
          option.available ? [option.id ?? String(index)] : []
        ),
      }, { type: "quit" }];
    case "scriptComplete":
      return [{ type: "select", ids: output.nextAvailable.map((script) => script.id) }, { type: "quit" }];
    case "hubMenu":
      return [{ type: "doActivity", ids: output.snapshot.activities
        .filter((activity) =>
          activity.available ||
          (activity.kind === "action" && activity.actionKind !== undefined)
        )
        .map((activity) => activity.id) }, { type: "quit" }];
    case "gameEnd":
      return [];
  }
}

function accepted(expected: InputExpectation[]): InputResult {
  return { accepted: true, code: "accepted", message: "Input accepted.", expected };
}

function rejected(
  code: InputRejectionCode,
  message: string,
  expected: InputExpectation[],
): InputResult {
  return { accepted: false, code, message, expected };
}
