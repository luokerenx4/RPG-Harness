import { evaluateCondition, explainCondition } from "../condition";
import { collectMapRoutes, mapRouteActivityId } from "../maps";
import { mapPlacementEventKey, mapPlacementKey } from "../resources";
import type {
  Action,
  Condition,
  HubActivity,
  MapAvailableResource,
  MapPlacementDef,
  PresetContext,
  ProjectResourceRef,
} from "../types";

/**
 * Renderer-neutral projection of the resources and semantic operations in the
 * current map. Headless consumes this without simulating a visual avatar; a 2D
 * surface additionally uses placement coordinates and layers.
 */
export function collectMapAvailableResources(
  ctx: PresetContext,
): MapAvailableResource[] {
  const resources: MapAvailableResource[] = [];
  const mapId = ctx.state.baseline.currentMapId;
  const map = mapId === null ? undefined : ctx.mapMap.get(mapId);

  if (map) {
    for (const placement of map.placements ?? []) {
      pushPlacement(resources, ctx, map.id, placement);
    }

    // Transitional projection for existing content. Migration moves these
    // fields to placements; consumers already use the Map v2 query contract.
    const routes = collectMapRoutes(map);
    for (const route of routes.filter((candidate) => candidate.source === "legacy-connection")) {
      const connection = route;
      const target = ctx.mapMap.get(connection.target);
      const ref: ProjectResourceRef = { kind: "map", id: connection.target };
      const key = route.key;
      const title = target
        ? `→ ${target.name}（${connection.dir}）`
        : `→ ${connection.dir}`;
      const condition = resolveAvailability(ctx, connection.requires, connection.lockedHint);
      const activity: HubActivity = {
        id: mapRouteActivityId(routes, route),
        kind: "action",
        resource: ref,
        sourceKey: key,
        actionKind: "moveToMap",
        payload: { to: connection.target, routeKey: route.key },
        title,
        category: "move",
        cost: 0,
        available: condition.available,
        ...(condition.requires ? { requires: condition.requires } : {}),
        ...(condition.lockedReason ? { lockedReason: condition.lockedReason } : {}),
      };
      resources.push({
        key,
        mapId: map.id,
        source: "legacy-connection",
        resource: ref,
        label: title,
        ...condition,
        activity,
      });
    }

    for (const action of map.actions ?? []) {
      const key = `${mapPlacementKey(map.id, `legacy-action-${action.id}`)}`;
      const activity = activityForAction(ctx, action, `action:${action.id}`, key);
      resources.push({
        key,
        mapId: map.id,
        source: "legacy-map-action",
        resource: { kind: "action", id: action.id },
        label: action.title,
        available: activity.available,
        ...(activity.requires ? { requires: activity.requires } : {}),
        ...(activity.lockedReason ? { lockedReason: activity.lockedReason } : {}),
        activity,
      });
    }
  }

  for (const action of ctx.game.actions ?? []) {
    if (action.exposure === "placed") continue;
    if (action.whenIn !== undefined) {
      if (mapId === null || !action.whenIn.includes(mapId)) continue;
    }
    const key = `action:${action.id}`;
    const activity = activityForAction(ctx, action, key, key);
    resources.push({
      key,
      mapId: mapId ?? "",
      source: "global-action",
      resource: { kind: "action", id: action.id },
      label: action.title,
      available: activity.available,
      ...(activity.requires ? { requires: activity.requires } : {}),
      ...(activity.lockedReason ? { lockedReason: activity.lockedReason } : {}),
      activity,
    });
  }

  return resources;
}

function pushPlacement(
  out: MapAvailableResource[],
  ctx: PresetContext,
  mapId: string,
  placement: MapPlacementDef,
): void {
  const placementKey = mapPlacementKey(mapId, placement.id);
  const baseCondition = resolveAvailability(ctx, placement.requires);
  const resourceLabel = labelForResource(ctx, placement.resource) ?? placement.id;
  out.push({
    key: placementKey,
    mapId,
    source: "placement",
    ...(placement.resource ? { resource: placement.resource } : {}),
    placementId: placement.id,
    at: placement.at,
    ...(placement.layer ? { layer: placement.layer } : {}),
    label: resourceLabel,
    ...baseCondition,
  });

  for (const event of [...placement.events].sort(
    (left, right) => left.order - right.order,
  )) {
    const resource = event.run ?? placement.resource;
    const key = mapPlacementEventKey(mapId, placement.id, event.id);
    const requires = combineConditions(placement.requires, event.requires);
    const condition = resolveAvailability(ctx, requires, event.lockedHint);
    const label = event.label ?? labelForResource(ctx, resource) ?? event.id;
    const activity = resource
      ? activityForPlacementResource(ctx, resource, key, label, condition)
      : undefined;
    out.push({
      key,
      mapId,
      source: "placement",
      ...(resource ? { resource } : {}),
      placementId: placement.id,
      eventId: event.id,
      at: placement.at,
      ...(placement.layer ? { layer: placement.layer } : {}),
      trigger: event.trigger,
      ...(event.chance !== undefined ? { chance: event.chance } : {}),
      label,
      ...condition,
      ...(activity ? { activity } : {}),
    });
  }
}

function activityForPlacementResource(
  ctx: PresetContext,
  resource: ProjectResourceRef,
  key: string,
  label: string,
  condition: ReturnType<typeof resolveAvailability>,
): HubActivity | undefined {
  if (resource.kind === "action") {
    const action = ctx.actionMap.get(resource.id);
    if (!action) return undefined;
    const combined = resolveAvailability(
      ctx,
      combineConditions(condition.requires, action.requires),
      condition.lockedReason,
    );
    return {
      ...activityForAction(ctx, action, key, key, combined),
      title: label,
      resource,
    };
  }
  if (resource.kind === "map") {
    return {
      id: key,
      kind: "action",
      resource,
      sourceKey: key,
      actionKind: "moveToMap",
      payload: { to: resource.id, routeKey: key },
      title: label,
      category: "move",
      cost: 0,
      available: condition.available,
      ...(condition.requires ? { requires: condition.requires } : {}),
      ...(condition.lockedReason ? { lockedReason: condition.lockedReason } : {}),
    };
  }
  if (resource.kind === "script") {
    return {
      id: key,
      kind: "script",
      resource,
      sourceKey: key,
      title: label,
      category: "story",
      cost: 0,
      available: condition.available,
      ...(condition.requires ? { requires: condition.requires } : {}),
      ...(condition.lockedReason ? { lockedReason: condition.lockedReason } : {}),
    };
  }
  return undefined;
}

function activityForAction(
  ctx: PresetContext,
  action: Action,
  id: string,
  sourceKey: string,
  precomputed?: ReturnType<typeof resolveAvailability>,
): HubActivity {
  const condition = precomputed ?? resolveAvailability(ctx, action.requires);
  return {
    id,
    kind: "action",
    resource: { kind: "action", id: action.id },
    sourceKey,
    title: action.title,
    description: action.description,
    category: action.category,
    ...(action.aiTags ? { aiTags: [...action.aiTags] } : {}),
    cost: action.cost,
    available: condition.available,
    ...(condition.requires ? { requires: condition.requires } : {}),
    ...(condition.lockedReason ? { lockedReason: condition.lockedReason } : {}),
  };
}

function resolveAvailability(
  ctx: PresetContext,
  requires?: Condition,
  lockedHint?: string,
): { available: boolean; requires?: Condition; lockedReason?: string } {
  if (!requires) return { available: true };
  const result = evaluateCondition(requires, ctx.state);
  return {
    available: result.ok,
    requires,
    ...(!result.ok
      ? { lockedReason: lockedHint ?? explainCondition(requires, ctx.state, ctx.game) }
      : {}),
  };
}

function combineConditions(
  ...conditions: Array<Condition | undefined>
): Condition | undefined {
  const present = conditions.filter((value): value is Condition => value !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return { all: present };
}

function labelForResource(
  ctx: PresetContext,
  resource?: ProjectResourceRef,
): string | undefined {
  if (!resource) return undefined;
  return ctx.resourceRegistry.get(`${resource.kind}:${resource.id}`)?.label ?? resource.id;
}
