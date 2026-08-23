import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MapTopologyError } from "./map-topology";
import { handle } from "./handlers";
import { startStudioServer } from "./index";
import {
  markMapTopologyJournalCommitted,
  prepareMapTopologyJournal,
  recoverMapTopologyTransactions,
} from "./map-topology-journal";

const created: string[] = [];

interface CorruptibleJournalManifest {
  entries: Array<Record<string, unknown>>;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Studio map topology recovery journal", () => {
  test("rolls back a process exit between two map replacements", async () => {
    const fixture = await journalFixture();
    const journal = await prepareMapTopologyJournal(fixture.mutations);
    await writeFile(fixture.gateFile, fixture.mutations[0]!.updated);

    const recovered = await recoverMapTopologyTransactions(fixture.gameDir);

    expect(recovered).toEqual([path.basename(journal.directory)]);
    expect(await readFile(fixture.gateFile, "utf-8")).toBe(fixture.mutations[0]!.original);
    expect(await readFile(fixture.depthsFile, "utf-8")).toBe(fixture.mutations[1]!.original);
    expect(await stat(path.join(fixture.gameDir, ".studio-transactions")).then(
      () => true,
      () => false,
    )).toBe(false);
  });

  test("keeps a fully verified commit when only journal cleanup was interrupted", async () => {
    const fixture = await journalFixture();
    const journal = await prepareMapTopologyJournal(fixture.mutations);
    await Promise.all(fixture.mutations.map((mutation) =>
      writeFile(mutation.absolute, mutation.updated)
    ));
    await markMapTopologyJournalCommitted(journal);

    await recoverMapTopologyTransactions(fixture.gameDir);

    expect(await readFile(fixture.gateFile, "utf-8")).toBe(fixture.mutations[0]!.updated);
    expect(await readFile(fixture.depthsFile, "utf-8")).toBe(fixture.mutations[1]!.updated);
  });

  test("treats the commit marker as final and preserves edits made after commit", async () => {
    const fixture = await journalFixture();
    const journal = await prepareMapTopologyJournal(fixture.mutations);
    await Promise.all(fixture.mutations.map((mutation) =>
      writeFile(mutation.absolute, mutation.updated)
    ));
    await markMapTopologyJournalCommitted(journal);
    const external = "id: gate\nname: Edited after commit\nchain: raid\n";
    await writeFile(fixture.gateFile, external);

    await recoverMapTopologyTransactions(fixture.gameDir);

    expect(await readFile(fixture.gateFile, "utf-8")).toBe(external);
    expect(await stat(journal.directory).then(
      () => true,
      () => false,
    )).toBe(false);
  });

  test("removes recorded staged sources while rolling back a prepared transaction", async () => {
    const fixture = await journalFixture();
    await prepareMapTopologyJournal(fixture.mutations);
    await writeFile(fixture.mutations[0]!.temporary, fixture.mutations[0]!.updated);
    await writeFile(fixture.gateFile, fixture.mutations[0]!.updated);

    await recoverMapTopologyTransactions(fixture.gameDir);

    expect(await readFile(fixture.gateFile, "utf-8")).toBe(fixture.mutations[0]!.original);
    expect(await stat(fixture.mutations[0]!.temporary).then(
      () => true,
      () => false,
    )).toBe(false);
  });

  test("never overwrites an external edit and preserves its recovery evidence", async () => {
    const fixture = await journalFixture();
    const journal = await prepareMapTopologyJournal(fixture.mutations);
    await writeFile(fixture.gateFile, "id: gate\nname: External owner\n");

    let caught: unknown;
    try {
      await recoverMapTopologyTransactions(fixture.gameDir);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MapTopologyError);
    expect(caught).toMatchObject({
      status: 500,
      code: "map_topology_recovery_required",
    });
    expect(await readFile(fixture.gateFile, "utf-8")).toContain("External owner");
    expect(await stat(path.join(journal.directory, "manifest.json")).then(
      (value) => value.isFile(),
      () => false,
    )).toBe(true);
  });

  test("fails closed on corrupted target or source recovery evidence", async () => {
    const corruptions: Array<(manifest: CorruptibleJournalManifest) => void> = [
      (manifest) => {
        manifest.entries[0]!.target = "maps/depths.yaml";
      },
      (manifest) => {
        manifest.entries[0]!.originalBase64 = "not/base64!";
      },
      (manifest) => {
        manifest.entries[0]!.unexpectedCleanupPath = "../../outside";
      },
    ];

    for (const corrupt of corruptions) {
      const fixture = await journalFixture();
      const journal = await prepareMapTopologyJournal(fixture.mutations);
      const manifestPath = path.join(journal.directory, "manifest.json");
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf-8"),
      ) as CorruptibleJournalManifest;
      corrupt(manifest);
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

      const error = await rejection(recoverMapTopologyTransactions(fixture.gameDir));

      expect(error).toMatchObject({
        status: 500,
        code: "map_topology_recovery_required",
      });
      expect(await readFile(fixture.gateFile, "utf-8")).toBe(fixture.mutations[0]!.original);
      expect(await stat(manifestPath).then(
        (value) => value.isFile(),
        () => false,
      )).toBe(true);
    }
  });

  test("preserves a partial transaction when its manifest path is not a regular file", async () => {
    const fixture = await journalFixture();
    const journal = await prepareMapTopologyJournal(fixture.mutations);
    const manifestPath = path.join(journal.directory, "manifest.json");
    await rm(manifestPath);
    await mkdir(manifestPath);
    await writeFile(fixture.gateFile, fixture.mutations[0]!.updated);

    const error = await rejection(recoverMapTopologyTransactions(fixture.gameDir));

    expect(error).toMatchObject({
      status: 500,
      code: "map_topology_recovery_required",
    });
    expect(await readFile(fixture.gateFile, "utf-8")).toBe(fixture.mutations[0]!.updated);
    expect(await stat(journal.directory).then(
      (value) => value.isDirectory(),
      () => false,
    )).toBe(true);
  });

  test("recovers an interrupted transaction before serving the next Studio snapshot", async () => {
    const fixture = await journalFixture();
    await writeFile(path.join(fixture.gameDir, "game.yaml"), "title: Recovery fixture\n");
    await prepareMapTopologyJournal(fixture.mutations);
    await writeFile(fixture.gateFile, fixture.mutations[0]!.updated);

    const response = await handle(
      new Request("http://studio.test/api/project"),
      { gameDir: fixture.gameDir },
    );

    expect(response.status).toBe(200);
    expect(await readFile(fixture.gateFile, "utf-8")).toBe(fixture.mutations[0]!.original);
  });

  test("recovers before eager validation so a process can restart from a zero-entry midpoint", async () => {
    const fixture = await journalFixture();
    await writeFile(path.join(fixture.gameDir, "game.yaml"), "title: Recovery restart\n");
    await prepareMapTopologyJournal(fixture.mutations);
    await writeFile(fixture.mutations[0]!.temporary, fixture.mutations[0]!.updated);
    await writeFile(fixture.gateFile, fixture.mutations[0]!.updated);

    const server = await startStudioServer({ gameDir: fixture.gameDir, port: 0 });
    try {
      expect(server.port).toBeGreaterThan(0);
      expect((await fetch(`${server.url}/api/project`)).status).toBe(200);
      expect(await readFile(fixture.gateFile, "utf-8")).toBe(fixture.mutations[0]!.original);
      expect(await stat(fixture.mutations[0]!.temporary).then(
        () => true,
        () => false,
      )).toBe(false);
    } finally {
      server.stop();
    }
  });
});

async function journalFixture() {
  const gameDir = await mkdtemp(path.join(os.tmpdir(), "autogal-topology-journal-"));
  created.push(gameDir);
  const mapsDir = path.join(gameDir, "maps");
  await mkdir(mapsDir);
  const gateFile = path.join(mapsDir, "gate.yaml");
  const depthsFile = path.join(mapsDir, "depths.yaml");
  const mutations = [
    {
      id: "gate",
      absolute: gateFile,
      temporary: `${gateFile}.studio.topology.11111111-1111-4111-8111-111111111111.tmp`,
      original: "id: gate\nname: Gate\nchain: raid\nis_entry: true\nconnections:\n  - { dir: Depths, target: depths }\n",
      updated: "id: gate\nname: Gate\nchain: raid\nconnections:\n  - { dir: Depths, target: depths }\n",
    },
    {
      id: "depths",
      absolute: depthsFile,
      temporary: `${depthsFile}.studio.topology.22222222-2222-4222-8222-222222222222.tmp`,
      original: "id: depths\nname: Depths\nchain: raid\nconnections:\n  - { dir: Gate, target: gate }\n",
      updated: "id: depths\nname: Depths\nchain: raid\nis_entry: true\nconnections:\n  - { dir: Gate, target: gate }\n",
    },
  ];
  await Promise.all(mutations.map((mutation) =>
    writeFile(mutation.absolute, mutation.original)
  ));
  return { gameDir, gateFile, depthsFile, mutations };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("expected operation to reject");
  } catch (error) {
    return error;
  }
}
