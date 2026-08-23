import type { ComposedState, Game } from "@rpg-harness/engine";

export interface PickerSaveSummary {
  location: string;
  activity: string;
  records: number;
}

export function pickerSaveSummary(game: Game, state: ComposedState): PickerSaveSummary {
  const mapId = state.baseline.currentMapId;
  const scriptId = state.baseline.currentScriptId;
  return {
    location: (game.maps ?? []).find((map) => map.id === mapId)?.name ?? mapId ?? "旅の途中",
    activity: game.scripts.find((script) => script.id === scriptId)?.title ?? "自由行動",
    records: state.baseline.completionOrder.length,
  };
}
