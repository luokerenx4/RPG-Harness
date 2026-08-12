import { Engine } from "./engine";
import { classifyInput, type InputResult } from "./input";
import type { ComposedState, Game, Input, Output } from "./types";

export interface StepResult {
  output: Output | null;
  state: ComposedState;
  done: boolean;
  inputResult?: InputResult;
}

export async function peek(
  game: Game,
  state: ComposedState,
): Promise<StepResult> {
  const engine = new Engine(game, state);
  const runner = engine.run();
  const first = await runner.next();
  await runner.return();
  const output = first.done ? null : first.value;
  return {
    output,
    state: engine.getState(),
    // gameEnd is a terminal yield — the run loop yields it then returns.
    // From the caller's perspective the game IS over, so done:true here
    // even though the generator hasn't formally returned yet. This keeps
    // peek and step consistent (both report done:true at game-end).
    done: first.done === true || output?.type === "gameEnd",
  };
}

export async function step(
  game: Game,
  state: ComposedState,
  input: Input,
): Promise<StepResult> {
  const engine = new Engine(game, state);
  const runner = engine.run();
  const prime = await runner.next();
  if (prime.done) {
    return {
      output: null,
      state: engine.getState(),
      done: true,
      inputResult: {
        accepted: false,
        code: "terminal",
        message: "The game has already ended.",
        expected: [],
      },
    };
  }
  // If the current yielded output is gameEnd, the game is over.
  // Don't consume input past it — that swallows the gameEnd and
  // returns output:null, which breaks AI players following the
  // "stop on gameEnd" rule. Return the gameEnd idempotently with
  // done:true instead.
  if (prime.value.type === "gameEnd") {
    await runner.return();
    return {
      output: prime.value,
      state: engine.getState(),
      done: true,
      inputResult: classifyInput(prime.value, input),
    };
  }
  const inputResult = classifyInput(prime.value, input);
  if (!inputResult.accepted) {
    await runner.return();
    return {
      output: prime.value,
      state: engine.getState(),
      done: false,
      inputResult,
    };
  }
  const next = await runner.next(input);
  await runner.return();
  const output = next.done ? null : next.value;
  return {
    output,
    state: engine.getState(),
    done: next.done === true || output?.type === "gameEnd",
    inputResult,
  };
}
