import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSessionName } from "@rpg-harness/session-store";
import { getPlaytestReport } from "../playtest-reports";
import { assertTargetEmpty } from "./fork";
import {
  executeDevelopmentWorkItem,
  type WorkResult,
} from "./work";
import {
  collectDevelopmentWorklist,
  type DevelopmentWorkItem,
} from "./worklist";

export interface SweepArgs {
  gameDir: string;
  session?: string;
  sessionPrefix: string;
  limit: number;
  fromKey?: string;
  snapshotRevision?: string;
  persona?: string;
  maxSteps?: number;
  maxNodes?: number;
  maxTotalNodes?: number;
  pretty: boolean;
}

export interface SweepResult {
  schemaVersion: 1;
  status: "clean" | "completed" | "paused" | "stopped";
  reason:
    | "clean"
    | "snapshot-completed"
    | "budget-exhausted"
    | "work-failed"
    | "authoring-required"
    | "search-budget-exhausted";
  snapshot: {
    revision: string;
    file: string;
    sourceSession: string | null;
    totalItems: number;
    startIndex: number;
    selectedItems: number;
    completedItems: number;
    remainingItems: number;
    nextKey: string | null;
    remainingKeys: string[];
  };
  safety: {
    immutableWorklist: true;
    preflightedTargets: string[];
    sourceWrites: false;
    nodeBudget: { limit: number; used: number; remaining: number };
  };
  resume: {
    fromKey: string;
    snapshotRevision: string;
  } | null;
  runs: Array<{
    index: number;
    key: string;
    targetSession: string | null;
    status: WorkResult["status"];
    result: WorkResult;
  }>;
}

interface PersistedSweepSnapshot {
  schemaVersion: 1;
  revision: string;
  sourceSession: string | null;
  items: DevelopmentWorkItem[];
}

export async function sweepCommand(args: SweepArgs): Promise<void> {
  const result = await runDevelopmentSweep(args);
  process.stdout.write(
    (args.pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result)) + "\n",
  );
  if (result.status === "stopped") process.exitCode = 1;
}

/**
 * Execute a bounded, frozen development batch. The queue is collected once so
 * earlier branches cannot silently re-rank later work, and every branch name
 * is checked before the first write.
 */
export async function runDevelopmentSweep(args: SweepArgs): Promise<SweepResult> {
  validateSweepArgs(args);
  const snapshot = args.snapshotRevision === undefined
    ? await createSweepSnapshot(args.gameDir, args.session)
    : await readSweepSnapshot(
        args.gameDir,
        args.snapshotRevision,
        args.session,
      );
  const snapshotRevision = snapshot.revision;
  const allItems = snapshot.items;
  const startIndex = args.fromKey === undefined
    ? 0
    : allItems.findIndex((item) => item.key === args.fromKey);
  if (startIndex < 0) {
    throw new Error(`Sweep resume key is not in the current snapshot: ${args.fromKey}`);
  }
  const liveKeys = args.snapshotRevision === undefined
    ? null
    : new Set(
        (await collectDevelopmentWorklist(args.gameDir, args.session)).items
          .map((item) => item.key),
      );
  const queuedItems = allItems
    .slice(startIndex)
    .filter((item) => liveKeys === null || liveKeys.has(item.key));
  const selected = queuedItems.slice(0, args.limit);

  if (selected.length === 0) {
    return resultEnvelope(args, snapshotRevision, allItems, startIndex, selected, [], [], {
      status: "clean",
      reason: "clean",
    }, 0, queuedItems);
  }

  const targets = selected.map((item) =>
    branchTarget(item, args.sessionPrefix, allItems.indexOf(item))
  );
  const preflightedTargets = await preflightTargets(args, selected, targets);
  if (args.snapshotRevision === undefined) {
    await persistSweepSnapshot(args.gameDir, snapshot);
  }
  const runs: SweepResult["runs"] = [];
  const totalNodeLimit = args.maxTotalNodes ?? 5_000;
  let usedNodes = 0;
  let stoppedReason:
    | "work-failed"
    | "authoring-required"
    | "search-budget-exhausted"
    | null = null;

  for (const [index, item] of selected.entries()) {
    const targetSession = targets[index] ?? null;
    const searches = item.operation.command === "reach" ||
      item.operation.command === "reach-script";
    const remainingNodes = Math.max(0, totalNodeLimit - usedNodes);
    if (searches && remainingNodes === 0) {
      stoppedReason = "search-budget-exhausted";
      break;
    }
    let result: WorkResult;
    try {
      result = await executeDevelopmentWorkItem({
        gameDir: args.gameDir,
        key: item.key,
        ...(args.session !== undefined ? { session: args.session } : {}),
        ...(targetSession !== null ? { newSession: targetSession } : {}),
        ...(args.persona !== undefined ? { persona: args.persona } : {}),
        ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
        ...(searches
          ? { maxNodes: Math.min(args.maxNodes ?? 5_000, remainingNodes) }
          : args.maxNodes !== undefined
            ? { maxNodes: args.maxNodes }
            : {}),
        pretty: false,
      }, item);
    } catch (error) {
      const possibleTargets = targetSession === null
        ? []
        : preflightedTargets.filter((session) =>
            session === targetSession || session.startsWith(`${targetSession}-`)
          );
      const wrote = await anyTargetWritten(args.gameDir, possibleTargets);
      result = {
        schemaVersion: 1,
        status: "failed",
        selection: {
          key: item.key,
          priority: item.priority,
          kind: item.kind,
          actionability: item.actionability,
          title: item.title,
        },
        operation: item.operation,
        safety: {
          mode: wrote ? "isolated-session" : "read-only",
          writes: wrote,
          targetSession: wrote ? targetSession : null,
        },
        result: { error: error instanceof Error ? error.message : String(error) },
      };
    }
    runs.push({
      index: index + 1,
      key: item.key,
      targetSession,
      status: result.status,
      result,
    });
    const consumedNodes = searchNodes(result);
    usedNodes += consumedNodes;
    if (result.status === "failed") {
      stoppedReason = searches && (
        consumedNodes >= remainingNodes || searchHitNodeLimit(result)
      )
        ? "search-budget-exhausted"
        : "work-failed";
      break;
    }
    if (result.status === "prepared") {
      stoppedReason = "authoring-required";
      break;
    }
  }

  if (stoppedReason) {
    return resultEnvelope(
      args,
      snapshotRevision,
      allItems,
      startIndex,
      selected,
      preflightedTargets,
      runs,
      {
        status: stoppedReason === "search-budget-exhausted" ? "paused" : "stopped",
        reason: stoppedReason,
      },
      usedNodes,
      queuedItems,
    );
  }
  const exhausted = selected.length < queuedItems.length;
  return resultEnvelope(
    args,
    snapshotRevision,
    allItems,
    startIndex,
    selected,
    preflightedTargets,
    runs,
    {
      status: "completed",
      reason: exhausted ? "budget-exhausted" : "snapshot-completed",
    },
    usedNodes,
    queuedItems,
  );
}

async function createSweepSnapshot(
  gameDir: string,
  sourceSession: string | undefined,
): Promise<PersistedSweepSnapshot> {
  const worklist = await collectDevelopmentWorklist(gameDir, sourceSession);
  const source = sourceSession ?? null;
  const revision = createHash("sha256")
    .update(JSON.stringify({ sourceSession: source, items: worklist.items }))
    .digest("hex");
  return {
    schemaVersion: 1,
    revision,
    sourceSession: source,
    items: worklist.items,
  };
}

async function persistSweepSnapshot(
  gameDir: string,
  snapshot: PersistedSweepSnapshot,
): Promise<void> {
  const directory = path.join(gameDir, ".rpg-harness", "sweeps");
  const file = path.join(directory, `${snapshot.revision}.json`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(file, JSON.stringify(snapshot, null, 2) + "\n", {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = JSON.parse(await readFile(file, "utf-8")) as PersistedSweepSnapshot;
    if (JSON.stringify(existing) !== JSON.stringify(snapshot)) {
      throw new Error(`Sweep snapshot collision at revision ${snapshot.revision}`);
    }
  }
}

async function readSweepSnapshot(
  gameDir: string,
  revision: string,
  sourceSession: string | undefined,
): Promise<PersistedSweepSnapshot> {
  if (!/^[a-f0-9]{64}$/.test(revision)) {
    throw new Error(`Invalid sweep snapshot revision: ${revision}`);
  }
  const file = path.join(gameDir, ".rpg-harness", "sweeps", `${revision}.json`);
  let snapshot: PersistedSweepSnapshot;
  try {
    snapshot = JSON.parse(await readFile(file, "utf-8")) as PersistedSweepSnapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Sweep snapshot changed: persisted revision ${revision} was not found. ` +
          "Start a new sweep and use its resume coordinates.",
      );
    }
    throw error;
  }
  const expectedSource = sourceSession ?? null;
  const computedRevision = createHash("sha256")
    .update(JSON.stringify({
      sourceSession: snapshot.sourceSession,
      items: snapshot.items,
    }))
    .digest("hex");
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.revision !== revision ||
    computedRevision !== revision
  ) {
    throw new Error(`Sweep snapshot ${revision} is invalid or has been modified`);
  }
  if (snapshot.sourceSession !== expectedSource) {
    throw new Error(
      `Sweep snapshot ${revision} belongs to source session ` +
        `${snapshot.sourceSession ?? "<all>"}, not ${expectedSource ?? "<all>"}`,
    );
  }
  return snapshot;
}

function resultEnvelope(
  args: SweepArgs,
  revision: string,
  allItems: DevelopmentWorkItem[],
  startIndex: number,
  selected: DevelopmentWorkItem[],
  preflightedTargets: string[],
  runs: SweepResult["runs"],
  outcome: Pick<SweepResult, "status" | "reason">,
  usedNodes = 0,
  pendingItems = allItems.slice(startIndex),
): SweepResult {
  const completedItems = runs.filter((run) => run.status === "executed").length;
  const remainingKeys = pendingItems
    .slice(completedItems)
    .map((item) => item.key);
  return {
    schemaVersion: 1,
    ...outcome,
    snapshot: {
      revision,
      file: sweepSnapshotRelativePath(revision),
      sourceSession: args.session ?? null,
      totalItems: allItems.length,
      startIndex,
      selectedItems: selected.length,
      completedItems,
      remainingItems: remainingKeys.length,
      nextKey: remainingKeys[0] ?? null,
      remainingKeys,
    },
    safety: {
      immutableWorklist: true,
      preflightedTargets,
      sourceWrites: false,
      nodeBudget: {
        limit: args.maxTotalNodes ?? 5_000,
        used: usedNodes,
        remaining: Math.max(0, (args.maxTotalNodes ?? 5_000) - usedNodes),
      },
    },
    resume: remainingKeys[0]
      ? { fromKey: remainingKeys[0], snapshotRevision: revision }
      : null,
    runs,
  };
}

function sweepSnapshotRelativePath(revision: string): string {
  return `.rpg-harness/sweeps/${revision}.json`;
}

function branchTarget(
  item: DevelopmentWorkItem,
  prefix: string,
  index: number,
): string | null {
  if (!createsBranch(item)) return null;
  return `${prefix}-${String(index + 1).padStart(3, "0")}`;
}

function createsBranch(item: DevelopmentWorkItem): boolean {
  return ["reproduce", "verify-audit", "verify-autoplay", "cover", "reach", "reach-script"]
    .includes(item.operation.command);
}

async function preflightTargets(
  args: SweepArgs,
  items: DevelopmentWorkItem[],
  targets: Array<string | null>,
): Promise<string[]> {
  const expanded: string[] = [];
  for (const [index, item] of items.entries()) {
    const target = targets[index];
    if (!target) continue;
    assertSessionName(target);
    if (target === args.session) {
      throw new Error(`Sweep target would overwrite source session: ${target}`);
    }
    if (item.operation.command === "verify-audit") {
      const report = await getPlaytestReport(args.gameDir, item.operation.args.reportId);
      const personas = report.evidence.auditMatrix?.lanes.map((lane) => lane.persona) ?? [];
      expanded.push(
        `${target}-source`,
        ...personas.map((persona) => `${target}-${persona}`),
      );
    } else if (item.operation.command === "verify-autoplay") {
      expanded.push(`${target}-source`, `${target}-run`);
    } else {
      expanded.push(target);
    }
  }
  if (new Set(expanded).size !== expanded.length) {
    throw new Error("Sweep target session names are not unique");
  }
  for (const session of expanded) {
    assertSessionName(session);
    await assertTargetEmpty(args.gameDir, session);
  }
  return expanded;
}

function validateSweepArgs(args: SweepArgs): void {
  assertSessionName(args.sessionPrefix);
  if (!Number.isInteger(args.limit) || args.limit < 1) {
    throw new Error("--limit must be a positive integer");
  }
  if (args.maxSteps !== undefined && (!Number.isInteger(args.maxSteps) || args.maxSteps < 1)) {
    throw new Error("--max-steps must be a positive integer");
  }
  if (args.maxNodes !== undefined && (!Number.isInteger(args.maxNodes) || args.maxNodes < 1)) {
    throw new Error("--max-nodes must be a positive integer");
  }
  if (
    args.maxTotalNodes !== undefined &&
    (!Number.isInteger(args.maxTotalNodes) || args.maxTotalNodes < 1)
  ) {
    throw new Error("--max-total-nodes must be a positive integer");
  }
}

function searchNodes(result: WorkResult): number {
  if (!result.result || typeof result.result !== "object") return 0;
  const search = (result.result as { search?: unknown }).search;
  if (!search || typeof search !== "object") return 0;
  const explored = (search as { exploredNodes?: unknown }).exploredNodes;
  return typeof explored === "number" && Number.isFinite(explored) ? explored : 0;
}

function searchHitNodeLimit(result: WorkResult): boolean {
  if (!result.result || typeof result.result !== "object") return false;
  return (result.result as { reason?: unknown }).reason === "max-nodes";
}

async function anyTargetWritten(gameDir: string, sessions: string[]): Promise<boolean> {
  for (const session of sessions) {
    try {
      await assertTargetEmpty(gameDir, session);
    } catch (error) {
      if ((error as Error).message === `Target session already exists: ${session}`) {
        return true;
      }
      throw error;
    }
  }
  return false;
}
