import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
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

  test("heartbeats a live lease and does not steal it after staleAfterMs", async () => {
    const gameDir = await temporaryGame();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const options = { staleAfterMs: 30, retryMs: 2, timeoutMs: 45 };
    const first = withSessionLock(gameDir, "web", async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    }, options);
    await waitFor(() => events.includes("first:start"));

    const ownerFile = await currentOwnerFile(gameDir, "web");
    const firstHeartbeat = (await stat(ownerFile)).mtimeMs;
    await delay(55);
    expect((await stat(ownerFile)).mtimeMs).toBeGreaterThan(firstHeartbeat);

    const second = withSessionLock(gameDir, "web", async () => {
      events.push("second:start");
    }, options);
    await expect(second).rejects.toThrow("Timed out waiting");
    expect(events).toEqual(["first:start"]);

    releaseFirst();
    await first;
    expect(events).toEqual(["first:start", "first:end"]);
  });

  test("reclaims a genuinely abandoned lease", async () => {
    const gameDir = await temporaryGame();
    const lockDir = sessionLockDir(gameDir, "web");
    const token = "abandoned-owner";
    await mkdir(path.dirname(lockDir), { recursive: true });
    await writeFile(lockDir, JSON.stringify({
      schemaVersion: 1,
      token,
      // Deliberately outside the OS PID range: it cannot be a live owner.
      pid: Number.MAX_SAFE_INTEGER,
      createdAt: 1,
    }), "utf-8");
    const old = new Date(Date.now() - 10_000);
    await utimes(lockDir, old, old);

    let acquired = false;
    await withSessionLock(gameDir, "web", async () => {
      acquired = true;
    }, { staleAfterMs: 10, retryMs: 2, timeoutMs: 100 });

    expect(acquired).toBe(true);
    expect(await readdir(path.dirname(lockDir))).toEqual([]);
  });

  test("reclaims stale corrupt owner metadata by its exact token marker", async () => {
    const gameDir = await temporaryGame();
    const lockDir = sessionLockDir(gameDir, "web");
    await mkdir(path.dirname(lockDir), { recursive: true });
    await writeFile(lockDir, "{not-json", "utf-8");
    const old = new Date(Date.now() - 10_000);
    await utimes(lockDir, old, old);

    let acquired = false;
    await withSessionLock(gameDir, "web", async () => {
      acquired = true;
    }, { staleAfterMs: 10, retryMs: 2, timeoutMs: 100 });

    expect(acquired).toBe(true);
    expect(await readdir(path.dirname(lockDir))).toEqual([]);
  });

  test("reclaims stale semantically invalid owner metadata", async () => {
    const gameDir = await temporaryGame();
    const lockDir = sessionLockDir(gameDir, "web");
    await mkdir(path.dirname(lockDir), { recursive: true });
    await writeFile(lockDir, "{}", "utf-8");
    const old = new Date(Date.now() - 10_000);
    await utimes(lockDir, old, old);

    let acquired = false;
    await withSessionLock(gameDir, "web", async () => {
      acquired = true;
    }, { staleAfterMs: 10, retryMs: 2, timeoutMs: 100 });

    expect(acquired).toBe(true);
    expect(await readdir(path.dirname(lockDir))).toEqual([]);
  });

  test("fails closed with a migration hint for a legacy lock directory", async () => {
    const gameDir = await temporaryGame();
    const lockDir = sessionLockDir(gameDir, "web");
    await mkdir(lockDir, { recursive: true });
    const old = new Date(Date.now() - 10_000);
    await utimes(lockDir, old, old);

    let acquired = false;
    await expect(withSessionLock(gameDir, "web", async () => {
      acquired = true;
    }, { staleAfterMs: 10, retryMs: 2, timeoutMs: 100 }))
      .rejects.toThrow("Legacy session lock directory requires manual cleanup");

    expect(acquired).toBe(false);
    expect((await stat(lockDir)).isDirectory()).toBe(true);
  });

  test("metadata preparation cannot claim a lock acquired while its fd is paused", async () => {
    const gameDir = await temporaryGame();
    let metadataOpened!: () => void;
    const metadataOpenedGate = new Promise<void>((resolve) => {
      metadataOpened = resolve;
    });
    let resumeInitializer!: () => void;
    const initializerGate = new Promise<void>((resolve) => {
      resumeInitializer = resolve;
    });
    let initializerEntered = false;
    const initializing = withSessionLock(gameDir, "web", async () => {
      initializerEntered = true;
    }, {
      staleAfterMs: 10,
      retryMs: 2,
      timeoutMs: 100,
      onLeaseMetadataOpened: async () => {
        metadataOpened();
        await initializerGate;
      },
    });
    await metadataOpenedGate;

    let releaseReplacement!: () => void;
    const replacementGate = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    let replacementEntered = false;
    const replacement = withSessionLock(gameDir, "web", async () => {
      replacementEntered = true;
      await replacementGate;
    }, { staleAfterMs: 10_000, retryMs: 2, timeoutMs: 200 });
    await waitFor(() => replacementEntered);

    resumeInitializer();
    await expect(initializing).rejects.toThrow("Timed out waiting");
    expect(initializerEntered).toBe(false);

    let thirdEntered = false;
    await expect(withSessionLock(gameDir, "web", async () => {
      thirdEntered = true;
    }, { staleAfterMs: 10_000, retryMs: 2, timeoutMs: 25 }))
      .rejects.toThrow("Timed out waiting");
    expect(thirdEntered).toBe(false);

    releaseReplacement();
    await replacement;
  });

  test("a live recovery claim fences publication after the stale owner is unlinked", async () => {
    const gameDir = await temporaryGame();
    await writeDeadLease(gameDir, "web", "dead-before-recovery-claim");

    let displaced!: () => void;
    const displacedPromise = new Promise<void>((resolve) => {
      displaced = resolve;
    });
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let reclaimerEntered = false;
    const reclaimer = withSessionLock(gameDir, "web", async () => {
      reclaimerEntered = true;
    }, {
      staleAfterMs: 10,
      retryMs: 2,
      timeoutMs: 200,
      onStaleOwnerDisplaced: async () => {
        displaced();
        await paused;
      },
    });
    await displacedPromise;

    let thirdEntered = false;
    await expect(withSessionLock(gameDir, "web", async () => {
      thirdEntered = true;
    }, { staleAfterMs: 10_000, retryMs: 2, timeoutMs: 25 }))
      .rejects.toThrow("interrupted session lock recovery");
    expect(thirdEntered).toBe(false);

    resume();
    await reclaimer;
    expect(reclaimerEntered).toBe(true);
  });

  test("two reclaimers cannot displace each other's replacement owner", async () => {
    const gameDir = await temporaryGame();
    await writeDeadLease(gameDir, "web", "dead-before-two-reclaimers");
    let claims = 0;
    let releaseClaims!: () => void;
    const bothClaimed = new Promise<void>((resolve) => {
      releaseClaims = resolve;
    });
    let active = 0;
    let maximumActive = 0;
    const contender = () => withSessionLock(gameDir, "web", async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await delay(8);
      active -= 1;
    }, {
      staleAfterMs: 10,
      retryMs: 1,
      timeoutMs: 300,
      onRecoveryClaimAcquired: async () => {
        claims += 1;
        if (claims === 2) releaseClaims();
        await bothClaimed;
      },
    });

    await Promise.all([contender(), contender()]);
    expect(claims).toBe(2);
    expect(maximumActive).toBe(1);
  });

  test("a short owner published after stale confirmation leaves no dead restored lease", async () => {
    const gameDir = await temporaryGame();
    const lockDir = sessionLockDir(gameDir, "web");
    await writeDeadLease(gameDir, "web", "dead-before-short-owner");
    let shortOwnerRuns = 0;
    let reclaimerRuns = 0;
    const reclaimer = withSessionLock(gameDir, "web", async () => {
      reclaimerRuns += 1;
    }, {
      staleAfterMs: 10,
      retryMs: 2,
      timeoutMs: 200,
      onStaleLeaseConfirmed: async () => {
        // Replace the confirmed stale inode with a complete short lease, then
        // release it before this reclaimer creates its recovery claim.
        await rm(lockDir, { force: true });
        await withSessionLock(gameDir, "web", async () => {
          shortOwnerRuns += 1;
        });
      },
    });
    await reclaimer;
    expect(shortOwnerRuns).toBe(1);
    expect(reclaimerRuns).toBe(1);
    expect(await pathExists(lockDir)).toBe(false);

    let thirdRuns = 0;
    await withSessionLock(gameDir, "web", async () => {
      thirdRuns += 1;
    });
    expect(thirdRuns).toBe(1);
  });

  test("reclaims an abandoned recovery claim before publishing", async () => {
    const gameDir = await temporaryGame();
    const sessionDir = path.dirname(sessionLockDir(gameDir, "web"));
    const claimToken = "33333333-3333-4333-8333-333333333333";
    const recoveryFile = path.join(
      sessionDir,
      `.transaction-lock.recovery-${claimToken}.claim`,
    );
    await mkdir(sessionDir, { recursive: true });
    await writeFile(recoveryFile, JSON.stringify({
      schemaVersion: 1,
      token: claimToken,
      pid: Number.MAX_SAFE_INTEGER,
      processIdentity: "dead-process",
      createdAt: 1,
      recovery: true,
    }), "utf-8");
    const old = new Date(Date.now() - 10_000);
    await utimes(recoveryFile, old, old);

    let entered = false;
    await withSessionLock(gameDir, "web", async () => {
      entered = true;
    }, { staleAfterMs: 10, retryMs: 2, timeoutMs: 200 });
    expect(entered).toBe(true);
    expect(await pathExists(recoveryFile)).toBe(false);
  });

  test("ignores a forged traversal token while cleaning recovery claims", async () => {
    const gameDir = await temporaryGame();
    const sessionDir = path.dirname(sessionLockDir(gameDir, "web"));
    const claimToken = "11111111-1111-4111-8111-111111111111";
    const claimFile = path.join(
      sessionDir,
      `.transaction-lock.recovery-${claimToken}.claim`,
    );
    const victim = path.join(gameDir, "victim");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(victim, "keep", "utf-8");
    await writeFile(claimFile, JSON.stringify({
      schemaVersion: 1,
      token: "../../../../victim",
      pid: Number.MAX_SAFE_INTEGER,
      processIdentity: "dead-process",
      createdAt: 1,
      recovery: true,
    }), "utf-8");
    const old = new Date(Date.now() - 10_000);
    await utimes(claimFile, old, old);

    let entered = false;
    await withSessionLock(gameDir, "web", async () => {
      entered = true;
    }, { staleAfterMs: 10, retryMs: 2, timeoutMs: 100 });
    expect(entered).toBe(true);
    expect(await readFile(victim, "utf-8")).toBe("keep");
  });

  test("cleans a complete prepared lease abandoned by a dead process", async () => {
    const gameDir = await temporaryGame();
    const sessionDir = path.dirname(sessionLockDir(gameDir, "web"));
    const preparedFile = path.join(
      sessionDir,
      ".transaction-lock.owner-44444444-4444-4444-8444-444444444444.prepared",
    );
    await mkdir(sessionDir, { recursive: true });
    await writeFile(preparedFile, JSON.stringify({
      schemaVersion: 1,
      token: "44444444-4444-4444-8444-444444444444",
      pid: Number.MAX_SAFE_INTEGER,
      processIdentity: "dead-process",
      createdAt: 1,
    }), "utf-8");
    const old = new Date(Date.now() - 10_000);
    await utimes(preparedFile, old, old);

    await withSessionLock(gameDir, "web", async () => {}, {
      staleAfterMs: 10,
      retryMs: 2,
      timeoutMs: 200,
    });
    expect(await pathExists(preparedFile)).toBe(false);
  });

  test("cleans an empty prepared lease abandoned before metadata write", async () => {
    const gameDir = await temporaryGame();
    const sessionDir = path.dirname(sessionLockDir(gameDir, "web"));
    const preparedFile = path.join(
      sessionDir,
      ".transaction-lock.owner-22222222-2222-4222-8222-222222222222.prepared",
    );
    await mkdir(sessionDir, { recursive: true });
    await writeFile(preparedFile, "", "utf-8");
    const old = new Date(Date.now() - 10_000);
    await utimes(preparedFile, old, old);

    await withSessionLock(gameDir, "web", async () => {}, {
      staleAfterMs: 10,
      retryMs: 2,
      timeoutMs: 200,
    });
    expect(await pathExists(preparedFile)).toBe(false);
  });

  test("a reclaimer paused after displacing a dead owner leaves a closed public gate", async () => {
    const gameDir = await temporaryGame();
    const lockDir = sessionLockDir(gameDir, "web");
    await writeDeadLease(gameDir, "web", "dead-owner-before-reclaimer-crash");

    let displaced!: () => void;
    const displacedPromise = new Promise<void>((resolve) => {
      displaced = resolve;
    });
    let continueReclaimer!: () => void;
    const reclaimerGate = new Promise<void>((resolve) => {
      continueReclaimer = resolve;
    });
    let releaseReclaimer!: () => void;
    const reclaimerOperationGate = new Promise<void>((resolve) => {
      releaseReclaimer = resolve;
    });
    let reclaimerEntered = false;
    const reclaimer = withSessionLock(gameDir, "web", async () => {
      reclaimerEntered = true;
      await reclaimerOperationGate;
    }, {
      staleAfterMs: 10,
      retryMs: 2,
      timeoutMs: 200,
      onStaleOwnerDisplaced: async () => {
        displaced();
        await reclaimerGate;
      },
    });
    await displacedPromise;

    // The public owner is gone, but the live recovery claim remains the fence.
    expect(await pathExists(lockDir)).toBe(false);
    expect((await readdir(path.dirname(lockDir))).some((entry) =>
      entry.startsWith(".transaction-lock.recovery-") && entry.endsWith(".claim")
    )).toBe(true);
    let thirdEntered = false;
    await expect(withSessionLock(gameDir, "web", async () => {
      thirdEntered = true;
    }, { staleAfterMs: 10_000, retryMs: 2, timeoutMs: 25 }))
      .rejects.toThrow("interrupted session lock recovery");
    expect(thirdEntered).toBe(false);

    continueReclaimer();
    await waitFor(() => reclaimerEntered);
    releaseReclaimer();
    await reclaimer;
  });

  test("reclaims a stale lease when its PID was reused by another process identity", async () => {
    const gameDir = await temporaryGame();
    const lockDir = sessionLockDir(gameDir, "web");
    const token = "reused-pid-owner";
    await mkdir(path.dirname(lockDir), { recursive: true });
    await writeFile(lockDir, JSON.stringify({
      schemaVersion: 1,
      token,
      // The PID is demonstrably alive, but this start identity cannot belong
      // to the current process. PID-only recovery would leak this lock forever.
      pid: process.pid,
      processIdentity: "old-process-start-identity",
      createdAt: 1,
    }), "utf-8");
    const old = new Date(Date.now() - 10_000);
    await utimes(lockDir, old, old);

    let acquired = false;
    await withSessionLock(gameDir, "web", async () => {
      acquired = true;
    }, { staleAfterMs: 10, retryMs: 2, timeoutMs: 200 });

    expect(acquired).toBe(true);
    expect(await readdir(path.dirname(lockDir))).toEqual([]);
  });

  test("recognizes the same live process identity across locale changes", async () => {
    const gameDir = await temporaryGame();
    let processIdentity: string | null = null;
    await withSessionLock(gameDir, "identity-source", async () => {
      const owner = JSON.parse(
        await readFile(await currentOwnerFile(gameDir, "identity-source"), "utf-8"),
      ) as { processIdentity?: unknown };
      processIdentity = typeof owner.processIdentity === "string"
        ? owner.processIdentity
        : null;
    });
    // Unsupported platforms deliberately fail closed; the three supported
    // platform probes produce an identity and exercise this assertion.
    if (processIdentity === null) return;

    const lockDir = sessionLockDir(gameDir, "locale-stable");
    const token = "locale-stable-owner";
    await mkdir(path.dirname(lockDir), { recursive: true });
    await writeFile(lockDir, JSON.stringify({
      schemaVersion: 1,
      token,
      pid: process.pid,
      processIdentity,
      createdAt: 1,
    }), "utf-8");
    const old = new Date(Date.now() - 10_000);
    await utimes(lockDir, old, old);

    const previousLcAll = process.env.LC_ALL;
    const previousLang = process.env.LANG;
    const previousTz = process.env.TZ;
    process.env.LC_ALL = "ja_JP.UTF-8";
    process.env.LANG = "zh_CN.UTF-8";
    process.env.TZ = "Pacific/Honolulu";
    let entered = false;
    try {
      await expect(withSessionLock(gameDir, "locale-stable", async () => {
        entered = true;
      }, { staleAfterMs: 10, retryMs: 2, timeoutMs: 25 }))
        .rejects.toThrow("Timed out waiting");
    } finally {
      restoreEnvironmentVariable("LC_ALL", previousLcAll);
      restoreEnvironmentVariable("LANG", previousLang);
      restoreEnvironmentVariable("TZ", previousTz);
    }
    expect(entered).toBe(false);
  });

  test("does not unlink a replacement published after stale owner pinning", async () => {
    const gameDir = await temporaryGame();
    const lockDir = sessionLockDir(gameDir, "web");
    const staleToken = "confirmed-then-replaced";
    await mkdir(path.dirname(lockDir), { recursive: true });
    await writeFile(lockDir, JSON.stringify({
      schemaVersion: 1,
      token: staleToken,
      pid: Number.MAX_SAFE_INTEGER,
      createdAt: 1,
    }), "utf-8");
    const old = new Date(Date.now() - 10_000);
    await utimes(lockDir, old, old);

    let hookCalls = 0;
    let contenderStarted = false;
    const contender = withSessionLock(gameDir, "web", async () => {
      contenderStarted = true;
    }, {
      staleAfterMs: 10,
      retryMs: 2,
      timeoutMs: 40,
      onStaleOwnerPinned: async () => {
        hookCalls += 1;
        // Hit the final stat→unlink window: replace the public path after the
        // stale inode was pinned. The reclaimer must compare inode again and
        // leave this replacement untouched.
        await rm(lockDir, { force: true });
        await writeFile(lockDir, JSON.stringify({
          schemaVersion: 1,
          token: "replacement-after-pin",
          pid: process.pid,
          processIdentity: null,
          createdAt: Date.now(),
        }), "utf-8");
      },
    });

    await expect(contender).rejects.toThrow("Timed out waiting");
    expect(hookCalls).toBe(1);
    expect(contenderStarted).toBe(false);
    expect(JSON.parse(await readFile(lockDir, "utf-8"))).toMatchObject({
      token: "replacement-after-pin",
    });
    await rm(lockDir, { force: true });
  });

  test("an old owner cannot remove a replacement owner's lease", async () => {
    const gameDir = await temporaryGame();
    const lockDir = sessionLockDir(gameDir, "web");
    const displacedDir = path.join(path.dirname(lockDir), ".displaced-old-lock");
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted = false;
    const first = withSessionLock(gameDir, "web", async () => {
      firstStarted = true;
      await firstGate;
    });
    await waitFor(() => firstStarted);

    // Model stale recovery's atomic displacement, then let a replacement
    // owner acquire the public lock path before the old operation unwinds.
    await rename(lockDir, displacedDir);
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let secondStarted = false;
    const second = withSessionLock(gameDir, "web", async () => {
      secondStarted = true;
      await secondGate;
    });
    await waitFor(() => secondStarted);

    releaseFirst();
    await first;
    expect(await pathExists(lockDir)).toBe(true);

    let thirdStarted = false;
    const third = withSessionLock(gameDir, "web", async () => {
      thirdStarted = true;
    }, { staleAfterMs: 10_000, retryMs: 2, timeoutMs: 25 });
    await expect(third).rejects.toThrow("Timed out waiting");
    expect(thirdStarted).toBe(false);

    releaseSecond();
    await second;
    await rm(displacedDir, { force: true });
  });

  test("release cannot unlink a replacement after ownership verification", async () => {
    const gameDir = await temporaryGame();
    const lockFile = sessionLockDir(gameDir, "web");
    let replacementWritten = false;
    const owner = withSessionLock(gameDir, "web", async () => {}, {
      onOwnedLeaseVerifiedBeforeUnlink: async () => {
        await rm(lockFile, { force: true });
        await writeFile(lockFile, JSON.stringify({
          schemaVersion: 1,
          token: "replacement-during-release",
          pid: process.pid,
          processIdentity: null,
          createdAt: Date.now(),
        }), "utf-8");
        replacementWritten = true;
      },
    });
    await owner;
    expect(replacementWritten).toBe(true);
    expect(JSON.parse(await readFile(lockFile, "utf-8"))).toMatchObject({
      token: "replacement-during-release",
    });
    await rm(lockFile, { force: true });
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

function sessionLockDir(gameDir: string, session: string): string {
  return path.join(
    gameDir,
    ".rpg-harness",
    "sessions",
    session,
    ".transaction-lock",
  );
}

async function currentOwnerFile(gameDir: string, session: string): Promise<string> {
  const lockFile = sessionLockDir(gameDir, session);
  if (!(await pathExists(lockFile))) throw new Error("lease owner file not found");
  return lockFile;
}

async function writeDeadLease(
  gameDir: string,
  session: string,
  token: string,
): Promise<void> {
  const lockFile = sessionLockDir(gameDir, session);
  await mkdir(path.dirname(lockFile), { recursive: true });
  await writeFile(lockFile, JSON.stringify({
    schemaVersion: 1,
    token,
    pid: Number.MAX_SAFE_INTEGER,
    processIdentity: "dead-process",
    createdAt: 1,
  }), "utf-8");
  const old = new Date(Date.now() - 10_000);
  await utimes(lockFile, old, old);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
