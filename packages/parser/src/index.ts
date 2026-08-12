import type {
  Action,
  AssetSpec,
  CharacterDef,
  EnemyDef,
  Game,
  ItemDef,
  MapDef,
  Module,
  Script,
  SkillDef,
  WeaponDef,
} from "@rpg-harness/engine";
import type { Manifest } from "./manifest";
import { validateGame } from "./validate";

export { parseScript, ScriptParseError } from "./script";
export { parseManifest, ManifestParseError } from "./manifest";
export { parseCharacter, CharacterParseError } from "./character";
export { parseCondition, ConditionParseError } from "./condition";
export { parseAction, ActionParseError } from "./action";
export { parseItem, ItemParseError } from "./item";
export { parseEnemy, EnemyParseError } from "./enemy";
export { parseWeapon, WeaponParseError } from "./weapon";
export { parseSkill, SkillParseError } from "./skill";
export { parseMap, MapParseError } from "./map";
export { parseAssetSpec, AssetParseError } from "./asset";
export { validateGame, GameValidationError } from "./validate";
export type { Manifest } from "./manifest";

export function buildGame(
  manifest: Manifest,
  characters: CharacterDef[],
  scripts: Script[],
  actions?: Action[],
  modules?: Module[],
  items?: ItemDef[],
  enemies?: EnemyDef[],
  weapons?: WeaponDef[],
  skills?: SkillDef[],
  maps?: MapDef[],
  assets?: AssetSpec[],
): Game {
  const game: Game = {
    title: manifest.title,
    characters,
    scripts,
  };
  if (manifest.aiAudit) game.aiAudit = manifest.aiAudit;
  if (actions && actions.length > 0) game.actions = actions;
  if (items && items.length > 0) game.items = items;
  if (enemies && enemies.length > 0) game.enemies = enemies;
  if (weapons && weapons.length > 0) game.weapons = weapons;
  if (skills && skills.length > 0) game.skills = skills;
  if (maps && maps.length > 0) game.maps = maps;
  if (assets && assets.length > 0) game.assets = assets;
  if (manifest.training) game.training = manifest.training;
  if (manifest.switches && manifest.switches.length > 0) {
    game.switches = manifest.switches;
  }
  if (manifest.variables && manifest.variables.length > 0) {
    game.variables = manifest.variables;
  }
  if (modules && modules.length > 0) game.modules = modules;
  if (manifest.preset) game.preset = manifest.preset;
  validateGame(game);
  return game;
}
