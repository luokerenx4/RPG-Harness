import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssetSpec } from "@rpg-harness/engine";
import { projectAssetPreview, scanProjectArtifacts } from "./handlers";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Studio project artifacts", () => {
  test("projects lightweight asset previews without exposing filesystem paths", () => {
    expect(projectAssetPreview({
      path: "assets/portraits/kagari",
      kind: "portrait",
      description: "Kagari portrait",
      prompt: "portrait",
      placeholder: "[篝] 朱柄の槍",
      renderings: {
        source: "/private/source.png",
        sourceQuality: "/private/source.quality.png",
        tuiAns: "/private/tui.ans",
      },
    } as AssetSpec)).toEqual({
      path: "assets/portraits/kagari",
      kind: "portrait",
      placeholder: "[篝] 朱柄の槍",
      renderings: {
        source: true,
        sourceQuality: true,
        sourceCompressed: false,
        tuiTxt: false,
        tuiAns: true,
        web: false,
      },
    });
  });

  test("projects directional sprite metadata for map authoring surfaces", () => {
    const spriteGrid = {
      columns: 3,
      rows: 4,
      defaultFacing: "south" as const,
      frames: { north: 10, east: 7, south: 1, west: 4 },
    };
    expect(projectAssetPreview({
      path: "assets/sprites/kagari-field",
      kind: "sprite",
      description: "Kagari field sprite",
      prompt: "sprite atlas",
      placeholder: "Kagari map sprite",
      spriteGrid,
      renderings: { source: "/private/sprite.png" },
    } as AssetSpec)).toEqual({
      path: "assets/sprites/kagari-field",
      kind: "sprite",
      placeholder: "Kagari map sprite",
      spriteGrid,
      renderings: {
        source: true,
        sourceQuality: false,
        sourceCompressed: false,
        tuiTxt: false,
        tuiAns: false,
        web: false,
      },
    });
  });

  test("indexes tests and session-scoped issues with stable resource refs", async () => {
    const gameDir = await mkdtemp(path.join(os.tmpdir(), "autogal-artifacts-"));
    created.push(gameDir);
    await mkdir(path.join(gameDir, "tests"));
    await writeFile(path.join(gameDir, "tests", "opening.yaml"), "name: opening\n");
    await writeFile(path.join(gameDir, "tests", "notes.txt"), "ignored\n");
    const sessionDir = path.join(gameDir, ".rpg-harness", "sessions", "ai-qa");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(path.join(sessionDir, "issues.jsonl"), [
      JSON.stringify({
        id: "pt-1",
        status: "open",
        title: "Opening stalls",
        target: "scripts/opening.md",
        evidence: {
          currentScriptId: "opening",
          sourceTargets: [{ moduleId: "raid" }, { scriptId: "fallback" }],
        },
      }),
      "{broken",
      "",
    ].join("\n"));

    expect(await scanProjectArtifacts(gameDir)).toEqual([
      {
        kind: "test",
        id: "opening",
        key: "test:opening",
        label: "opening",
        source: "tests/opening.yaml",
        editable: false,
        refs: [],
      },
      {
        kind: "issue",
        id: "ai-qa/pt-1",
        key: "issue:ai-qa/pt-1",
        label: "[open] Opening stalls",
        editable: false,
        refs: ["module:raid", "script:fallback", "script:opening"],
      },
      {
        kind: "issue",
        id: "ai-qa/invalid-line-2",
        key: "issue:ai-qa/invalid-line-2",
        label: "[invalid] ai-qa/issues.jsonl line 2",
        editable: false,
        refs: [],
      },
    ]);
  });
});
