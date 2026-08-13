import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAudit } from "./audit";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true })
  ));
});

describe("peek session lifecycle", () => {
  test("persists a missing named session as an auditable shared source", async () => {
    const gameDir = await temporaryGame();
    const first = await runPeek(gameDir, "fresh-source", true);
    const stateFile = path.join(
      gameDir,
      ".rpg-harness/sessions/fresh-source/state.json",
    );
    const persisted = JSON.parse(await readFile(stateFile, "utf-8"));

    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout).state).toEqual(persisted);
    const audit = await runAudit({
      gameDir,
      fromSession: "fresh-source",
      sessionPrefix: "fresh-audit",
      personas: ["objective"],
      maxSteps: 10,
      reportOnStop: false,
      pretty: false,
    });
    expect(audit.source).toMatchObject({
      session: "fresh-source",
      mode: "current-state",
    });
    expect(audit.lanes[0]).toMatchObject({
      persona: "objective",
      reason: "completed",
      ending: "intro",
    });
  });

  test("does not rewrite an existing session while inspecting it", async () => {
    const gameDir = await temporaryGame();
    expect((await runPeek(gameDir, "existing")).exitCode).toBe(0);
    const stateFile = path.join(
      gameDir,
      ".rpg-harness/sessions/existing/state.json",
    );
    const state = JSON.parse(await readFile(stateFile, "utf-8"));
    const compact = JSON.stringify(state);
    await writeFile(stateFile, compact, "utf-8");

    expect((await runPeek(gameDir, "existing")).exitCode).toBe(0);
    expect(await readFile(stateFile, "utf-8")).toBe(compact);
  });

  test("returns a bounded GUI-addressable decision envelope by default", async () => {
    const gameDir = await temporaryGame();
    const compact = await runPeek(gameDir, "compact-source");
    const payload = JSON.parse(compact.stdout);
    const compactRevision = payload.stateRevision as string;

    expect(compact.exitCode).toBe(0);
    expect(compact.stderr).toBe("");
    expect(compactRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(payload).toMatchObject({
      session: "compact-source",
      webPath: "/?session=compact-source",
      output: {
        type: "scriptComplete",
        nextAvailable: [{ id: "intro", title: "Intro" }],
      },
      done: false,
    });
    expect(payload).not.toHaveProperty("state");

    const full = JSON.parse((await runPeek(gameDir, "compact-source", true)).stdout);
    expect(full.state).toBeDefined();
    expect(full.stateRevision).toBe(compactRevision);
  });

  test("uses the same bounded envelope for step while --full retains state", async () => {
    const gameDir = await temporaryGame();
    expect((await runPeek(gameDir, "compact-step")).exitCode).toBe(0);
    const compact = await runStep(
      gameDir,
      "compact-step",
      { type: "select", scriptId: "intro" },
    );
    const payload = JSON.parse(compact.stdout);

    expect(compact.exitCode).toBe(0);
    expect(compact.stderr).toBe("");
    expect(payload).toMatchObject({
      session: "compact-step",
      webPath: "/?session=compact-step",
      stateRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      inputResult: { accepted: true, code: "accepted" },
    });
    expect(payload).not.toHaveProperty("state");

    expect((await runPeek(gameDir, "full-step")).exitCode).toBe(0);
    const full = JSON.parse((await runStep(
      gameDir,
      "full-step",
      { type: "select", scriptId: "intro" },
      true,
    )).stdout);
    expect(full.state).toBeDefined();
    expect(full.inputResult).toMatchObject({ accepted: true });
  });
});

async function temporaryGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-peek-"));
  temporaryDirectories.push(dir);
  await writeFile(path.join(dir, "game.yaml"), "title: Peek lifecycle test\n", "utf-8");
  await mkdir(path.join(dir, "scripts"));
  await writeFile(path.join(dir, "scripts", "intro.md"), [
    "---",
    "id: intro",
    "title: Intro",
    "characters: []",
    "---",
    "",
    "Hello.",
    "",
    "[end]",
    "",
  ].join("\n"), "utf-8");
  return dir;
}

async function runPeek(gameDir: string, session: string, full = false): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const command = [
    process.execPath,
    path.resolve(import.meta.dir, "../bin.ts"),
    "peek",
    gameDir,
    "--session",
    session,
    ...(full ? ["--full"] : []),
  ];
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function runStep(
  gameDir: string,
  session: string,
  input: Record<string, unknown>,
  full = false,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([
    process.execPath,
    path.resolve(import.meta.dir, "../bin.ts"),
    "step",
    gameDir,
    "--session",
    session,
    "--input",
    JSON.stringify(input),
    ...(full ? ["--full"] : []),
  ], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
