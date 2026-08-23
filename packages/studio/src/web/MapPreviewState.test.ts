import { describe, expect, test } from "bun:test";
import type { MapDef } from "@rpg-harness/engine";
import type { MapPreviewResponse } from "./api";
import {
  createMapPreviewViewState,
  mapPreviewDraftIdentity,
  mapPreviewStatusLabel,
  mapPreviewViewReducer,
} from "./MapPreviewState";

function response(mapId: string, source: "saved" | "draft"): MapPreviewResponse {
  return {
    mapId,
    source,
    readOnly: true,
    state: "deterministic-initial",
    hub: [],
    headless: [],
    tui: [],
  };
}

describe("Studio map preview view state", () => {
  test("keeps last-good only for the same map and marks it stale while rebuilding", () => {
    let state = createMapPreviewViewState("town", "saved");
    state = mapPreviewViewReducer(state, {
      type: "ready",
      target: "saved",
      preview: response("town", "saved"),
    });
    expect(mapPreviewStatusLabel(state)).toBe("SAVED PREVIEW · READY");

    state = mapPreviewViewReducer(state, { type: "begin", target: "draft", mapId: "town" });
    expect(state.preview?.source).toBe("saved");
    expect(mapPreviewStatusLabel(state)).toBe("BUILDING DRAFT PREVIEW · STALE");

    state = mapPreviewViewReducer(state, { type: "begin", target: "saved", mapId: "shrine" });
    expect(state.preview).toBeNull();
    expect(mapPreviewStatusLabel(state)).toBe("BUILDING SAVED PREVIEW");
  });

  test("distinguishes invalid drafts from transport failures and preserves last-good", () => {
    const ready = mapPreviewViewReducer(createMapPreviewViewState("town", "draft"), {
      type: "ready",
      target: "draft",
      preview: response("town", "draft"),
    });
    const invalid = mapPreviewViewReducer(ready, {
      type: "invalid",
      target: "draft",
      mapId: "town",
      error: "placement outside bounds",
    });
    expect(mapPreviewStatusLabel(invalid)).toBe("INVALID DRAFT");
    expect(invalid.preview).toBe(ready.preview);
    const unavailable = mapPreviewViewReducer(ready, {
      type: "unavailable",
      target: "draft",
      mapId: "town",
      error: "network offline",
    });
    expect(mapPreviewStatusLabel(unavailable)).toBe("PREVIEW UNAVAILABLE");
    expect(unavailable.preview).toBe(ready.preview);
  });

  test("deduplicates identical authoring drafts and rebuilds for properties or spatial changes", () => {
    const map = {
      id: "town",
      name: "Town",
      description: "one",
      placements: [],
    } satisfies MapDef;
    expect(mapPreviewDraftIdentity(map)).not.toBe(mapPreviewDraftIdentity({
      ...map,
      description: "property refresh",
    }));
    expect(mapPreviewDraftIdentity(map)).not.toBe(mapPreviewDraftIdentity({
      ...map,
      placements: [{
        id: "event",
        at: { x: 0, y: 0 },
        z: 0,
        footprint: { width: 1, height: 1 },
        collision: "trigger",
        visible: true,
        events: [],
      }],
    }));
  });
});
