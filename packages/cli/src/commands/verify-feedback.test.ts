import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState } from "@rpg-harness/engine";
import { loadGame } from "../loader";
import {
  listPlaytestReports,
  recordPlaytestReport,
  resolvePlaytestReport,
} from "../playtest-reports";
import { saveSession } from "../session";
import { currentQualityAuditInputRevision } from "./quality-certificate";
import { verifyFeedbackReport } from "./verify-feedback";
import { collectDevelopmentWorklist } from "./worklist";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("player feedback verification", () => {
  test("requires a changed project and a current quality certificate before closing", async () => {
    const gameDir = await temporaryFeedbackGame();
    const originalInputRevision = await currentQualityAuditInputRevision(gameDir);
    if (!originalInputRevision) throw new Error("fixture has no quality input revision");
    await saveSession(gameDir, "player", createInitialState(await loadGame(gameDir)));
    const report = await recordPlaytestReport({
      gameDir,
      session: "player",
      area: "tooling",
      severity: "minor",
      title: "Show proof",
      origin: {
        kind: "player-feedback",
        surface: "web",
        projectInputRevision: originalInputRevision,
      },
    });

    expect((await collectDevelopmentWorklist(gameDir)).items).toContainEqual(
      expect.objectContaining({
        key: `report/${report.id}`,
        actionability: "authoring",
        operation: {
          command: "edit",
          args: { target: "project", key: `report/${report.id}` },
        },
      }),
    );
    await expect(resolvePlaytestReport({
      gameDir,
      id: report.id,
      session: "player",
      resolution: "Trust me",
    })).rejects.toThrow(/verify-feedback/);
    expect(await verifyFeedbackReport({
      gameDir,
      reportId: report.id,
      sessionPrefix: "verify-unchanged",
      resolution: "Added proof",
    })).toMatchObject({
      status: "failed",
      reason: "project-unchanged",
      originalInputRevision,
      currentInputRevision: originalInputRevision,
    });
    expect((await listPlaytestReports(gameDir))[0]?.status).toBe("open");

    await writeFile(
      path.join(gameDir, "modules", "run.ts"),
      immediateEndingPreset("fixed project revision"),
      "utf-8",
    );
    expect((await collectDevelopmentWorklist(gameDir)).items).toContainEqual(
      expect.objectContaining({
        key: `report/${report.id}`,
        actionability: "executable",
        operation: {
          command: "verify-feedback",
          args: { reportId: report.id, sessionPrefix: "<new-session>" },
        },
      }),
    );
    const verified = await verifyFeedbackReport({
      gameDir,
      reportId: report.id,
      sessionPrefix: "verify-fixed",
      resolution: "Added project revision and quality certificate proof.",
    });
    expect(verified.currentInputRevision).not.toBe(originalInputRevision);
    if (!verified.currentInputRevision || !verified.certificateRevision) {
      throw new Error("verified result lost its project proof");
    }
    expect(verified.resolvedReport?.verification.fixedInputRevision)
      .toBe(verified.currentInputRevision);
    expect(verified.resolvedReport?.verification.certificateRevision)
      .toBe(verified.certificateRevision);
    expect(verified).toMatchObject({
      status: "verified",
      reportId: report.id,
      originalInputRevision,
      currentInputRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      certificateRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      worklistTotal: 0,
      resolvedReport: {
        status: "resolved",
        resolution: "Added project revision and quality certificate proof.",
        verification: {
          kind: "player-feedback",
          originalInputRevision,
          fixedInputRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
          certificateRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
          unrelatedWorkItems: 0,
        },
      },
    });
    expect((await collectDevelopmentWorklist(gameDir)).summary.total).toBe(0);
  });
});

async function temporaryFeedbackGame(): Promise<string> {
  const gameDir = await mkdtemp(path.join(tmpdir(), "rpgh-feedback-verify-"));
  temporaryDirectories.push(gameDir);
  await mkdir(path.join(gameDir, "modules"), { recursive: true });
  await writeFile(path.join(gameDir, "game.yaml"), [
    "title: Feedback verification test",
    "preset: ./modules/run.ts",
    "ai_audit:",
    "  personas: [objective]",
    "  seeds: [7]",
    "  min_unique_endings: 1",
    "",
  ].join("\n"), "utf-8");
  await writeFile(
    path.join(gameDir, "modules", "run.ts"),
    immediateEndingPreset("original project revision"),
    "utf-8",
  );
  return gameDir;
}

function immediateEndingPreset(marker: string): string {
  return [
    'import type { RunFunction } from "@rpg-harness/engine";',
    `// ${marker}`,
    "const run: RunFunction = async function* () {",
    '  yield { type: "gameEnd", reason: "done", endingId: "ending" };',
    "};",
    "export default run;",
    "",
  ].join("\n");
}
