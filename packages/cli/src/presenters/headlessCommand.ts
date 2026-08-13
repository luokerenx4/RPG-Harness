import { createHash } from "node:crypto";
import type { ComposedState, InputResult } from "@rpg-harness/engine";
import {
  compactHeadlessOutput,
  type HeadlessOutput,
} from "./headlessOutput";

interface HeadlessCommandResultArgs {
  session: string;
  output: HeadlessOutput | null;
  done: boolean;
  state: ComposedState;
  inputResult?: InputResult;
  full: boolean;
}

/** One causal, GUI-addressable response shared by `peek` and `step`. */
export function presentHeadlessCommandResult(args: HeadlessCommandResultArgs) {
  return {
    session: args.session,
    webPath: `/?session=${encodeURIComponent(args.session)}`,
    stateRevision: createHash("sha256")
      .update(JSON.stringify(args.state))
      .digest("hex"),
    output: args.full ? args.output : compactHeadlessOutput(args.output),
    done: args.done,
    ...(args.inputResult ? { inputResult: args.inputResult } : {}),
    ...(args.full ? { state: args.state } : {}),
  };
}
