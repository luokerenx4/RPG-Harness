// Custom preset for 妖刀奇譚 — an extraction-shooter loop on RPG-Harness.
//
// Architecturally distinct from the bundled `training` and `vn` presets:
// no calendar, no day/slot, no end-conditions. Just two modes managed by
// the raid module — HUB (大名府) and RAID (in the field). The mode flag
// lives at state["sengoku-raid"].mode; the module's onHubBuild returns a
// mode-appropriate hubMenu snapshot.
//
// Activity dispatch goes through the engine's standard dispatchActivity:
//   - "script:<id>"  → engine sets baseline.currentScriptId
//   - bare action id → engine resolves via runtime.lastHubActivities
//     (populated by fireOnHubBuild). The HubActivity carries
//     `actionKind` + `payload`; the engine synthesizes an Action and
//     routes it through the actionHandlerRegistry, where the raid
//     module's declared handlers pick it up.
//
// The raid module owns onHubBuild and wins the first-wins arbitration
// because we don't enable the engine's `training:` config (training
// preset isn't auto-included, so we have no competitor).

import {
  checkTriggers,
  dispatchActivity,
  drainNarrations,
  fireOnActionComplete,
  fireOnHubBuild,
  fireOnScriptComplete,
  fireOnSessionStart,
  markScriptCompleted,
  scriptRevision,
  runScript,
} from "@rpg-harness/engine";
import type { Action, Input, Output, PresetContext } from "@rpg-harness/engine";


export default raidRun;

export async function* raidRun(
  ctx: PresetContext,
): AsyncGenerator<Output, void, Input> {
  fireOnSessionStart(ctx);
  // Triggers may be active in seed state (fixtures).
  checkTriggers(ctx);

  while (true) {
    yield* drainNarrations(ctx);

    // Run the current script if one is set. Scripts are used for
    // set-piece narrative beats (intro, character first-meets, bonding
    // scenes, endings) — NOT for raid loops.
    if (ctx.state.baseline.currentScriptId !== null) {
      const script = ctx.scriptMap.get(ctx.state.baseline.currentScriptId);
      if (!script) {
        throw new Error(
          `raidRun: current script not found: ${ctx.state.baseline.currentScriptId}`,
        );
      }
      const finished = yield* runScript(ctx, script);
      if (finished) {
        const completedId = script.id;
        markScriptCompleted(ctx.state, completedId, scriptRevision(script));
        ctx.state.baseline.currentScriptId = null;
        ctx.state.baseline.beatIndex = 0;
        fireOnScriptComplete(ctx, completedId);
        // Keep the calendar-style onActionComplete pulse so any
        // listener (none right now, but kept for future modules) sees
        // a uniform action-complete event for script-as-activity.
        const completedAction: Action = {
          id: completedId,
          title: script.title,
          cost: 0,
        };
        fireOnActionComplete(ctx, completedAction, undefined);
      } else {
        return;
      }
      continue;
    }

    // Hub: ask the raid module for the menu (mode-dependent).
    const hubOutput = fireOnHubBuild(ctx);
    if (hubOutput === undefined) {
      yield { type: "gameEnd" };
      return;
    }
    const input = yield hubOutput;
    if (input.type === "quit") return;
    if (input.type !== "doActivity") continue;
    const r = yield* dispatchActivity(ctx, input.id);
    if (r === "quit") return;
  }
}
