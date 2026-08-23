import { afterEach, describe, expect, test } from "bun:test";
import type { MapDef } from "@rpg-harness/engine";
import { fetchMapPreview, fetchSavedMapPreview, MapPreviewRequestError } from "./api";
import {
  createMapPreviewRequestGate,
  isAbortError,
  scheduleMapPreviewRequest,
} from "./MapPreviewRequestGate";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Studio map preview requests", () => {
  test("posts the complete spatial draft through an abortable read-only preview request", async () => {
    const map = {
      id: "town",
      name: "Town",
      description: "",
      layout: {
        width: 4,
        height: 3,
        tileWidth: 32,
        tileHeight: 32,
        layers: [],
        regions: [],
      },
      placements: [],
    } satisfies MapDef;
    const controller = new AbortController();
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return Response.json({
        mapId: "town",
        state: "deterministic-initial",
        source: "draft",
        readOnly: true,
        hub: [],
        headless: [],
        tui: [],
      });
    }) as typeof fetch;

    await expect(fetchMapPreview(map, controller.signal)).resolves.toMatchObject({
      mapId: "town",
      source: "draft",
      readOnly: true,
    });
    expect(capturedUrl).toBe("/api/maps/town/preview");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.signal).toBe(controller.signal);
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      layout: map.layout,
      placements: [],
    });
  });

  test("uses GET for an unchanged saved projection", async () => {
    const controller = new AbortController();
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return Response.json({
        mapId: "town",
        state: "deterministic-initial",
        source: "saved",
        readOnly: true,
        hub: [],
        headless: [],
        tui: [],
      });
    }) as typeof fetch;

    await expect(fetchSavedMapPreview("town", controller.signal)).resolves.toMatchObject({
      mapId: "town",
      source: "saved",
    });
    expect(capturedUrl).toBe("/api/maps/town/preview");
    expect(capturedInit).toEqual({ signal: controller.signal });
  });

  test("preserves HTTP status so validation failures are not confused with network errors", async () => {
    globalThis.fetch = (async () => Response.json(
      { error: "placement outside bounds", code: "invalid_map_draft" },
      { status: 400 },
    )) as unknown as typeof fetch;
    const map = {
      id: "town",
      name: "Town",
      description: "",
      placements: [],
    } satisfies MapDef;
    try {
      await fetchMapPreview(map);
      throw new Error("expected preview request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(MapPreviewRequestError);
      expect((error as MapPreviewRequestError).status).toBe(400);
      expect((error as MapPreviewRequestError).code).toBe("invalid_map_draft");
      expect((error as Error).message).toContain("outside bounds");
    }
  });

  test("aborts and rejects a late response after a newer draft begins", () => {
    const gate = createMapPreviewRequestGate();
    const first = gate.begin();
    expect(gate.isCurrent(first)).toBe(true);

    const second = gate.begin();
    expect(first.controller.signal.aborted).toBe(true);
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);

    gate.cancel(first);
    expect(gate.isCurrent(second)).toBe(true);
    gate.cancel(second);
    expect(second.controller.signal.aborted).toBe(true);
    expect(gate.isCurrent(second)).toBe(false);
  });

  test("commits only B when B resolves before a late A", async () => {
    const gate = createMapPreviewRequestGate();
    let resolveA!: (value: string) => void;
    let resolveB!: (value: string) => void;
    const a = new Promise<string>((resolve) => { resolveA = resolve; });
    const b = new Promise<string>((resolve) => { resolveB = resolve; });
    const committed: string[] = [];

    const requestA = gate.begin();
    const commitA = a.then((value) => {
      if (gate.isCurrent(requestA)) committed.push(value);
    });
    const requestB = gate.begin();
    const commitB = b.then((value) => {
      if (gate.isCurrent(requestB)) committed.push(value);
    });
    resolveB("B");
    await commitB;
    resolveA("A");
    await commitA;
    expect(committed).toEqual(["B"]);
  });

  test("debounces a draft build and cancellation prevents the scheduled request", async () => {
    let runs = 0;
    scheduleMapPreviewRequest(() => { runs += 1; }, 15);
    expect(runs).toBe(0);
    await Bun.sleep(25);
    expect(runs).toBe(1);

    const cancel = scheduleMapPreviewRequest(() => { runs += 1; }, 15);
    cancel();
    await Bun.sleep(25);
    expect(runs).toBe(1);
  });

  test("recognizes AbortError values across realms", () => {
    expect(isAbortError({ name: "AbortError" })).toBe(true);
    expect(isAbortError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);
    expect(isAbortError(new Error("network"))).toBe(false);
  });
});
