import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listPlaytestReports } from "../playtest-reports";
import { runAutoplay } from "./autoplay";
import { runDevelopmentWorkItem } from "./work";
import { collectDevelopmentWorklist } from "./worklist";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true })
  ));
});

describe("autoplay issue verification", () => {
  test("keeps a repeated stop open, then resolves it only after checkpoint completion", async () => {
    const gameDir = await temporaryRepairableStallGame();
    const original = await runAutoplay({
      gameDir,
      persona: "greedy",
      verbose: false,
      maxSteps: 20,
      seed: 17,
      session: "original-stall",
      reportOnStop: true,
    });
    const reportId = original.report?.id;
    if (!reportId) throw new Error("fixture did not create an autoplay issue");

    expect((await collectDevelopmentWorklist(gameDir)).items).toContainEqual(
      expect.objectContaining({
        key: `report/${reportId}`,
        operation: {
          command: "verify-autoplay",
          args: { reportId, sessionPrefix: "<new-session>" },
        },
        coordinates: expect.objectContaining({
          autoplay: expect.objectContaining({
            persona: "greedy",
            seed: 17,
            stopReason: "stalled",
          }),
        }),
      }),
    );

    const failed = await runDevelopmentWorkItem({
      gameDir,
      key: `report/${reportId}`,
      newSession: "verify-still-bad",
      pretty: false,
    });
    expect(failed).toMatchObject({
      status: "failed",
      operation: {
        command: "verify-autoplay",
        args: { reportId, sessionPrefix: "<new-session>" },
      },
      safety: {
        mode: "isolated-session",
        writes: true,
        targetSession: "verify-still-bad",
      },
      result: {
        status: "failed",
        sourceSession: "verify-still-bad-source",
        runSession: "verify-still-bad-run",
        original: {
          persona: "greedy",
          maxSteps: 20,
          seed: 17,
          stopReason: "stalled",
        },
        result: {
          reason: "stalled",
          webPath: "/?session=verify-still-bad-run",
        },
      },
    });
    expect((await listPlaytestReports(gameDir))[0]?.status).toBe("open");

    await writeFixedScript(gameDir);
    const verified = await runDevelopmentWorkItem({
      gameDir,
      key: `report/${reportId}`,
      newSession: "verify-fixed",
      pretty: false,
    });
    expect(verified).toMatchObject({
      status: "executed",
      result: {
        status: "verified",
        sourceSession: "verify-fixed-source",
        runSession: "verify-fixed-run",
        result: {
          reason: "completed",
          ending: null,
          webPath: "/?session=verify-fixed-run",
        },
        resolvedReport: {
          id: reportId,
          status: "resolved",
          resolution: expect.stringContaining("completed from the immutable issue checkpoint"),
          verification: {
            kind: "autoplay",
            originalStopReason: "stalled",
            persona: "greedy",
            maxSteps: 20,
            seed: 17,
            session: "verify-fixed-run",
            webPath: "/?session=verify-fixed-run",
            sourceCheckpointRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
            result: { reason: "completed" },
          },
        },
      },
    });
    const [resolved] = await listPlaytestReports(gameDir);
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.verification).toMatchObject({ kind: "autoplay" });
    expect((await collectDevelopmentWorklist(gameDir)).items)
      .not.toContainEqual(expect.objectContaining({ key: `report/${reportId}` }));
  });
});

async function temporaryRepairableStallGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-verify-autoplay-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "modules"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), [
    "title: Autoplay verification test",
    "preset: ./modules/run.ts",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "run.ts"), [
    'import type { RunFunction } from "@rpg-harness/engine";',
    "const run: RunFunction = async function* (ctx) {",
    '  if (ctx.game.scripts.some((script) => script.id === "fixed")) {',
    '    yield { type: "gameEnd", reason: "fixed" };',
    "    return;",
    "  }",
    "  while (true) {",
    '    yield { type: "hubMenu", snapshot: { day: 1, maxDay: 1, slot: 0, slotName: "day", slotsPerDay: 1, stats: [], affections: [], activities: [{ id: "wait", kind: "action", title: "Wait", cost: 0, available: true }] } };',
    '    yield { type: "narration", text: "Still blocked." };',
    "  }",
    "};",
    "export default run;",
    "",
  ].join("\n"), "utf-8");
  return dir;
}

async function writeFixedScript(gameDir: string): Promise<void> {
  await mkdir(path.join(gameDir, "scripts"), { recursive: true });
  await writeFile(path.join(gameDir, "scripts", "fixed.md"), [
    "---",
    "id: fixed",
    "title: Fixed",
    "characters: []",
    "---",
    "",
    "The route is repaired.",
    "",
  ].join("\n"), "utf-8");
}
