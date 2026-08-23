import type {
  Game,
  ProjectResourceEntry,
  ProjectResourceKind,
  ProjectResourceRef,
  ProjectResourceGraph,
  ProjectResourceNode,
  ProjectResourceRegistry,
} from "./types";

export class ProjectResourceRegistryError extends Error {}

export function projectResourceKey(ref: ProjectResourceRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function buildProjectResourceRegistry(game: Game): ProjectResourceRegistry {
  const registry = new Map<string, ProjectResourceEntry>();
  const add = (
    kind: ProjectResourceKind,
    id: string,
    label: string,
    value: unknown,
  ) => {
    const key = projectResourceKey({ kind, id });
    if (registry.has(key)) {
      throw new ProjectResourceRegistryError(`duplicate project resource "${key}"`);
    }
    registry.set(key, { kind, id, key, label, value });
  };

  add("manifest", "game", game.title, game);
  for (const value of game.characters) add("character", value.id, value.name, value);
  for (const value of game.items ?? []) add("item", value.id, value.name, value);
  for (const value of game.enemies ?? []) add("enemy", value.id, value.name, value);
  for (const value of game.weapons ?? []) add("weapon", value.id, value.name, value);
  for (const value of game.skills ?? []) add("skill", value.id, value.name, value);
  for (const value of game.maps ?? []) add("map", value.id, value.name, value);
  for (const value of game.scripts) add("script", value.id, value.title, value);
  for (const value of game.actions ?? []) add("action", value.id, value.title, value);
  for (const value of game.assets ?? []) {
    add("asset", value.path, value.placeholder || value.description || value.path, value);
  }
  for (const value of game.modules ?? []) add("module", value.id, value.id, value);

  return registry;
}

export function buildProjectResourceGraph(game: Game): ProjectResourceGraph {
  const registry = buildProjectResourceRegistry(game);
  const nodes: ProjectResourceNode[] = [];
  for (const entry of registry.values()) {
    const refs = collectResourceRefs(entry.kind, entry.value);
    nodes.push({
      kind: entry.kind,
      id: entry.id,
      key: entry.key,
      label: entry.label,
      ...(sourceFor(entry.kind, entry.id, entry.value) ? {
        source: sourceFor(entry.kind, entry.id, entry.value),
      } : {}),
      refs: [...new Set(refs.map(projectResourceKey))].sort(),
    });
  }
  nodes.sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)
  );

  const backlinks = new Map<string, Set<string>>();
  for (const node of nodes) {
    for (const ref of node.refs) {
      const sources = backlinks.get(ref) ?? new Set<string>();
      sources.add(node.key);
      backlinks.set(ref, sources);
    }
  }
  const missing = [...backlinks.entries()]
    .filter(([key]) => !registry.has(key))
    .map(([key, referencedBy]) => ({
      key,
      referencedBy: [...referencedBy].sort(),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));

  const backlinksObject = Object.fromEntries(
    [...backlinks.entries()]
      .filter(([key]) => registry.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [key, [...values].sort()]),
  );
  return {
    resources: nodes,
    backlinks: backlinksObject,
    missing,
    unreferenced: nodes
      .filter((node) => node.kind !== "manifest" && node.kind !== "module")
      .filter((node) => backlinksObject[node.key] === undefined)
      .map((node) => node.key),
  };
}

export function resolveProjectResource(
  registry: ProjectResourceRegistry,
  ref: ProjectResourceRef,
): ProjectResourceEntry | undefined {
  if (ref.kind === "custom") return undefined;
  return registry.get(projectResourceKey(ref));
}

export function mapPlacementKey(mapId: string, placementId: string): string {
  return `map:${mapId}/placement:${placementId}`;
}

export function mapPlacementEventKey(
  mapId: string,
  placementId: string,
  eventId: string,
): string {
  return `${mapPlacementKey(mapId, placementId)}/event:${eventId}`;
}

function collectResourceRefs(
  kind: ProjectResourceKind,
  value: unknown,
): ProjectResourceRef[] {
  const refs: ProjectResourceRef[] = [];
  const add = (ref: ProjectResourceRef | undefined) => {
    if (ref && ref.kind !== "custom") refs.push(ref);
  };
  const obj = value as Record<string, any>;
  const addCondition = (condition: unknown) => {
    for (const ref of collectConditionResourceRefs(condition)) add(ref);
  };
  const addDelta = (delta: unknown) => {
    for (const ref of collectStateDeltaResourceRefs(delta)) add(ref);
  };
  const addAction = (action: Record<string, any>) => {
    if (action.itemId) add({ kind: "item", id: action.itemId });
    if (action.enemyId) add({ kind: "enemy", id: action.enemyId });
    if (action.skillId) add({ kind: "skill", id: action.skillId });
    if (action.mapId) add({ kind: "map", id: action.mapId });
    for (const mapId of action.whenIn ?? []) add({ kind: "map", id: mapId });
    addCondition(action.requires);
    addDelta(action.effects);
  };

  if (kind === "manifest") {
    for (const module of obj.modules ?? []) add({ kind: "module", id: module.id });
    for (const endCondition of obj.training?.endConditions ?? []) addCondition(endCondition.when);
  } else if (kind === "character") {
    if (obj.mapSprite) add({ kind: "asset", id: obj.mapSprite });
    for (const asset of Object.values(obj.portraits ?? {})) {
      if (typeof asset === "string") add({ kind: "asset", id: asset });
    }
  } else if (kind === "item") {
    addDelta(obj.effects);
  } else if (kind === "skill") {
    addCondition(obj.requires);
    addDelta(obj.cost);
    addDelta(obj.effects);
  } else if (kind === "script") {
    for (const character of obj.characters ?? []) add({ kind: "character", id: character });
    addCondition(obj.requires);
    for (const beat of obj.beats ?? []) {
      if (beat.type === "dialogue") add({ kind: "character", id: beat.speaker });
      if (beat.type === "setBg" && beat.assetPath) add({ kind: "asset", id: beat.assetPath });
      if (beat.type === "showCg") add({ kind: "asset", id: beat.assetPath });
      if (beat.type === "setPortrait") {
        if (beat.assetPath) add({ kind: "asset", id: beat.assetPath });
        if (beat.characterId) add({ kind: "character", id: beat.characterId });
      }
      if (beat.type === "effects") addDelta(beat.effects);
      if (beat.type === "choice") {
        for (const option of beat.options ?? []) {
          addCondition(option.requires);
          addDelta(option.effects);
        }
      }
    }
  } else if (kind === "action") {
    addAction(obj);
  } else if (kind === "map") {
    if (obj.bg) add({ kind: "asset", id: obj.bg });
    if (obj.layout?.tileset) add({ kind: "asset", id: obj.layout.tileset });
    for (const layer of obj.layout?.layers ?? []) {
      if (layer.asset) add({ kind: "asset", id: layer.asset });
    }
    if (obj.onEnter) add({ kind: "script", id: obj.onEnter });
    for (const action of obj.actions ?? []) addAction(action);
    for (const connection of obj.connections ?? []) {
      add({ kind: "map", id: connection.target });
      addCondition(connection.requires);
    }
    for (const encounter of obj.encounterTable ?? []) {
      if (encounter.enemyId) add({ kind: "enemy", id: encounter.enemyId });
    }
    for (const loot of obj.lootTable ?? []) {
      if (loot.itemId) add({ kind: "item", id: loot.itemId });
    }
    for (const spawn of obj.characterSpawns ?? []) {
      add({ kind: "character", id: spawn.characterId });
      add({ kind: "script", id: spawn.encounterScriptId });
    }
    for (const placement of obj.placements ?? []) {
      add(placement.resource);
      if (placement.asset) add({ kind: "asset", id: placement.asset });
      addCondition(placement.requires);
      for (const event of placement.events ?? []) {
        add(event.run);
        addCondition(event.requires);
      }
    }
  } else if (kind === "asset") {
    if (obj.styleRef) add({ kind: "asset", id: obj.styleRef });
    for (const character of obj.refs?.characters ?? []) {
      add({ kind: "character", id: character });
    }
  } else if (kind === "module") {
    for (const trigger of obj.triggers ?? []) addCondition(trigger.when);
  }
  return refs;
}

function collectConditionResourceRefs(value: unknown): ProjectResourceRef[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const condition = value as Record<string, any>;
  if (Array.isArray(condition.all)) return condition.all.flatMap(collectConditionResourceRefs);
  if (Array.isArray(condition.any)) return condition.any.flatMap(collectConditionResourceRefs);
  if (condition.not) return collectConditionResourceRefs(condition.not);
  if (typeof condition.scriptCompleted === "string") {
    return [{ kind: "script", id: condition.scriptCompleted }];
  }
  if (typeof condition.affection?.character === "string") {
    return [{ kind: "character", id: condition.affection.character }];
  }
  if (typeof condition.characterStat?.character === "string") {
    return [{ kind: "character", id: condition.characterStat.character }];
  }
  if (typeof condition.inventory?.itemId === "string") {
    return [{ kind: "item", id: condition.inventory.itemId }];
  }
  if (typeof condition.weaponPower?.weaponId === "string") {
    return [{ kind: "weapon", id: condition.weaponPower.weaponId }];
  }
  if (typeof condition.knowsSkill === "string") {
    return [{ kind: "skill", id: condition.knowsSkill }];
  }
  if (typeof condition.selfSwitch?.scriptId === "string") {
    return [{ kind: "script", id: condition.selfSwitch.scriptId }];
  }
  return [];
}

function collectStateDeltaResourceRefs(value: unknown): ProjectResourceRef[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const delta = value as Record<string, any>;
  const refs: ProjectResourceRef[] = [];
  for (const id of Object.keys(delta.characterStats ?? {})) refs.push({ kind: "character", id });
  for (const id of Object.keys(delta.inventory ?? {})) refs.push({ kind: "item", id });
  for (const id of Object.keys(delta.weapons ?? {})) refs.push({ kind: "weapon", id });
  for (const id of delta.skills?.learn ?? []) refs.push({ kind: "skill", id });
  for (const id of delta.skills?.forget ?? []) refs.push({ kind: "skill", id });
  for (const id of Object.keys(delta.selfSwitches ?? {})) refs.push({ kind: "script", id });
  return refs;
}

function sourceFor(
  kind: ProjectResourceKind,
  id: string,
  value: unknown,
): string | undefined {
  const obj = value as Record<string, any>;
  if (kind === "manifest") return "game.yaml";
  if (kind === "character") return `characters/${id}.md`;
  if (kind === "item") return `items/${id}.md`;
  if (kind === "enemy") return `enemies/${id}.md`;
  if (kind === "weapon") return `weapons/${id}.md`;
  if (kind === "skill") return `skills/${id}.md`;
  if (kind === "map") return `maps/${id}.yaml`;
  if (kind === "script") return obj.source ?? `scripts/${id}.md`;
  if (kind === "action") return `actions/${id}.yaml`;
  if (kind === "asset") return `${id}/spec.yaml`;
  if (kind === "module") return obj.source;
  return undefined;
}
