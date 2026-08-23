import {
  activityDecisionContext,
  choiceDecisionContext,
  peek,
  step,
} from "@rpg-harness/engine";
import type { Input } from "@rpg-harness/engine";
import {
  rebindSessionCoPlayControl,
  withSessionLock,
} from "@rpg-harness/session-store";
import { loadGame } from "../loader";
import { presentHeadlessCommandResult } from "../presenters/headlessCommand";
import { presentHeadlessOutput } from "../presenters/headlessOutput";
import { appendLog, loadSession, saveSession } from "../session";

interface Args {
  gameDir: string;
  session: string;
  input: string;
  full: boolean;
  pretty: boolean;
}

export async function stepCommand(args: Args): Promise<void> {
  const game = await loadGame(args.gameDir);
  let input: Input;
  try {
    input = JSON.parse(args.input) as Input;
  } catch (err) {
    throw new Error(`Invalid --input JSON: ${(err as Error).message}`);
  }
  const result = await withSessionLock(args.gameDir, args.session, async () => {
    const state = await loadSession(args.gameDir, args.session, game);
    const lineageState = structuredClone(state);
    const before = await peek(game, state);
    const next = await step(game, state, input);
    await saveSession(args.gameDir, args.session, next.state);
    const decision = next.inputResult?.accepted
      ? choiceDecisionContext(before.output, input)
      : undefined;
    const activityDecision = next.inputResult?.accepted
      ? activityDecisionContext(before.output, input)
      : undefined;
    await appendLog(args.gameDir, args.session, {
      t: Date.now(),
      source: "cli",
      input,
      output: next.output,
      ...(next.inputResult ? { inputResult: next.inputResult } : {}),
      ...(decision ? { decision } : {}),
      ...(activityDecision ? { activityDecision } : {}),
    }, next.state);
    if (next.inputResult?.accepted) {
      await rebindSessionCoPlayControl({
        gameDir: args.gameDir,
        session: args.session,
        previousState: lineageState,
        state: next.state,
        controller: "cli",
        lastAction: publicAction(input, decision, activityDecision),
      });
    }
    return next;
  });
  const assetMap = new Map((game.assets ?? []).map((a) => [a.path, a]));
  const output = presentHeadlessOutput(result.output, assetMap);
  const payload = presentHeadlessCommandResult({
    session: args.session,
    output,
    done: result.done,
    state: result.state,
    ...(result.inputResult ? { inputResult: result.inputResult } : {}),
    full: args.full,
  });
  process.stdout.write(
    args.pretty ? JSON.stringify(payload, null, 2) + "\n" : JSON.stringify(payload) + "\n",
  );
}

function publicAction(
  input: Input,
  decision?: ReturnType<typeof choiceDecisionContext>,
  activity?: ReturnType<typeof activityDecisionContext>,
) {
  switch (input.type) {
    case "next": return { type: "next" as const };
    case "quit": return { type: "quit" as const };
    case "choose": return {
      type: "choose" as const,
      ...(decision?.choiceId ? { choiceId: decision.choiceId } : {}),
      ...(decision?.optionId ? { optionId: decision.optionId } : {}),
    };
    case "select": return { type: "select" as const, scriptId: input.scriptId };
    case "doActivity": return {
      type: "doActivity" as const,
      id: activity?.activityId ?? input.id,
      ...(activity?.title ? { title: activity.title } : {}),
    };
    case "moveMap": return { type: "moveMap" as const, direction: input.direction };
  }
}
