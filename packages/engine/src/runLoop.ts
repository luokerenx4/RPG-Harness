import { Engine, ModuleContractError } from "./engine";
import {
  activityDecisionContext,
  choiceDecisionContext,
  type ActivityDecisionContext,
  type ChoiceDecisionContext,
} from "./decision";
import {
  classifyInput,
  retargetAcceptedInputResult,
  type InputResult,
} from "./input";
import {
  cloneState,
  createInitialState,
  ModuleInitializationError,
} from "./state";
import type { ComposedState, Game, Input, Output } from "./types";

export interface TraceEntry {
  index: number;
  input: Input | null;
  output: Output;
  decision?: ChoiceDecisionContext;
  activityDecision?: ActivityDecisionContext;
  inputResult?: InputResult;
}

export type LoopReason =
  | "completed"
  | "condition-met"
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

export interface BehaviorCycleDiagnostic extends StallDiagnostic {
  /** State paths that kept changing while the public behavior repeated. */
  changingStatePaths: string[];
}

export interface LoopResult {
  trace: TraceEntry[];
  finalState: ComposedState;
  done: boolean;
  reason: LoopReason;
  error?: string;
  failure?: LoopFailure;
  stall?: StallDiagnostic;
  behaviorCycle?: BehaviorCycleDiagnostic;
}

export interface LoopFailure {
  phase: "setup" | "prime" | "input" | "decision" | "observer";
  name: string;
  message: string;
  /** The attempted input is present only when the engine failed consuming it. */
  input: Input | null;
  /** Last successfully yielded public output that established input meaning. */
  output: Output | null;
  decision?: ChoiceDecisionContext;
  activityDecision?: ActivityDecisionContext;
  stack?: string;
  /** Author-owned modules whose setup contract caused the failure. */
  moduleIds?: string[];
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
  /** Stop after persisting/observing the current public output and state. */
  stopWhen?: (
    entry: TraceEntry,
    state: ComposedState,
  ) => boolean | Promise<boolean>;
}

export async function runLoop(
  game: Game,
  initialState: ComposedState | undefined,
  inputs: InputSource,
  options: RunLoopOptions = {},
): Promise<LoopResult> {
  const trace: TraceEntry[] = [];
  const fingerprints: string[] = [];
  const behaviorFingerprints: string[] = [];
  const stateSnapshots: string[] = [];
  const maxSteps = options.maxSteps ?? 5000;
  let startState: ComposedState;
  try {
    startState = initialState
      ? cloneState(initialState)
      : createInitialState(game);
  } catch (error) {
    if (!(error instanceof ModuleInitializationError)) throw error;
    return {
      trace,
      finalState: error.partialState,
      done: false,
      reason: "error",
      error: error.message,
      failure: {
        phase: "setup",
        name: error.name,
        message: error.message,
        input: null,
        output: null,
        moduleIds: [error.moduleId],
        ...(error.stack ? { stack: error.stack } : {}),
      },
    };
  }

  const inputsArray: Input[] | null = Array.isArray(inputs) ? inputs : null;
  const inputsFn = !Array.isArray(inputs) ? inputs : null;
  let cursor = 0;
  let lastInput: Input | null = null;
  let lastOutput: Output | null = null;
  let stepIndex = 0;
  let failurePhase: LoopFailure["phase"] = "setup";
  let failureInput: Input | null = null;
  let failureOutput: Output | null = null;
  let engine: Engine | undefined;

  try {
    engine = new Engine(game, startState);
    const runner = engine.run();
    let priming = true;
    while (true) {
      failurePhase = priming ? "prime" : "input";
      failureInput = !priming && lastInput ? structuredClone(lastInput) : null;
      failureOutput = lastOutput ? structuredClone(lastOutput) : null;
      const classifiedInput: InputResult | undefined = !priming && lastOutput && lastInput
        ? classifyInput(lastOutput, lastInput)
        : undefined;
      const result: IteratorResult<Output, void> = priming
        ? await runner.next()
        : classifiedInput?.accepted === false
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
      const inputResult = classifiedInput
        ? retargetAcceptedInputResult(classifiedInput, result.value)
        : undefined;
      const decision = lastInput && inputResult?.accepted !== false
        ? choiceDecisionContext(lastOutput, lastInput)
        : undefined;
      const activityDecision = lastInput && inputResult?.accepted !== false
        ? activityDecisionContext(lastOutput, lastInput)
        : undefined;
      const entry: TraceEntry = {
        index: stepIndex,
        input: lastInput,
        output: result.value,
        ...(inputResult ? { inputResult } : {}),
        ...(decision ? { decision } : {}),
        ...(activityDecision ? { activityDecision } : {}),
      };
      lastOutput = result.value;
      trace.push(entry);
      const currentState = engine.getState();
      failurePhase = "observer";
      failureOutput = structuredClone(result.value);
      await options.onStep?.(entry, currentState);

      // gameEnd is a terminal public output. Do not ask an input source for
      // another move and then misclassify its null response as exhaustion.
      // Terminal truth also takes precedence over a caller-owned local stop:
      // a branch probe that reaches an ending really did complete the game.
      if (result.value.type === "gameEnd") {
        await runner.return();
        return {
          trace,
          finalState: engine.getState(),
          done: true,
          reason: "completed",
        };
      }

      if (await options.stopWhen?.(entry, currentState)) {
        await runner.return();
        return {
          trace,
          finalState: currentState,
          done: false,
          reason: "condition-met",
        };
      }

      if (options.stallDetection) {
        const stallRepetitions = options.stallDetection.repetitions ?? 3;
        const stallMaxCycleLength = options.stallDetection.maxCycleLength ?? 20;
        fingerprints.push(stableStringify({
          state: engine.getState(),
          output: result.value,
        }));
        behaviorFingerprints.push(stableStringify({
          input: entry.input,
          output: result.value,
        }));
        stateSnapshots.push(stableStringify(engine.getState()));
        const fingerprintWindow = stallRepetitions * stallMaxCycleLength;
        if (fingerprints.length > fingerprintWindow) {
          fingerprints.shift();
          behaviorFingerprints.shift();
          stateSnapshots.shift();
        }
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
        const behaviorCycle = options.stallDetection
          ? detectBehaviorCycle(
              trace,
              behaviorFingerprints,
              stateSnapshots,
              options.stallDetection.repetitions ?? 3,
              options.stallDetection.maxCycleLength ?? 20,
            )
          : undefined;
        return {
          trace,
          finalState: engine.getState(),
          done: false,
          reason: "max-steps",
          ...(behaviorCycle ? { behaviorCycle } : {}),
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
        failurePhase = "decision";
        failureOutput = structuredClone(result.value);
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
    const error = err instanceof Error ? err : new Error(String(err));
    const attemptedInput = failurePhase === "input" && failureInput
      ? failureInput
      : null;
    const semanticOutput = failureOutput;
    return {
      trace,
      finalState: engine?.getState() ?? cloneState(startState),
      done: false,
      reason: "error",
      error: error.message,
      failure: {
        phase: failurePhase,
        name: error.name,
        message: error.message,
        input: attemptedInput,
        output: semanticOutput,
        ...failureDecisionContext(semanticOutput, attemptedInput),
        ...(error instanceof ModuleContractError
          ? { moduleIds: error.moduleIds }
          : {}),
        ...(error.stack ? { stack: error.stack } : {}),
      },
    };
  }
}

function failureDecisionContext(
  output: Output | null,
  input: Input | null,
): Pick<LoopFailure, "decision" | "activityDecision"> {
  if (!output || !input) return {};
  const decision = choiceDecisionContext(output, input);
  const activityDecision = activityDecisionContext(output, input);
  return {
    ...(decision ? { decision } : {}),
    ...(activityDecision ? { activityDecision } : {}),
  };
}

function detectBehaviorCycle(
  trace: TraceEntry[],
  behaviorFingerprints: string[],
  stateSnapshots: string[],
  repetitions: number,
  maxCycleLength: number,
): BehaviorCycleDiagnostic | undefined {
  const repeated = detectRepeatedSuffix(
    behaviorFingerprints,
    repetitions,
    maxCycleLength,
  );
  if (!repeated) return undefined;
  const { cycleLength, windowLength, start } = repeated;
  const firstPhaseEnd = start + cycleLength - 1;
  const lastPhaseEnd = behaviorFingerprints.length - 1;
  const changingStatePaths = diffPaths(
    JSON.parse(stateSnapshots[firstPhaseEnd]!),
    JSON.parse(stateSnapshots[lastPhaseEnd]!),
  );
  // An exact state/output cycle should already have returned `stalled`.
  // This diagnostic exists specifically for behavior that repeats while
  // counters, clocks, RNG, or other state keeps moving.
  if (changingStatePaths.length === 0) return undefined;
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
    changingStatePaths,
  };
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
  const repeated = detectRepeatedSuffix(fingerprints, repetitions, maxCycleLength);
  if (repeated) {
    const { cycleLength, windowLength } = repeated;
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

function detectRepeatedSuffix(
  fingerprints: string[],
  repetitions: number,
  maxCycleLength: number,
): { cycleLength: number; windowLength: number; start: number } | undefined {
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
    if (repeats) return { cycleLength, windowLength, start };
  }
  return undefined;
}

function diffPaths(left: unknown, right: unknown, limit = 20): string[] {
  const paths: string[] = [];
  const visit = (a: unknown, b: unknown, path: string): void => {
    if (paths.length >= limit || Object.is(a, b)) return;
    if (
      a === null || b === null ||
      typeof a !== "object" || typeof b !== "object" ||
      Array.isArray(a) !== Array.isArray(b)
    ) {
      paths.push(path || "<root>");
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      const length = Math.max(a.length, b.length);
      for (let index = 0; index < length && paths.length < limit; index++) {
        visit(a[index], b[index], `${path}[${index}]`);
      }
      return;
    }
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(aRecord), ...Object.keys(bRecord)])].sort();
    for (const key of keys) {
      if (paths.length >= limit) break;
      visit(aRecord[key], bRecord[key], path ? `${path}.${key}` : key);
    }
  };
  visit(left, right, "");
  return paths;
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
