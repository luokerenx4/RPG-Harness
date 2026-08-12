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

import { markScriptCompleted } from "../../state";
import {
  checkEndConditions,
  checkTriggers,
  dispatchActivity,
  drainNarrations,
  fireOnActionComplete,
  fireOnEndConditionFire,
  fireOnHubBuild,
  fireOnScriptComplete,
  fireOnSessionStart,
  runScript,
} from "../../primitives";
import type { Action, Input, Output, PresetContext } from "../../types";

// Default export is the RunFunction itself — this is what the CLI
// loader picks up when game.yaml says `preset: ./preset/run.ts`
// (the --eject scenario). Named export is kept for engine-internal
// consumers (state.ts resolveRunFn).
export default trainingRun;

export async function* trainingRun(
  ctx: PresetContext,
): AsyncGenerator<Output, void, Input> {
  fireOnSessionStart(ctx);
  // Catch triggers already-active in seed state (e.g. fixture injects
  // spectral=90 with a "spectral runaway" trigger that fires at >=80).
  // mutateState wouldn't fire them since no mutation happened yet.
  checkTriggers(ctx);

  while (true) {
    yield* drainNarrations(ctx);

    // Explicitly re-check triggers at the top of every loop iteration,
    // BEFORE deciding whether to yield a hub or run a script. Without
    // this, triggers gated on `scriptCompleted(X)` (or any condition that
    // becomes true at script end via markScriptCompleted — which doesn't
    // route through mutateState) only get re-evaluated when the NEXT
    // step()'s session-start checkTriggers runs. That means the player
    // sees a "clean" hub, picks an action, and their dispatch gets
    // silently swallowed because the trigger fires first in the next
    // step and reassigns currentScriptId. Re-checking here ensures the
    // hub we yield is post-trigger — any inserted script runs before
    // the player ever sees the menu.
    if (ctx.state.baseline.currentScriptId === null) {
      checkTriggers(ctx);
    }

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
        markScriptCompleted(ctx.state, completedId);
        ctx.state.baseline.currentScriptId = null;
        ctx.state.baseline.beatIndex = 0;
        fireOnScriptComplete(ctx, completedId);
        // Scripts default to 1-slot cost via the synthetic action that
        // the training preset's calendar-advance hook consumes. Scripts
        // can override via frontmatter `cost: N` — most usefully `cost: 0`
        // for intros / cutscenes that shouldn't eat a player's decision
        // window.
        const completedAction: Action = {
          id: completedId,
          title: script.title,
          cost: script.cost ?? 1,
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
    if (hubOutput.type !== "hubMenu") continue;
    const selectedActivity = hubOutput.snapshot.activities.find(
      (activity) => activity.id === input.id,
    );
    if (!selectedActivity) continue;
    if (
      !selectedActivity.available &&
      (selectedActivity.kind === "script" || selectedActivity.actionKind === undefined)
    ) continue;
    const dispatched = yield* dispatchActivity(ctx, input.id);
    if (dispatched === "quit") return;
  }
}
