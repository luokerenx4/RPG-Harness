import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MapTopologyError } from "./map-topology-error";
import { withProjectProcessLock } from "./project-process-lock";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("Studio project process lock", () => {
  test("rejects a concurrent holder for the same project with a typed 409", async () => {
    const gameDir = await projectFixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    const holder = withProjectProcessLock(gameDir, async () => {
      entered.resolve();
      await release.promise;
    });

    await within(entered.promise);
    try {
      const error = await rejection(withProjectProcessLock(gameDir, async () => {}));
      expect(error).toBeInstanceOf(MapTopologyError);
      expect(error).toMatchObject({
        status: 409,
        code: "map_topology_project_busy",
      });
    } finally {
      release.resolve();
      await holder;
    }
  });

  test("elects only one of two contenders that publish simultaneously", async () => {
    const gameDir = await projectFixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    let entries = 0;
    const contender = () => withProjectProcessLock(gameDir, async () => {
      entries += 1;
      entered.resolve();
      await release.promise;
    });
    const attempts = [contender(), contender()];
    const settledPromise = Promise.allSettled(attempts);

    await within(entered.promise);
    await Bun.sleep(25);
    expect(entries).toBe(1);
    release.resolve();
    const settled = await settledPromise;

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: { status: 409, code: "map_topology_project_busy" },
    });
  });

  test("lets different projects make progress in parallel", async () => {
    const firstDir = await projectFixture();
    const secondDir = await projectFixture();
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    const release = deferred<void>();
    const first = withProjectProcessLock(firstDir, async () => {
      firstEntered.resolve();
      await release.promise;
      return "first";
    });
    const second = withProjectProcessLock(secondDir, async () => {
      secondEntered.resolve();
      await release.promise;
      return "second";
    });

    try {
      await within(Promise.all([firstEntered.promise, secondEntered.promise]));
    } finally {
      release.resolve();
    }
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });

  test("releases ownership when the protected operation fails", async () => {
    const gameDir = await projectFixture();

    await expect(withProjectProcessLock(gameDir, async () => {
      throw new Error("operation failed");
    })).rejects.toThrow("operation failed");

    await expect(withProjectProcessLock(gameDir, async () => "reacquired"))
      .resolves.toBe("reacquired");
  });

  test("reclaims an abandoned contender without touching later owners", async () => {
    const gameDir = await projectFixture();
    const lockDirectory = path.join(
      gameDir,
      ".studio-transactions",
      "process-lock",
      "holder-2147483647-11111111-1111-4111-8111-111111111111",
    );
    await mkdir(lockDirectory, { recursive: true });

    await expect(withProjectProcessLock(gameDir, async () => "recovered"))
      .resolves.toBe("recovered");
    expect(await exists(lockDirectory)).toBe(false);
  });

  test("never trusts a dead holder record to choose a cleanup path", async () => {
    const gameDir = await projectFixture();
    const protectedDirectory = path.join(gameDir, "must-survive");
    const holderToken = "22222222-2222-4222-8222-222222222222";
    const holderDirectory = path.join(
      gameDir,
      ".studio-transactions",
      "process-lock",
      `holder-2147483647-${holderToken}`,
    );
    await mkdir(protectedDirectory);
    await mkdir(holderDirectory, { recursive: true });
    await writeFile(path.join(holderDirectory, "record.json"), `${JSON.stringify({
      version: 1,
      pid: 2147483647,
      token: holderToken,
      ticket: 1,
      createdAt: new Date(0).toISOString(),
      directory: protectedDirectory,
    })}\n`);

    await expect(withProjectProcessLock(gameDir, async () => "safe"))
      .resolves.toBe("safe");
    expect(await exists(protectedDirectory)).toBe(true);
    expect(await exists(holderDirectory)).toBe(false);
  });

  test("excludes a second process while a child owns the project lock", async () => {
    const gameDir = await projectFixture();
    const enteredPath = path.join(gameDir, "child-entered");
    const releasePath = path.join(gameDir, "child-release");
    const moduleUrl = pathToFileURL(
      path.join(import.meta.dirname, "project-process-lock.ts"),
    ).href;
    const child = Bun.spawn([
      process.execPath,
      "-e",
      [
        `import { withProjectProcessLock } from ${JSON.stringify(moduleUrl)};`,
        `import { stat, writeFile } from "node:fs/promises";`,
        `const gameDir = ${JSON.stringify(gameDir)};`,
        `const enteredPath = ${JSON.stringify(enteredPath)};`,
        `const releasePath = ${JSON.stringify(releasePath)};`,
        "await withProjectProcessLock(gameDir, async () => {",
        "  await writeFile(enteredPath, \"entered\\n\");",
        "  while (!(await stat(releasePath).then(() => true, () => false))) {",
        "    await Bun.sleep(10);",
        "  }",
        "});",
      ].join("\n"),
    ], { stdout: "pipe", stderr: "pipe" });

    try {
      await within(waitForFile(enteredPath), 5_000);
      const error = await rejection(withProjectProcessLock(gameDir, async () => {}));
      expect(error).toBeInstanceOf(MapTopologyError);
      expect(error).toMatchObject({
        status: 409,
        code: "map_topology_project_busy",
      });
    } finally {
      await writeFile(releasePath, "release\n");
    }

    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    await expect(withProjectProcessLock(gameDir, async () => "after-child"))
      .resolves.toBe("after-child");
  }, 10_000);

  test("recovers immediately after a lock owner is killed", async () => {
    const gameDir = await projectFixture();
    const enteredPath = path.join(gameDir, "killed-child-entered");
    const moduleUrl = processLockModuleUrl();
    const child = Bun.spawn([
      process.execPath,
      "-e",
      [
        `import { withProjectProcessLock } from ${JSON.stringify(moduleUrl)};`,
        `import { writeFile } from "node:fs/promises";`,
        `const gameDir = ${JSON.stringify(gameDir)};`,
        `const enteredPath = ${JSON.stringify(enteredPath)};`,
        "await withProjectProcessLock(gameDir, async () => {",
        "  await writeFile(enteredPath, \"entered\\n\");",
        "  while (true) await Bun.sleep(1_000);",
        "});",
      ].join("\n"),
    ], { stdout: "pipe", stderr: "pipe" });

    await within(waitForFile(enteredPath), 5_000);
    child.kill(9);
    await within(child.exited, 5_000);

    await expect(withProjectProcessLock(gameDir, async () => "after-kill"))
      .resolves.toBe("after-kill");
  }, 10_000);

  test("never overlaps a critical section under multi-process contention", async () => {
    const gameDir = await projectFixture();
    const moduleUrl = processLockModuleUrl();
    const critical = path.join(gameDir, "critical-section");
    const overlapRoot = path.join(gameDir, "overlaps");
    await mkdir(overlapRoot);
    const children = Array.from({ length: 12 }, (_, index) => Bun.spawn([
      process.execPath,
      "-e",
      [
        `import { withProjectProcessLock } from ${JSON.stringify(moduleUrl)};`,
        `import { mkdir, rmdir, writeFile } from "node:fs/promises";`,
        `const gameDir = ${JSON.stringify(gameDir)};`,
        `const critical = ${JSON.stringify(critical)};`,
        `const overlap = ${JSON.stringify(path.join(overlapRoot, `worker-${index}`))};`,
        "while (true) {",
        "  try {",
        "    await withProjectProcessLock(gameDir, async () => {",
        "      let ownsMarker = false;",
        "      try { await mkdir(critical); ownsMarker = true; }",
        "      catch { await writeFile(overlap, \"overlap\\n\"); }",
        "      await Bun.sleep(8);",
        "      if (ownsMarker) await rmdir(critical);",
        "    });",
        "    break;",
        "  } catch (error) {",
        "    if (error?.code !== \"map_topology_project_busy\") throw error;",
        "    await Bun.sleep(2 + Math.floor(Math.random() * 8));",
        "  }",
        "}",
      ].join("\n"),
    ], { stdout: "pipe", stderr: "pipe" }));

    const results = await within(Promise.all(children.map(async (child) => ({
      exitCode: await child.exited,
      stderr: await new Response(child.stderr).text(),
    }))), 20_000);

    expect(results).toEqual(Array.from({ length: 12 }, () => ({ exitCode: 0, stderr: "" })));
    expect(await readdir(overlapRoot)).toEqual([]);
  }, 25_000);
});

async function projectFixture(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "autogal-process-lock-"));
  created.push(directory);
  return directory;
}

async function waitForFile(absolute: string): Promise<void> {
  while (!(await exists(absolute))) await Bun.sleep(10);
}

function processLockModuleUrl(): string {
  return pathToFileURL(path.join(import.meta.dirname, "project-process-lock.ts")).href;
}

async function exists(absolute: string): Promise<boolean> {
  return stat(absolute).then(() => true, () => false);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await within(promise);
    throw new Error("expected operation to reject");
  } catch (error) {
    return error;
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function within<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out waiting for process lock")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
