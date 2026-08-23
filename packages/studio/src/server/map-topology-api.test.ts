import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handle } from "./handlers";
import { resolveMapSourceFile } from "./map-source";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Studio map topology API", () => {
  test("previews without writing, then atomically transfers the authoritative entry", async () => {
    const fixture = await topologyApiFixture();
    const gateBefore = await readFile(fixture.gateFile, "utf-8");
    const depthsBefore = await readFile(fixture.depthsFile, "utf-8");
    const body = transferBody();

    const preview = await topologyRequest(fixture.gameDir, "depths", "POST", body, true);
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expect(previewBody.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(previewBody).toMatchObject({
      changedIds: ["depths", "gate"],
      assignments: [
        { id: "gate", chain: "raid", isEntry: false },
        { id: "depths", chain: "raid", isEntry: true },
      ],
    });
    body.expected.revision = previewBody.revision;
    expect(await readFile(fixture.gateFile, "utf-8")).toBe(gateBefore);
    expect(await readFile(fixture.depthsFile, "utf-8")).toBe(depthsBefore);

    const committed = await topologyRequest(fixture.gameDir, "depths", "PATCH", body);
    expect(committed.status).toBe(200);
    const response = await committed.json();
    expect(response.changedIds).toEqual(["depths", "gate"]);
    expect(response.project.maps.find((map: { id: string }) => map.id === "gate")?.isEntry).toBeUndefined();
    expect(response.project.maps.find((map: { id: string }) => map.id === "depths")?.isEntry).toBe(true);
    expect(await readFile(fixture.gateFile, "utf-8")).toContain("# gate comment");
    expect(await readFile(fixture.gateFile, "utf-8")).not.toContain("is_entry:");
    expect(await readFile(fixture.depthsFile, "utf-8")).toContain("is_entry: true");
  });

  test("returns 409 for a stale expected snapshot and writes nothing", async () => {
    const fixture = await topologyApiFixture();
    const gateBefore = await readFile(fixture.gateFile, "utf-8");
    const depthsBefore = await readFile(fixture.depthsFile, "utf-8");
    const stale = transferBody();
    const preview = await topologyRequest(fixture.gameDir, "depths", "POST", stale, true);
    stale.expected.revision = (await preview.json()).revision;
    stale.expected.destinationEntryId = "depths";

    const response = await topologyRequest(fixture.gameDir, "depths", "PATCH", stale);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain("changed since this dialog opened");
    expect(body.code).toBe("stale_map_topology");
    expect(await readFile(fixture.gateFile, "utf-8")).toBe(gateBefore);
    expect(await readFile(fixture.depthsFile, "utf-8")).toBe(depthsBefore);
  });

  test("rejects unknown fields and empty chains while preserving exact whitespace chains", async () => {
    const fixture = await topologyApiFixture();
    const malformed = await topologyRequest(fixture.gameDir, "town", "POST", {
      ...standaloneBody("new"),
      surprise: true,
    }, true);
    expect(malformed.status).toBe(400);

    const empty = await topologyRequest(
      fixture.gameDir,
      "town",
      "POST",
      standaloneBody(""),
      true,
    );
    expect(empty.status).toBe(400);

    const whitespace = await topologyRequest(
      fixture.gameDir,
      "town",
      "POST",
      standaloneBody("   "),
      true,
    );
    expect(whitespace.status).toBe(200);
    expect((await whitespace.json()).assignments).toEqual([
      { id: "town", chain: "   ", isEntry: true },
    ]);
  });

  test("treats yaml and yml canonical candidates as an ambiguous source", async () => {
    const fixture = await topologyApiFixture();
    await writeFile(path.join(fixture.gameDir, "maps", "town.yml"), "id: town\nname: Duplicate town\n");
    expect(await resolveMapSourceFile(fixture.gameDir, "town")).toBeUndefined();
    const response = await topologyRequest(fixture.gameDir, "town", "POST", standaloneBody("new"), true);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("ambiguous");
  });

  test("requires commit to use the complete topology revision returned by preview", async () => {
    const fixture = await topologyApiFixture();
    const body = transferBody();
    const preview = await topologyRequest(fixture.gameDir, "depths", "POST", body, true);
    body.expected.revision = (await preview.json()).revision;
    await writeFile(path.join(fixture.gameDir, "maps", "newcomer.yaml"), "id: newcomer\nname: Newcomer\n");

    const response = await topologyRequest(fixture.gameDir, "depths", "PATCH", body);
    expect(response.status).toBe(409);
    const result = await response.json();
    expect(result.code).toBe("stale_map_topology");
    expect(result.error).toContain("changed since this dialog opened");
  });

  test("does not claim a preview is committable when canonical source identity is missing", async () => {
    const fixture = await topologyApiFixture();
    await writeFile(path.join(fixture.gameDir, "maps", "alias.yaml"), "id: orphan\nname: Orphan\n");
    const response = await topologyRequest(fixture.gameDir, "orphan", "POST", standaloneBody("new"), true);
    expect(response.status).toBe(404);
    expect((await response.json()).error).toContain("source file not found");
  });

  test("reports a structurally unreachable topology as validation, not server I/O", async () => {
    const fixture = await topologyApiFixture();
    await writeFile(fixture.depthsFile, [
      "id: depths",
      "name: Depths",
      "chain: raid",
      "",
    ].join("\n"));

    const response = await topologyRequest(fixture.gameDir, "depths", "POST", transferBody(), true);
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.code).toBe("invalid_map_topology");
    expect(body.error).toMatch(/unreachable/);
  });

  test("returns an error without committing when the authoritative Studio projection is invalid", async () => {
    const fixture = await topologyApiFixture();
    const duplicateScript = [
      "---",
      "id: duplicate",
      "title: Duplicate",
      "---",
      "",
      "A duplicate resource.",
      "",
    ].join("\n");
    await writeFile(path.join(fixture.gameDir, "scripts", "one.md"), duplicateScript);
    await writeFile(path.join(fixture.gameDir, "scripts", "two.md"), duplicateScript);
    const body = transferBody();
    const preview = await topologyRequest(fixture.gameDir, "depths", "POST", body, true);
    expect(preview.status).toBe(200);
    body.expected.revision = (await preview.json()).revision;
    const gateBefore = await readFile(fixture.gateFile, "utf-8");
    const depthsBefore = await readFile(fixture.depthsFile, "utf-8");

    const response = await topologyRequest(fixture.gameDir, "depths", "PATCH", body);
    expect(response.status).toBe(500);
    expect((await response.json()).code).toBe("map_topology_unavailable");
    expect(await readFile(fixture.gateFile, "utf-8")).toBe(gateBefore);
    expect(await readFile(fixture.depthsFile, "utf-8")).toBe(depthsBefore);
  });
});

function transferBody() {
  return {
    expected: {
      chain: "raid" as string | null,
      isEntry: false,
      sourceEntryId: "gate" as string | null,
      destinationEntryId: "gate" as string | null,
      revision: undefined as string | undefined,
    },
    destination: {
      chain: "raid" as string | null,
      entry: "make-selected" as const,
    },
  };
}

function standaloneBody(chain: string) {
  return {
    expected: {
      chain: null,
      isEntry: false,
      sourceEntryId: null,
      destinationEntryId: null,
    },
    destination: {
      chain,
      entry: "make-selected",
    },
  };
}

function topologyRequest(
  gameDir: string,
  mapId: string,
  method: "POST" | "PATCH",
  body: unknown,
  preview = false,
) {
  return handle(new Request(
    `http://studio.test/api/maps/${encodeURIComponent(mapId)}/topology${preview ? "/preview" : ""}`,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ), { gameDir });
}

async function topologyApiFixture() {
  const gameDir = await mkdtemp(path.join(os.tmpdir(), "autogal-topology-api-"));
  created.push(gameDir);
  await mkdir(path.join(gameDir, "maps"));
  await mkdir(path.join(gameDir, "scripts"));
  await writeFile(path.join(gameDir, "game.yaml"), "title: Topology API\n");
  const gateFile = path.join(gameDir, "maps", "gate.yaml");
  const depthsFile = path.join(gameDir, "maps", "depths.yaml");
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
  await writeFile(path.join(gameDir, "maps", "town.yaml"), "id: town\nname: Town\n");
  return { gameDir, gateFile, depthsFile };
}
