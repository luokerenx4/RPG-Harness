import type { Input, Output, PresetContext } from "../types";
import { collectMapAvailableResources } from "./collectMapResources";
import { dispatchActivity } from "./dispatchActivity";

export async function* drainAutomaticMapEvents(
  ctx: PresetContext,
): AsyncGenerator<Output, void, Input> {
  queueAutomaticMapEvents(ctx);
  const queue = ctx.state.runtime.pendingMapEvents ?? [];
  while (queue.length > 0) {
    const key = queue.shift()!;
    const resource = collectMapAvailableResources(ctx).find((entry) => entry.key === key);
    if (!resource?.available || !resource.activity) continue;

    const fired = ctx.state.runtime.firedMapEvents ??= [];
    if (fired.includes(key)) continue;
    fired.push(key);

    const previousActivities = ctx.state.runtime.lastHubActivities;
    ctx.state.runtime.lastHubActivities = [...previousActivities, resource.activity];
    try {
      yield* dispatchActivity(ctx, key);
    } finally {
      ctx.state.runtime.lastHubActivities = previousActivities;
    }
    if (ctx.state.baseline.currentScriptId !== null) return;
    queueAutomaticMapEvents(ctx);
  }
}

function queueAutomaticMapEvents(ctx: PresetContext): void {
  const mapId = ctx.state.baseline.currentMapId;
  const runtime = ctx.state.runtime;
  const entered = runtime.observedMapId !== mapId;
  if (entered) {
    runtime.observedMapId = mapId;
    runtime.pendingMapEvents = [];
    runtime.firedMapEvents = [];
  }
  if (mapId === null) return;

  const fired = runtime.firedMapEvents ??= [];
  const pending = runtime.pendingMapEvents ??= [];
  for (const resource of collectMapAvailableResources(ctx)) {
    const automatic = resource.trigger === "autorun" ||
      (entered && resource.trigger === "map_enter");
    if (!automatic || !resource.available || !resource.activity) continue;
    if (fired.includes(resource.key) || pending.includes(resource.key)) continue;
    pending.push(resource.key);
  }
}
