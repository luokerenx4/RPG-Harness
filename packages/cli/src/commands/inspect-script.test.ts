import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectScript } from "./inspect-script";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

describe("read-only script inspection", () => {
  test("reports authored choices and points to state-dependent hooks", async () => {
    const gameDir = await temporaryInspectionGame();
    const inspection = await inspectScript({
      gameDir,
      scriptId: "scene",
      pretty: false,
    });

    expect(inspection.script.id).toBe("scene");
    expect(inspection.script.source).toBe("scripts/scene.md");
    expect(inspection.script.ai).toEqual({
      relatedActivityIds: ["prepare", "script:scene"],
    });
    expect(inspection.script.beats[1]).toMatchObject({
      index: 1,
      beat: {
        type: "choice",
        id: "reply",
        options: [
          { id: "stay", text: "Stay", aiTags: ["social"] },
          { id: "leave", text: "Leave", aiTags: ["independent"] },
        ],
      },
    });
    expect(inspection.hooks).toEqual({
      onBeatBefore: ["dynamic-prose"],
      note: expect.stringContaining("--session NAME"),
    });
    expect(inspection.session).toBeNull();
  });

  test("resolves hook replacements on an isolated session clone without creating files", async () => {
    const gameDir = await temporaryInspectionGame();
    const sessionRoot = path.join(gameDir, ".rpg-harness", "sessions");
    const inspection = await inspectScript({
      gameDir,
      scriptId: "scene",
      session: "missing-player",
      pretty: false,
    });

    expect(inspection.session).toMatchObject({
      name: "missing-player",
      completed: false,
      availability: { ok: true },
      evaluation: "isolated-read-only",
      transforms: [
        {
          beatIndex: 0,
          action: "replace",
          authored: { type: "narration", text: "Placeholder" },
          resolved: { type: "narration", text: "Warm runtime answer" },
        },
      ],
    });
    expect(await directoryEntriesOrEmpty(sessionRoot)).toEqual([]);
  });

  test("rejects unknown ids with the available script list", async () => {
    const gameDir = await temporaryInspectionGame();
    await expect(inspectScript({
      gameDir,
      scriptId: "missing",
      pretty: false,
    })).rejects.toThrow("Unknown script: missing. Available: scene");
  });
});

async function temporaryInspectionGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-inspect-script-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(
    path.join(dir, "game.yaml"),
    [
      "title: Inspect script test",
      "variables:",
      "  mood: { type: string, initial: warm }",
      "modules:",
      "  - ./dynamic-prose.ts",
      "",
    ].join("\n"),
    "utf-8",
  );
  await writeFile(
    path.join(dir, "scripts", "scene.md"),
    [
      "---",
      "id: scene",
      "title: Scene",
      "characters: []",
      "ai:",
      "  relatedActivityIds: [prepare, script:scene]",
      "---",
      "",
      "Placeholder",
      "",
      "? Reply. {id: reply}",
      "  - Stay {id: stay, ai: social}",
      "  - Leave {id: leave, ai: independent}",
      "",
      "[end]",
      "",
    ].join("\n"),
    "utf-8",
  );
  await writeFile(
    path.join(dir, "dynamic-prose.ts"),
    [
      "export default {",
      "  id: 'dynamic-prose',",
      "  onBeatBefore(ctx, scriptId, _beatIndex, beat) {",
      "    if (scriptId === 'scene' && beat.type === 'narration' && beat.text === 'Placeholder' && ctx.state.baseline.variables.mood === 'warm') {",
      "      return { replace: { ...beat, text: 'Warm runtime answer' } };",
      "    }",
      "  },",
      "};",
      "",
    ].join("\n"),
    "utf-8",
  );
  return dir;
}

async function directoryEntriesOrEmpty(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
