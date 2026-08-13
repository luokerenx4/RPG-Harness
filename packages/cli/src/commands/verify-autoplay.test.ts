import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listPlaytestReports } from "../playtest-reports";
import { runAutoplay } from "./autoplay";
import { verifyAutoplayReport } from "./verify-autoplay";
import { runDevelopmentWorkItem } from "./work";
import { collectDevelopmentWorklist } from "./worklist";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true })
  ));
});

describe("autoplay issue verification", () => {
  test("re-runs a repaired module initializer from the original fresh seed", async () => {
    const gameDir = await temporaryRepairableInitializationErrorGame();
    const original = await runAutoplay({
      gameDir,
      persona: "greedy",
      verbose: false,
      maxSteps: 10,
      seed: 29,
      session: "original-initialization-error",
      reportOnStop: true,
    });
    const report = original.report;
    if (!report) throw new Error("fixture did not create an initialization issue");
    expect(original).toMatchObject({
      reason: "error",
      failure: {
        phase: "setup",
        name: "ModuleInitializationError",
        moduleIds: ["world-seed"],
      },
    });
    expect(report).toMatchObject({
      status: "open",
      target: "modules/world.ts",
      evidence: {
        autoplay: {
          replayMode: "fresh-initialization",
          initializationModuleId: "world-seed",
          seed: 29,
        },
        sourceTargets: [{
          kind: "module-setup",
          file: "modules/world.ts",
          moduleId: "world-seed",
          setupPhase: "initialize",
        }],
      },
    });
    expect(report.evidence).not.toHaveProperty("checkpoint");
    expect(report.evidence.autoplay).not.toHaveProperty("replayCheckpoint");
    expect((await collectDevelopmentWorklist(gameDir)).items).toContainEqual(
      expect.objectContaining({
        key: `report/${report.id}`,
        actionability: "executable",
        target: "modules/world.ts",
        operation: {
          command: "verify-autoplay",
          args: { reportId: report.id, sessionPrefix: "<new-session>" },
        },
      }),
    );
    await expect(access(path.join(
      gameDir,
      ".rpg-harness/sessions/original-initialization-error/state.json",
    ))).rejects.toMatchObject({ code: "ENOENT" });

    const stillBroken = await verifyAutoplayReport({
      gameDir,
      reportId: report.id,
      sessionPrefix: "initialization-still-broken",
    });
    expect(stillBroken).toMatchObject({
      status: "failed",
      sourceSession: null,
      runSession: null,
      result: { reason: "error", ending: null, webPath: null },
    });
    await expect(access(path.join(
      gameDir,
      ".rpg-harness/sessions/initialization-still-broken-run/state.json",
    ))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await listPlaytestReports(gameDir))[0]?.status).toBe("open");

    await writeFile(path.join(gameDir, "modules", "world.ts"), [
      'import type { Module } from "@rpg-harness/engine";',
      "const module: Module = {",
      '  id: "world-seed",',
      "  initialize(_game, context) { return { seed: context.seed }; },",
      "};",
      "export default module;",
      "",
    ].join("\n"), "utf-8");
    const verified = await verifyAutoplayReport({
      gameDir,
      reportId: report.id,
      sessionPrefix: "initialization-fixed",
    });
    expect(verified).toMatchObject({
      status: "verified",
      sourceSession: null,
      original: { stopReason: "error", seed: 29 },
      result: { reason: "completed", ending: "world-ready" },
      resolvedReport: {
        verification: {
          kind: "autoplay",
          replayMode: "fresh-initialization",
          initializationModuleId: "world-seed",
          result: { ending: "world-ready" },
        },
      },
    });
    expect(verified.resolvedReport?.verification)
      .not.toHaveProperty("replayCheckpointRevision");
    expect(verified.resolvedReport?.verification)
      .not.toHaveProperty("issueCheckpointRevision");
    const fixedState = JSON.parse(await readFile(path.join(
      gameDir,
      ".rpg-harness/sessions/initialization-fixed-run/state.json",
    ), "utf-8"));
    expect(fixedState["world-seed"]).toEqual({ seed: 29 });
  });

  test("repairs an Engine module contract before the first public output", async () => {
    const gameDir = await temporaryRepairableModuleContractGame();
    const original = await runAutoplay({
      gameDir,
      persona: "greedy",
      verbose: false,
      maxSteps: 10,
      seed: 31,
      session: "original-contract-error",
      reportOnStop: true,
    });
    const report = original.report;
    if (!report) throw new Error("fixture did not create a setup contract issue");
    expect(report).toMatchObject({
      target: "modules/contract.ts",
      evidence: {
        checkpoint: expect.objectContaining({ revision: expect.any(String) }),
        autoplay: {
          replayCheckpoint: expect.objectContaining({ revision: expect.any(String) }),
          seed: 31,
        },
        failure: {
          phase: "setup",
          name: "ModuleContractError",
          moduleIds: ["broken-contract"],
        },
        sourceTargets: [{
          kind: "module-setup",
          file: "modules/contract.ts",
          moduleId: "broken-contract",
          setupPhase: "engine",
        }],
      },
    });
    await writeFile(path.join(gameDir, "modules", "contract.ts"), [
      'import type { Module } from "@rpg-harness/engine";',
      "const module: Module = {",
      '  id: "broken-contract",',
      '  provides: ["ready"],',
      "  actionHandlers: { ready: () => ({}) },",
      "};",
      "export default module;",
      "",
    ].join("\n"), "utf-8");
    const verified = await verifyAutoplayReport({
      gameDir,
      reportId: report.id,
      sessionPrefix: "contract-fixed",
    });
    expect(verified).toMatchObject({
      status: "verified",
      result: { reason: "completed", ending: "contract-ready" },
      resolvedReport: {
        verification: {
          kind: "autoplay",
          result: { ending: "contract-ready" },
        },
      },
    });
  });

  test("resolves a project preset crash from its frozen pre-run checkpoint", async () => {
    const gameDir = await temporaryRepairablePresetErrorGame();
    const original = await runAutoplay({
      gameDir,
      persona: "greedy",
      verbose: false,
      maxSteps: 10,
      seed: 37,
      session: "original-preset-error",
      reportOnStop: true,
    });
    const report = original.report;
    if (!report) throw new Error("fixture did not create a preset issue");
    expect(original).toMatchObject({
      reason: "error",
      failure: {
        phase: "prime",
        name: "TypeError",
        message: "preset bootstrap failed",
      },
    });
    expect(report).toMatchObject({
      status: "open",
      target: "modules/run.ts",
      title: "Autoplay greedy failed in project preset during prime",
      evidence: {
        checkpoint: expect.objectContaining({ revision: expect.any(String) }),
        autoplay: {
          replayCheckpoint: expect.objectContaining({
            revision: expect.any(String),
          }),
          seed: 37,
        },
        sourceTargets: [{
          kind: "preset",
          file: "modules/run.ts",
          runtimePhase: "prime",
        }],
      },
    });

    const stillBroken = await verifyAutoplayReport({
      gameDir,
      reportId: report.id,
      sessionPrefix: "preset-still-broken",
    });
    expect(stillBroken).toMatchObject({
      status: "failed",
      result: { reason: "error", ending: null },
    });
    expect((await listPlaytestReports(gameDir))[0]?.status).toBe("open");

    await writeFile(path.join(gameDir, "modules", "run.ts"), [
      'import type { RunFunction } from "@rpg-harness/engine";',
      "const run: RunFunction = async function* (ctx) {",
      '  ctx.state.baseline.completionOrder.push("preset-fixed");',
      '  yield { type: "gameEnd", endingId: "preset-fixed", reason: "preset repaired" };',
      "};",
      "export default run;",
      "",
    ].join("\n"), "utf-8");
    const verified = await verifyAutoplayReport({
      gameDir,
      reportId: report.id,
      sessionPrefix: "preset-fixed",
    });
    expect(verified).toMatchObject({
      status: "verified",
      original: { stopReason: "error", persona: "greedy", seed: 37 },
      result: {
        reason: "completed",
        ending: "preset-fixed",
        webPath: "/?session=preset-fixed-run",
      },
      resolvedReport: {
        status: "resolved",
        verification: {
          kind: "autoplay",
          originalStopReason: "error",
          result: { ending: "preset-fixed" },
        },
      },
    });
  });

  test("resolves a project persona crash only after its repaired policy reaches gameEnd", async () => {
    const gameDir = await temporaryRepairablePersonaErrorGame();
    const original = await runAutoplay({
      gameDir,
      persona: "oracle",
      verbose: false,
      maxSteps: 10,
      seed: 11,
      session: "original-persona-error",
      reportOnStop: true,
    });
    const report = original.report;
    if (!report) throw new Error("fixture did not create a persona failure issue");
    expect(report).toMatchObject({
      status: "open",
      target: "modules/persona.ts",
      evidence: {
        failure: { phase: "decision", message: "oracle lost the thread" },
        sourceTargets: [{
          kind: "module-persona",
          file: "modules/persona.ts",
          moduleId: "road-oracle",
          persona: "oracle",
        }],
      },
    });

    await writeFile(path.join(gameDir, "modules", "persona.ts"), [
      'import type { Module } from "@rpg-harness/engine";',
      "const module: Module = {",
      '  id: "road-oracle",',
      "  aiPersonas: {",
      '    oracle: { description: "Reads the road", decide: async () => ({ type: "next" }) },',
      "  },",
      "};",
      "export default module;",
      "",
    ].join("\n"), "utf-8");
    const verified = await verifyAutoplayReport({
      gameDir,
      reportId: report.id,
      sessionPrefix: "persona-fixed",
    });
    expect(verified).toMatchObject({
      status: "verified",
      original: { stopReason: "error", persona: "oracle", seed: 11 },
      result: { reason: "completed", ending: "road-found" },
      resolvedReport: {
        status: "resolved",
        verification: {
          kind: "autoplay",
          originalStopReason: "error",
          persona: "oracle",
          result: { ending: "road-found" },
        },
      },
    });
  });

  test("resolves a module action crash only after causal replay reaches gameEnd", async () => {
    const gameDir = await temporaryRepairableActionErrorGame();
    const original = await runAutoplay({
      gameDir,
      persona: "greedy",
      verbose: false,
      maxSteps: 10,
      seed: 7,
      session: "original-action-error",
      reportOnStop: true,
    });
    const report = original.report;
    if (!report) throw new Error("fixture did not create an action failure issue");
    expect(report).toMatchObject({
      status: "open",
      target: "modules/actions.ts",
      evidence: {
        failure: {
          phase: "input",
          activityDecision: {
            activityId: "forge",
            actionKind: "broken-actions:explode",
          },
        },
      },
    });

    const failed = await verifyAutoplayReport({
      gameDir,
      reportId: report.id,
      sessionPrefix: "action-still-broken",
    });
    expect(failed).toMatchObject({
      status: "failed",
      original: { stopReason: "error", persona: "greedy", seed: 7 },
      result: { reason: "error", ending: null },
    });
    expect((await listPlaytestReports(gameDir))[0]?.status).toBe("open");

    await writeFile(path.join(gameDir, "modules", "actions.ts"), [
      'import type { Module } from "@rpg-harness/engine";',
      "const actions: Module = {",
      '  id: "broken-actions",',
      "  actionHandlers: { explode: () => ({}) },",
      "};",
      "export default actions;",
      "",
    ].join("\n"), "utf-8");
    const verified = await verifyAutoplayReport({
      gameDir,
      reportId: report.id,
      sessionPrefix: "action-fixed",
    });
    expect(verified).toMatchObject({
      status: "verified",
      original: { stopReason: "error" },
      result: { reason: "completed", ending: "forge-fixed" },
      resolvedReport: {
        status: "resolved",
        verification: {
          kind: "autoplay",
          originalStopReason: "error",
          result: { ending: "forge-fixed" },
        },
      },
    });
    expect((await listPlaytestReports(gameDir))[0]?.status).toBe("resolved");
  });

  test("rejects a final-state-only patch and resolves only after a full causal replay", async () => {
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
    const replayCheckpoint = original.report?.evidence.autoplay?.replayCheckpoint;
    const issueCheckpoint = original.report?.evidence.checkpoint;
    if (!replayCheckpoint || !issueCheckpoint) {
      throw new Error("fixture did not freeze both autoplay checkpoints");
    }
    expect(replayCheckpoint.revision).not.toBe(issueCheckpoint.revision);
    expect((await readCheckpoint(gameDir, "original-stall", replayCheckpoint.file))
      .baseline.switches.poisoned).toBe(false);
    expect((await readCheckpoint(gameDir, "original-stall", issueCheckpoint.file))
      .baseline.switches.poisoned).toBe(true);

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
          decisionPathRevision: original.decisionPath.revision,
        },
        result: {
          reason: "stalled",
          webPath: "/?session=verify-still-bad-run",
        },
      },
    });
    expect((await listPlaytestReports(gameDir))[0]?.status).toBe("open");
    expect(JSON.parse(await readFile(path.join(
      gameDir,
      ".rpg-harness",
      "sessions",
      "verify-still-bad-source",
      "fork.json",
    ), "utf-8"))).toMatchObject({
      fromReport: reportId,
      fromSession: "original-stall",
      sourceLogEntry: 0,
      mode: "playtest-replay-checkpoint",
    });

    // This patch would fool the old verifier: the stopped checkpoint is
    // poisoned, so loading only that final state immediately reaches gameEnd.
    // A causal replay starts healthy and proves the underlying route still stalls.
    await writeMarkerScript(gameDir, "final_state_only");
    const finalStateOnly = await verifyAutoplayReport({
      gameDir,
      reportId,
      sessionPrefix: "verify-final-state-only",
    }, {
      afterSourceMaterialized: async (session) => {
        const file = path.join(
          gameDir,
          ".rpg-harness",
          "sessions",
          session,
          "state.json",
        );
        const state = JSON.parse(await readFile(file, "utf-8"));
        state.baseline.switches.poisoned = true;
        await writeFile(file, JSON.stringify(state, null, 2), "utf-8");
      },
    });
    expect(finalStateOnly).toMatchObject({
      status: "failed",
      sourceSession: "verify-final-state-only-source",
      runSession: "verify-final-state-only-run",
      result: { reason: "stalled" },
    });
    expect(JSON.parse(await readFile(path.join(
      gameDir,
      ".rpg-harness",
      "sessions",
      "verify-final-state-only-source",
      "state.json",
    ), "utf-8")).baseline.switches.poisoned).toBe(true);
    expect((await listPlaytestReports(gameDir))[0]?.status).toBe("open");

    // A generator that silently returns is classified as completed by the
    // engine, but no gameEnd or completed ending proves the route was repaired.
    await writeMarkerScript(gameDir, "silent_return");
    const silentReturn = await runDevelopmentWorkItem({
      gameDir,
      key: `report/${reportId}`,
      newSession: "verify-silent-return",
      pretty: false,
    });
    expect(silentReturn).toMatchObject({
      status: "failed",
      result: {
        status: "failed",
        sourceSession: "verify-silent-return-source",
        runSession: "verify-silent-return-run",
        result: { reason: "completed", ending: null },
      },
    });
    expect((await listPlaytestReports(gameDir))[0]?.status).toBe("open");

    await writeMarkerScript(gameDir, "fixed");
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
          ending: "fixed",
          webPath: "/?session=verify-fixed-run",
        },
        resolvedReport: {
          id: reportId,
          status: "resolved",
          resolution: expect.stringContaining("reached terminal ending fixed"),
          verification: {
            kind: "autoplay",
            originalStopReason: "stalled",
            persona: "greedy",
            maxSteps: 20,
            seed: 17,
            session: "verify-fixed-run",
            webPath: "/?session=verify-fixed-run",
            replayCheckpointRevision: replayCheckpoint.revision,
            issueCheckpointRevision: issueCheckpoint.revision,
            result: { reason: "completed", ending: "fixed" },
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
    "switches:",
    "  poisoned: false",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "run.ts"), [
    'import type { RunFunction } from "@rpg-harness/engine";',
    "const run: RunFunction = async function* (ctx) {",
    "  const enteredPoisoned = ctx.state.baseline.switches.poisoned;",
    '  if (enteredPoisoned && ctx.game.scripts.some((script) => script.id === "final_state_only")) {',
    '    yield { type: "gameEnd", endingId: "final-state-only", reason: "only the stopped state was patched" };',
    "    return;",
    "  }",
    "  while (true) {",
    '    yield { type: "hubMenu", snapshot: { day: 1, maxDay: 1, slot: 0, slotName: "day", slotsPerDay: 1, stats: [], affections: [], activities: [{ id: "wait", kind: "action", title: "Wait", cost: 0, available: true }] } };',
    "    ctx.state.baseline.switches.poisoned = true;",
    '    if (ctx.game.scripts.some((script) => script.id === "fixed")) {',
    '      ctx.state.baseline.completionOrder.push("fixed");',
    '      yield { type: "gameEnd", endingId: "fixed", reason: "fixed from a healthy replay" };',
    "      return;",
    "    }",
    '    if (ctx.game.scripts.some((script) => script.id === "silent_return")) {',
    "      return;",
    "    }",
    '    yield { type: "narration", text: "Still blocked." };',
    "  }",
    "};",
    "export default run;",
    "",
  ].join("\n"), "utf-8");
  return dir;
}

async function temporaryRepairableInitializationErrorGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-verify-initialize-error-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "modules"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), [
    "title: Repairable initialization error",
    "preset: ./modules/run.ts",
    "modules:",
    "  - ./modules/world.ts",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "world.ts"), [
    'import type { Module } from "@rpg-harness/engine";',
    "const module: Module = {",
    '  id: "world-seed",',
    '  initialize() { throw new Error("world generation collapsed"); },',
    "};",
    "export default module;",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "run.ts"), [
    'import type { RunFunction } from "@rpg-harness/engine";',
    "const run: RunFunction = async function* () {",
    '  yield { type: "gameEnd", endingId: "world-ready", reason: "initialized" };',
    "};",
    "export default run;",
    "",
  ].join("\n"), "utf-8");
  return dir;
}

async function temporaryRepairableModuleContractGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-verify-contract-error-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "modules"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), [
    "title: Repairable module contract",
    "preset: ./modules/run.ts",
    "modules:",
    "  - ./modules/contract.ts",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "contract.ts"), [
    'import type { Module } from "@rpg-harness/engine";',
    "const module: Module = {",
    '  id: "broken-contract",',
    '  provides: ["missing"],',
    "  actionHandlers: {},",
    "};",
    "export default module;",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "run.ts"), [
    'import type { RunFunction } from "@rpg-harness/engine";',
    "const run: RunFunction = async function* () {",
    '  yield { type: "gameEnd", endingId: "contract-ready", reason: "valid" };',
    "};",
    "export default run;",
    "",
  ].join("\n"), "utf-8");
  return dir;
}

async function temporaryRepairablePresetErrorGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-verify-preset-error-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "modules"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), [
    "title: Repairable preset error",
    "preset: ./modules/run.ts",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "run.ts"), [
    'import type { RunFunction } from "@rpg-harness/engine";',
    "const run: RunFunction = async function* () {",
    '  throw new TypeError("preset bootstrap failed");',
    '  yield { type: "gameEnd", endingId: "unreachable" };',
    "};",
    "export default run;",
    "",
  ].join("\n"), "utf-8");
  return dir;
}

async function temporaryRepairableActionErrorGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-verify-action-error-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "modules"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), [
    "title: Repairable action error",
    "preset: ./modules/run.ts",
    "modules:",
    "  - ./modules/actions.ts",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "actions.ts"), [
    'import type { Module } from "@rpg-harness/engine";',
    "const actions: Module = {",
    '  id: "broken-actions",',
    '  actionHandlers: { explode: () => { throw new TypeError("forge overheated"); } },',
    "};",
    "export default actions;",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "run.ts"), [
    'import { dispatchActivity } from "@rpg-harness/engine";',
    'import type { RunFunction } from "@rpg-harness/engine";',
    "const run: RunFunction = async function* (ctx) {",
    '  const activity = { id: "forge", kind: "action" as const, title: "Use forge", cost: 0, available: true, actionKind: "broken-actions:explode" };',
    "  ctx.state.runtime.lastHubActivities = [activity];",
    '  const input = yield { type: "hubMenu", snapshot: { day: 1, maxDay: 1, slot: 0, slotName: "day", slotsPerDay: 1, stats: [], affections: [], activities: [activity] } };',
    '  if (input.type === "doActivity") {',
    '    yield* dispatchActivity(ctx, input.id);',
    '    yield { type: "gameEnd", endingId: "forge-fixed", reason: "handler completed" };',
    "  }",
    "};",
    "export default run;",
    "",
  ].join("\n"), "utf-8");
  return dir;
}

async function temporaryRepairablePersonaErrorGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-verify-persona-error-"));
  temporaryDirectories.push(dir);
  await mkdir(path.join(dir, "modules"), { recursive: true });
  await writeFile(path.join(dir, "game.yaml"), [
    "title: Repairable persona error",
    "preset: ./modules/run.ts",
    "modules:",
    "  - ./modules/persona.ts",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "persona.ts"), [
    'import type { Module } from "@rpg-harness/engine";',
    "const module: Module = {",
    '  id: "road-oracle",',
    "  aiPersonas: {",
    '    oracle: { description: "Reads the road", decide: async () => { throw new RangeError("oracle lost the thread"); } },',
    "  },",
    "};",
    "export default module;",
    "",
  ].join("\n"), "utf-8");
  await writeFile(path.join(dir, "modules", "run.ts"), [
    'import type { RunFunction } from "@rpg-harness/engine";',
    "const run: RunFunction = async function* () {",
    '  yield { type: "narration", text: "A road waits." };',
    '  yield { type: "gameEnd", endingId: "road-found", reason: "continued" };',
    "};",
    "export default run;",
    "",
  ].join("\n"), "utf-8");
  return dir;
}

async function writeMarkerScript(gameDir: string, id: string): Promise<void> {
  await mkdir(path.join(gameDir, "scripts"), { recursive: true });
  await writeFile(path.join(gameDir, "scripts", `${id}.md`), [
    "---",
    `id: ${id}`,
    `title: ${id}`,
    "characters: []",
    "---",
    "",
    "The route is repaired.",
    "",
  ].join("\n"), "utf-8");
}

async function readCheckpoint(
  gameDir: string,
  session: string,
  file: string,
): Promise<{ baseline: { switches: Record<string, boolean> } }> {
  return JSON.parse(await readFile(
    path.join(gameDir, ".rpg-harness", "sessions", session, ...file.split("/")),
    "utf-8",
  ));
}
