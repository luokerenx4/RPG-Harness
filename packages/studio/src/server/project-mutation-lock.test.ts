import { describe, expect, test } from "bun:test";
import { withProjectSnapshotLock } from "./project-mutation-lock";

describe("Studio project snapshot lock", () => {
  test("does not let a reader observe a multi-file writer in progress", async () => {
    let signalWriter!: () => void;
    const writerStarted = new Promise<void>((resolve) => { signalWriter = resolve; });
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const writer = withProjectSnapshotLock("/tmp/autogal-lock-project", async () => {
      signalWriter();
      await writerGate;
      return "committed";
    });
    await writerStarted;

    let readerRan = false;
    const reader = withProjectSnapshotLock("/tmp/autogal-lock-project", async () => {
      readerRan = true;
      return "snapshot";
    });
    await Promise.resolve();
    expect(readerRan).toBe(false);

    releaseWriter();
    await expect(writer).resolves.toBe("committed");
    await expect(reader).resolves.toBe("snapshot");
    expect(readerRan).toBe(true);
  });

  test("continues the queue after a failed request and isolates different projects", async () => {
    const failed = withProjectSnapshotLock("/tmp/autogal-lock-failure", async () => {
      throw new Error("failed mutation");
    });
    const next = withProjectSnapshotLock("/tmp/autogal-lock-failure", async () => "next snapshot");
    const other = withProjectSnapshotLock("/tmp/autogal-lock-other", async () => "other snapshot");

    await expect(failed).rejects.toThrow("failed mutation");
    await expect(next).resolves.toBe("next snapshot");
    await expect(other).resolves.toBe("other snapshot");
  });
});
