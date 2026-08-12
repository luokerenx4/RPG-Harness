import { Engine } from "./engine";
import { choiceDecisionContext, type ChoiceDecisionContext } from "./decision";
import { classifyInput, type InputResult } from "./input";
import { cloneState, createInitialState } from "./state";
import type { ComposedState, Game, Input, Output } from "./types";

export interface TraceEntry {
  index: number;
  input: Input | null;
  output: Output;
  decision?: ChoiceDecisionContext;
  inputResult?: InputResult;
}

export type LoopReason =
  | "completed"
  | "inputs-exhausted"
  | "max-steps"
  | "stalled"
  | "quit"
  | "error";

export interface StallCycleStep {
  traceIndex: number;
  input: Input | null;
  output: string;
}

export interface StallDiagnostic {
  cycleLength: number;
  repetitions: number;
  firstTraceIndex: number;
  lastTraceIndex: number;
  cycle: StallCycleStep[];
}

export interface LoopResult {
  trace: TraceEntry[];
  finalState: ComposedState;
  done: boolean;
  reason: LoopReason;
  error?: string;
  stall?: StallDiagnostic;
}

export type InputSource =
  | Input[]
  | ((output: Output, state: ComposedState, stepIndex: number) => Promise<Input | null>);

export interface RunLoopOptions {
  maxSteps?: number;
  stallDetection?: {
    /** Consecutive identical state/output cycles required before stopping. Default: 3. */
    repetitions?: number;
    /** Longest visible-output cycle considered. Default: 20. */
    maxCycleLength?: number;
  };
  onStep?: (entry: TraceEntry, state: ComposedState) => void | Promise<void>;
}

export async function runLoop(
  game: Game,
  initialState: ComposedState | undefined,
  inputs: InputSource,
  options: RunLoopOptions = {},
): Promise<LoopResult> {
  const startState = initialState
    ? cloneState(initialState)
    : createInitialState(game);
  const engine = new Engine(game, startState);
  const runner = engine.run();
  const trace: TraceEntry[] = [];
  const fingerprints: string[] = [];
  const maxSteps = options.maxSteps ?? 5000;

  const inputsArray: Input[] | null = Array.isArray(inputs) ? inputs : null;
  const inputsFn = !Array.isArray(inputs) ? inputs : null;
  let cursor = 0;
  let lastInput: Input | null = null;
  let lastOutput: Output | null = null;
  let stepIndex = 0;

  try {
    let priming = true;
    while (true) {
      const inputResult: InputResult | undefined = !priming && lastOutput && lastInput
        ? classifyInput(lastOutput, lastInput)
        : undefined;
      const result: IteratorResult<Output, void> = priming
        ? await runner.next()
        : inputResult?.accepted === false
          ? { done: false as const, value: lastOutput! }
          : await runner.next(lastInput!);
      priming = false;

      if (result.done) {
        return {
          trace,
          finalState: engine.getState(),
          done: true,
          reason: "completed",
        };
      }
      const decision = lastInput && inputResult?.accepted !== false
        ? choiceDecisionContext(lastOutput, lastInput)
        : undefined;
      const entry: TraceEntry = {
        index: stepIndex,
        input: lastInput,
        output: result.value,
        ...(inputResult ? { inputResult } : {}),
        ...(decision ? { decision } : {}),
      };
      lastOutput = result.value;
      trace.push(entry);
      await options.onStep?.(entry, engine.getState());

      // gameEnd is a terminal public output. Do not ask an input source for
      // another move and then misclassify its null response as exhaustion.
      if (result.value.type === "gameEnd") {
        await runner.return();
        return {
          trace,
          finalState: engine.getState(),
          done: true,
          reason: "completed",
        };
      }

      if (options.stallDetection) {
        const stallRepetitions = options.stallDetection.repetitions ?? 3;
        const stallMaxCycleLength = options.stallDetection.maxCycleLength ?? 20;
        fingerprints.push(stableStringify({
          state: engine.getState(),
          output: result.value,
        }));
        const fingerprintWindow = stallRepetitions * stallMaxCycleLength;
        if (fingerprints.length > fingerprintWindow) fingerprints.shift();
        const stall = detectStall(
          trace,
          fingerprints,
          stallRepetitions,
          stallMaxCycleLength,
        );
        if (stall) {
          await runner.return();
          return {
            trace,
            finalState: engine.getState(),
            done: false,
            reason: "stalled",
            stall,
          };
        }
      }

      // maxSteps budgets inputs, not public outputs. Check the budget before
      // asking the input source for another decision: an LLM-backed source may
      // be expensive or stateful, and its answer must never be requested only
      // to be discarded on the next loop iteration.
      if (stepIndex >= maxSteps) {
        await runner.return();
        return {
          trace,
          finalState: engine.getState(),
          done: false,
          reason: "max-steps",
        };
      }

      let nextInput: Input | null;
      if (inputsArray) {
        if (cursor >= inputsArray.length) {
          await runner.return();
          return {
            trace,
            finalState: engine.getState(),
            done: false,
            reason: "inputs-exhausted",
          };
        }
        nextInput = inputsArray[cursor++] ?? null;
      } else {
        nextInput = await inputsFn!(result.value, engine.getState(), stepIndex);
      }
      if (!nextInput) {
        await runner.return();
        return {
          trace,
          finalState: engine.getState(),
          done: false,
          reason: "inputs-exhausted",
        };
      }
      if (nextInput.type === "quit") {
        await runner.return();
        return {
          trace,
          finalState: engine.getState(),
          done: false,
          reason: "quit",
        };
      }
      lastInput = nextInput;
      stepIndex++;
    }
  } catch (err) {
    return {
      trace,
      finalState: engine.getState(),
      done: false,
      reason: "error",
      error: (err as Error).message,
    };
  }
}

function detectStall(
  trace: TraceEntry[],
  fingerprints: string[],
  repetitions: number,
  maxCycleLength: number,
): StallDiagnostic | undefined {
  if (!Number.isInteger(repetitions) || repetitions < 2) {
    throw new Error("stallDetection.repetitions must be an integer of at least 2");
  }
  if (!Number.isInteger(maxCycleLength) || maxCycleLength < 1) {
    throw new Error("stallDetection.maxCycleLength must be a positive integer");
  }
  for (let cycleLength = 1; cycleLength <= maxCycleLength; cycleLength++) {
    const windowLength = cycleLength * repetitions;
    if (fingerprints.length < windowLength) continue;
    const start = fingerprints.length - windowLength;
    let repeats = true;
    for (let offset = cycleLength; offset < windowLength; offset++) {
      if (fingerprints[start + offset] !== fingerprints[start + (offset % cycleLength)]) {
        repeats = false;
        break;
      }
    }
    if (!repeats) continue;
    const cycleStart = trace.length - cycleLength;
    return {
      cycleLength,
      repetitions,
      firstTraceIndex: trace[trace.length - windowLength]!.index,
      lastTraceIndex: trace.at(-1)!.index,
      cycle: trace.slice(cycleStart).map((entry) => ({
        traceIndex: entry.index,
        input: entry.input,
        output: describeOutput(entry.output),
      })),
    };
  }
  return undefined;
}

function describeOutput(output: Output): string {
  switch (output.type) {
    case "narration":
      return `narration: ${output.text}`;
    case "dialogue":
      return `dialogue ${output.speakerName ?? output.speakerId}: ${output.text}`;
    case "choice":
      return `choice ${[output.scriptId, output.choiceId].filter(Boolean).join("/") || "legacy"}`;
    case "scriptComplete":
      return `scriptComplete ${output.completedId ?? "-"}`;
    case "hubMenu":
      return `hub available=[${output.snapshot.activities
        .filter((activity) => activity.available)
        .map((activity) => activity.id)
        .join(",")}]`;
    case "gameEnd":
      return `gameEnd${output.reason ? `: ${output.reason}` : ""}`;
    case "clear":
      return "clear";
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForFingerprint(value));
}

function sortForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForFingerprint);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortForFingerprint(nested)]),
  );
}
