import { choiceDecisionContext, peek, step } from "@rpg-harness/engine";
import type { Input } from "@rpg-harness/engine";
import { withSessionLock } from "@rpg-harness/session-store";
import { loadGame } from "../loader";
import { presentHeadlessOutput } from "../presenters/headlessOutput";
import { appendLog, loadSession, saveSession } from "../session";

interface Args {
  gameDir: string;
  session: string;
  input: string;
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
    const before = await peek(game, state);
    const next = await step(game, state, input);
    await saveSession(args.gameDir, args.session, next.state);
    const decision = next.inputResult?.accepted
      ? choiceDecisionContext(before.output, input)
      : undefined;
    await appendLog(args.gameDir, args.session, {
      t: Date.now(),
      source: "cli",
      input,
      output: next.output,
      ...(next.inputResult ? { inputResult: next.inputResult } : {}),
      ...(decision ? { decision } : {}),
    }, next.state);
    return next;
  });
  const assetMap = new Map((game.assets ?? []).map((a) => [a.path, a]));
  const output = presentHeadlessOutput(result.output, assetMap);
  const payload = {
    output,
    done: result.done,
    state: result.state,
    ...(result.inputResult ? { inputResult: result.inputResult } : {}),
  };
  process.stdout.write(
    args.pretty ? JSON.stringify(payload, null, 2) + "\n" : JSON.stringify(payload) + "\n",
  );
}
