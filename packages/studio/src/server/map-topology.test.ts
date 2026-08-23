import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createInitialState,
  enterMap,
  peek,
  step,
  type Game,
  type MapDef,
} from "@rpg-harness/engine";
import { loadGame } from "@rpg-harness/cli";
import { parseMap } from "@rpg-harness/parser";
import { serializeMapTopologyPatch, updateMapAuthoring } from "./map-write";
import { withProjectSnapshotLock } from "./project-mutation-lock";
import {
  MapTopologyError,
  mapTopologyRevision,
  planMapTopology,
  updateMapTopology,
  type MapTopologyIntent,
} from "./map-topology";

function map(
  id: string,
  options: Partial<MapDef> = {},
): MapDef {
  return {
    id,
    name: id.toUpperCase(),
    description: "",
    difficulty: 1,
    ...options,
  };
}

function game(maps: MapDef[]): Game {
  return { title: "Topology", characters: [], scripts: [], maps };
}

function topologyIntent(
  mapId: string,
  expected: MapTopologyIntent["expected"],
  destination: MapTopologyIntent["destination"],
  sourceReplacementEntryId?: string,
): MapTopologyIntent {
  return {
    mapId,
    expected,
    destination,
    ...(sourceReplacementEntryId ? { sourceReplacementEntryId } : {}),
  };
}

describe("Studio map topology planning", () => {
  test("creates a new exact chain and makes the selected standalone map its entry", () => {
    const plan = planMapTopology(game([map("town")]), topologyIntent(
      "town",
      { chain: null, isEntry: false, sourceEntryId: null, destinationEntryId: null },
      { chain: " raid ", entry: "make-selected" },
    ));

    expect(plan.assignments).toEqual([{ id: "town", chain: " raid ", isEntry: true }]);
    expect(plan.game.maps?.[0]).toMatchObject({ chain: " raid ", isEntry: true });
  });

  test("moves a member into an existing chain while retaining both existing entries", () => {
    const current = game([
      map("alpha_entry", {
        chain: "alpha",
        isEntry: true,
        connections: [{ dir: "member", target: "member" }],
      }),
      map("member", { chain: "alpha" }),
      map("beta_entry", {
        chain: "beta",
        isEntry: true,
        connections: [{ dir: "member", target: "member" }],
      }),
    ]);
    const plan = planMapTopology(current, topologyIntent(
      "member",
      {
        chain: "alpha",
        isEntry: false,
        sourceEntryId: "alpha_entry",
        destinationEntryId: "beta_entry",
      },
      { chain: "beta", entry: "keep-existing" },
    ));

    expect(plan.assignments).toEqual([{ id: "member", chain: "beta", isEntry: false }]);
    expect(plan.game.maps?.find((candidate) => candidate.id === "alpha_entry")?.isEntry).toBe(true);
    expect(plan.game.maps?.find((candidate) => candidate.id === "beta_entry")?.isEntry).toBe(true);
  });

  test("transfers entry within one chain as a two-map assignment", () => {
    const current = game([
      map("gate", {
        chain: "raid",
        isEntry: true,
        connections: [{ dir: "depths", target: "depths" }],
      }),
      map("depths", {
        chain: "raid",
        connections: [{ dir: "gate", target: "gate" }],
      }),
    ]);
    const plan = planMapTopology(current, topologyIntent(
      "depths",
      {
        chain: "raid",
        isEntry: false,
        sourceEntryId: "gate",
        destinationEntryId: "gate",
      },
      { chain: "raid", entry: "make-selected" },
    ));

    expect(plan.assignments).toEqual([
      { id: "gate", chain: "raid", isEntry: false },
      { id: "depths", chain: "raid", isEntry: true },
    ]);
    expect(plan.changedIds).toEqual(["depths", "gate"]);
  });

  test("requires and applies a replacement when moving the source entry away", () => {
    const current = game([
      map("gate", {
        chain: "raid",
        isEntry: true,
        connections: [{ dir: "depths", target: "depths" }],
      }),
      map("depths", {
        chain: "raid",
        connections: [{ dir: "gate", target: "gate" }],
      }),
    ]);
    const expected = {
      chain: "raid",
      isEntry: true,
      sourceEntryId: "gate",
      destinationEntryId: null,
    };
    expect(() => planMapTopology(current, topologyIntent(
      "gate",
      expected,
      { chain: null, entry: "keep-existing" },
    ))).toThrow("requires a replacement entry");

    const plan = planMapTopology(current, topologyIntent(
      "gate",
      expected,
      { chain: null, entry: "keep-existing" },
      "depths",
    ));
    expect(plan.assignments).toEqual([
      { id: "depths", chain: "raid", isEntry: true },
      { id: "gate", chain: null, isEntry: false },
    ]);
  });

  test("rejects an entry transfer that makes the old entry unreachable", () => {
    const current = game([
      map("gate", {
        chain: "raid",
        isEntry: true,
        connections: [{ dir: "depths", target: "depths" }],
      }),
      map("depths", { chain: "raid" }),
    ]);
    expect(() => planMapTopology(current, topologyIntent(
      "depths",
      {
        chain: "raid",
        isEntry: false,
        sourceEntryId: "gate",
        destinationEntryId: "gate",
      },
      { chain: "raid", entry: "make-selected" },
    ))).toThrow(/gate.*unreachable|unreachable.*gate/);
  });

  test("treats expected topology as a compare-and-swap guard", () => {
    const current = game([map("gate", { chain: "raid", isEntry: true })]);
    try {
      planMapTopology(current, topologyIntent(
        "gate",
        { chain: "old", isEntry: true, sourceEntryId: "gate", destinationEntryId: null },
        { chain: null, entry: "keep-existing" },
      ));
      throw new Error("expected stale topology to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(MapTopologyError);
      expect((error as MapTopologyError).status).toBe(409);
    }
  });

  test("canonicalizes a stray standalone entry to no chain and no entry", () => {
    const plan = planMapTopology(game([map("town", { isEntry: true })]), topologyIntent(
      "town",
      { chain: null, isEntry: true, sourceEntryId: null, destinationEntryId: null },
      { chain: null, entry: "keep-existing" },
    ));
    expect(plan.game.maps?.[0]?.chain).toBeUndefined();
    expect(plan.game.maps?.[0]?.isEntry).toBeUndefined();
  });

  test("revisions cover membership and structural routes but ignore presentation fields", () => {
    const original = game([
      map("gate", {
        chain: "raid",
        isEntry: true,
        connections: [{ dir: "Depths", target: "depths" }],
      }),
      map("depths", { chain: "raid" }),
    ]);
    expect(mapTopologyRevision({
      ...original,
      maps: original.maps?.map((candidate) => ({ ...candidate, name: `Renamed ${candidate.name}` })),
    })).toBe(mapTopologyRevision(original));
    expect(mapTopologyRevision({
      ...original,
      maps: original.maps?.map((candidate) => candidate.id === "depths"
        ? { ...candidate, chain: "other" }
        : candidate),
    })).not.toBe(mapTopologyRevision(original));
    expect(mapTopologyRevision({
      ...original,
      maps: original.maps?.map((candidate) => candidate.id === "gate"
        ? { ...candidate, connections: [{ dir: "Town", target: "town" }] }
        : candidate),
    })).not.toBe(mapTopologyRevision(original));
  });
});

describe("Studio map topology source transaction", () => {
  test("patches only topology scalars and preserves authored bytes", () => {
    const original = [
      "# authored map",
      "id: gate",
      "name: Gate",
      "chain: raid # exact identity",
      "is_entry: true",
      "# keep the flow layout byte-for-byte",
      "layout: { width: 2, height: 2, layers: [], regions: [] }",
    ].join("\n") + "\n";
    const next = serializeMapTopologyPatch(original, { chain: " raid ", isEntry: false });
    expect(next.content).toContain("chain: \" raid \" # exact identity");
    expect(next.content).not.toContain("is_entry:");
    expect(next.content.slice(next.content.indexOf("# keep the flow"))).toBe(
      original.slice(original.indexOf("# keep the flow")),
    );
    expect(next.map.chain).toBe(" raid ");
  });

  test("commits an entry transfer across two files and reloads the exact result", async () => {
    const fixture = await topologyFixture();
    try {
      const result = await updateMapTopology(
        fixture.sources,
        transferIntent(),
        () => readFixtureGame(fixture.directory),
      );
      expect(result.changedIds).toEqual(["depths", "gate"]);
      expect((await readFile(fixture.gateFile, "utf-8"))).not.toContain("is_entry:");
      expect((await readFile(fixture.depthsFile, "utf-8"))).toContain("is_entry: true");
      expect((await readdir(path.join(fixture.directory, "maps"))).sort()).toEqual([
        "depths.yaml",
        "gate.yaml",
      ]);
    } finally {
      await rm(fixture.directory, { recursive: true });
    }
  });

  test("rolls every file back byte-exactly when authoritative reload fails", async () => {
    const fixture = await topologyFixture();
    const gateBefore = await readFile(fixture.gateFile, "utf-8");
    const depthsBefore = await readFile(fixture.depthsFile, "utf-8");
    let reloadCount = 0;
    try {
      await expect(updateMapTopology(
        fixture.sources,
        transferIntent(),
        async () => {
          reloadCount += 1;
          if (reloadCount === 3) throw new Error("authoritative reload failed");
          return readFixtureGame(fixture.directory);
        },
      )).rejects.toThrow("authoritative reload failed");
      expect(await readFile(fixture.gateFile, "utf-8")).toBe(gateBefore);
      expect(await readFile(fixture.depthsFile, "utf-8")).toBe(depthsBefore);
      expect((await readdir(path.join(fixture.directory, "maps"))).sort()).toEqual([
        "depths.yaml",
        "gate.yaml",
      ]);
    } finally {
      await rm(fixture.directory, { recursive: true });
    }
  });

  test("rolls back when the authoritative Studio response cannot be projected", async () => {
    const fixture = await topologyFixture();
    const gateBefore = await readFile(fixture.gateFile, "utf-8");
    const depthsBefore = await readFile(fixture.depthsFile, "utf-8");
    try {
      await expect(updateMapTopology(
        fixture.sources,
        transferIntent(),
        () => readFixtureGame(fixture.directory),
        async () => {
          throw new Error("project graph projection failed");
        },
      )).rejects.toThrow("project graph projection failed");
      expect(await readFile(fixture.gateFile, "utf-8")).toBe(gateBefore);
      expect(await readFile(fixture.depthsFile, "utf-8")).toBe(depthsBefore);
    } finally {
      await rm(fixture.directory, { recursive: true });
    }
  });

  test("preserves an external edit and marks recovery required when rollback cannot be complete", async () => {
    const fixture = await topologyFixture();
    const gateBefore = await readFile(fixture.gateFile, "utf-8");
    const external = "id: depths\nname: External recovery owner\n";
    try {
      let caught: unknown;
      try {
        await updateMapTopology(
          fixture.sources,
          transferIntent(),
          () => readFixtureGame(fixture.directory),
          async () => {
            await writeFile(fixture.depthsFile, external);
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
      expect((caught as Error).message).toContain("Rollback skipped for externally changed maps: depths");
      expect(await readFile(fixture.gateFile, "utf-8")).toBe(gateBefore);
      expect(await readFile(fixture.depthsFile, "utf-8")).toBe(external);
    } finally {
      await rm(fixture.directory, { recursive: true });
    }
  });

  test("rejects a semantic source edit that lands after validation without overwriting it", async () => {
    const fixture = await topologyFixture();
    let reloadCount = 0;
    const external = (await readFile(fixture.depthsFile, "utf-8")).replace(
      "name: Depths",
      "name: External Depths",
    );
    try {
      await expect(updateMapTopology(
        fixture.sources,
        transferIntent(),
        async () => {
          reloadCount += 1;
          const snapshot = await readFixtureGame(fixture.directory);
          if (reloadCount === 2) await writeFile(fixture.depthsFile, external);
          return snapshot;
        },
      )).rejects.toThrow("source changed after topology validation");
      expect(await readFile(fixture.depthsFile, "utf-8")).toBe(external);
      expect((await readFile(fixture.gateFile, "utf-8"))).toContain("is_entry: true");
    } finally {
      await rm(fixture.directory, { recursive: true });
    }
  });

  test("classifies a partial or deleted source arriving after validation as stale", async () => {
    for (const mutate of [
      async (fixture: Awaited<ReturnType<typeof topologyFixture>>) => {
        await writeFile(fixture.depthsFile, "id: [unfinished");
      },
      async (fixture: Awaited<ReturnType<typeof topologyFixture>>) => {
        await rm(fixture.depthsFile);
      },
    ]) {
      const fixture = await topologyFixture();
      let reloadCount = 0;
      try {
        let caught: unknown;
        try {
          await updateMapTopology(
            fixture.sources,
            transferIntent(),
            async () => {
              reloadCount += 1;
              const snapshot = await readFixtureGame(fixture.directory);
              if (reloadCount === 2) await mutate(fixture);
              return snapshot;
            },
          );
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(MapTopologyError);
        expect(caught).toMatchObject({ status: 409, code: "stale_map_source" });
        expect((caught as Error).message).toContain("source changed after topology validation");
      } finally {
        await rm(fixture.directory, { recursive: true });
      }
    }
  });

  test("serializes topology with ordinary map authoring and preserves both writes", async () => {
    const fixture = await topologyFixture();
    let releaseProjection!: () => void;
    let projectionStarted!: () => void;
    const projectionGate = new Promise<void>((resolve) => { releaseProjection = resolve; });
    const projectionReady = new Promise<void>((resolve) => { projectionStarted = resolve; });
    try {
      const topology = withProjectSnapshotLock(fixture.directory, () => updateMapTopology(
        fixture.sources,
        transferIntent(),
        () => readFixtureGame(fixture.directory),
        async () => {
          projectionStarted();
          await projectionGate;
        },
      ));
      await projectionReady;

      let authoringFinished = false;
      const authoring = withProjectSnapshotLock(fixture.directory, async () => {
        const current = await readFixtureGame(fixture.directory);
        const updated = await updateMapAuthoring(
          fixture.depthsFile,
          current,
          "depths",
          { properties: { description: "Composed after topology" } },
          () => readFixtureGame(fixture.directory),
        );
        authoringFinished = true;
        return updated;
      });
      await Promise.resolve();
      expect(authoringFinished).toBe(false);
      releaseProjection();
      await topology;
      await authoring;

      const finalGame = await readFixtureGame(fixture.directory);
      expect(finalGame.maps?.find((candidate) => candidate.id === "gate")?.isEntry).toBeUndefined();
      expect(finalGame.maps?.find((candidate) => candidate.id === "depths")).toMatchObject({
        description: "Composed after topology",
        isEntry: true,
      });
    } finally {
      releaseProjection();
      await rm(fixture.directory, { recursive: true });
    }
  });
});

describe("Studio topology runtime acceptance", () => {
  test("a validated entry transfer changes the real sengoku Headless departure target", async () => {
    const gameDir = path.resolve(import.meta.dir, "../../../../examples/sengoku-raid");
    const loaded = await loadGame(gameDir);
    const plan = planMapTopology(loaded, topologyIntent(
      "sumida_river_ferry_landing",
      {
        chain: "sumida_river",
        isEntry: false,
        sourceEntryId: "sumida_river_bridge_foot",
        destinationEntryId: "sumida_river_bridge_foot",
      },
      { chain: "sumida_river", entry: "make-selected" },
    ));
    const state = createInitialState(plan.game, { seed: 0 });
    state.baseline.scripts["000_intro"] = {
      completed: true,
      selfSwitches: { A: false, B: false, C: false, D: false },
    };
    state.baseline.completionOrder = ["000_intro"];
    enterMap(state, plan.game, "edo_castle");

    const before = await peek(plan.game, state);
    expect(before.output?.type).toBe("hubMenu");
    if (before.output?.type !== "hubMenu") throw new Error("expected sengoku hub menu");
    const departure = before.output.snapshot.activities.filter(
      (activity) => activity.id === "depart:sumida_river",
    );
    expect(departure).toHaveLength(1);
    expect(departure[0]).toMatchObject({
      id: "depart:sumida_river",
      actionKind: "depart",
      payload: {
        chain: "sumida_river",
        mapId: "sumida_river_ferry_landing",
      },
      available: true,
    });

    const after = await step(plan.game, before.state, {
      type: "doActivity",
      id: "depart:sumida_river",
    });
    expect(after.inputResult?.accepted).toBe(true);
    expect(after.state.baseline.currentMapId).toBe("sumida_river_ferry_landing");
    expect(after.state.baseline.visuals.bg).toBe("assets/backgrounds/sumida-ferry");
    expect(after.state["sengoku-raid"]).toMatchObject({
      raid: {
        chain: "sumida_river",
        entryMapId: "sumida_river_ferry_landing",
        visited: {
          sumida_river_ferry_landing: { visited: true },
        },
      },
    });
  }, 15_000);
});

function transferIntent(): MapTopologyIntent {
  return topologyIntent(
    "depths",
    {
      chain: "raid",
      isEntry: false,
      sourceEntryId: "gate",
      destinationEntryId: "gate",
    },
    { chain: "raid", entry: "make-selected" },
  );
}

async function topologyFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "autogal-topology-"));
  const mapsDir = path.join(directory, "maps");
  await mkdir(mapsDir);
  const gateFile = path.join(mapsDir, "gate.yaml");
  const depthsFile = path.join(mapsDir, "depths.yaml");
  await writeFile(gateFile, [
    "# gate comment",
    "id: gate",
    "name: Gate",
    "chain: raid",
    "is_entry: true",
    "connections:",
    "  - { dir: Depths, target: depths }",
    "",
  ].join("\n"));
  await writeFile(depthsFile, [
    "# depths comment",
    "id: depths",
    "name: Depths",
    "chain: raid",
    "connections:",
    "  - { dir: Gate, target: gate }",
    "",
  ].join("\n"));
  return {
    directory,
    gateFile,
    depthsFile,
    sources: new Map([
      ["gate", gateFile],
      ["depths", depthsFile],
    ]),
  };
}

async function readFixtureGame(directory: string): Promise<Game> {
  const mapsDir = path.join(directory, "maps");
  const files = (await readdir(mapsDir)).filter((file) => file.endsWith(".yaml")).sort();
  return game(await Promise.all(files.map(async (file) => {
    const absolute = path.join(mapsDir, file);
    return parseMap(await readFile(absolute, "utf-8"), absolute);
  })));
}
