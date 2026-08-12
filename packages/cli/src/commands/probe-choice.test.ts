import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState, peek, step } from "@rpg-harness/engine";
import { loadGame } from "../loader";
import { appendLog, sessionDir } from "../session";
import { runChoiceProbe } from "./probe-choice";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

describe("read-only choice policy probe", () => {
  test("re-evaluates live tags from an immutable checkpoint and leaves the session unchanged", async () => {
    const gameDir = await temporaryChoiceGame();
    const game = await loadGame(gameDir);
    const state = createInitialState(game);
    const waiting = await peek(game, state);
    expect(waiting.output?.type).toBe("scriptComplete");
    const presented = await step(game, waiting.state, {
      type: "select",
      scriptId: "intro",
    });
    expect(presented.output?.type).toBe("choice");
    await appendLog(
      gameDir,
      "player",
      { input: { type: "select", scriptId: "intro" }, output: presented.output },
      presented.state,
    );
    await writeChoiceScript(gameDir, true);
    const before = await snapshotTree(sessionDir(gameDir, "player"));

    const summary = await runChoiceProbe({
      gameDir,
      session: "player",
      at: 1,
      personas: ["objective", "greedy", "charmer", "rude", "hunter"],
      pretty: false,
    });

    expect(summary.choice).toMatchObject({
      key: "intro/opening",
      options: [
        { id: "wait", aiTags: ["independent"] },
        { id: "help", aiTags: ["social", "compassionate"] },
        { id: "refuse", aiTags: ["defiant"] },
      ],
    });
    expect(summary.decisions.map(({ persona, optionId, reason }) => ({
      persona,
      optionId,
      kind: reason.kind,
    }))).toEqual([
      { persona: "objective", optionId: "wait", kind: "ai-priority" },
      { persona: "greedy", optionId: "wait", kind: "positional-fallback" },
      { persona: "charmer", optionId: "help", kind: "semantic-tags" },
      { persona: "rude", optionId: "refuse", kind: "semantic-tags" },
      { persona: "hunter", optionId: "wait", kind: "positional-fallback" },
    ]);
    expect(summary.source.checkpointRevision).not.toBeNull();
    expect(summary.source.stateRevision).toBe(summary.source.checkpointRevision!);
    expect(summary.source.evaluatedStateRevision).not.toBe(summary.source.stateRevision);
    expect(summary.decisions[0]?.reason).toEqual({
      kind: "ai-priority",
      priority: 0,
      explicit: false,
      tiedAvailableOptions: 3,
      tieBreak: "first",
    });
    expect(await snapshotTree(sessionDir(gameDir, "player"))).toEqual(before);
  });

  test("rejects random because sampling is not authoring evidence", async () => {
    const gameDir = await temporaryChoiceGame();
    await expect(runChoiceProbe({
      gameDir,
      session: "player",
      at: 0,
      personas: ["random"],
      pretty: false,
    })).rejects.toThrow("must be deterministic");
  });

  test("executes a project-registered persona against historical choice state", async () => {
    const gameDir = await temporaryChoiceGame();
    await registerProjectPersona(gameDir);
    const game = await loadGame(gameDir);
    const waiting = await peek(game, createInitialState(game));
    const presented = await step(game, waiting.state, {
      type: "select",
      scriptId: "intro",
    });
    await appendLog(
      gameDir,
      "player",
      { input: { type: "select", scriptId: "intro" }, output: presented.output },
      presented.state,
    );

    const summary = await runChoiceProbe({
      gameDir,
      session: "player",
      at: 1,
      personas: ["project-scout"],
      pretty: false,
    });

    expect(summary.decisions[0]).toMatchObject({
      persona: "project-scout",
      optionId: "help",
      reason: {
        kind: "registered-persona",
        source: "module:probe-project",
      },
    });
  });

  test("rejects a checkpoint whose live output is not a choice", async () => {
    const gameDir = await temporaryChoiceGame();
    await expect(runChoiceProbe({
      gameDir,
      session: "player",
      at: 0,
      personas: ["objective"],
      pretty: false,
    })).rejects.toThrow("is scriptComplete, not a choice");
  });

  test("rejects an acceptance persona that no built-in or module registers", async () => {
    const gameDir = await temporaryChoiceGame();
    await writeFile(
      path.join(gameDir, "game.yaml"),
      "title: Probe choice test\nai_audit:\n  personas: [missing-policy]\n  min_unique_decision_paths: 1\n",
      "utf-8",
    );
    await expect(loadGame(gameDir)).rejects.toThrow(
      "ai_audit.personas references unknown persona missing-policy",
    );
  });
});

async function temporaryChoiceGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-probe-choice-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), "title: Probe choice test\n", "utf-8");
  await writeChoiceScript(dir, false);
  return dir;
}

async function writeChoiceScript(gameDir: string, tagged: boolean): Promise<void> {
  await writeFile(
    path.join(gameDir, "scripts", "intro.md"),
    [
      "---",
      "id: intro",
      "title: Intro",
      "characters: []",
      "---",
      "",
      "? Pick one. {id: opening}",
      tagged ? "  - Wait {id: wait, ai: independent}" : "  - Wait {id: wait}",
      tagged ? "  - Help {id: help, ai: social compassionate}" : "  - Help {id: help}",
      tagged ? "  - Refuse {id: refuse, ai: defiant}" : "  - Refuse {id: refuse}",
      "",
      "[end]",
      "",
    ].join("\n"),
    "utf-8",
  );
}

async function registerProjectPersona(gameDir: string): Promise<void> {
  await mkdir(path.join(gameDir, "modules"), { recursive: true });
  await writeFile(
    path.join(gameDir, "game.yaml"),
    "title: Probe choice test\nmodules:\n  - ./modules/persona.ts\nai_audit:\n  personas: [project-scout]\n  min_unique_decision_paths: 1\n",
    "utf-8",
  );
  await writeFile(
    path.join(gameDir, "modules", "persona.ts"),
    [
      "export default {",
      "  id: 'probe-project',",
      "  aiPersonas: {",
      "    'project-scout': {",
      "      description: 'Choose help',",
      "      decide: async (output) => {",
      "        if (output.type !== 'choice') return { type: 'next' };",
      "        return { type: 'choose', choiceId: output.choiceId, optionId: 'help' };",
      "      },",
      "    },",
      "  },",
      "};",
      "",
    ].join("\n"),
    "utf-8",
  );
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function visit(dir: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) await visit(absolute);
      else snapshot[relative] = await readFile(absolute, "utf-8");
    }
  }
  await visit(root);
  return snapshot;
}
