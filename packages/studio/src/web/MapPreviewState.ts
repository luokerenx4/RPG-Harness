import type { MapDef } from "@rpg-harness/engine";
import type { MapPreviewResponse } from "./api";

export type MapPreviewTarget = "saved" | "draft";
export type MapPreviewPhase = "building" | "ready" | "invalid" | "unavailable";

export interface MapPreviewViewState {
  phase: MapPreviewPhase;
  target: MapPreviewTarget;
  mapId: string;
  preview: MapPreviewResponse | null;
  error: string | null;
}

export type MapPreviewViewAction =
  | { type: "begin"; target: MapPreviewTarget; mapId: string }
  | { type: "ready"; target: MapPreviewTarget; preview: MapPreviewResponse }
  | { type: "invalid"; target: MapPreviewTarget; mapId: string; error: string }
  | { type: "unavailable"; target: MapPreviewTarget; mapId: string; error: string };

export function createMapPreviewViewState(
  mapId: string,
  target: MapPreviewTarget = "saved",
): MapPreviewViewState {
  return {
    phase: "building",
    target,
    mapId,
    preview: null,
    error: null,
  };
}

export function mapPreviewViewReducer(
  state: MapPreviewViewState,
  action: MapPreviewViewAction,
): MapPreviewViewState {
  if (action.type === "begin") {
    return {
      phase: "building",
      target: action.target,
      mapId: action.mapId,
      preview: state.mapId === action.mapId ? state.preview : null,
      error: null,
    };
  }
  if (action.type === "ready") {
    return {
      phase: "ready",
      target: action.target,
      mapId: action.preview.mapId,
      preview: action.preview,
      error: null,
    };
  }
  return {
    phase: action.type,
    target: action.target,
    mapId: action.mapId,
    preview: state.mapId === action.mapId ? state.preview : null,
    error: action.error,
  };
}

export function mapPreviewStatusLabel(state: MapPreviewViewState): string {
  if (state.phase === "invalid") {
    return "INVALID DRAFT";
  }
  if (state.phase === "unavailable") {
    return "PREVIEW UNAVAILABLE";
  }
  const target = state.target === "draft" ? "DRAFT" : "SAVED";
  if (state.phase === "building") {
    return `BUILDING ${target} PREVIEW${state.preview ? " · STALE" : ""}`;
  }
  return `${target} PREVIEW · READY`;
}

/** Stable authoring identity used to avoid rebuilding the same draft on rerender. */
export function mapPreviewDraftIdentity(map: MapDef): string {
  return JSON.stringify({
    id: map.id,
    name: map.name,
    description: map.description,
    difficulty: map.difficulty,
    bg: map.bg,
    isExtract: Boolean(map.isExtract),
    layout: map.layout ?? null,
    placements: map.placements ?? [],
  });
}
