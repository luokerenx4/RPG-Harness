import { peek } from "@rpg-harness/engine";
import { access } from "node:fs/promises";
import path from "node:path";
import { assertSessionName, withSessionLock } from "@rpg-harness/session-store";
import { loadGame } from "../loader";
import { presentHeadlessOutput } from "../presenters/headlessOutput";
import { loadSession, saveSession, sessionDir } from "../session";

interface Args {
  gameDir: string;
  session: string;
  pretty: boolean;
}

export async function peekCommand(args: Args): Promise<void> {
  assertSessionName(args.session);
  const game = await loadGame(args.gameDir);
  const result = await withSessionLock(args.gameDir, args.session, async () => {
    const stateFile = path.join(sessionDir(args.gameDir, args.session), "state.json");
    const exists = await pathExists(stateFile);
    const state = await loadSession(args.gameDir, args.session, game);
    const current = await peek(game, state);
    // `peek` is read-only for an existing branch. For a named branch that does
    // not exist yet, persist the exact hydrated state it returned so the next
    // Headless, GUI, TUI, fork, or audit command sees the same source.
    if (!exists) await saveSession(args.gameDir, args.session, current.state);
    return current;
  });
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

async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
