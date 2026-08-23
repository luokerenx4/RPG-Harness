import { afterEach, describe, expect, test } from "bun:test";
import {
  MapPlacementRefactorRequestError,
  previewMapPlacementRename,
  saveMapPlacementRename,
  type MapPlacementRenameIntent,
} from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Studio map placement refactor API client", () => {
  test("previews one stable target and its engine-proven backlinks", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody = "";
    globalThis.fetch = (async (input, init) => {
      capturedUrl = String(input);
      capturedMethod = init?.method ?? "";
      capturedBody = String(init?.body);
      return Response.json({
        revision: `sha256:${"a".repeat(64)}`,
        targetKey: "map:field/placement:west-entry",
        changedIds: ["field", "gate"],
        backlinks: [{
          targetKey: "map:field/placement:west-entry",
          targetMapId: "field",
          targetPlacementId: "west-entry",
          sourceKey: "map:gate/legacy-connection:0",
          sourceMapId: "gate",
          sourceMapName: "Gate",
          source: "legacy-connection",
          sourceConnectionIndex: 0,
          label: "West",
        }],
      });
    }) as typeof fetch;

    const result = await previewMapPlacementRename(intent());
    expect(capturedUrl).toBe("/api/map-placements/rename/preview");
    expect(capturedMethod).toBe("POST");
    expect(JSON.parse(capturedBody)).toEqual(intent());
    expect(result.backlinks[0]?.sourceConnectionIndex).toBe(0);
  });

  test("commits with PATCH and exposes typed stale-reference details", async () => {
    let capturedUrl = "";
    let method = "";
    globalThis.fetch = (async (input, init) => {
      capturedUrl = String(input);
      method = init?.method ?? "";
      return Response.json(
        { error: "placement refs changed", code: "stale_map_placement_refs" },
        { status: 409 },
      );
    }) as typeof fetch;

    const request = saveMapPlacementRename({
      ...intent(),
      expectedRevision: `sha256:${"a".repeat(64)}`,
    });
    expect(capturedUrl).toBe("/api/map-placements/rename");
    expect(method).toBe("PATCH");
    await expect(request).rejects.toBeInstanceOf(MapPlacementRefactorRequestError);
    await request.catch((error: MapPlacementRefactorRequestError) => {
      expect(error.status).toBe(409);
      expect(error.code).toBe("stale_map_placement_refs");
    });
  });
});

function intent(): MapPlacementRenameIntent {
  return {
    mapId: "field",
    placementId: "west-entry",
    newPlacementId: "west-gate",
  };
}
