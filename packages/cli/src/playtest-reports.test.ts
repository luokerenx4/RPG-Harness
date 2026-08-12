import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  formatPlaytestReports,
  listPlaytestReports,
  recordPlaytestReport,
} from "./playtest-reports";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

describe("playtest reports", () => {
  test("records a coding issue with compact evidence from the latest step", async () => {
    const gameDir = await temporaryGame();
    const session = "ai-kagari";
    const dir = path.join(gameDir, ".rpg-harness", "sessions", session);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "state.json"),
      JSON.stringify({
        baseline: {
          currentScriptId: "bond_kagari_04",
          completionOrder: ["000_intro", "bond_kagari_01"],
        },
      }),
    );
    await writeFile(
      path.join(dir, "log.jsonl"),
      [
        JSON.stringify({
          input: { type: "next" },
          output: { type: "narration", text: "first" },
        }),
        JSON.stringify({
          input: { type: "next" },
          output: {
            type: "dialogue",
            speakerId: "kagari",
            speakerName: "篝",
            text: "お主、あたしに訊いたな。",
            visualState: { bg: "a-heavy-field-we-do-not-copy" },
          },
        }),
      ].join("\n") + "\n",
    );

    const report = await recordPlaytestReport({
      gameDir,
      session,
      area: "narrative",
      severity: "major",
      title: "Silent choice is remembered as spoken dialogue",
      details: "bond_kagari_04 contradicts the earlier choice.",
      target: "scripts/bond_kagari_04.md",
    });

    expect(report.id).toMatch(/^pt-\d{14}-[a-f0-9]{8}$/);
    expect(report.evidence.currentScriptId).toBe("bond_kagari_04");
    expect(report.evidence.lastCompletedScriptId).toBe("bond_kagari_01");
    expect(report.evidence.logEntry).toBe(2);
    expect(report.evidence.lastEvent).toEqual({
      input: { type: "next" },
      output: {
        type: "dialogue",
        speakerId: "kagari",
        speakerName: "篝",
        text: "お主、あたしに訊いたな。",
      },
    });

    const stored = await listPlaytestReports(gameDir, session);
    expect(stored).toEqual([report]);
    const raw = await readFile(path.join(dir, "issues.jsonl"), "utf-8");
    expect(raw.trim().split("\n")).toHaveLength(1);
  });

  test("can report a broken session even when state and log JSON are invalid", async () => {
    const gameDir = await temporaryGame();
    const session = "broken-engine";
    const dir = path.join(gameDir, ".rpg-harness", "sessions", session);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "state.json"), "{ definitely broken");
    await writeFile(path.join(dir, "log.jsonl"), "not json\n");

    const report = await recordPlaytestReport({
      gameDir,
      session,
      area: "engine",
      severity: "blocker",
      title: "Session cannot be resumed",
    });

    expect(report.evidence.currentScriptId).toBeNull();
    expect(report.evidence.lastEvent).toBeNull();
    expect(report.evidence.captureErrors).toHaveLength(2);
  });

  test("lists reports across sessions and formats a compact human view", async () => {
    const gameDir = await temporaryGame();
    await recordPlaytestReport({
      gameDir,
      session: "one",
      area: "ui",
      severity: "minor",
      title: "Choice text wraps awkwardly",
    });
    await recordPlaytestReport({
      gameDir,
      session: "two",
      area: "gameplay",
      severity: "note",
      title: "Raid pacing feels slow",
    });

    const reports = await listPlaytestReports(gameDir);
    expect(reports).toHaveLength(2);
    const table = formatPlaytestReports(reports);
    expect(table).toContain("SEVERITY");
    expect(table).toContain("Choice text wraps awkwardly");
    expect(table).toContain("Raid pacing feels slow");
  });
});

async function temporaryGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-playtest-report-"));
  temporaryDirectories.push(dir);
  return dir;
}
