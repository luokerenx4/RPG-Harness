import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Game, MapDef } from "@rpg-harness/engine";
import { loadGame } from "@rpg-harness/cli";
import { MapTopologyError } from "./map-topology-error";
import {
  planReciprocalMapRoutes,
  reciprocalMapRouteRevision,
  updateReciprocalMapRoutes,
  type ReciprocalMapRouteIntent,
} from "./map-routes";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Studio reciprocal map route planning", () => {
  test("creates two ordinary directed routes that may anchor to each other's new placement", () => {
    const current = game([
      map("a", { connections: [{ dir: "legacy", target: "b" }] }),
      map("b"),
    ]);
    const plan = planReciprocalMapRoutes(current, reciprocalIntent());
    const a = plan.game.maps?.find((candidate) => candidate.id === "a")!;
    const b = plan.game.maps?.find((candidate) => candidate.id === "b")!;

    expect(a.connections).toEqual([{ dir: "legacy", target: "b" }]);
    expect(a.placements?.at(-1)).toMatchObject({
      id: "to_b",
      at: { x: 40, y: 50 },
      resource: { kind: "map", id: "b" },
      collision: "trigger",
      events: [{
        id: "depart_b",
        label: "Enter B",
        trigger: "interact",
        arrival: { placementId: "to_a" },
        order: 0,
      }],
    });
    expect(b.placements?.at(-1)?.events[0]?.arrival).toEqual({ placementId: "to_b" });
    expect(plan.changedIds).toEqual(["a", "b"]);
  });

  test("allows arbitrary non-negative placement coordinates on node maps", () => {
    const plan = planReciprocalMapRoutes(
      game([map("a"), map("b")]),
      reciprocalIntent(),
    );
    expect(plan.game.maps?.find((candidate) => candidate.id === "a")?.placements?.[0]?.at)
      .toEqual({ x: 40, y: 50 });
  });

  test("validates placement bounds on spatial maps", () => {
    const spatial = game([
      map("a", { layout: layout(2, 2) }),
      map("b", { layout: layout(2, 2) }),
    ]);
    expect(() => planReciprocalMapRoutes(spatial, reciprocalIntent())).toThrow(
      /placement footprint must fit inside 2x2 layout/,
    );
  });

  test("rejects self-routes, non-reciprocal pairs, blank identity, and id conflicts", () => {
    const current = game([
      map("a", { placements: [placement("taken")] }),
      map("b"),
      map("c"),
    ]);
    const self = reciprocalIntent();
    self.forward.targetMapId = "a";
    self.reverse.sourceMapId = "a";
    expect(() => planReciprocalMapRoutes(current, self)).toThrow(/two distinct maps/);

    const nonReciprocal = reciprocalIntent();
    nonReciprocal.reverse.targetMapId = "c";
    expect(() => planReciprocalMapRoutes(current, nonReciprocal)).toThrow(/exactly opposite/);

    const blank = reciprocalIntent();
    blank.forward.label = "   ";
    expect(() => planReciprocalMapRoutes(current, blank)).toThrow(/non-blank/);

    const conflict = reciprocalIntent();
    conflict.forward.placementId = "taken";
    expect(() => planReciprocalMapRoutes(current, conflict)).toThrow(/already has placement id/);
  });

  test("revision covers both complete authored map definitions", () => {
    const original = game([map("a"), map("b")]);
    const revision = reciprocalMapRouteRevision(original, ["a", "b"]);
    expect(reciprocalMapRouteRevision({
      ...original,
      maps: original.maps?.map((candidate) => candidate.id === "a"
        ? { ...candidate, name: "Renamed A" }
        : candidate),
    }, ["a", "b"])).not.toBe(revision);
    expect(reciprocalMapRouteRevision({
      ...original,
      maps: original.maps?.map((candidate) => candidate.id === "b"
        ? { ...candidate, placements: [placement("new_anchor")] }
        : candidate),
    }, ["a", "b"])).not.toBe(revision);

    const stale = reciprocalIntent();
    stale.expectedRevision = revision;
    const renamed = {
      ...original,
      maps: original.maps?.map((candidate) => candidate.id === "a"
        ? { ...candidate, name: "Renamed A" }
        : candidate),
    };
    expect(() => planReciprocalMapRoutes(renamed, stale)).toThrow(/changed since/);
  });
});

describe("Studio reciprocal map route source transaction", () => {
  test("commits both files and leaves legacy connections authored in place", async () => {
    const fixture = await routeFixture();
    const loaded = await loadGame(fixture.gameDir);
    const intent = reciprocalIntent();
    intent.expectedRevision = reciprocalMapRouteRevision(loaded, ["a", "b"]);
    const result = await updateReciprocalMapRoutes(
      fixture.sources,
      intent,
      () => loadGame(fixture.gameDir),
    );
    expect(result.changedIds).toEqual(["a", "b"]);
    const updated = await loadGame(fixture.gameDir);
    expect(updated.maps?.find((candidate) => candidate.id === "a")?.connections)
      .toEqual([{ dir: "Legacy B", target: "b" }]);
    expect(updated.maps?.find((candidate) => candidate.id === "a")?.placements?.at(-1)?.events[0])
      .toMatchObject({ id: "depart_b", arrival: { placementId: "to_a" } });
    expect(await readFile(fixture.aFile, "utf-8")).toContain("connections:");
    expect(await readFile(fixture.aFile, "utf-8")).toContain("# keep legacy route");
    const authoredA = await readFile(fixture.aFile, "utf-8");
    expect(authoredA).toContain("# keep authored placement trivia");
    expect(authoredA).toContain("- &quiet_door {");
    expect(authoredA).toContain("events: [ { id: quiet");
    expect(authoredA).toContain('label: "", locked_hint: ""');
    expect(updated.maps?.find((candidate) => candidate.id === "a")?.placements?.[0]?.events[0])
      .toMatchObject({ id: "quiet", label: "", lockedHint: "" });
  });

  test("rolls both files back byte-exactly when authoritative reload fails", async () => {
    const fixture = await routeFixture();
    const aBefore = await readFile(fixture.aFile, "utf-8");
    const bBefore = await readFile(fixture.bFile, "utf-8");
    let reloadCount = 0;
    await expect(updateReciprocalMapRoutes(
      fixture.sources,
      reciprocalIntent(),
      async () => {
        reloadCount += 1;
        if (reloadCount === 3) throw new Error("route reload failed");
        return loadGame(fixture.gameDir);
      },
    )).rejects.toThrow("route reload failed");
    expect(await readFile(fixture.aFile, "utf-8")).toBe(aBefore);
    expect(await readFile(fixture.bFile, "utf-8")).toBe(bBefore);
  });

  test("preserves an external edit and requires recovery instead of partial rollback", async () => {
    const fixture = await routeFixture();
    const aBefore = await readFile(fixture.aFile, "utf-8");
    const external = "id: b\nname: External owner\n";
    let caught: unknown;
    try {
      await updateReciprocalMapRoutes(
        fixture.sources,
        reciprocalIntent(),
        () => loadGame(fixture.gameDir),
        async () => {
          await writeFile(fixture.bFile, external);
          throw new Error("projection failed after external edit");
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MapTopologyError);
    expect(caught).toMatchObject({
      status: 500,
      code: "map_topology_recovery_required",
    });
    expect((caught as Error).message).toContain("Rollback skipped for externally changed maps: b");
    expect(await readFile(fixture.aFile, "utf-8")).toBe(aBefore);
    expect(await readFile(fixture.bFile, "utf-8")).toBe(external);
  });

  test("accepts a source already restored to its original bytes during rollback", async () => {
    const fixture = await routeFixture();
    const aBefore = await readFile(fixture.aFile, "utf-8");
    const bBefore = await readFile(fixture.bFile, "utf-8");
    let caught: unknown;
    try {
      await updateReciprocalMapRoutes(
        fixture.sources,
        reciprocalIntent(),
        () => loadGame(fixture.gameDir),
        async () => {
          await writeFile(fixture.bFile, bBefore);
          throw new Error("projection failed after one source was restored");
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(MapTopologyError);
    expect((caught as Error).message).toBe("projection failed after one source was restored");
    expect(await readFile(fixture.aFile, "utf-8")).toBe(aBefore);
    expect(await readFile(fixture.bFile, "utf-8")).toBe(bBefore);
    expect(await stat(path.join(fixture.gameDir, ".studio-transactions")).then(
      () => true,
      () => false,
    )).toBe(false);
  });

  test("fails closed if re-planning would add map sources that were never locked", async () => {
    const fixture = await routeFixture(true);
    const intent = reciprocalIntent();
    let reloadCount = 0;
    await expect(updateReciprocalMapRoutes(
      fixture.sources,
      intent,
      async () => {
        reloadCount += 1;
        const snapshot = await loadGame(fixture.gameDir);
        if (reloadCount === 2) {
          intent.forward.sourceMapId = "c";
          intent.forward.targetMapId = "d";
          intent.reverse.sourceMapId = "d";
          intent.reverse.targetMapId = "c";
        }
        return snapshot;
      },
    )).rejects.toMatchObject({ status: 409, code: "stale_map_source" });
    expect((await loadGame(fixture.gameDir)).maps?.find((candidate) => candidate.id === "a")?.placements
      ?.map((candidate) => candidate.id)).toEqual(["quiet_door"]);
  });
});

function map(id: string, options: Partial<MapDef> = {}): MapDef {
  return {
    id,
    name: id.toUpperCase(),
    description: "",
    difficulty: 1,
    ...options,
  };
}

function game(maps: MapDef[]): Game {
  return { title: "Routes", characters: [], scripts: [], maps };
}

function layout(width: number, height: number): NonNullable<MapDef["layout"]> {
  return { width, height, tileWidth: 1, tileHeight: 1, layers: [], regions: [] };
}

function placement(id: string): NonNullable<MapDef["placements"]>[number] {
  return {
    id,
    at: { x: 0, y: 0 },
    resource: { kind: "map", id: "a" },
    z: 0,
    footprint: { width: 1, height: 1 },
    collision: "none",
    visible: true,
    events: [],
  };
}

function reciprocalIntent(): ReciprocalMapRouteIntent {
  return {
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

async function routeFixture(extraMaps = false) {
  const gameDir = await mkdtemp(path.join(os.tmpdir(), "autogal-map-routes-"));
  created.push(gameDir);
  await mkdir(path.join(gameDir, "maps"));
  await writeFile(path.join(gameDir, "game.yaml"), "title: Route fixture\n");
  const aFile = path.join(gameDir, "maps", "a.yaml");
  const bFile = path.join(gameDir, "maps", "b.yaml");
  await writeFile(aFile, [
    "# authored A",
    "id: a",
    "name: A",
    "# keep legacy route",
    "connections:",
    "  - { dir: Legacy B, target: b }",
    "placements:",
    "  # keep authored placement trivia",
    '  - &quiet_door { id: quiet_door, at: [0, 0], resource: { kind: map, id: b }, events: [{ id: quiet, trigger: interact, label: "", locked_hint: "" }] }',
    "",
  ].join("\n"));
  await writeFile(bFile, "# authored B\nid: b\nname: B\n");
  const sources = new Map([["a", aFile], ["b", bFile]]);
  if (extraMaps) {
    for (const id of ["c", "d"]) {
      const file = path.join(gameDir, "maps", `${id}.yaml`);
      await writeFile(file, `id: ${id}\nname: ${id.toUpperCase()}\n`);
      sources.set(id, file);
    }
  }
  return { gameDir, aFile, bFile, sources };
}
