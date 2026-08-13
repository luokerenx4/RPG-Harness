import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  formatPlaytestReports,
  listPlaytestReports,
  recordPlaytestReport,
  reproducePlaytestReport,
  resolvePlaytestReport,
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
          visuals: {
            bg: "assets/backgrounds/inn-veranda-night",
            portraits: {
              left: "assets/portraits/kagari-default",
              right: null,
            },
            cg: "assets/cgs/bond-kagari-03",
          },
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
    expect(report.evidence.visualState).toEqual({
      bg: "assets/backgrounds/inn-veranda-night",
      portraits: {
        left: "assets/portraits/kagari-default",
        right: null,
      },
      cg: "assets/cgs/bond-kagari-03",
    });
    expect(report.evidence.checkpoint).toMatchObject({
      schemaVersion: 1,
      file: expect.stringMatching(/^issue-checkpoints\/[a-f0-9]{64}\.json$/),
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
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

  test("reproduces the issue snapshot after the live save and log are gone", async () => {
    const gameDir = await temporaryGame();
    const session = "web-bug";
    const dir = path.join(gameDir, ".rpg-harness", "sessions", session);
    const state = {
      baseline: {
        currentScriptId: "ending_mundane_seal",
        completionOrder: [],
        visuals: { bg: "assets/backgrounds/edo-castle", portraits: {}, cg: null },
      },
      runtime: {},
    };
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "state.json"), JSON.stringify(state));
    await writeFile(
      path.join(dir, "log.jsonl"),
      JSON.stringify({ input: { type: "next" }, output: { type: "choice" } }) + "\n",
    );
    const report = await recordPlaytestReport({
      gameDir,
      session,
      area: "ui",
      severity: "minor",
      title: "Wrong background under the ending CG",
    });
    await rm(path.join(dir, "state.json"));
    await rm(path.join(dir, "log.jsonl"));

    const result = await reproducePlaytestReport({
      gameDir,
      id: report.id,
      to: "repro-bg",
    });

    expect(result).toMatchObject({
      session: "repro-bg",
      fromReport: report.id,
      fromSession: session,
      sourceLogEntry: 1,
      mode: "playtest-checkpoint",
      webPath: "/?session=repro-bg",
    });
    expect(JSON.parse(await readFile(
      path.join(gameDir, ".rpg-harness/sessions/repro-bg/state.json"),
      "utf-8",
    ))).toEqual(state);
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

  test("captures hub telemetry instead of reducing evidence to activity ids", async () => {
    const gameDir = await temporaryGame();
    const session = "hub-ui";
    const dir = path.join(gameDir, ".rpg-harness", "sessions", session);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "log.jsonl"),
      JSON.stringify({
        input: { type: "next" },
        output: {
          type: "hubMenu",
          snapshot: {
            day: 0,
            maxDay: 0,
            slot: 0,
            slotName: "",
            stats: [{ id: "hp", value: 30, max: 30 }],
            affections: [{ id: "kagari", value: 2 }],
            activities: [
              {
                id: "depart:kuro_swamp",
                title: "出立 — 黒沼地",
                category: "raid",
                aiTags: ["exploration", "progression"],
                available: false,
                lockedReason: "need a key",
                requires: { inventory: { itemId: "key", min: 1 } },
              },
            ],
          },
        },
      }) + "\n",
    );
    const report = await recordPlaytestReport({
      gameDir,
      session,
      area: "ui",
      severity: "minor",
      title: "Non-calendar hub shows Day 0/0",
    });
    expect(report.evidence.lastEvent?.output).toEqual({
      type: "hubMenu",
      day: 0,
      maxDay: 0,
      slot: 0,
      slotName: "",
      stats: [{ id: "hp", value: 30, max: 30 }],
      affections: [{ id: "kagari", value: 2 }],
      activities: [
        {
          id: "depart:kuro_swamp",
          title: "出立 — 黒沼地",
          category: "raid",
          aiTags: ["exploration", "progression"],
          available: false,
          lockedReason: "need a key",
          requires: { inventory: { itemId: "key", min: 1 } },
        },
      ],
    });
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
    expect(table).toContain("STATUS");
    expect(table).toContain("Choice text wraps awkwardly");
    expect(table).toContain("Raid pacing feels slow");
  });

  test("resolves a report by id while preserving its captured evidence", async () => {
    const gameDir = await temporaryGame();
    const open = await recordPlaytestReport({
      gameDir,
      session: "web",
      area: "ui",
      severity: "minor",
      title: "Narrator label leaks",
    });

    const resolved = await resolvePlaytestReport({
      gameDir,
      id: open.id,
      resolution: "Narrator beats now use narration output.",
    });

    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedAt).toBeString();
    expect(resolved.resolution).toBe(
      "Narrator beats now use narration output.",
    );
    expect(resolved.evidence).toEqual(open.evidence);
    expect(await listPlaytestReports(gameDir, "web")).toEqual([resolved]);
  });

  test("fails loudly when resolving an unknown report id", async () => {
    const gameDir = await temporaryGame();
    expect(
      resolvePlaytestReport({ gameDir, id: "pt-missing" }),
    ).rejects.toThrow("not found");
  });
});

async function temporaryGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-playtest-report-"));
  temporaryDirectories.push(dir);
  return dir;
}
