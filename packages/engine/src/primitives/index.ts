export { drainNarrations } from "./drainNarrations";
export { drainAutomaticMapEvents } from "./drainMapEvents";
export { checkEndConditions } from "./checkEndConditions";
export { checkTriggers, TriggerExecutionError } from "./checkTriggers";
export { applyActionResult } from "./applyActionResult";
export { runScript } from "./runScript";
export { dispatchActivity } from "./dispatchActivity";
export { mutateState } from "./mutateState";
export { enterMap, EnterMapError } from "./enterMap";
export { buildMapHubSnapshot, collectMapActivities } from "./buildMapHub";
export { collectMapAvailableResources } from "./collectMapResources";
export { moveMapPlayer } from "./moveMapPlayer";
export type { MapMoveResult } from "./moveMapPlayer";
export { giveItem, consumeItem, hasItem } from "./inventory";
export {
  getEquippedWeapon,
  getEquippedWeaponPower,
  getWeaponPower,
  equipWeapon,
} from "./weapons";
export { hasSkill, learnSkill, forgetSkill } from "./skills";
export {
  fireHook,
  ModuleHookExecutionError,
  fireOnSessionStart,
  fireOnScriptStart,
  fireOnScriptComplete,
  fireOnScriptSelect,
  fireOnBeatBefore,
  fireOnBeatAfter,
  fireOnChoicePresented,
  fireOnChoiceResolved,
  fireOnLabelEnter,
  fireOnActionDispatch,
  fireOnActionComplete,
  fireOnStateMutated,
  fireOnHubBuild,
  fireOnEndConditionFire,
  fireOnNarrationDrain,
} from "./hooks";
