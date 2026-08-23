import { evaluateCondition } from "../condition";
import type {
  Action,
  ActionResult,
  Input,
  Output,
  PresetContext,
} from "../types";
import { applyActionResult } from "./applyActionResult";
import {
  fireOnActionComplete,
  fireOnActionDispatch,
  fireOnScriptSelect,
} from "./hooks";
import { mutateState } from "./mutateState";

// Dispatch a hub-menu activity by its full id. Three resolution paths:
//   1. "script:<id>" → fire onScriptSelect, set baseline.currentScriptId
//   2. "action:<id>" → resolve to a registered Action in ctx.actionMap
//      (checked requires, fire onActionDispatch, run via handler)
//   3. fallback: look up the activity id in
//      state.runtime.lastHubActivities (populated by fireOnHubBuild).
//      Lets onHubBuild emit fully-dynamic activities with actionKind +
//      payload — the engine synthesizes an Action and runs it through
//      the same handler registry as static actions. Modules no longer
//      need a string-prefix router.
export async function* dispatchActivity(
  ctx: PresetContext,
  activityId: string,
): AsyncGenerator<Output, "ok" | "quit", Input> {
  if (activityId.startsWith("script:")) {
    const requested = activityId.slice("script:".length);
    const requestedScript = ctx.scriptMap.get(requested);
    if (!requestedScript) return "ok";
    if (ctx.state.baseline.scripts[requested]?.completed === true) return "ok";
    if (
      requestedScript.requires !== undefined &&
      !evaluateCondition(requestedScript.requires, ctx.state).ok
    ) return "ok";
    const scriptId = fireOnScriptSelect(ctx, requested);
    const script = ctx.scriptMap.get(scriptId);
    if (!script) return "ok";
    if (ctx.state.baseline.scripts[scriptId]?.completed === true) return "ok";
    if (
      script.requires !== undefined &&
      !evaluateCondition(script.requires, ctx.state).ok
    ) return "ok";
    ctx.state.baseline.currentScriptId = scriptId;
    ctx.state.baseline.beatIndex = 0;
    return "ok";
  }
  if (activityId.startsWith("action:")) {
    const actionId = activityId.slice("action:".length);
    const original = ctx.actionMap.get(actionId);
    if (!original) return "ok";
    // whenIn gate: actions restricted to specific maps were filtered
    // out of the hub menu by buildMapHubSnapshot, but a caller can
    // still dispatch them by id (CLI step, AI player, scripted test).
    // Without this check, whenIn is a UI hint not a real constraint.
    // Surface the rejection as a narration so the call doesn't fail
    // silently and the player understands what blocked them.
    if (
      original.whenIn !== undefined &&
      (ctx.state.baseline.currentMapId === null ||
        !original.whenIn.includes(ctx.state.baseline.currentMapId))
    ) {
      ctx.state.runtime.pendingNarrations.push(
        `[${original.title}] 不在合适的地点（需要：${original.whenIn.join(" / ")}，当前：${ctx.state.baseline.currentMapId ?? "无"}）`,
      );
      return "ok";
    }
    const available =
      original.requires === undefined ||
      evaluateCondition(original.requires, ctx.state).ok;
    if (!available) return "ok";
    const dispatched = fireOnActionDispatch(ctx, original);
    if (dispatched === "cancel") return "ok";
    return yield* runAction(ctx, dispatched);
  }

  // Dynamic activity dispatch: resolve via the most recent hubMenu's
  // snapshot. If the activity declared an actionKind, synthesize an
  // Action and run it. We don't pre-gate on `available: false` —
  // that flag is for UI display; the handler is expected to surface
  // its own denial narration when the player picks a blocked
  // activity, so they understand WHY it's locked.
  const dyn = ctx.state.runtime.lastHubActivities.find(
    (a) => a.id === activityId,
  );
  if (dyn?.sourceKey && dyn.requires && !evaluateCondition(dyn.requires, ctx.state).ok) {
    ctx.state.runtime.pendingNarrations.push(
      dyn.lockedReason ?? `[${dyn.title}] 今は実行できない。`,
    );
    return "ok";
  }
  if (dyn?.resource?.kind === "script") {
    const requestedScript = ctx.scriptMap.get(dyn.resource.id);
    if (!requestedScript) return "ok";
    if (ctx.state.baseline.scripts[requestedScript.id]?.completed === true) return "ok";
    if (
      requestedScript.requires !== undefined &&
      !evaluateCondition(requestedScript.requires, ctx.state).ok
    ) return "ok";
    const scriptId = fireOnScriptSelect(ctx, requestedScript.id);
    const script = ctx.scriptMap.get(scriptId);
    if (!script) return "ok";
    ctx.state.baseline.currentScriptId = scriptId;
    ctx.state.baseline.beatIndex = 0;
    return "ok";
  }
  if (dyn?.resource?.kind === "action") {
    const original = ctx.actionMap.get(dyn.resource.id);
    if (!original) return "ok";
    const available =
      original.requires === undefined ||
      evaluateCondition(original.requires, ctx.state).ok;
    if (!available) return "ok";
    const dispatched = fireOnActionDispatch(ctx, original);
    if (dispatched === "cancel") return "ok";
    return yield* runAction(ctx, dispatched);
  }
  if (dyn && dyn.kind === "action" && dyn.actionKind) {
    const synthetic: Action = {
      id: dyn.id,
      title: dyn.title,
      cost: dyn.cost,
      kind: dyn.actionKind,
      ...(dyn.aiTags ? { aiTags: [...dyn.aiTags] } : {}),
      ...(dyn.payload ? { payload: dyn.payload } : {}),
    };
    const dispatched = fireOnActionDispatch(ctx, synthetic);
    if (dispatched === "cancel") return "ok";
    return yield* runAction(ctx, dispatched);
  }
  // Activity id not found in any resolution path. If a hub menu was
  // recently built (lastHubActivities non-empty), the player is in a
  // selection flow and picked something stale or out-of-context (e.g.,
  // a hub action while combat replaced the menu). Surface a generic
  // hint so the input isn't swallowed in silence. We don't narrate
  // when lastHubActivities is empty: that's typically test fixtures
  // dispatching by id before any hub has been built.
  if (ctx.state.runtime.lastHubActivities.length > 0) {
    yield { type: "narration", text: "今はそれは出来ぬ。" };
  }
  return "ok";
}

// Inner action runner. Dispatches via the action handler registry
// (set up at engine construction from all modules' actionHandlers).
// Falls back to applying action.effects directly for kindless actions.
// After the action body, every module's onActionComplete hook fires —
// the training preset uses this to advance the calendar.
async function* runAction(
  ctx: PresetContext,
  action: Action,
): AsyncGenerator<Output, "ok" | "quit", Input> {
  const handler = action.kind
    ? ctx.actionHandlerRegistry[action.kind]
    : undefined;
  let result: ActionResult | undefined;
  if (handler) {
    result = handler({
      state: ctx.state,
      action,
      game: ctx.game,
      rng: ctx.rng,
    });
    applyActionResult(ctx, result);
  } else if (action.effects || action.narrations) {
    // Kindless actions: apply effects + emit a random narration from
    // action.narrations if any. Lets YAML authors give simple actions
    // (study, work, rest…) flavor variants without a module handler.
    const narration =
      action.narrations && action.narrations.length > 0
        ? [action.narrations[Math.floor(ctx.rng() * action.narrations.length)]!]
        : undefined;
    applyActionResult(ctx, {
      ...(action.effects ? { deltas: action.effects } : {}),
      ...(narration ? { narrations: narration } : {}),
    });
  }
  fireOnActionComplete(ctx, action, result);
  return "ok";
}
