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
    const first = await runPeek(gameDir, "fresh-source");
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

async function runPeek(gameDir: string, session: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn([
    process.execPath,
    path.resolve(import.meta.dir, "../bin.ts"),
    "peek",
    gameDir,
    "--session",
    session,
  ], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
