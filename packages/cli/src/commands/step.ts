import { step } from "@rpg-harness/engine";
import type { Input } from "@rpg-harness/engine";
import { withSessionLock } from "@rpg-harness/session-store";
import { loadGame } from "../loader";
import { joinVisualState } from "../presenters/visualSummary";
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
    const next = await step(game, state, input);
    await saveSession(args.gameDir, args.session, next.state);
    await appendLog(args.gameDir, args.session, {
      t: Date.now(),
      source: "cli",
      input,
      output: next.output,
    });
    return next;
  });
  const assetMap = new Map((game.assets ?? []).map((a) => [a.path, a]));
  const output =
    result.output && result.output.visualState
      ? {
          ...result.output,
          visualStateResolved: joinVisualState(
            result.output.visualState,
            assetMap,
          ),
        }
      : result.output;
  const payload = {
    output,
    done: result.done,
    state: result.state,
  };
  process.stdout.write(
    args.pretty ? JSON.stringify(payload, null, 2) + "\n" : JSON.stringify(payload) + "\n",
  );
}
