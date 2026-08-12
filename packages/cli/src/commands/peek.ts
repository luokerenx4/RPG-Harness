import { peek } from "@rpg-harness/engine";
import { loadGame } from "../loader";
import { presentHeadlessOutput } from "../presenters/headlessOutput";
import { loadSession } from "../session";

interface Args {
  gameDir: string;
  session: string;
  pretty: boolean;
}

export async function peekCommand(args: Args): Promise<void> {
  const game = await loadGame(args.gameDir);
  const state = await loadSession(args.gameDir, args.session, game);
  const result = await peek(game, state);
  const assetMap = new Map((game.assets ?? []).map((a) => [a.path, a]));
  const output = presentHeadlessOutput(result.output, assetMap);
  const payload = {
    output,
    done: result.done,
    state: result.state,
  };
  process.stdout.write(
    args.pretty ? JSON.stringify(payload, null, 2) + "\n" : JSON.stringify(payload) + "\n",
  );
}
