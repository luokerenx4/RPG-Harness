import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState } from "@rpg-harness/engine";
import { loadGame } from "../loader";
import { listPlaytestReports } from "../playtest-reports";
import { saveSession } from "../session";
import { sessionDir } from "../session";
import { runAudit } from "./audit";
import { runDevelopmentWorkItem } from "./work";
import { collectDevelopmentWorklist } from "./worklist";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true })
  ));
});

describe("AI audit issue verification", () => {
  test("keeps a failed recheck open with replayable lanes", async () => {
    const { gameDir, reportId } = await createAuditIssue(4);

    const result = await runDevelopmentWorkItem({
      gameDir,
      key: `report/${reportId}`,
      newSession: "verify-still-bad",
      pretty: false,
    });

    expect(result).toMatchObject({
      status: "failed",
      operation: {
        command: "verify-audit",
        args: { reportId, sessionPrefix: "<new-session>" },
      },
      safety: {
        mode: "isolated-session",
        writes: true,
        targetSession: "verify-still-bad",
      },
      result: {
        status: "failed",
        reportId,
        sourceSession: "verify-still-bad-source",
        sourceRevisionMatches: true,
        qualityGate: {
          status: "failed",
          violations: ["unique decision paths 3 < required 4"],
        },
        lanes: expect.arrayContaining([
          expect.objectContaining({
            persona: "charmer",
            session: "verify-still-bad-charmer",
            webPath: "/?session=verify-still-bad-charmer",
          }),
        ]),
      },
    });
    expect((await listPlaytestReports(gameDir))).toHaveLength(1);
    expect((await listPlaytestReports(gameDir))[0]?.status).toBe("open");
    expect((await collectDevelopmentWorklist(gameDir)).items)
      .toContainEqual(expect.objectContaining({ key: `report/${reportId}` }));
  });

  test("does not resolve an old finding by lowering the live quality gate", async () => {
    const { gameDir, reportId } = await createAuditIssue(4);
    await writeManifest(gameDir, 3);

    const result = await runDevelopmentWorkItem({
      gameDir,
      key: `report/${reportId}`,
      newSession: "verify-lowered",
      pretty: false,
    });

    expect(result).toMatchObject({
      status: "failed",
      result: {
        status: "failed",
        reportId,
        sourceSession: "verify-lowered-source",
        sourceRevisionMatches: true,
        qualityGate: {
          status: "failed",
          policy: { minUniqueDecisionPaths: 4 },
          observed: { uniqueEndings: 1, uniqueDecisionPaths: 3 },
          violations: ["unique decision paths 3 < required 4"],
        },
      },
    });
    expect((await listPlaytestReports(gameDir))[0]?.status).toBe("open");
  });

  test("reruns from immutable evidence and resolves after a real route fix", async () => {
    const { gameDir, reportId } = await createAuditIssue(4);
    await writeDiverseIntro(gameDir);

    const result = await runDevelopmentWorkItem({
      gameDir,
      key: `report/${reportId}`,
      newSession: "verify-fixed",
      pretty: false,
    });

    expect(result).toMatchObject({
      status: "executed",
      result: {
        status: "verified",
        reportId,
        sourceSession: "verify-fixed-source",
        sourceRevisionMatches: true,
        qualityGate: {
          status: "passed",
          policy: { minUniqueDecisionPaths: 4 },
          observed: { uniqueEndings: 1, uniqueDecisionPaths: 4 },
        },
        resolvedReport: {
          id: reportId,
          status: "resolved",
          resolution: expect.stringContaining("4 semantic decision paths"),
          verification: {
            kind: "ai-audit",
            sessionPrefix: "verify-fixed",
            policy: { minUniqueDecisionPaths: 4 },
            observed: { uniqueEndings: 1, uniqueDecisionPaths: 4 },
            lanes: expect.arrayContaining([
              expect.objectContaining({
                persona: "objective",
                ending: "intro",
                pathRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
              }),
            ]),
          },
        },
      },
    });
    const [resolved] = await listPlaytestReports(gameDir);
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.verification).toMatchObject({ kind: "ai-audit" });
    expect((await collectDevelopmentWorklist(gameDir)).items)
      .not.toContainEqual(expect.objectContaining({ key: `report/${reportId}` }));
  });

  test("preflights every verification lane before reproducing the source", async () => {
    const { gameDir, reportId } = await createAuditIssue(4);
    const game = await loadGame(gameDir);
    await saveSession(gameDir, "verify-collision-rude", createInitialState(game));

    await expect(runDevelopmentWorkItem({
      gameDir,
      key: `report/${reportId}`,
      newSession: "verify-collision",
      pretty: false,
    })).rejects.toThrow("Target session already exists: verify-collision-rude");
    await expect(readFile(path.join(
      sessionDir(gameDir, "verify-collision-source"),
      "state.json",
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createAuditIssue(minPaths: number): Promise<{
  gameDir: string;
  reportId: string;
}> {
  const gameDir = await mkdtemp(path.join(tmpdir(), "rpgh-verify-audit-"));
  temporaryDirectories.push(gameDir);
  await mkdir(path.join(gameDir, "scripts"), { recursive: true });
  await writeManifest(gameDir, minPaths);
  await writeCollapsedIntro(gameDir);
  const game = await loadGame(gameDir);
  await saveSession(gameDir, "player", createInitialState(game));
  const audit = await runAudit({
    gameDir,
    fromSession: "player",
    sessionPrefix: "original-failure",
    personas: ["objective", "greedy", "charmer", "rude"],
    maxSteps: 10,
    reportOnStop: false,
    pretty: false,
  });
  const reportId = audit.qualityGate?.report?.id;
  if (!reportId) throw new Error("fixture did not create audit issue");
  return { gameDir, reportId };
}

async function writeCollapsedIntro(gameDir: string): Promise<void> {
  await writeFile(path.join(gameDir, "scripts", "intro.md"), [
    "---",
    "id: intro",
    "title: Intro",
    "characters: []",
    "---",
    "",
    "? Pick a route. {id: route}",
    "- First {id: first, ai: neutral}",
    "- Second {id: second, ai: defiant}",
    "- Third {id: third, ai: social}",
    "",
    "[end]",
    "",
  ].join("\n"), "utf-8");
}

async function writeDiverseIntro(gameDir: string): Promise<void> {
  await writeFile(path.join(gameDir, "scripts", "intro.md"), [
    "---",
    "id: intro",
    "title: Intro",
    "characters: []",
    "---",
    "",
    "```yaml",
    "type: choice",
    "id: route",
    "options:",
    "  - { id: first, text: First, ai_tags: [neutral] }",
    "  - { id: second, text: Second, ai_tags: [defiant] }",
    "  - { id: third, text: Third, ai_tags: [social] }",
    "  - { id: fourth, text: Fourth, aiPriority: 10 }",
    "```",
    "",
    "[end]",
    "",
  ].join("\n"), "utf-8");
}

async function writeManifest(gameDir: string, minPaths: number): Promise<void> {
  await writeFile(path.join(gameDir, "game.yaml"), [
    "title: Audit verification test",
    "ai_audit:",
    `  min_unique_decision_paths: ${minPaths}`,
  ].join("\n") + "\n", "utf-8");
}
