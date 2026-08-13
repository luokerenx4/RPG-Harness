import { evaluateCondition } from "../condition";
import { applyDelta } from "../state";
import type {
  ActionResult,
  PresetContext,
  Trigger,
  TriggerFailureStage,
} from "../types";
import { ModuleHookExecutionError } from "./hooks";
import { fireOnStateMutated } from "./hooks";

/** Exact project-owned parallel event that failed during evaluation. */
export class TriggerExecutionError extends Error {
  readonly causeName: string;
  readonly causeMessage: string;

  constructor(
    readonly moduleId: string,
    readonly triggerId: string,
    readonly stage: TriggerFailureStage,
    cause: unknown,
  ) {
    const original = cause instanceof Error ? cause : new Error(String(cause));
    super(
      `Module ${moduleId} trigger ${triggerId} ${stage} failed: ${original.message}`,
      { cause: original },
    );
    this.name = "TriggerExecutionError";
    this.causeName = original.name;
    this.causeMessage = original.message;
    if (original.stack) this.stack = original.stack;
  }
}

function triggerFailure<T>(
  moduleId: string,
  triggerId: string,
  stage: TriggerFailureStage,
  run: () => T,
): T {
  try {
    return run();
  } catch (error) {
    if (
      error instanceof TriggerExecutionError ||
      error instanceof ModuleHookExecutionError
    ) throw error;
    throw new TriggerExecutionError(moduleId, triggerId, stage, error);
  }
}

// Edge-detecting trigger dispatcher. Called by mutateState after every
// state mutation. Compares each trigger's current `when` evaluation
// to its previous evaluation (tracked in state.runtime.activeTriggers)
// and fires `do` ONLY on rising-edge transitions (was false → now
// true). Falling edges (was true → now false) re-arm the trigger
// unless it was declared with `once: true`.
//
// Trigger-fired mutations apply via an internal helper that does NOT
// recursively call checkTriggers — this caps cascade depth at 1.
// Authors who need multi-stage chains can do it through flags: trigger
// A sets `flag: X`, trigger B's `when` includes `flag: X`, the NEXT
// state mutation that touches anything triggers re-check and B fires.
export function checkTriggers(ctx: PresetContext): void {
  const runtime = ctx.state.runtime;

  // Snapshot the currently-active set BEFORE evaluating. Edge detection
  // compares against this. Updates land at the end of the pass.
  const wasActive = new Set(runtime.activeTriggers);
  const newActive: string[] = [];
  const toFire: Array<{ moduleId: string; trigger: Trigger }> = [];

  for (const owned of ctx.triggerRegistry) {
    const { moduleId, trigger: trig } = owned;
    const isActive = triggerFailure(
      moduleId,
      trig.id,
      "condition",
      () => evaluateCondition(trig.when, ctx.state).ok,
    );
    if (isActive) {
      newActive.push(trig.id);
      if (wasActive.has(trig.id)) continue; // not a rising edge
      if (trig.once && runtime.firedTriggers.includes(trig.id)) continue;
      toFire.push(owned);
    }
    // Falling edges (was active, no longer) drop out of newActive
    // naturally — the trigger re-arms.
  }

  runtime.activeTriggers = newActive;

  // Fire in declaration order. Each trigger's result applies via
  // applyTriggerResult (sibling helper, NO re-check) to bound cascade.
  for (const { moduleId, trigger: trig } of toFire) {
    if (trig.once) runtime.firedTriggers.push(trig.id);
    const result = triggerFailure(moduleId, trig.id, "handler", () => {
      const value = trig.do(ctx);
      if (isPromiseLike(value)) {
        void Promise.resolve(value).catch(() => undefined);
        throw new TypeError("Trigger handlers must be synchronous");
      }
      return value;
    });
    triggerFailure(
      moduleId,
      trig.id,
      "result",
      () => applyTriggerResult(ctx, result),
    );
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function";
}

// Apply a trigger's ActionResult without invoking checkTriggers again.
// This is the bounding mechanism — trigger-fired mutations show up in
// onStateMutated (source="trigger") for observability but do NOT
// recursively fire more triggers in the same wave.
function applyTriggerResult(
  ctx: PresetContext,
  result: ActionResult,
): void {
  if (result.deltas) {
    applyDelta(ctx.state, result.deltas);
    fireOnStateMutated(ctx, result.deltas, "trigger");
  }
  if (result.narrations && result.narrations.length > 0) {
    ctx.state.runtime.pendingNarrations.push(...result.narrations);
  }
  if (result.customLog) {
    const { moduleId, entry } = result.customLog;
    const existing = ctx.state[moduleId] as
      | { log?: unknown[] }
      | undefined;
    const slot = existing ?? { log: [] };
    if (!Array.isArray(slot.log)) slot.log = [];
    slot.log.push(entry);
    ctx.state[moduleId] = slot;
  }
}
