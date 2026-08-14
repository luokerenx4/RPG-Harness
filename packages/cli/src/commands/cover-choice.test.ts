import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadDevelopmentBranchHandoff, readSessionLog } from "./fork";
import { peek } from "@rpg-harness/engine";
import { loadGame } from "../loader";
import { loadSession } from "../session";
import { runAutoplay } from "./autoplay";
import { collectChoiceCoverage } from "./choice-coverage";
import { runChoiceCoverageWorkItem } from "./cover-choice";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

describe("coverage-driven autoplay", () => {
  test("forks the exact checkpoint and selects a pending option after authoring order changes", async () => {
    const gameDir = await temporaryChoiceGame();
    await seedFirstBranch(gameDir);
    await writeScript(gameDir, "beta", "target-first");

    const summary = await runChoiceCoverageWorkItem({
      gameDir,
      session: "cover-beta",
      playerSession: "premiere-beta",
      sourceSession: "seed-alpha",
      key: "intro/opening/beta",
      persona: "greedy",
      maxSteps: 20,
      verbose: false,
      pretty: false,
    });

    expect(summary.workItem).toMatchObject({
      key: "intro/opening/beta",
      optionId: "beta",
      evidence: {
        input: { type: "choose", choiceId: "opening", optionId: "beta" },
      },
    });
    expect(summary.fork).toMatchObject({
      fromSession: "seed-alpha",
      sourceLogEntry: 2,
    });
    expect(summary.targetChoice).toEqual({
      key: "intro/opening/beta",
      scriptId: "intro",
      choiceId: "opening",
      optionId: "beta",
      optionText: "Beta",
      status: "selected",
      index: 0,
    });
    // This tiny fixture ends with the target script, so terminal truth wins
    // over the local coverage boundary.
    expect(summary.reason).toBe("completed");
    expect(summary.targetScriptCompleted).toBe(true);
    expect(summary.responseTrace).toEqual([
      { type: "narration", text: "After the choice." },
      { type: "narration", text: "After the pacing prompt." },
    ]);
    expect(summary.playerHandoff).toEqual({
      session: "premiere-beta",
      webPath: "/?session=premiere-beta",
      sourceSession: "cover-beta",
      sourceLogEntry: 2,
    });
    const game = await loadGame(gameDir);
    const premiereState = await loadSession(gameDir, "premiere-beta", game);
    expect((await peek(game, premiereState)).output).toMatchObject({
      type: "narration",
      text: "After the choice.",
    });
    expect(await readSessionLog(gameDir, "premiere-beta")).toHaveLength(1);
    expect(summary.decisions).toBe(4);
    expect(summary.ending).toBe("intro");
    // The branch lineage intentionally excludes the source's later alpha
    // selection, so it still sees alpha as its sibling work item. Global
    // aggregation combines the two independent pieces of evidence.
    expect(summary.choiceCoverage?.summary.pendingOptions).toBe(1);
    expect((await collectChoiceCoverage(gameDir)).summary.pendingOptions).toBe(0);
    expect((await readSessionLog(gameDir, "cover-beta")).some((entry) =>
      (entry.decision as { optionId?: string } | undefined)?.optionId === "beta"
    )).toBe(true);
    expect(JSON.parse(await readFile(
      path.join(gameDir, ".rpg-harness", "sessions", "cover-beta", "fork.json"),
      "utf-8",
    ))).toMatchObject({
      handoff: {
        schemaVersion: 1,
        workKey: "choice-branch/intro/opening/beta",
        priority: "P3",
        kind: "choice-branch",
        title: "Explore authored choice: Beta",
        operation: "cover",
        state: "covered",
        coordinates: {
          scriptId: "intro",
          choiceId: "opening",
          optionId: "beta",
        },
      },
    });
    expect(JSON.parse(await readFile(
      path.join(gameDir, ".rpg-harness", "sessions", "premiere-beta", "fork.json"),
      "utf-8",
    ))).toMatchObject({
      fromSession: "cover-beta",
      sourceLogEntry: 2,
      handoff: {
        workKey: "choice-branch/intro/opening/beta",
        state: "covered",
        premiere: {
          prompt: "Pick one.",
          optionText: "Beta",
        },
      },
    });
    expect(await loadDevelopmentBranchHandoff(gameDir, "premiere-beta"))
      .toMatchObject({
        premiere: { prompt: "Pick one.", optionText: "Beta" },
      });
  });

  test("refuses a stale work item instead of selecting the same array index", async () => {
    const gameDir = await temporaryChoiceGame();
    await seedFirstBranch(gameDir);
    await writeScript(gameDir, "gamma");

    await expect(runChoiceCoverageWorkItem({
      gameDir,
      session: "cover-stale",
      sourceSession: "seed-alpha",
      key: "intro/opening/beta",
      persona: "greedy",
      maxSteps: 20,
      verbose: false,
      pretty: false,
    })).rejects.toThrow("Pending choice branch not found");

    expect((await readSessionLog(gameDir, "cover-stale")).some((entry) =>
      (entry.decision as { optionId?: string } | undefined)?.optionId !== undefined
    )).toBe(false);
  });

  test("executes a family-scoped branch whose witness exists only in a descendant", async () => {
    const gameDir = await temporaryChoiceGame();
    await seedFirstBranch(gameDir);
    const rootDir = path.join(gameDir, ".rpg-harness", "sessions", "family-root");
    await mkdir(rootDir, { recursive: true });
    await writeFile(path.join(rootDir, "log.jsonl"), "", "utf-8");
    await writeFile(
      path.join(gameDir, ".rpg-harness", "sessions", "seed-alpha", "fork.json"),
      JSON.stringify({
        schemaVersion: 1,
        fromSession: "family-root",
        sourceLogEntry: 0,
        mode: "checkpoint",
      }),
      "utf-8",
    );

    await expect(runChoiceCoverageWorkItem({
      gameDir,
      session: "family-proof-without-scope",
      sourceSession: "family-root",
      key: "intro/opening/beta",
      persona: "greedy",
      maxSteps: 20,
      verbose: false,
      pretty: false,
    })).rejects.toThrow("Pending choice branch not found");

    const summary = await runChoiceCoverageWorkItem({
      gameDir,
      session: "family-proof",
      playerSession: "family-premiere",
      sourceSession: "family-root",
      family: true,
      key: "intro/opening/beta",
      persona: "greedy",
      maxSteps: 20,
      verbose: false,
      pretty: false,
    });

    expect(summary.workItem.evidence.session).toBe("seed-alpha");
    expect(summary.fork).toMatchObject({
      fromSession: "seed-alpha",
      sourceLogEntry: 2,
    });
    expect(summary.targetChoice).toMatchObject({ optionId: "beta", status: "selected" });
    expect(summary.playerHandoff?.session).toBe("family-premiere");
  });

  test("preflights an occupied player premiere before publishing the proof branch", async () => {
    const gameDir = await temporaryChoiceGame();
    await seedFirstBranch(gameDir);
    await runAutoplay({
      gameDir,
      persona: "greedy",
      verbose: false,
      maxSteps: 20,
      session: "occupied-premiere",
    });

    await expect(runChoiceCoverageWorkItem({
      gameDir,
      session: "unwritten-proof",
      playerSession: "occupied-premiere",
      sourceSession: "seed-alpha",
      key: "intro/opening/beta",
      persona: "greedy",
      maxSteps: 20,
      verbose: false,
      pretty: false,
    })).rejects.toThrow("Target session already exists: occupied-premiere");

    expect(await readSessionLog(gameDir, "unwritten-proof")).toEqual([]);
  });

  test("keeps direct cover telemetry while returning JSON on stdout", async () => {
    const gameDir = await temporaryChoiceGame();
    await seedFirstBranch(gameDir);
    const child = Bun.spawn([
      process.execPath,
      path.resolve(import.meta.dir, "../bin.ts"),
      "cover",
      gameDir,
      "--session",
      "cover-cli",
      "--source-session",
      "seed-alpha",
      "--key",
      "intro/opening/beta",
      "--persona",
      "greedy",
      "--max-steps",
      "20",
    ], { stdout: "pipe", stderr: "pipe" });

    expect(await child.exited).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text())).toMatchObject({
      targetChoice: { optionId: "beta", status: "selected" },
    });
    const telemetry = await new Response(child.stderr).text();
    expect(telemetry).toContain("=== autoplay: Choice coverage test");
    expect(telemetry).toContain("=== done: completed");
  });
});

async function temporaryChoiceGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-cover-choice-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), "title: Choice coverage test\n", "utf-8");
  await writeScript(dir, "beta");
  return dir;
}

async function writeScript(
  gameDir: string,
  secondOptionId: string,
  order: "alpha-first" | "target-first" = "alpha-first",
): Promise<void> {
  const target = `- ${secondOptionId === "beta" ? "Beta" : "Gamma"} {id: ${secondOptionId}}`;
  const options = order === "target-first"
    ? [target, "- Alpha {id: alpha}"]
    : ["- Alpha {id: alpha}", target];
  await writeFile(
    path.join(gameDir, "scripts", "intro.md"),
    [
      "---",
      "id: intro",
      "title: Intro",
      "characters: []",
      "---",
      "",
      "Before the choice.",
      "",
      "? Pick one. {id: opening}",
      ...options,
      "",
      "After the choice.",
      "",
      "? Enter.",
      "- Continue",
      "",
      "After the pacing prompt.",
      "",
      "[end]",
      "",
    ].join("\n"),
    "utf-8",
  );
}

async function seedFirstBranch(gameDir: string): Promise<void> {
  const summary = await runAutoplay({
    gameDir,
    persona: "greedy",
    verbose: false,
    maxSteps: 20,
    session: "seed-alpha",
  });
  expect(summary.reason).toBe("completed");
  expect(summary.choiceCoverage?.summary.pendingOptions).toBe(1);
}
