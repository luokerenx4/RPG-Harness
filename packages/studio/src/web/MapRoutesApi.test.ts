import { afterEach, describe, expect, test } from "bun:test";
import {
  MapRouteRequestError,
  previewReciprocalMapRoutes,
  saveReciprocalMapRoutes,
  type ReciprocalMapRouteIntent,
} from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Studio reciprocal map routes API client", () => {
  test("previews the complete independent forward and reverse drafts", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    globalThis.fetch = (async (input, init) => {
      capturedUrl = String(input);
      capturedBody = String(init?.body);
      return Response.json({
        revision: `sha256:${"a".repeat(64)}`,
        changedIds: ["a", "b"],
        routes: [intent().forward, intent().reverse],
      });
    }) as typeof fetch;

    const result = await previewReciprocalMapRoutes(intent());
    expect(capturedUrl).toBe("/api/map-routes/reciprocal/preview");
    expect(JSON.parse(capturedBody).forward.arrival).toEqual({ placementId: "to_a" });
    expect(result.routes[1]?.trigger).toBe("player_touch");
  });

  test("commits with PATCH and exposes typed stale-source details", async () => {
    let method = "";
    globalThis.fetch = (async (_input, init) => {
      method = init?.method ?? "";
      return Response.json(
        { error: "map route sources changed", code: "stale_map_routes" },
        { status: 409 },
      );
    }) as typeof fetch;

    const request = saveReciprocalMapRoutes(intent());
    expect(method).toBe("PATCH");
    await expect(request).rejects.toBeInstanceOf(MapRouteRequestError);
    await request.catch((error: MapRouteRequestError) => {
      expect(error.status).toBe(409);
      expect(error.code).toBe("stale_map_routes");
    });
  });
});

function intent(): ReciprocalMapRouteIntent {
  return {
    forward: {
      sourceMapId: "a",
      targetMapId: "b",
      placementId: "to_b",
      at: { x: 1, y: 2 },
      eventId: "depart_b",
      label: "Enter B",
      trigger: "interact",
      arrival: { placementId: "to_a" },
    },
    reverse: {
      sourceMapId: "b",
      targetMapId: "a",
      placementId: "to_a",
      at: { x: 3, y: 4 },
      eventId: "depart_a",
      label: "Return A",
      trigger: "player_touch",
      arrival: { placementId: "to_b" },
    },
  };
}
