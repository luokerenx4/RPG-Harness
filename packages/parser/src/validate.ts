// Cross-cutting Condition + StateDelta validator. After all assets load,
// walks every condition + effect in the loaded game and verifies every
// leaf reference resolves to a declared registry entry. This is the
// structural payoff of Phases 1-4: every switch / variable / character /
// stat / script / item / weapon / skill / dialogue speaker name has a declared source of
// truth, so typos become hard parse errors instead of silently always-
// false runtime conditions.
//
// Validator surface — every condition leaf is checked:
//   { switch: { name } }         → game.switches[].id
//   { variable: { name } }       → game.variables[].id
//   { affection: { character } } → game.characters[].id
//   { characterStat: { character, name } } → character + that character's stats (lazy: any name allowed)
//   { stat: { name } }           → game.training?.stats[].id (else "no training stats" error)
//   { inventory: { itemId } }    → game.items[].id
//   { weaponPower: { weaponId } } → game.weapons[].id
//   { knowsSkill: id }           → game.skills[].id
//   { scriptCompleted: id }      → game.scripts[].id
//   { selfSwitch: { scriptId } } → game.scripts[].id
//   { day, slot }                → no leaf to check
// Effect leafs (StateDelta):
//   characterStats.<charId>      → game.characters[].id
//   switches.<name>              → game.switches[].id
//   variables.<name>             → game.variables[].id
//   inventory.<itemId>           → game.items[].id
//   weapons.<weaponId>           → game.weapons[].id
//   skills.{learn,forget}        → game.skills[].id
//
// All issues are aggregated and reported in one GameValidationError so
// authors fix everything in one pass rather than playing whack-a-mole.

import type {
  Condition,
  Game,
  Module,
  ProjectResourceRef,
  StateDelta,
} from "@rpg-harness/engine";
import { collectMapConnections } from "@rpg-harness/engine";

export class GameValidationError extends Error {}

interface Registries {
  switches: Set<string>;
  variables: Set<string>;
  characters: Set<string>;
  scripts: Set<string>;
  items: Set<string>;
  weapons: Set<string>;
  skills: Set<string>;
  enemies: Set<string>;
  maps: Set<string>;
  actions: Set<string>;
  assets: Set<string>;
  assetKinds: Map<string, string>;
  modules: Set<string>;
  trainingStats: Set<string>;
}

interface Issue {
  // Best-effort identifying string of where the reference lives — e.g.
  // "script 003_invitation.requires" or "action hunt.effects". Stays
  // optional because the parser doesn't (yet) thread file:line info
  // into every node.
  path: string;
  message: string;
}

export function validateGame(game: Game): void {
  const reg: Registries = {
    switches: new Set((game.switches ?? []).map((s) => s.id)),
    variables: new Set((game.variables ?? []).map((v) => v.id)),
    characters: new Set(game.characters.map((c) => c.id)),
    scripts: new Set(game.scripts.map((s) => s.id)),
    items: new Set((game.items ?? []).map((i) => i.id)),
    weapons: new Set((game.weapons ?? []).map((w) => w.id)),
    skills: new Set((game.skills ?? []).map((s) => s.id)),
    enemies: new Set((game.enemies ?? []).map((e) => e.id)),
    maps: new Set((game.maps ?? []).map((m) => m.id)),
    actions: new Set((game.actions ?? []).map((a) => a.id)),
    assets: new Set((game.assets ?? []).map((a) => a.path)),
    assetKinds: new Map((game.assets ?? []).map((a) => [a.path, a.kind])),
    modules: new Set((game.modules ?? []).map((m) => m.id)),
    trainingStats: new Set(
      (game.training?.stats ?? []).map((s) => s.id),
    ),
  };

  const issues: Issue[] = [];

  for (const character of game.characters) {
    if (!character.mapSprite) continue;
    if (!reg.assets.has(character.mapSprite)) {
      issues.push({
        path: `character ${character.id}.map_sprite`,
        message: `undeclared asset "${character.mapSprite}". Declared: ${listOrNone(reg.assets)}`,
      });
    } else if (reg.assetKinds.get(character.mapSprite) !== "sprite") {
      issues.push({
        path: `character ${character.id}.map_sprite`,
        message: `asset "${character.mapSprite}" must have kind "sprite"`,
      });
    }
  }

  for (const scriptId of game.aiAudit?.requiredScripts ?? []) {
    if (!reg.scripts.has(scriptId)) {
      issues.push({
        path: "ai_audit.required_scripts",
        message: `undeclared script "${scriptId}". Declared: ${listOrNone(reg.scripts)}`,
      });
    }
  }

  for (const s of game.scripts) {
    const seenChoiceIds = new Set<string>();
    const labels = new Set(s.beats.flatMap((beat) =>
      beat.type === "label" ? [beat.name] : []
    ));
    if (s.requires) visitCondition(s.requires, `script ${s.id}.requires`, reg, issues);
    s.beats.forEach((beat, beatIdx) => {
      if (beat.type === "dialogue" && !reg.characters.has(beat.speaker)) {
        issues.push({
          path: `script ${s.id}.beats[${beatIdx}].speaker`,
          message:
            beat.speaker === "narrator"
              ? 'undeclared character "narrator". Plain text is narration; remove the @narrator prefix'
              : `undeclared character "${beat.speaker}". Declared: ${listOrNone(reg.characters)}`,
        });
      } else if (beat.type === "choice") {
        if (beat.id !== undefined) {
          if (seenChoiceIds.has(beat.id)) {
            issues.push({
              path: `script ${s.id}.beats[${beatIdx}].id`,
              message: `duplicate choice id \`${beat.id}\` within script ${s.id}`,
            });
          }
          seenChoiceIds.add(beat.id);
        }
        const seenOptionIds = new Set<string>();
        beat.options.forEach((opt, optIdx) => {
          const where = `script ${s.id}.beats[${beatIdx}].options[${optIdx}]`;
          if (beat.id !== undefined && opt.id === undefined) {
            issues.push({
              path: `${where}.id`,
              message: `choice \`${beat.id}\` uses branch coverage and requires every option to have a stable id`,
            });
          }
          if (beat.id === undefined && opt.id !== undefined) {
            issues.push({
              path: `${where}.id`,
              message: `option id \`${opt.id}\` requires its containing choice to have an id`,
            });
          }
          if (opt.id !== undefined) {
            if (seenOptionIds.has(opt.id)) {
              issues.push({
                path: `${where}.id`,
                message: `duplicate option id \`${opt.id}\` within choice ${beat.id ?? beatIdx}`,
              });
            }
            seenOptionIds.add(opt.id);
          }
          if (opt.requires) visitCondition(opt.requires, `${where}.requires`, reg, issues);
          if (opt.effects) visitDelta(opt.effects, `${where}.effects`, reg, issues);
          if (opt.goto && opt.goto !== "$end") {
            if (!labels.has(opt.goto)) {
              issues.push({
                path: `${where}.goto`,
                message: `unknown label \`${opt.goto}\` in script ${s.id}`,
              });
            }
          }
        });
      } else if (beat.type === "goto") {
        if (!labels.has(beat.target)) {
          issues.push({
            path: `script ${s.id}.beats[${beatIdx}].target`,
            message: `unknown label \`${beat.target}\` in script ${s.id}`,
          });
        }
      } else if (beat.type === "effects") {
        visitDelta(beat.effects, `script ${s.id}.beats[${beatIdx}].effects`, reg, issues);
      }
    });
  }

  for (const a of game.actions ?? []) {
    if (a.requires) visitCondition(a.requires, `action ${a.id}.requires`, reg, issues);
    if (a.effects) visitDelta(a.effects, `action ${a.id}.effects`, reg, issues);
    if (a.kind === "useItem" || a.itemId !== undefined) {
      if (a.itemId && !reg.items.has(a.itemId)) {
        issues.push({
          path: `action ${a.id}.itemId`,
          message: `undeclared item "${a.itemId}". Declared: ${listOrNone(reg.items)}`,
        });
      }
    }
    if (a.kind === "useSkill" || a.skillId !== undefined) {
      if (a.skillId && !reg.skills.has(a.skillId)) {
        issues.push({
          path: `action ${a.id}.skillId`,
          message: `undeclared skill "${a.skillId}". Declared: ${listOrNone(reg.skills)}`,
        });
      }
    }
    if (a.enemyId !== undefined && !reg.enemies.has(a.enemyId)) {
      issues.push({
        path: `action ${a.id}.enemyId`,
        message: `undeclared enemy "${a.enemyId}". Declared: ${listOrNone(reg.enemies)}`,
      });
    }
    if (a.mapId !== undefined && !reg.maps.has(a.mapId)) {
      issues.push({
        path: `action ${a.id}.mapId`,
        message: `undeclared map "${a.mapId}". Declared: ${listOrNone(reg.maps)}`,
      });
    }
    if (a.whenIn !== undefined) {
      for (const mid of a.whenIn) {
        if (!reg.maps.has(mid)) {
          issues.push({
            path: `action ${a.id}.whenIn`,
            message: `undeclared map "${mid}". Declared: ${listOrNone(reg.maps)}`,
          });
        }
      }
    }
  }

  for (const item of game.items ?? []) {
    if (item.effects) visitDelta(item.effects, `item ${item.id}.effects`, reg, issues);
  }
  for (const skill of game.skills ?? []) {
    if (skill.cost) visitDelta(skill.cost, `skill ${skill.id}.cost`, reg, issues);
    if (skill.effects) visitDelta(skill.effects, `skill ${skill.id}.effects`, reg, issues);
    if (skill.requires) visitCondition(skill.requires, `skill ${skill.id}.requires`, reg, issues);
  }

  for (const ec of game.training?.endConditions ?? []) {
    visitCondition(ec.when, `training.endConditions[${ec.reason}].when`, reg, issues);
    if (ec.goto && !reg.scripts.has(ec.goto)) {
      issues.push({
        path: `training.endConditions[${ec.reason}].goto`,
        message: `undeclared script "${ec.goto}". Declared: ${listOrNone(reg.scripts)}`,
      });
    }
  }

  // Walk every map: legacy flat fields plus Map v2 layout, placements,
  // resource references, and event bindings.
  for (const m of game.maps ?? []) {
    if (m.layout?.tileset !== undefined) {
      if (!reg.assets.has(m.layout.tileset)) {
        issues.push({
          path: `map ${m.id}.layout.tileset`,
          message: `undeclared asset "${m.layout.tileset}". Declared: ${listOrNone(reg.assets)}`,
        });
      } else if (reg.assetKinds.get(m.layout.tileset) !== "tileset") {
        issues.push({
          path: `map ${m.id}.layout.tileset`,
          message: `asset "${m.layout.tileset}" must have kind "tileset"`,
        });
      }
    }
    const layerIds = new Set<string>();
    const regionIds = new Set<string>();
    if (m.layout?.playerStart && (
      m.layout.playerStart.x < 0 || m.layout.playerStart.y < 0 ||
      m.layout.playerStart.x >= m.layout.width ||
      m.layout.playerStart.y >= m.layout.height
    )) {
      issues.push({
        path: `map ${m.id}.layout.player_start`,
        message: `player start must fit inside ${m.layout.width}x${m.layout.height} layout`,
      });
    }
    for (const layer of m.layout?.layers ?? []) {
      if (layerIds.has(layer.id)) {
        issues.push({
          path: `map ${m.id}.layout.layers[${layer.id}]`,
          message: `duplicate layer id "${layer.id}"`,
        });
      }
      layerIds.add(layer.id);
      if (layer.asset !== undefined && !reg.assets.has(layer.asset)) {
        issues.push({
          path: `map ${m.id}.layout.layers[${layer.id}].asset`,
          message: `undeclared asset "${layer.asset}". Declared: ${listOrNone(reg.assets)}`,
        });
      }
    }
    for (const region of m.layout?.regions ?? []) {
      if (regionIds.has(region.id)) {
        issues.push({
          path: `map ${m.id}.layout.regions[${region.id}]`,
          message: `duplicate region id "${region.id}"`,
        });
      }
      regionIds.add(region.id);
      if (
        region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 ||
        region.x + region.width > m.layout!.width ||
        region.y + region.height > m.layout!.height
      ) {
        issues.push({
          path: `map ${m.id}.layout.regions[${region.id}]`,
          message: `region must fit inside ${m.layout!.width}x${m.layout!.height} layout`,
        });
      }
    }

    const placementIds = new Set<string>();
    for (const placement of m.placements ?? []) {
      const where = `map ${m.id}.placements[${placement.id}]`;
      if (placementIds.has(placement.id)) {
        issues.push({ path: where, message: `duplicate placement id "${placement.id}"` });
      }
      placementIds.add(placement.id);
      if (placement.layer !== undefined && !layerIds.has(placement.layer)) {
        issues.push({
          path: `${where}.layer`,
          message: `undeclared map layer "${placement.layer}". Declared: ${listOrNone(layerIds)}`,
        });
      }
      if (m.layout !== undefined && (
        placement.at.x < 0 || placement.at.y < 0 ||
        placement.footprint.width <= 0 || placement.footprint.height <= 0 ||
        placement.at.x + placement.footprint.width > m.layout.width ||
        placement.at.y + placement.footprint.height > m.layout.height
      )) {
        issues.push({
          path: `${where}.at`,
          message: `placement footprint must fit inside ${m.layout.width}x${m.layout.height} layout`,
        });
      }
      if (placement.resource) {
        visitProjectResourceRef(placement.resource, `${where}.resource`, reg, issues);
      }
      if (placement.asset !== undefined && !reg.assets.has(placement.asset)) {
        issues.push({
          path: `${where}.asset`,
          message: `undeclared asset "${placement.asset}". Declared: ${listOrNone(reg.assets)}`,
        });
      }
      if (placement.requires) {
        visitCondition(placement.requires, `${where}.requires`, reg, issues);
      }
      if (!placement.resource && placement.events.length === 0) {
        issues.push({
          path: where,
          message: `placement must declare a resource or at least one event`,
        });
      }
      const eventIds = new Set<string>();
      for (const event of placement.events) {
        const eventWhere = `${where}.events[${event.id}]`;
        if (eventIds.has(event.id)) {
          issues.push({ path: eventWhere, message: `duplicate event id "${event.id}"` });
        }
        eventIds.add(event.id);
        if (event.run) {
          visitProjectResourceRef(event.run, `${eventWhere}.run`, reg, issues);
        }
        if (event.requires) {
          visitCondition(event.requires, `${eventWhere}.requires`, reg, issues);
        }
        if (event.trigger.includes(":")) {
          const moduleId = event.trigger.split(":", 1)[0]!;
          if (!reg.modules.has(moduleId)) {
            issues.push({
              path: `${eventWhere}.trigger`,
              message: `namespaced trigger references undeclared module "${moduleId}". Declared: ${listOrNone(reg.modules)}`,
            });
          }
        }
      }
    }

    for (const c of m.connections ?? []) {
      const where = `map ${m.id}.connections`;
      if (!reg.maps.has(c.target)) {
        issues.push({
          path: where,
          message: `undeclared map target "${c.target}". Declared: ${listOrNone(reg.maps)}`,
        });
      }
      if (c.requires) {
        visitCondition(c.requires, `${where}[${c.target}].requires`, reg, issues);
      }
    }
    if (m.onEnter !== undefined && !reg.scripts.has(m.onEnter)) {
      issues.push({
        path: `map ${m.id}.on_enter`,
        message: `undeclared script "${m.onEnter}". Declared: ${listOrNone(reg.scripts)}`,
      });
    }
    for (const e of m.encounterTable ?? []) {
      if (e.enemyId !== null && !reg.enemies.has(e.enemyId)) {
        issues.push({
          path: `map ${m.id}.encounter_table`,
          message: `undeclared enemy "${e.enemyId}". Declared: ${listOrNone(reg.enemies)}`,
        });
      }
    }
    for (const l of m.lootTable ?? []) {
      if (l.itemId !== null && !reg.items.has(l.itemId)) {
        issues.push({
          path: `map ${m.id}.loot_table`,
          message: `undeclared item "${l.itemId}". Declared: ${listOrNone(reg.items)}`,
        });
      }
    }
    for (const a of m.actions ?? []) {
      const where = `map ${m.id}.actions[${a.id}]`;
      if (a.requires) visitCondition(a.requires, `${where}.requires`, reg, issues);
      if (a.effects) visitDelta(a.effects, `${where}.effects`, reg, issues);
      if (a.itemId && !reg.items.has(a.itemId)) {
        issues.push({ path: `${where}.itemId`, message: `undeclared item "${a.itemId}". Declared: ${listOrNone(reg.items)}` });
      }
      if (a.skillId && !reg.skills.has(a.skillId)) {
        issues.push({ path: `${where}.skillId`, message: `undeclared skill "${a.skillId}". Declared: ${listOrNone(reg.skills)}` });
      }
      if (a.enemyId !== undefined && !reg.enemies.has(a.enemyId)) {
        issues.push({ path: `${where}.enemyId`, message: `undeclared enemy "${a.enemyId}". Declared: ${listOrNone(reg.enemies)}` });
      }
      if (a.mapId !== undefined && !reg.maps.has(a.mapId)) {
        issues.push({ path: `${where}.mapId`, message: `undeclared map "${a.mapId}". Declared: ${listOrNone(reg.maps)}` });
      }
      if (a.whenIn !== undefined) {
        for (const mid of a.whenIn) {
          if (!reg.maps.has(mid)) {
            issues.push({ path: `${where}.whenIn`, message: `undeclared map "${mid}". Declared: ${listOrNone(reg.maps)}` });
          }
        }
      }
    }
    for (const spawn of m.characterSpawns ?? []) {
      const where = `map ${m.id}.character_spawns[${spawn.characterId}]`;
      if (!reg.characters.has(spawn.characterId)) {
        issues.push({
          path: where,
          message: `undeclared character "${spawn.characterId}". Declared: ${listOrNone(reg.characters)}`,
        });
      }
      if (!reg.scripts.has(spawn.encounterScriptId)) {
        issues.push({
          path: `${where}.encounter_script`,
          message: `undeclared script "${spawn.encounterScriptId}". Declared: ${listOrNone(reg.scripts)}`,
        });
      }
    }
  }

  validateMapChains(game, issues);

  for (const mod of game.modules ?? []) {
    visitModuleTriggers(mod, reg, issues);
  }

  if (issues.length > 0) {
    const lines = issues.map((i) => `  ${i.path}: ${i.message}`);
    throw new GameValidationError(
      `Game validation failed (${issues.length} issue${
        issues.length === 1 ? "" : "s"
      }):\n${lines.join("\n")}`,
    );
  }
}

function validateMapChains(game: Game, issues: Issue[]): void {
  const chains = new Map<string, NonNullable<Game["maps"]>>();
  for (const map of game.maps ?? []) {
    if (!map.chain) continue;
    const siblings = chains.get(map.chain) ?? [];
    siblings.push(map);
    chains.set(map.chain, siblings);
  }

  for (const [chain, maps] of chains) {
    const entries = maps.filter((map) => map.isEntry === true);
    if (entries.length !== 1) {
      issues.push({
        path: `map chain ${chain}`,
        message:
          entries.length === 0
            ? `must declare exactly one is_entry map; none found`
            : `must declare exactly one is_entry map; found ${entries.map((map) => map.id).join(", ")}`,
      });
      continue;
    }

    const ids = new Set(maps.map((map) => map.id));
    const byId = new Map(maps.map((map) => [map.id, map]));
    const reachable = new Set<string>();
    const pending = [entries[0]!.id];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      const current = byId.get(id);
      const targets = current
        ? collectMapConnections(current).map((connection) => connection.target)
        : [];
      for (const target of targets) {
        if (ids.has(target) && !reachable.has(target)) {
          pending.push(target);
        }
      }
    }

    for (const map of maps) {
      if (reachable.has(map.id)) continue;
      issues.push({
        path: `map ${map.id}`,
        message: `unreachable from is_entry map "${entries[0]!.id}" in chain "${chain}"`,
      });
    }
  }
}

function visitProjectResourceRef(
  ref: ProjectResourceRef,
  path: string,
  reg: Registries,
  issues: Issue[],
): void {
  if (ref.kind === "custom") return;
  const registry = ref.kind === "character" ? reg.characters
    : ref.kind === "item" ? reg.items
    : ref.kind === "enemy" ? reg.enemies
    : ref.kind === "weapon" ? reg.weapons
    : ref.kind === "skill" ? reg.skills
    : ref.kind === "map" ? reg.maps
    : ref.kind === "script" ? reg.scripts
    : ref.kind === "action" ? reg.actions
    : ref.kind === "asset" ? reg.assets
    : reg.modules;
  if (!registry.has(ref.id)) {
    issues.push({
      path,
      message: `undeclared ${ref.kind} "${ref.id}". Declared: ${listOrNone(registry)}`,
    });
  }
}

function visitModuleTriggers(
  mod: Module,
  reg: Registries,
  issues: Issue[],
): void {
  for (const trig of mod.triggers ?? []) {
    visitCondition(trig.when, `module ${mod.id}.triggers[${trig.id}].when`, reg, issues);
  }
}

function visitCondition(
  cond: Condition,
  path: string,
  reg: Registries,
  issues: Issue[],
): void {
  if ("all" in cond) {
    cond.all.forEach((c, i) => visitCondition(c, `${path}.all[${i}]`, reg, issues));
    return;
  }
  if ("any" in cond) {
    cond.any.forEach((c, i) => visitCondition(c, `${path}.any[${i}]`, reg, issues));
    return;
  }
  if ("not" in cond) {
    visitCondition(cond.not, `${path}.not`, reg, issues);
    return;
  }
  if ("scriptCompleted" in cond) {
    if (!reg.scripts.has(cond.scriptCompleted)) {
      issues.push({
        path,
        message: `undeclared script "${cond.scriptCompleted}". Declared: ${listOrNone(reg.scripts)}`,
      });
    }
    return;
  }
  if ("affection" in cond) {
    if (!reg.characters.has(cond.affection.character)) {
      issues.push({
        path,
        message: `undeclared character "${cond.affection.character}". Declared: ${listOrNone(reg.characters)}`,
      });
    }
    return;
  }
  if ("characterStat" in cond) {
    if (!reg.characters.has(cond.characterStat.character)) {
      issues.push({
        path,
        message: `undeclared character "${cond.characterStat.character}". Declared: ${listOrNone(reg.characters)}`,
      });
    }
    return;
  }
  if ("switch" in cond) {
    if (!reg.switches.has(cond.switch.name)) {
      issues.push({
        path,
        message: `undeclared switch "${cond.switch.name}". Declared: ${listOrNone(reg.switches)}`,
      });
    }
    return;
  }
  if ("variable" in cond) {
    if (!reg.variables.has(cond.variable.name)) {
      issues.push({
        path,
        message: `undeclared variable "${cond.variable.name}". Declared: ${listOrNone(reg.variables)}`,
      });
    }
    return;
  }
  if ("stat" in cond) {
    if (!reg.trainingStats.has(cond.stat.name)) {
      issues.push({
        path,
        message: `undeclared training stat "${cond.stat.name}". Declared: ${listOrNone(reg.trainingStats)}`,
      });
    }
    return;
  }
  if ("inventory" in cond) {
    if (!reg.items.has(cond.inventory.itemId)) {
      issues.push({
        path,
        message: `undeclared item "${cond.inventory.itemId}". Declared: ${listOrNone(reg.items)}`,
      });
    }
    return;
  }
  if ("weaponPower" in cond) {
    if (!reg.weapons.has(cond.weaponPower.weaponId)) {
      issues.push({
        path,
        message: `undeclared weapon "${cond.weaponPower.weaponId}". Declared: ${listOrNone(reg.weapons)}`,
      });
    }
    return;
  }
  if ("knowsSkill" in cond) {
    if (!reg.skills.has(cond.knowsSkill)) {
      issues.push({
        path,
        message: `undeclared skill "${cond.knowsSkill}". Declared: ${listOrNone(reg.skills)}`,
      });
    }
    return;
  }
  if ("selfSwitch" in cond) {
    if (!reg.scripts.has(cond.selfSwitch.scriptId)) {
      issues.push({
        path,
        message: `undeclared script "${cond.selfSwitch.scriptId}" (selfSwitch). Declared: ${listOrNone(reg.scripts)}`,
      });
    }
    return;
  }
  // day / slot have no leaf reference — no-op
}

function visitDelta(
  delta: StateDelta,
  path: string,
  reg: Registries,
  issues: Issue[],
): void {
  if (delta.characterStats) {
    for (const charId of Object.keys(delta.characterStats)) {
      if (!reg.characters.has(charId)) {
        issues.push({
          path: `${path}.characterStats`,
          message: `undeclared character "${charId}". Declared: ${listOrNone(reg.characters)}`,
        });
      }
    }
  }
  if (delta.switches) {
    for (const name of Object.keys(delta.switches)) {
      if (!reg.switches.has(name)) {
        issues.push({
          path: `${path}.switches`,
          message: `undeclared switch "${name}". Declared: ${listOrNone(reg.switches)}`,
        });
      }
    }
  }
  if (delta.variables) {
    for (const name of Object.keys(delta.variables)) {
      if (!reg.variables.has(name)) {
        issues.push({
          path: `${path}.variables`,
          message: `undeclared variable "${name}". Declared: ${listOrNone(reg.variables)}`,
        });
      }
    }
  }
  if (delta.inventory) {
    for (const itemId of Object.keys(delta.inventory)) {
      if (!reg.items.has(itemId)) {
        issues.push({
          path: `${path}.inventory`,
          message: `undeclared item "${itemId}". Declared: ${listOrNone(reg.items)}`,
        });
      }
    }
  }
  if (delta.weapons) {
    for (const weaponId of Object.keys(delta.weapons)) {
      if (!reg.weapons.has(weaponId)) {
        issues.push({
          path: `${path}.weapons`,
          message: `undeclared weapon "${weaponId}". Declared: ${listOrNone(reg.weapons)}`,
        });
      }
    }
  }
  if (delta.skills) {
    for (const id of [...(delta.skills.learn ?? []), ...(delta.skills.forget ?? [])]) {
      if (!reg.skills.has(id)) {
        issues.push({
          path: `${path}.skills`,
          message: `undeclared skill "${id}". Declared: ${listOrNone(reg.skills)}`,
        });
      }
    }
  }
  if (delta.stats) {
    for (const name of Object.keys(delta.stats)) {
      if (!reg.trainingStats.has(name)) {
        issues.push({
          path: `${path}.stats`,
          message: `undeclared training stat "${name}". Declared: ${listOrNone(reg.trainingStats)}`,
        });
      }
    }
  }
  if (delta.selfSwitches) {
    for (const scriptId of Object.keys(delta.selfSwitches)) {
      if (!reg.scripts.has(scriptId)) {
        issues.push({
          path: `${path}.selfSwitches`,
          message: `undeclared script "${scriptId}" (selfSwitch). Declared: ${listOrNone(reg.scripts)}`,
        });
      }
    }
  }
}

function listOrNone(set: Set<string>): string {
  if (set.size === 0) return "(none)";
  return [...set].sort().join(", ");
}
