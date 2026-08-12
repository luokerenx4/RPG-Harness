import type {
  Action,
  ActionResult,
  Beat,
  ChoiceResolution,
  EndConditionSpec,
  Output,
  PresetContext,
  RenderedChoice,
  StateDelta,
  StateMutationSource,
} from "../types";

// Per-hook fire functions. Verbose but type-safe and explicit at each
// call site — easier to reason about than a single dynamic dispatch.
//
// Three compose strategies are encoded by hook name:
//   - fireOnX (observer): iterates all modules, ignores returns
//   - fireOnXFirstWins (first-wins): stops at first non-undefined
//   - fireOnXReducer (reducer): chains transforms

// ============ OBSERVERS ============

export function fireOnSessionStart(ctx: PresetContext): void {
  for (const mod of ctx.modules) mod.onSessionStart?.(ctx);
}

// Dedup'd entry: `step`-style callers re-enter runScript on every step
// (each step is a fresh Engine over the saved state). Without this
// guard, onScriptStart fires on every step — observable as duplicate
// narration pushes, re-fired side effects, infinite loops when the
// hook queues something that gets consumed by drainNarrations.
//
// The runtime tracker `firedScriptStarts` mirrors `firedTriggers`'s
// once-and-done semantics within a single script entry. It's cleared
// for `scriptId` by fireOnScriptComplete, so a script that finishes
// and is later re-launched gets a clean re-fire.
export function fireOnScriptStart(
  ctx: PresetContext,
  scriptId: string,
): void {
  const fired = ctx.state.runtime.firedScriptStarts;
  if (fired.includes(scriptId)) return;
  fired.push(scriptId);
  for (const mod of ctx.modules) mod.onScriptStart?.(ctx, scriptId);
}

export function fireOnScriptComplete(
  ctx: PresetContext,
  scriptId: string,
): void {
  const fired = ctx.state.runtime.firedScriptStarts;
  const idx = fired.indexOf(scriptId);
  if (idx >= 0) fired.splice(idx, 1);
  for (const mod of ctx.modules) mod.onScriptComplete?.(ctx, scriptId);
}

export function fireOnBeatAfter(
  ctx: PresetContext,
  scriptId: string,
  beatIdx: number,
  beat: Beat,
): void {
  for (const mod of ctx.modules) mod.onBeatAfter?.(ctx, scriptId, beatIdx, beat);
}

export function fireOnChoiceResolved(
  ctx: PresetContext,
  scriptId: string,
  beatIdx: number,
  choiceIdx: number,
  resolution: ChoiceResolution,
): void {
  for (const mod of ctx.modules) {
    mod.onChoiceResolved?.(ctx, scriptId, beatIdx, choiceIdx, resolution);
  }
}

export function fireOnLabelEnter(
  ctx: PresetContext,
  scriptId: string,
  labelName: string,
): void {
  for (const mod of ctx.modules) mod.onLabelEnter?.(ctx, scriptId, labelName);
}

export function fireOnActionComplete(
  ctx: PresetContext,
  action: Action,
  result: ActionResult | undefined,
): void {
  for (const mod of ctx.modules) mod.onActionComplete?.(ctx, action, result);
}

export function fireOnStateMutated(
  ctx: PresetContext,
  delta: StateDelta,
  source: StateMutationSource,
): void {
  for (const mod of ctx.modules) mod.onStateMutated?.(ctx, delta, source);
}

export function fireOnNarrationDrain(
  ctx: PresetContext,
  text: string,
): void {
  for (const mod of ctx.modules) mod.onNarrationDrain?.(ctx, text);
}

export function fireOnEndConditionFire(
  ctx: PresetContext,
  ec: EndConditionSpec,
): void {
  for (const mod of ctx.modules) mod.onEndConditionFire?.(ctx, ec);
}

// ============ FIRST-WINS ============
// Semantic note: iterates ALL modules even after a non-undefined return,
// so downstream observers see the event. The "first non-undefined wins"
// semantics applies only to the return value — every module's hook is
// invoked. Discovered while testing onHubBuild: training preset always
// returns the hub, but hook-tracker's onHubBuild needs to fire too for
// observability (e.g. logging, metrics).

export function fireOnScriptSelect(
  ctx: PresetContext,
  scriptId: string,
): string {
  let winner: string | undefined;
  for (const mod of ctx.modules) {
    const r = mod.onScriptSelect?.(ctx, scriptId);
    if (winner === undefined && typeof r === "string") winner = r;
  }
  return winner ?? scriptId;
}

export function fireOnHubBuild(ctx: PresetContext): Output | undefined {
  // A script may temporarily stage itself somewhere other than the logical
  // current map. Returning to the hub ends that scene: when the current map
  // declares a bg, restore it before any module constructs the menu. Maps
  // without a bg intentionally keep inheritance semantics.
  const currentMapId = ctx.state.baseline.currentMapId;
  const currentMap = currentMapId ? ctx.mapMap.get(currentMapId) : undefined;
  if (currentMap?.bg) ctx.state.baseline.visuals.bg = currentMap.bg;

  let winner: Output | undefined;
  for (const mod of ctx.modules) {
    const r = mod.onHubBuild?.(ctx);
    if (winner === undefined && r !== undefined) winner = r;
  }
  // The composed baseline is the single source of truth for the current
  // stage. Custom hub builders frequently focus on activities and omit
  // visualState; forwarding such an output would make stateful shells retain
  // the previous script's portrait/CG even after runScript cleared it.
  if (winner?.type === "hubMenu") {
    winner = { ...winner, visualState: ctx.state.baseline.visuals };
  }
  // Record the hubMenu's activities so dispatchActivity can resolve
  // Input.doActivity ids back to their actionKind + payload. This is
  // what lets onHubBuild emit fully-dynamic activities without each
  // module implementing a string-prefix router.
  if (winner && winner.type === "hubMenu") {
    ctx.state.runtime.lastHubActivities = winner.snapshot.activities;
  }
  return winner;
}

export function fireOnActionDispatch(
  ctx: PresetContext,
  action: Action,
): Action | "cancel" {
  let winner: Action | "cancel" | undefined;
  for (const mod of ctx.modules) {
    const r = mod.onActionDispatch?.(ctx, action);
    if (winner === undefined && r !== undefined) winner = r;
  }
  return winner ?? action;
}

// ============ REDUCERS ============

export function fireOnChoicePresented(
  ctx: PresetContext,
  scriptId: string,
  beatIdx: number,
  initial: RenderedChoice[],
): RenderedChoice[] {
  let acc = initial;
  for (const mod of ctx.modules) {
    const r = mod.onChoicePresented?.(ctx, scriptId, beatIdx, acc);
    if (r !== undefined) acc = r;
  }
  return acc;
}

export function fireOnBeatBefore(
  ctx: PresetContext,
  scriptId: string,
  beatIdx: number,
  initial: Beat,
): Beat | { skip: true } {
  let acc: Beat = initial;
  for (const mod of ctx.modules) {
    const r = mod.onBeatBefore?.(ctx, scriptId, beatIdx, acc);
    if (r === undefined) continue;
    if ("skip" in r && r.skip === true) return { skip: true };
    if ("replace" in r) {
      acc = r.replace;
      continue;
    }
    // Bare Beat return → replace
    acc = r as Beat;
  }
  return acc;
}

// Legacy fireHook stub kept for primitives/index.ts re-export
// compatibility. New code should call the per-hook function above
// directly for type safety.
export function fireHook(
  _ctx: PresetContext,
  _name: string,
  ..._args: unknown[]
): void {
  // no-op; use fireOnX named dispatchers instead
}
