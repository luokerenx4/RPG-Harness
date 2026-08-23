import { afterEach, describe, expect, test } from "bun:test";
import {
  MapTopologyRequestError,
  previewMapTopology,
  saveMapTopology,
  type MapTopologyIntent,
} from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function intent(chain: string | null): MapTopologyIntent {
  return {
    expected: {
      chain: "raid",
      isEntry: false,
      sourceEntryId: "gate",
      destinationEntryId: null,
    },
    destination: { chain, entry: "make-selected" },
  };
}

describe("Studio map topology API client", () => {
  test("previews the exact chain value without trimming it", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    globalThis.fetch = (async (input, init) => {
      capturedUrl = String(input);
      capturedBody = String(init?.body);
      return Response.json({
        revision: `sha256:${"a".repeat(64)}`,
        changedIds: ["crossroads"],
        assignments: [{ id: "crossroads", chain: "   ", isEntry: true }],
      });
    }) as typeof fetch;

    const result = await previewMapTopology("crossroads / east", intent("   "));

    expect(capturedUrl).toBe("/api/maps/crossroads%20%2F%20east/topology/preview");
    expect(JSON.parse(capturedBody).destination.chain).toBe("   ");
    expect(result.assignments[0]?.chain).toBe("   ");
    expect(result.revision).toBe(`sha256:${"a".repeat(64)}`);
  });

  test("commits with PATCH and exposes server conflict details", async () => {
    let method = "";
    globalThis.fetch = (async (_input, init) => {
      method = init?.method ?? "";
      return Response.json(
        { error: "map topology changed since this dialog opened", code: "stale_map_topology" },
        { status: 409 },
      );
    }) as typeof fetch;

    const request = saveMapTopology("crossroads", intent(null));
    expect(method).toBe("PATCH");
    await expect(request).rejects.toBeInstanceOf(MapTopologyRequestError);
    await request.catch((error: MapTopologyRequestError) => {
      expect(error.status).toBe(409);
      expect(error.code).toBe("stale_map_topology");
    });
  });
});
