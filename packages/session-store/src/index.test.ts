import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withSessionLock } from "./index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

describe("withSessionLock", () => {
  test("serializes two transactions for the same game session", async () => {
    const gameDir = await temporaryGame();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withSessionLock(gameDir, "web", async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    await waitFor(() => events.includes("first:start"));
    const second = withSessionLock(gameDir, "web", async () => {
      events.push("second:start");
      events.push("second:end");
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  test("does not serialize different session names", async () => {
    const gameDir = await temporaryGame();
    let secondRan = false;
    await withSessionLock(gameDir, "one", async () => {
      await withSessionLock(gameDir, "two", async () => {
        secondRan = true;
      });
    });
    expect(secondRan).toBe(true);
  });
});

async function temporaryGame(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rpgh-session-lock-"));
  temporaryDirectories.push(dir);
  return dir;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition was not reached");
}
