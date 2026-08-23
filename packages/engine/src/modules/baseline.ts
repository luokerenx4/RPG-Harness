import type {
  ActionHandler,
  BaselineState,
  CharacterDef,
  CharacterState,
  FlagValue,
  Game,
  Module,
  StateDelta,
  SwitchDef,
  VariableDef,
  VariableValue,
  WeaponDef,
  WeaponState,
} from "../types";
import { emptyVisualState } from "../types";
import { enterMap } from "../primitives/enterMap";
import { resolveMapRoute } from "../maps";
import { evaluateCondition } from "../condition";

export const BASELINE_NAMESPACE = "baseline";

// Default useItem action handler. Available on every game (baseline
// module is built-in). When player picks an action with
// `kind: "useItem", itemId: <id>`:
//   1. Look up the item in game.items
//   2. Verify the player owns >= 1
//   3. Return an ActionResult whose deltas combine the item's effects
//      with a `-1` inventory entry — applied atomically by
//      applyActionResult so onStateMutated fires once with both
//      changes visible
//
// No-ops silently if the item is missing or unowned. Author-side
// `requires:` on the action is the standard way to ensure the action
// only shows when usable.
const useItemHandler: ActionHandler = ({ state, action, game }) => {
  if (!action.itemId) return {};
  const itemDef = (game.items ?? []).find((i) => i.id === action.itemId);
  if (!itemDef) return {};
  const have = state.baseline.inventory[action.itemId] ?? 0;
  if (have < 1) return {};

  const deltas: StateDelta = {
    inventory: { [action.itemId]: -1 },
  };
  if (itemDef.effects) {
    if (itemDef.effects.characterStats) {
      deltas.characterStats = itemDef.effects.characterStats;
    }
    if (itemDef.effects.switches) deltas.switches = itemDef.effects.switches;
    if (itemDef.effects.variables) {
      deltas.variables = itemDef.effects.variables;
    }
    if (itemDef.effects.stats) deltas.stats = itemDef.effects.stats;
    if (itemDef.effects.statMax) deltas.statMax = itemDef.effects.statMax;
  }
  return { deltas };
};

// useSkill action handler. Validates ownership (knownSkills), then
// applies both cost and effects in a single combined delta — atomic
// so triggers see both at once.
const useSkillHandler: ActionHandler = ({ state, action, game }) => {
  if (!action.skillId) return {};
  const skillDef = (game.skills ?? []).find((s) => s.id === action.skillId);
  if (!skillDef) return {};
  if (!state.baseline.knownSkills.includes(action.skillId)) return {};

  // Merge cost + effects. Both can touch any StateDelta field; later
  // entries (effects) override earlier (cost) on simple keys. For
  // stats/affection/inventory/weapons (which are records summed
  // additively), we sum field-by-field.
  const deltas: StateDelta = {};
  if (skillDef.cost) mergeDelta(deltas, skillDef.cost);
  if (skillDef.effects) mergeDelta(deltas, skillDef.effects);
  return { deltas };
};

// Merge `src` into `dst` — additive on numeric record fields,
// last-write-wins on flag values. Used by useSkill to combine the
// skill's cost + effects into one atomic delta.
function mergeDelta(dst: StateDelta, src: StateDelta): void {
  if (src.characterStats) {
    dst.characterStats = dst.characterStats ?? {};
    for (const [charId, statDeltas] of Object.entries(src.characterStats)) {
      const into = (dst.characterStats[charId] = dst.characterStats[charId] ?? {});
      for (const [name, v] of Object.entries(statDeltas)) {
        into[name] = (into[name] ?? 0) + v;
      }
    }
  }
  if (src.stats) {
    dst.stats = dst.stats ?? {};
    for (const [k, v] of Object.entries(src.stats)) {
      dst.stats[k] = (dst.stats[k] ?? 0) + v;
    }
  }
  if (src.statMax) {
    dst.statMax = dst.statMax ?? {};
    for (const [k, v] of Object.entries(src.statMax)) {
      dst.statMax[k] = (dst.statMax[k] ?? 0) + v;
    }
  }
  if (src.switches) {
    dst.switches = { ...(dst.switches ?? {}), ...src.switches };
  }
  if (src.variables) {
    dst.variables = dst.variables ?? {};
    for (const [k, v] of Object.entries(src.variables)) {
      const cur = dst.variables[k];
      if (typeof cur === "number" && typeof v === "number") {
        dst.variables[k] = cur + v;
      } else {
        dst.variables[k] = v;
      }
    }
  }
  if (src.inventory) {
    dst.inventory = dst.inventory ?? {};
    for (const [k, v] of Object.entries(src.inventory)) {
      dst.inventory[k] = (dst.inventory[k] ?? 0) + v;
    }
  }
  if (src.weapons) {
    dst.weapons = dst.weapons ?? {};
    for (const [k, v] of Object.entries(src.weapons)) {
      const cur = dst.weapons[k] ?? {};
      dst.weapons[k] = {
        power: (cur.power ?? 0) + (v.power ?? 0),
      };
    }
  }
  if (src.skills) {
    dst.skills = dst.skills ?? {};
    if (src.skills.learn) {
      dst.skills.learn = [...(dst.skills.learn ?? []), ...src.skills.learn];
    }
    if (src.skills.forget) {
      dst.skills.forget = [
        ...(dst.skills.forget ?? []),
        ...src.skills.forget,
      ];
    }
  }
}

export function createBaselineState(
  characters: CharacterDef[],
  weapons: WeaponDef[] = [],
  switches: SwitchDef[] = [],
  variables: VariableDef[] = [],
): BaselineState {
  const charMap: Record<string, CharacterState> = {};
  for (const c of characters) {
    const stats: Record<string, number> = {};
    for (const [name, def] of Object.entries(c.stats ?? {})) {
      stats[name] = def.initial;
    }
    // Affection is the engine-canonical character stat. Declare a
    // default of 0 if the character didn't register one, so inline
    // effects `+alice` always have a slot to read from.
    if (!("affection" in stats)) stats.affection = 0;
    charMap[c.id] = {
      stats,
      custom: {},
    };
  }
  const weaponMap: Record<string, WeaponState> = {};
  for (const w of weapons) {
    weaponMap[w.id] = { power: w.basePower };
  }
  const switchMap: Record<string, boolean> = {};
  for (const s of switches) switchMap[s.id] = s.initial;
  const variableMap: Record<string, VariableValue> = {};
  for (const v of variables) variableMap[v.id] = v.initial;
  // Auto-equip the only declared weapon. Multi-weapon games leave
  // equippedWeaponId null and equip via the equipWeapon primitive.
  const equippedWeaponId = weapons.length === 1 ? weapons[0]!.id : null;
  return {
    characters: charMap,
    switches: switchMap,
    variables: variableMap,
    scripts: {},
    completionOrder: [],
    currentScriptId: null,
    beatIndex: 0,
    scriptCursor: null,
    inventory: {},
    currentMapId: null,
    weapons: weaponMap,
    equippedWeaponId,
    knownSkills: [],
    visuals: emptyVisualState(),
  };
}

// Built-in handler for the engine-synthesized "move" activity that
// `buildMapHubSnapshot` / `collectMapActivities` emit for each
// MapConnection. Payload shape: { to: <mapId>, routeKey?: <event source> }.
// The key distinguishes multiple authored doors to one target; legacy callers
// without it remain valid only when the target identifies one route. Delegates
// to enterMap through the same path as a module/preset caller.
const moveToMapHandler: ActionHandler = ({ state, action, game }) => {
  const payload = action.payload as { to?: unknown; routeKey?: unknown } | undefined;
  const to = payload?.to;
  if (typeof to !== "string") return {};
  const routeKey = typeof payload?.routeKey === "string" ? payload.routeKey : undefined;
  const from = state.baseline.currentMapId === null
    ? undefined
    : (game.maps ?? []).find((map) => map.id === state.baseline.currentMapId);
  const connection = from ? resolveMapRoute(from, to, routeKey) : undefined;
  if (!connection) {
    return {
      narrations: [`今いる場所から ${to} へ続く道はない。`],
    };
  }
  if (connection.requires !== undefined) {
    const result = evaluateCondition(connection.requires, state);
    if (!result.ok) {
      return {
        narrations: [connection.lockedHint ?? result.reason ?? "その道はまだ開いていない。"],
      };
    }
  }
  enterMap(state, game, to);
  return {};
};

export const baselineModule: Module = {
  id: BASELINE_NAMESPACE,
  version: "0.1",
  initialize(game: Game): BaselineState {
    return createBaselineState(
      game.characters,
      game.weapons ?? [],
      game.switches ?? [],
      game.variables ?? [],
    );
  },
  provides: ["useItem", "useSkill", "moveToMap"],
  actionHandlers: {
    useItem: useItemHandler,
    useSkill: useSkillHandler,
    moveToMap: moveToMapHandler,
  },
};

export type { BaselineState, FlagValue };
