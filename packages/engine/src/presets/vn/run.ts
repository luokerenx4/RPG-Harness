// Pure VN preset. Game loop for visual-novel-shaped games: no hub, no
// calendar, just a script-by-script flow. After each script finishes,
// the engine yields a `scriptComplete` Output listing the next available
// scripts; the player picks one and the engine enters it.
//
// This is the file an AI / human author copies (via
// `rpgh init --preset vn --eject`) when they want to write their
// own VN loop semantics — e.g. add a save-point ritual between
// scripts, gate progression by some flag, or insert a custom Output.
// All engine primitives this file uses (drainNarrations, runScript,
// fireOn*) are exported from `@rpg-harness/engine` so an ejected copy of
// this file works unchanged outside the engine source tree.

import { evaluateCondition } from "../../condition";
import { markScriptCompleted } from "../../state";
import {
  checkTriggers,
  drainNarrations,
  fireOnScriptComplete,
  fireOnScriptSelect,
  fireOnSessionStart,
  runScript,
} from "../../primitives";
import type {
  Input,
  Output,
  PresetContext,
  ScriptInfo,
} from "../../types";

// Default export is the RunFunction itself — this is what the CLI
// loader picks up when game.yaml says `preset: ./preset/run.ts`
// (the --eject scenario). Named export is kept for engine-internal
// consumers (state.ts resolveRunFn).
export default vnRun;

export async function* vnRun(
  ctx: PresetContext,
): AsyncGenerator<Output, void, Input> {
  fireOnSessionStart(ctx);
  // Catch any triggers already-active in seed state (e.g. a fixture
  // injects alice.affection=5 and a milestone trigger fires at >=5).
  // mutateState wouldn't fire them since no mutation happened yet.
  checkTriggers(ctx);

  while (true) {
    yield* drainNarrations(ctx);

    // Run the current script if one is set.
    if (ctx.state.baseline.currentScriptId !== null) {
      const script = ctx.scriptMap.get(ctx.state.baseline.currentScriptId);
      if (!script) {
        throw new Error(
          `vnRun: current script not found: ${ctx.state.baseline.currentScriptId}`,
        );
      }
      const finished = yield* runScript(ctx, script);
      if (finished) {
        const completedId = script.id;
        markScriptCompleted(ctx.state, completedId);
        ctx.state.baseline.currentScriptId = null;
        ctx.state.baseline.beatIndex = 0;
        fireOnScriptComplete(ctx, completedId);
      } else {
        return;
      }
      continue;
    }

    // No script — show scriptComplete picker with available next scripts.
    const available = listAvailableScripts(ctx);
    if (available.length === 0) {
      yield { type: "gameEnd", visualState: ctx.state.baseline.visuals };
      return;
    }
    const order = ctx.state.baseline.completionOrder;
    const completedId = order[order.length - 1] ?? null;
    const input = yield {
      type: "scriptComplete",
      completedId,
      nextAvailable: available,
      visualState: ctx.state.baseline.visuals,
    };
    if (input.type === "quit") return;
    if (input.type !== "select") continue;
    if (!available.some((script) => script.id === input.scriptId)) continue;
    const finalId = fireOnScriptSelect(ctx, input.scriptId);
    const finalScript = ctx.scriptMap.get(finalId);
    if (!finalScript) continue;
    if (ctx.state.baseline.scripts[finalId]?.completed === true) continue;
    if (
      finalScript.requires !== undefined &&
      !evaluateCondition(finalScript.requires, ctx.state).ok
    ) continue;
    ctx.state.baseline.currentScriptId = finalId;
    ctx.state.baseline.beatIndex = 0;
  }
}

function listAvailableScripts(ctx: PresetContext): ScriptInfo[] {
  return ctx.game.scripts
    .filter(
      (s) =>
        ctx.state.baseline.scripts[s.id]?.completed !== true &&
        (s.requires === undefined ||
          evaluateCondition(s.requires, ctx.state).ok),
    )
    .map((s) => ({ id: s.id, title: s.title }));
}
