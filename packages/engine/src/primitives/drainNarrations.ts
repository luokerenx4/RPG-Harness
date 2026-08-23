import type { Input, Output, PresetContext } from "../types";
import { fireOnNarrationDrain } from "./hooks";
import { drainAutomaticMapEvents } from "./drainMapEvents";

// Drain the pending narration queue one at a time. Each shift happens
// AFTER the yield — so peek() (which calls .next() once then
// runner.return()s) sees the next narration without consuming it, and
// step() (.next() twice) consumes exactly one. This is how combat-via-
// step works post-PR #1: combat handlers push a batch of narrations
// into state.runtime.pendingNarrations and the run loop drains them
// across subsequent step() calls.
//
// Fires onNarrationDrain (observer) after each shift, so modules can
// observe / log narration playback.
//
// Input protocol: only `next` (or `quit`) advances past a narration.
// Other input types (`choose` / `doActivity` / `select`) re-yield the
// same narration — same idiom as `choice` in runScript. Without this,
// a `doActivity` sent while a narration is pending would silently
// drain the narration AND swallow the dispatch, leaving the caller
// wondering why their action didn't fire. Strict re-yield surfaces
// the input-order mistake immediately.
//
// Every yielded narration carries pendingCount (the queue length
// INCLUDING the one being yielded), so AI players and UI renderers can
// detect "more narrations are queued — keep sending next" without
// inferring it from re-yields. Without this signal the re-yield
// behavior is correct but invisible: a doActivity gets bounced and the
// caller can't tell why. With it, callers can preflight: if
// pendingCount > 0 and you wanted to dispatch, send next first.
export async function* drainNarrations(
  ctx: PresetContext,
): AsyncGenerator<Output, void, Input> {
  yield* drainAutomaticMapEvents(ctx);
  const q = ctx.state.runtime.pendingNarrations;
  while (q.length > 0) {
    const text = q[0]!;
    const input = yield {
      type: "narration",
      text,
      visualState: ctx.state.baseline.visuals,
      pendingCount: q.length,
    };
    if (input.type === "quit") return;
    if (input.type !== "next") continue;
    q.shift();
    fireOnNarrationDrain(ctx, text);
  }
}
