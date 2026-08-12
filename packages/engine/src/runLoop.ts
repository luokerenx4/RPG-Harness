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
  | "quit"
  | "error";

export interface LoopResult {
  trace: TraceEntry[];
  finalState: ComposedState;
  done: boolean;
  reason: LoopReason;
  error?: string;
}

export type InputSource =
  | Input[]
  | ((output: Output, state: ComposedState, stepIndex: number) => Promise<Input | null>);

export interface RunLoopOptions {
  maxSteps?: number;
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
