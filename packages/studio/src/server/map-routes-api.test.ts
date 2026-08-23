import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handle } from "./handlers";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Studio reciprocal map routes API", () => {
  test("previews without writing, then commits both directed placement-event routes", async () => {
    const fixture = await apiFixture();
    const aBefore = await readFile(fixture.aFile, "utf-8");
    const bBefore = await readFile(fixture.bFile, "utf-8");
    const body = routeBody();

    const preview = await routeRequest(fixture.gameDir, "POST", body, true);
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expect(previewBody.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(previewBody.changedIds).toEqual(["a", "b"]);
    expect(previewBody.routes[0]).toMatchObject({
      placementId: "to_b",
      arrival: { placementId: "to_a" },
    });
    expect(await readFile(fixture.aFile, "utf-8")).toBe(aBefore);
    expect(await readFile(fixture.bFile, "utf-8")).toBe(bBefore);

    body.expectedRevision = previewBody.revision;
    const committed = await routeRequest(fixture.gameDir, "PATCH", body);
    expect(committed.status).toBe(200);
    const result = await committed.json();
    expect(result.changedIds).toEqual(["a", "b"]);
    expect(result.project.maps.find((map: { id: string }) => map.id === "a").placements.at(-1))
      .toMatchObject({
        id: "to_b",
        resource: { kind: "map", id: "b" },
        events: [{ id: "depart_b", arrival: { placementId: "to_a" } }],
      });
    expect(await readFile(fixture.aFile, "utf-8")).toContain("# legacy connection survives");
    expect(await readFile(fixture.aFile, "utf-8")).toContain("connections:");
  });

  test("requires PATCH to carry the revision returned by preview", async () => {
    const fixture = await apiFixture();
    const response = await routeRequest(fixture.gameDir, "PATCH", routeBody());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "map_route_preview_required" });
  });

  test("rejects unknown fields, blank authored values, and self-routes", async () => {
    const fixture = await apiFixture();
    const unknown = await routeRequest(fixture.gameDir, "POST", {
      ...routeBody(),
      bidirectional: true,
    }, true);
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toContain("unknown reciprocal route field");

    const blankBody = routeBody();
    blankBody.forward.label = "   ";
    const blank = await routeRequest(fixture.gameDir, "POST", blankBody, true);
    expect(blank.status).toBe(400);
    expect((await blank.json()).error).toContain("non-blank");

    const selfBody = routeBody();
    selfBody.forward.targetMapId = "a";
    selfBody.reverse.sourceMapId = "a";
    const self = await routeRequest(fixture.gameDir, "POST", selfBody, true);
    expect(self.status).toBe(400);
    const selfResult = await self.json();
    expect(selfResult.error).toContain("two distinct maps");
    expect(selfResult.code).toBe("invalid_map_routes");

    const malformedArrival = routeBody();
    malformedArrival.forward.arrival = {
      placementId: "to_a",
      at: { x: 0, y: 0 },
    } as typeof malformedArrival.forward.arrival;
    const malformed = await routeRequest(fixture.gameDir, "POST", malformedArrival, true);
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toContain("exactly one");
  });

  test("stales a commit when any semantic field in either authored map changes", async () => {
    const fixture = await apiFixture();
    const body = routeBody();
    const preview = await routeRequest(fixture.gameDir, "POST", body, true);
    body.expectedRevision = (await preview.json()).revision;
    await writeFile(fixture.bFile, "id: b\nname: B renamed after preview\n");
    const aBefore = await readFile(fixture.aFile, "utf-8");

    const response = await routeRequest(fixture.gameDir, "PATCH", body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "stale_map_routes" });
    expect(await readFile(fixture.aFile, "utf-8")).toBe(aBefore);
  });

  test("returns spatial source bounds failures as validation and writes nothing", async () => {
    const fixture = await apiFixture(true);
    const aBefore = await readFile(fixture.aFile, "utf-8");
    const response = await routeRequest(fixture.gameDir, "POST", routeBody(), true);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "invalid_map_routes" });
    expect(await readFile(fixture.aFile, "utf-8")).toBe(aBefore);
  });

  test("classifies invalid, mismatched, and ambiguous canonical sources before loading the game", async () => {
    const cases = [
      {
        mutate: async (fixture: Awaited<ReturnType<typeof apiFixture>>) => {
          await writeFile(fixture.aFile, "id: a\nname: [unfinished\n");
        },
        status: 422,
        code: "invalid_map_routes",
        message: "map source is invalid for a",
      },
      {
        mutate: async (fixture: Awaited<ReturnType<typeof apiFixture>>) => {
          await writeFile(fixture.aFile, "id: not_a\nname: Mismatched A\n");
        },
        status: 409,
        code: "mismatched_map_source",
        message: "map source identity mismatch for a",
      },
      {
        mutate: async (fixture: Awaited<ReturnType<typeof apiFixture>>) => {
          await writeFile(path.join(fixture.gameDir, "maps", "a.yml"), "id: a\nname: Duplicate A\n");
        },
        status: 409,
        code: "ambiguous_map_source",
        message: "map source is ambiguous for a",
      },
    ] as const;

    for (const scenario of cases) {
      const fixture = await apiFixture();
      await scenario.mutate(fixture);
      for (const [method, preview] of [["POST", true], ["PATCH", false]] as const) {
        const body = routeBody();
        body.expectedRevision = `sha256:${"0".repeat(64)}`;
        const response = await routeRequest(fixture.gameDir, method, body, preview);
        expect(response.status).toBe(scenario.status);
        expect(await response.json()).toMatchObject({
          code: scenario.code,
          error: expect.stringContaining(scenario.message),
        });
      }
    }
  });
});

function routeRequest(
  gameDir: string,
  method: "POST" | "PATCH",
  body: unknown,
  preview = false,
) {
  return handle(new Request(
    `http://studio.test/api/map-routes/reciprocal${preview ? "/preview" : ""}`,
    {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  ), { gameDir });
}

function routeBody() {
  return {
    expectedRevision: undefined as string | undefined,
    forward: {
      sourceMapId: "a",
      targetMapId: "b",
      placementId: "to_b",
      at: { x: 40, y: 50 },
      eventId: "depart_b",
      label: "Enter B",
      trigger: "interact",
      arrival: { placementId: "to_a" },
    },
    reverse: {
      sourceMapId: "b",
      targetMapId: "a",
      placementId: "to_a",
      at: { x: 60, y: 70 },
      eventId: "depart_a",
      label: "Return A",
      trigger: "player_touch",
      arrival: { placementId: "to_b" },
    },
  };
}

async function apiFixture(spatial = false) {
  const gameDir = await mkdtemp(path.join(os.tmpdir(), "autogal-map-routes-api-"));
  created.push(gameDir);
  await mkdir(path.join(gameDir, "maps"));
  await writeFile(path.join(gameDir, "game.yaml"), "title: Route API fixture\n");
  const aFile = path.join(gameDir, "maps", "a.yaml");
  const bFile = path.join(gameDir, "maps", "b.yaml");
  await writeFile(aFile, [
    "# authored A",
    "id: a",
    "name: A",
    ...(spatial
      ? ["layout:", "  width: 2", "  height: 2", "  layers: []", "  regions: []"]
      : []),
    "# legacy connection survives",
    "connections:",
    "  - { dir: Legacy B, target: b }",
    "",
  ].join("\n"));
  await writeFile(bFile, [
    "id: b",
    "name: B",
    ...(spatial
      ? ["layout:", "  width: 2", "  height: 2", "  layers: []", "  regions: []"]
      : []),
    "",
  ].join("\n"));
  return { gameDir, aFile, bFile };
}
