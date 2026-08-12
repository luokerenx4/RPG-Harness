import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSessionLog } from "./fork";
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
    expect(summary.reason).toBe("completed");
    // The branch lineage intentionally excludes the source's later alpha
    // selection, so it still sees alpha as its sibling work item. Global
    // aggregation combines the two independent pieces of evidence.
    expect(summary.choiceCoverage?.summary.pendingOptions).toBe(1);
    expect((await collectChoiceCoverage(gameDir)).summary.pendingOptions).toBe(0);
    expect((await readSessionLog(gameDir, "cover-beta")).some((entry) =>
      (entry.decision as { optionId?: string } | undefined)?.optionId === "beta"
    )).toBe(true);
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
    })).rejects.toThrow("Choice coverage option is stale");

    expect((await readSessionLog(gameDir, "cover-stale")).some((entry) =>
      (entry.decision as { optionId?: string } | undefined)?.optionId !== undefined
    )).toBe(false);
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
