// Training-mode preset main loop. Same shape as vn/run.ts but with
// three extra responsibilities:
//   - end-condition check (per game.training.endConditions)
//   - hub Output via fireOnHubBuild (the training Module above
//     provides the actual hubMenu snapshot)
//   - action dispatch (via dispatchActivity primitive)
//
// All engine primitives this file uses are exported from
// `@rpg-harness/engine`, so an ejected copy of this file works unchanged
// outside the engine source tree.

import {
  checkEndConditions,
  dispatchActivity,
  drainNarrations,
  fireOnActionComplete,
  fireOnEndConditionFire,
  fireOnHubBuild,
  fireOnScriptComplete,
  fireOnSessionStart,
  markScriptCompleted,
  scriptRevision,
  runScript,
} from "@rpg-harness/engine";
import type { Action, Input, Output, PresetContext } from "@rpg-harness/engine";

// Default export is the RunFunction itself — this is what the CLI
// loader picks up when game.yaml says `preset: ./preset/run.ts`
// (the --eject scenario). Named export is kept for engine-internal
// consumers (state.ts resolveRunFn).
export default trainingRun;

export async function* trainingRun(
  ctx: PresetContext,
): AsyncGenerator<Output, void, Input> {
  fireOnSessionStart(ctx);

  while (true) {
    yield* drainNarrations(ctx);

    // End conditions check — only when no script is mid-flight, so an
    // in-progress ending script doesn't get clobbered.
    if (ctx.state.baseline.currentScriptId === null) {
      const endCheck = checkEndConditions(ctx);
      if (endCheck) {
        fireOnEndConditionFire(ctx, endCheck);
        if (
          endCheck.goto &&
          ctx.state.baseline.scripts[endCheck.goto]?.completed !== true &&
          ctx.scriptMap.has(endCheck.goto)
        ) {
          ctx.state.baseline.currentScriptId = endCheck.goto;
          ctx.state.baseline.beatIndex = 0;
          continue;
        }
        yield { type: "gameEnd", reason: endCheck.reason };
        return;
      }
    }

    // Run the current script if one is set.
    if (ctx.state.baseline.currentScriptId !== null) {
      const script = ctx.scriptMap.get(ctx.state.baseline.currentScriptId);
      if (!script) {
        throw new Error(
          `trainingRun: current script not found: ${ctx.state.baseline.currentScriptId}`,
        );
      }
      const finished = yield* runScript(ctx, script);
      if (finished) {
        const completedId = script.id;
        markScriptCompleted(ctx.state, completedId, scriptRevision(script));
        ctx.state.baseline.currentScriptId = null;
        ctx.state.baseline.beatIndex = 0;
        fireOnScriptComplete(ctx, completedId);
        // Scripts count as 1 slot — fire onActionComplete with synthetic
        // action so the training Module's calendar advance picks it up.
        const completedAction: Action = {
          id: completedId,
          title: script.title,
          cost: 1,
        };
        fireOnActionComplete(ctx, completedAction, undefined);
      } else {
        return;
      }
      continue;
    }

    // Hub.
    const hubOutput = fireOnHubBuild(ctx);
    if (hubOutput === undefined) {
      // No module claimed the hub. Should not normally happen when
      // game.training is configured (the bundled training Module
      // always returns a hub). Fall through to gameEnd to avoid an
      // infinite loop.
      yield { type: "gameEnd" };
      return;
    }
    const input = yield hubOutput;
    if (input.type === "quit") return;
    if (input.type !== "doActivity") continue;
    const dispatched = yield* dispatchActivity(ctx, input.id);
    if (dispatched === "quit") return;
  }
}
