import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState, scriptRevision } from "@rpg-harness/engine";
import { storeCheckpointState } from "@rpg-harness/session-store";
import { loadGame } from "../loader";
import { sessionDir } from "../session";
import {
  createCoverageCertificate,
  readCoverageCertificate,
  verifyCoverageCertificate,
} from "./coverage-certificate";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("coverage certificate", () => {
  test("freezes current family evidence and invalidates it after a content edit", async () => {
    const gameDir = await mkdtemp(path.join(tmpdir(), "rpgh-certificate-"));
    temporaryDirectories.push(gameDir);
    await mkdir(path.join(gameDir, "scripts"), { recursive: true });
    await writeFile(path.join(gameDir, "game.yaml"), "title: Certificate test\n");
    const scriptFile = path.join(gameDir, "scripts", "scene.md");
    await writeFile(scriptFile, scriptSource("After the choice."));

    const game = await loadGame(gameDir);
    const revision = scriptRevision(game.scripts[0]!);
    const state = createInitialState(game);
    state.baseline.scripts.scene = {
      completed: true,
      completedRevision: revision,
      selfSwitches: { A: false, B: false, C: false, D: false },
    };
    state.baseline.completionOrder.push("scene");
    const checkpoint = await storeCheckpointState(gameDir, state);
    const output = {
      type: "choice",
      scriptId: "scene",
      scriptRevision: revision,
      choiceId: "route",
      prompt: "Route?",
      options: [
        { id: "a", text: "Alpha", available: true },
        { id: "b", text: "Beta", available: true },
      ],
    };
    await writeSession(gameDir, "player", state, [
      {
        decision: {
          scriptId: "scene",
          scriptRevision: "0".repeat(64),
          choiceId: "route",
          optionId: "a",
        },
        output: { type: "scriptComplete", scriptId: "scene" },
        checkpoint,
      },
      { output, checkpoint },
      {
        decision: {
          scriptId: "scene",
          scriptRevision: revision,
          choiceId: "route",
          optionId: "a",
        },
        output: { type: "scriptComplete", scriptId: "scene" },
        checkpoint,
      },
    ]);
    await writeSession(gameDir, "branch", state, [
      { output, checkpoint },
      {
        decision: {
          scriptId: "scene",
          scriptRevision: revision,
          choiceId: "route",
          optionId: "b",
        },
        output: { type: "scriptComplete", scriptId: "scene" },
        checkpoint,
      },
    ]);
    await writeFile(
      path.join(sessionDir(gameDir, "branch"), "fork.json"),
      JSON.stringify({ fromSession: "player", sourceLogEntry: 0 }),
    );

    const created = await createCoverageCertificate({
      gameDir,
      session: "player",
      family: true,
    });
    const certificate = await readCoverageCertificate(created.file);
    expect(await verifyCoverageCertificate(gameDir, certificate)).toMatchObject({
      valid: true,
      issues: [],
      summary: {
        storyFacts: 1,
        requiredScripts: 1,
        choiceFacts: 2,
        requiredOptions: 2,
        checkpointObjects: 1,
      },
    });

    await rm(path.join(gameDir, ".rpg-harness", "sessions"), {
      recursive: true,
      force: true,
    });
    expect((await verifyCoverageCertificate(gameDir, certificate)).valid).toBe(true);

    await writeFile(scriptFile, scriptSource("Edited after the choice."));
    const stale = await verifyCoverageCertificate(gameDir, certificate);
    expect(stale.valid).toBe(false);
    expect(stale.issues).toContain("stale story fact: scene");
    expect(stale.issues).toContain("stale choice fact: scene/route/a");
    expect(stale.issues).toContain("stale choice fact: scene/route/b");
  });

  test("detects certificate tampering before trusting its facts", async () => {
    const gameDir = await mkdtemp(path.join(tmpdir(), "rpgh-certificate-"));
    temporaryDirectories.push(gameDir);
    await mkdir(path.join(gameDir, "scripts"), { recursive: true });
    await writeFile(path.join(gameDir, "game.yaml"), "title: Empty certificate\n");
    await writeFile(path.join(gameDir, "scripts", "router.md"), [
      "---",
      "id: router",
      "title: Router",
      "characters: []",
      "coverage:",
      "  ignore: true",
      "  reason: routing placeholder",
      "---",
      "",
      "[end]",
      "",
    ].join("\n"));
    const state = createInitialState(await loadGame(gameDir));
    await writeSession(gameDir, "player", state, []);
    const { certificate } = await createCoverageCertificate({
      gameDir,
      session: "player",
    });
    certificate.game.title = "Tampered";
    const verification = await verifyCoverageCertificate(gameDir, certificate);
    expect(verification.valid).toBe(false);
    expect(verification.issues.some((issue) =>
      issue.startsWith("certificate revision mismatch:"),
    )).toBe(true);
    expect(verification.issues).toContain(
      "game title mismatch: expected \"Empty certificate\"",
    );
  });
});

async function writeSession(
  gameDir: string,
  session: string,
  state: unknown,
  entries: unknown[],
): Promise<void> {
  const directory = sessionDir(gameDir, session);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "state.json"), JSON.stringify(state));
  await writeFile(
    path.join(directory, "log.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""),
  );
}

function scriptSource(afterChoice: string): string {
  return [
    "---",
    "id: scene",
    "title: Scene",
    "characters: []",
    "---",
    "",
    "? Route? {id: route}",
    "- Alpha {id: a, ai: neutral}",
    "- Beta {id: b, ai: neutral}",
    "",
    afterChoice,
    "",
    "[end]",
    "",
  ].join("\n");
}
