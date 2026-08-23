import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSessionName } from "@rpg-harness/session-store";
import { getPlaytestReport } from "../playtest-reports";
import { sessionDir } from "../session";
import { loadGame } from "../loader";
import type { AuditSummary } from "./audit";
import {
  type ProjectQualityAuditSummary,
  type ProjectQualityFuzzAuditSummary,
  projectQualityGateTargetSessions,
  runProjectQualityGate,
} from "./quality-certificate";
import { assertTargetEmpty } from "./fork";
import {
  executeDevelopmentWorkItem,
  type WorkResult,
} from "./work";
import type { ReachChoiceContinuation } from "./reach-choice";
import type { ReachScriptContinuation } from "./reach-script";
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
  /** Per-slice decision budget for the final project acceptance matrix. */
  auditMaxSteps?: number;
  /** Maximum resumable slices for each final audit persona. */
  auditMaxSegments?: number;
  /** Stable root seed for the final project acceptance matrix. */
  auditSeed?: number;
  /** Ignore a matching project-quality certificate and rerun every audit lane. */
  forceAudit?: boolean;
  /** Continue materialized search frontiers and freeze later worklist generations. */
  untilClean?: boolean;
  /** Hard cap for immutable worklist generations in `untilClean` mode. */
  maxGenerations?: number;
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
    | "search-budget-exhausted"
    | "search-stalled";
  snapshot: {
    revision: string;
    file: string;
    sourceSession: string | null;
    /** Queue authority: one lineage for regular sweep, whole project for convergence. */
    scope: "session" | "project";
    totalItems: number;
    startIndex: number;
    selectedItems: number;
    completedItems: number;
    remainingItems: number;
    nextKey: string | null;
  };
  safety: {
    immutableWorklist: true;
    preflightedTargets: string[];
    sourceWrites: false;
    nodeBudget: { limit: number; used: number; remaining: number };
    searchStalls: Array<{
      key: string;
      targetSession: string | null;
      attempt: number;
      reason: "no-state-progress";
    }>;
  };
  resume: {
    fromKey: string;
    snapshotRevision: string;
    /** Continue the paused search from its materialized frontier branch first. */
    next?: ReachChoiceContinuation["next"] | ReachScriptContinuation["next"];
  } | null;
  runs: Array<{
    index: number;
    attempt?: number;
    key: string;
    targetSession: string | null;
    status: WorkResult["status"];
    evidence: {
      safety: WorkResult["safety"];
      output: unknown;
    };
  }>;
}

export interface SweepConvergenceResult {
  schemaVersion: 1;
  mode: "until-clean";
  /** Convergence certifies the project queue; sourceSession is a fork/search root. */
  scope: "project";
  status: "clean" | "paused" | "stopped";
  reason:
    | "clean"
    | "item-budget-exhausted"
    | "generation-budget-exhausted"
    | "search-budget-exhausted"
    | "work-failed"
    | "authoring-required"
    | "quality-gate-failed"
    | "search-stalled"
    | "queue-stalled";
  sourceSession: string;
  budgets: {
    items: { limit: number; used: number; remaining: number };
    generations: { limit: number; used: number; remaining: number };
    nodes: { limit: number; used: number; remaining: number };
  };
  safety: {
    immutableGenerations: true;
    sourceWrites: false;
    preflightedTargets: string[];
    searchStalls: Array<{
      generation: number;
      key: string;
      targetSession: string | null;
      attempt: number;
      reason: "no-state-progress";
    }>;
  };
  liveWorklist: {
    scope: "project";
    totalItems: number;
    nextKey: string | null;
  };
  qualityGate?: {
    status: "passed" | "failed" | "not-evaluated" | "not-configured";
    mode: "executed" | "certificate" | "not-configured";
    sessionPrefix: string;
    inputRevision?: string;
    certificate?: { revision: string; file: string };
    audits?: ProjectQualityAuditSummary[];
    fuzzAudits?: ProjectQualityFuzzAuditSummary[];
  };
  resume: SweepResult["resume"];
  generations: Array<{
    generation: number;
    sessionPrefix: string;
    result: SweepResult;
  }>;
}

export type {
  ProjectQualityAuditSummary,
  ProjectQualityFuzzAuditSummary,
} from "./quality-certificate";

interface PersistedSweepSnapshot {
  schemaVersion: 1;
  revision: string;
  sourceSession: string | null;
  scope: "session" | "project";
  items: DevelopmentWorkItem[];
}

interface SweepAttempt {
  index: number;
  item: DevelopmentWorkItem;
  attemptItem: DevelopmentWorkItem;
  firstTarget: string | null;
  targetSession: string | null;
  attempt: number;
}

export async function sweepCommand(args: SweepArgs): Promise<void> {
  const result = args.untilClean
    ? await runDevelopmentConvergence(args)
    : await runDevelopmentSweep(args);
  process.stdout.write(
    (args.pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result)) + "\n",
  );
  if (result.status === "stopped") process.exitCode = 1;
}

/**
 * Consume multiple immutable queue generations without turning the scheduler
 * into an unbounded daemon. `limit`, `maxGenerations`, and `maxTotalNodes` are
 * shared hard budgets across the whole convergence run.
 */
export async function runDevelopmentConvergence(
  args: SweepArgs,
): Promise<SweepConvergenceResult> {
  validateSweepArgs(args);
  if (!args.session) throw new Error("--until-clean requires --session SOURCE");
  const generationLimit = args.maxGenerations ?? 5;
  if (!Number.isInteger(generationLimit) || generationLimit < 1) {
    throw new Error("--max-generations must be a positive integer");
  }
  if (args.fromKey !== undefined || args.snapshotRevision !== undefined) {
    throw new Error(
      "--until-clean starts from the live queue; use a regular sweep to resume a frozen snapshot",
    );
  }

  const itemLimit = args.limit;
  const nodeLimit = args.maxTotalNodes ?? 5_000;
  let usedItems = 0;
  let usedNodes = 0;
  const generations: SweepConvergenceResult["generations"] = [];
  const revisions = new Set<string>();
  let finalStatus: SweepConvergenceResult["status"] = "paused";
  let finalReason: SweepConvergenceResult["reason"] = "generation-budget-exhausted";
  let resume: SweepResult["resume"] = null;
  let qualityGate: SweepConvergenceResult["qualityGate"];

  for (let generation = 1; generation <= generationLimit; generation += 1) {
    const remainingItems = itemLimit - usedItems;
    const remainingNodes = nodeLimit - usedNodes;
    if (remainingItems <= 0) {
      finalReason = "item-budget-exhausted";
      break;
    }
    if (remainingNodes <= 0) {
      finalReason = "search-budget-exhausted";
      break;
    }

    const generationPrefix = `${args.sessionPrefix}-g${String(generation).padStart(2, "0")}`;
    assertSessionName(generationPrefix);
    const result = await runDevelopmentSweepInternal({
      ...args,
      sessionPrefix: generationPrefix,
      limit: remainingItems,
      maxTotalNodes: remainingNodes,
      untilClean: false,
    }, true, true);
    generations.push({ generation, sessionPrefix: generationPrefix, result });
    usedItems += attemptedWorkItems(result);
    usedNodes += result.safety.nodeBudget.used;
    resume = result.resume;

    if (result.status === "clean") {
      ({ finalStatus, finalReason, qualityGate } = await evaluateProjectQualityGate(
        args,
        generation,
      ));
      resume = null;
      break;
    }
    if (result.status === "paused") {
      finalStatus = "paused";
      finalReason = "search-budget-exhausted";
      break;
    }
    if (result.status === "stopped") {
      finalStatus = "stopped";
      finalReason = result.reason === "authoring-required"
        ? "authoring-required"
        : result.reason === "search-stalled"
          ? "search-stalled"
          : "work-failed";
      break;
    }
    if (result.reason === "budget-exhausted") {
      finalStatus = "paused";
      finalReason = "item-budget-exhausted";
      break;
    }
    if (revisions.has(result.snapshot.revision)) {
      finalStatus = "stopped";
      finalReason = "queue-stalled";
      break;
    }
    revisions.add(result.snapshot.revision);
    resume = null;
    const nextSnapshot = await createSweepSnapshot(
      args.gameDir,
      args.session,
      null,
    );
    if (nextSnapshot.items.length === 0) {
      ({ finalStatus, finalReason, qualityGate } = await evaluateProjectQualityGate(
        args,
        generation,
      ));
      break;
    }
    if (revisions.has(nextSnapshot.revision)) {
      finalStatus = "stopped";
      finalReason = "queue-stalled";
      break;
    }
  }

  let live = await collectDevelopmentWorklist(args.gameDir);
  if (live.items.length === 0 && qualityGate === undefined) {
    ({ finalStatus, finalReason, qualityGate } = await evaluateProjectQualityGate(
      args,
      Math.max(1, generations.length),
    ));
    resume = null;
    // A failed project gate records a new global audit finding. Refresh the
    // project queue so this same response hands the coding issue to the
    // next autonomous development generation.
    live = await collectDevelopmentWorklist(args.gameDir);
  } else if (
    generations.length >= generationLimit &&
    finalReason === "generation-budget-exhausted"
  ) {
    finalStatus = "paused";
  }

  const preflightedTargets = generations.flatMap(({ result }) =>
    result.safety.preflightedTargets
  );
  const searchStalls = generations.flatMap(({ generation, result }) =>
    result.safety.searchStalls.map((stall) => ({ generation, ...stall }))
  );
  return {
    schemaVersion: 1,
    mode: "until-clean",
    scope: "project",
    status: finalStatus,
    reason: finalReason,
    sourceSession: args.session,
    budgets: {
      items: {
        limit: itemLimit,
        used: usedItems,
        remaining: Math.max(0, itemLimit - usedItems),
      },
      generations: {
        limit: generationLimit,
        used: generations.length,
        remaining: Math.max(0, generationLimit - generations.length),
      },
      nodes: {
        limit: nodeLimit,
        used: usedNodes,
        remaining: Math.max(0, nodeLimit - usedNodes),
      },
    },
    safety: {
      immutableGenerations: true,
      sourceWrites: false,
      preflightedTargets,
      searchStalls,
    },
    liveWorklist: {
      scope: "project",
      totalItems: live.items.length,
      nextKey: live.items[0]?.key ?? null,
    },
    ...(qualityGate ? { qualityGate } : {}),
    resume,
    generations,
  };
}

async function evaluateProjectQualityGate(
  args: SweepArgs,
  generation: number,
): Promise<{
  finalStatus: SweepConvergenceResult["status"];
  finalReason: SweepConvergenceResult["reason"];
  qualityGate: NonNullable<SweepConvergenceResult["qualityGate"]>;
}> {
  const sessionPrefix = `${args.sessionPrefix}-quality-gate-g${String(generation).padStart(2, "0")}`;
  const qualityGate = await runProjectQualityGate({
    gameDir: args.gameDir,
    sessionPrefix,
    ...(args.auditMaxSteps !== undefined ? { maxSteps: args.auditMaxSteps } : {}),
    ...(args.auditMaxSegments !== undefined
      ? { maxSegments: args.auditMaxSegments }
      : {}),
    ...(args.auditSeed !== undefined ? { auditSeed: args.auditSeed } : {}),
    force: args.forceAudit ?? false,
  });
  if (qualityGate.status === "passed" || qualityGate.status === "not-configured") {
    return { finalStatus: "clean", finalReason: "clean", qualityGate };
  }
  return {
    finalStatus: "stopped",
    finalReason: "quality-gate-failed",
    qualityGate,
  };
}

/**
 * Execute a bounded, frozen development batch. The queue is collected once so
 * earlier branches cannot silently re-rank later work, and every branch name
 * is checked before the first write.
 */
export async function runDevelopmentSweep(args: SweepArgs): Promise<SweepResult> {
  return runDevelopmentSweepInternal(args, false);
}

async function runDevelopmentSweepInternal(
  args: SweepArgs,
  autoContinueSearches: boolean,
  projectWide = false,
): Promise<SweepResult> {
  validateSweepArgs(args);
  const snapshot = args.snapshotRevision === undefined
    ? await createSweepSnapshot(
        args.gameDir,
        args.session,
        projectWide ? null : args.session,
      )
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
        (await collectDevelopmentWorklist(
          args.gameDir,
          snapshot.scope === "project" ? undefined : args.session,
        )).items
          .map((item) => item.key),
      );
  const queuedItems = allItems
    .slice(startIndex)
    .filter((item) => liveKeys === null || liveKeys.has(item.key));
  const selected = queuedItems.slice(0, args.limit);

  if (selected.length === 0) {
    return resultEnvelope(
      args,
      snapshotRevision,
      snapshot.scope,
      allItems,
      startIndex,
      selected,
      [],
      [],
      { status: "clean", reason: "clean" },
      0,
      queuedItems,
    );
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
    | "search-stalled"
    | null = null;

  const queue: SweepAttempt[] = selected.map((item, index) => ({
    index,
    item,
    attemptItem: item,
    firstTarget: targets[index] ?? null,
    targetSession: targets[index] ?? null,
    attempt: 1,
  }));
  let searchBudgetBlocked = false;
  const searchStalls: SweepResult["safety"]["searchStalls"] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const { index, item, attemptItem, firstTarget, targetSession, attempt } = current;
    const searches = attemptItem.operation.command === "reach" ||
      attemptItem.operation.command === "reach-script";
    const remainingNodes = Math.max(0, totalNodeLimit - usedNodes);
    if (searches && remainingNodes === 0) {
      searchBudgetBlocked = true;
      continue;
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
      }, attemptItem);
    } catch (error) {
      const possibleTargets = targetSession === null ? [] : [targetSession];
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
        operation: attemptItem.operation,
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
      ...(attempt > 1 ? { attempt } : {}),
      key: item.key,
      targetSession,
      status: result.status,
      evidence: {
        safety: result.safety,
        output: compactSweepOutput(result),
      },
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
    if (result.status === "paused") {
      const next = workSearchContinuation(result);
      // A regular frozen sweep does not auto-resume the same search slice, but
      // it must still give every later selected item its turn. Keep this item
      // unresolved (and its exact continuation in `runs`) while spending the
      // shared node budget on the rest of the immutable queue.
      if (!autoContinueSearches) {
        searchBudgetBlocked = true;
        continue;
      }
      const canContinue = next !== null &&
        consumedNodes > 0 &&
        firstTarget !== null;
      if (!canContinue) {
        stoppedReason = "search-budget-exhausted";
        break;
      }
      if (!await searchContinuationChangedState(
        args.gameDir,
        attemptItem,
        args.session,
        targetSession,
      )) {
        searchStalls.push({
          key: item.key,
          targetSession,
          attempt,
          reason: "no-state-progress",
        });
        continue;
      }
      if (usedNodes >= totalNodeLimit) {
        searchBudgetBlocked = true;
        continue;
      }
      const nextAttempt = attempt + 1;
      const nextTarget = `${firstTarget}-c${String(nextAttempt - 1).padStart(2, "0")}`;
      assertSessionName(nextTarget);
      await assertTargetEmpty(args.gameDir, nextTarget);
      preflightedTargets.push(nextTarget);
      queue.push({
        index,
        item,
        attemptItem: continueSearchItem(item, next),
        firstTarget,
        targetSession: nextTarget,
        attempt: nextAttempt,
      });
      continue;
    }
    if (result.status === "prepared") {
      stoppedReason = "authoring-required";
      break;
    }
  }
  if (!stoppedReason && searchBudgetBlocked) {
    stoppedReason = "search-budget-exhausted";
  } else if (!stoppedReason && searchStalls.length > 0) {
    stoppedReason = "search-stalled";
  }

  if (stoppedReason) {
    return resultEnvelope(
      args,
      snapshotRevision,
      snapshot.scope,
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
      searchStalls,
    );
  }
  const exhausted = selected.length < queuedItems.length;
  return resultEnvelope(
    args,
    snapshotRevision,
    snapshot.scope,
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
    searchStalls,
  );
}

async function createSweepSnapshot(
  gameDir: string,
  sourceSession: string | undefined,
  scopeSession: string | null | undefined = sourceSession,
): Promise<PersistedSweepSnapshot> {
  const worklist = await collectDevelopmentWorklist(
    gameDir,
    scopeSession === null ? undefined : scopeSession,
  );
  const source = sourceSession ?? null;
  const scope = scopeSession == null ? "project" as const : "session" as const;
  const revision = createHash("sha256")
    .update(JSON.stringify({ sourceSession: source, scope, items: worklist.items }))
    .digest("hex");
  return {
    schemaVersion: 1,
    revision,
    sourceSession: source,
    scope,
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
      scope: snapshot.scope,
      items: snapshot.items,
    }))
    .digest("hex");
  if (
    snapshot.schemaVersion !== 1 ||
    (snapshot.scope !== "session" && snapshot.scope !== "project") ||
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
  scope: PersistedSweepSnapshot["scope"],
  allItems: DevelopmentWorkItem[],
  startIndex: number,
  selected: DevelopmentWorkItem[],
  preflightedTargets: string[],
  runs: SweepResult["runs"],
  outcome: Pick<SweepResult, "status" | "reason">,
  usedNodes = 0,
  pendingItems = allItems.slice(startIndex),
  searchStalls: SweepResult["safety"]["searchStalls"] = [],
): SweepResult {
  const completedKeys = new Set(
    runs.filter((run) => run.status === "executed").map((run) => run.key),
  );
  const completedItems = completedKeys.size;
  const remainingKeys = pendingItems
    .filter((item) => !completedKeys.has(item.key))
    .map((item) => item.key);
  const next = pausedSearchContinuation(runs, remainingKeys[0]);
  return {
    schemaVersion: 1,
    ...outcome,
    snapshot: {
      revision,
      file: sweepSnapshotRelativePath(revision),
      sourceSession: args.session ?? null,
      scope,
      totalItems: allItems.length,
      startIndex,
      selectedItems: selected.length,
      completedItems,
      remainingItems: remainingKeys.length,
      nextKey: remainingKeys[0] ?? null,
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
      searchStalls,
    },
    resume: remainingKeys[0]
      ? {
          fromKey: remainingKeys[0],
          snapshotRevision: revision,
          ...(next ? { next } : {}),
        }
      : null,
    runs,
  };
}

function pausedSearchContinuation(
  runs: SweepResult["runs"],
  key?: string,
): ReachChoiceContinuation["next"] | ReachScriptContinuation["next"] | null {
  const last = [...runs].reverse().find((run) =>
    run.status === "paused" && (key === undefined || run.key === key)
  );
  if (last?.status !== "paused" || !isRecord(last.evidence.output)) return null;
  const continuation = last.evidence.output.continuation;
  if (!isRecord(continuation) || !isRecord(continuation.next)) return null;
  const next = continuation.next;
  if (next.command !== "reach" && next.command !== "reach-script") return null;
  if (!isRecord(next.args)) return null;
  return next as unknown as
    | ReachChoiceContinuation["next"]
    | ReachScriptContinuation["next"];
}

function workSearchContinuation(
  result: WorkResult,
): ReachChoiceContinuation["next"] | ReachScriptContinuation["next"] | null {
  if (result.status !== "paused" || !isRecord(result.result)) return null;
  const continuation = result.result.continuation;
  if (!isRecord(continuation) || !isRecord(continuation.next)) return null;
  const next = continuation.next;
  if (next.command !== "reach" && next.command !== "reach-script") return null;
  if (!isRecord(next.args)) return null;
  return next as unknown as
    | ReachChoiceContinuation["next"]
    | ReachScriptContinuation["next"];
}

async function searchContinuationChangedState(
  gameDir: string,
  item: DevelopmentWorkItem,
  rootSession: string | undefined,
  targetSession: string | null,
): Promise<boolean> {
  if (targetSession === null) return true;
  if (item.operation.command !== "reach" && item.operation.command !== "reach-script") {
    return true;
  }
  const declaredSource = item.operation.args.fromSession;
  const sourceSession = declaredSource === "<source-session>"
    ? rootSession
    : declaredSource;
  if (!sourceSession) return true;
  try {
    const [sourceState, targetState] = await Promise.all([
      readFile(path.join(sessionDir(gameDir, sourceSession), "state.json"), "utf-8"),
      readFile(path.join(sessionDir(gameDir, targetSession), "state.json"), "utf-8"),
    ]);
    return sourceState !== targetState;
  } catch {
    // The reach result already replay-verified its materialized target. If a
    // concurrent diagnostic removes one of the comparison files, fail open to
    // the global node bound instead of falsely declaring causal stagnation.
    return true;
  }
}

function continueSearchItem(
  item: DevelopmentWorkItem,
  next: ReachChoiceContinuation["next"] | ReachScriptContinuation["next"],
): DevelopmentWorkItem {
  if (next.command === "reach") {
    if (item.operation.command !== "reach") {
      throw new Error(`Search continuation changed command for ${item.key}`);
    }
    return {
      ...item,
      operation: {
        command: "reach",
        args: {
          key: next.args.key,
          fromSession: next.args.fromSession,
          fromLogEntry: next.args.fromLogEntry,
          searchCheckpointRevision: next.args.searchCheckpointRevision,
          session: "<new-session>",
        },
      },
    };
  }
  if (item.operation.command !== "reach-script") {
    throw new Error(`Search continuation changed command for ${item.key}`);
  }
  return {
    ...item,
    operation: {
      command: "reach-script",
      args: {
        scriptId: next.args.scriptId,
        fromSession: next.args.fromSession,
        fromLogEntry: next.args.fromLogEntry,
        searchCheckpointRevision: next.args.searchCheckpointRevision,
        session: "<new-session>",
      },
    },
  };
}

function attemptedWorkItems(result: SweepResult): number {
  return new Set(result.runs.map((run) => run.key)).size;
}

function compactSweepOutput(result: WorkResult): unknown {
  if (result.operation?.command !== "cover" || !isRecord(result.result)) {
    return result.result;
  }
  const output = result.result;
  const progress = isRecord(output.progress)
    ? {
        madeProgress: output.progress.madeProgress,
        completedScripts: boundedSweepList(output.progress.completedScripts),
        objectiveChanges: boundedSweepList(output.progress.objectiveChanges),
      }
    : undefined;
  const decisionPath = isRecord(output.decisionPath) &&
      typeof output.decisionPath.revision === "string"
    ? { revision: output.decisionPath.revision }
    : undefined;
  const targetChoice = isRecord(output.targetChoice)
    ? {
        key: output.targetChoice.key,
        optionId: output.targetChoice.optionId,
        status: output.targetChoice.status,
      }
    : undefined;
  return {
    reason: output.reason,
    ...(progress ? { progress } : {}),
    ...(decisionPath ? { decisionPath } : {}),
    inputs: output.inputs,
    rejectedInputs: output.rejectedInputs,
    visibleOutputs: output.visibleOutputs,
    ending: output.ending,
    session: output.session,
    webPath: output.webPath,
    ...(targetChoice ? { targetChoice } : {}),
    targetScriptCompleted: output.targetScriptCompleted,
  };
}

function boundedSweepList(value: unknown): { count: number; recent: unknown[] } {
  const items = Array.isArray(value) ? value : [];
  return { count: items.length, recent: items.slice(-10) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
  return ["reproduce", "verify-audit", "verify-autoplay", "verify-feedback", "cover", "reach", "reach-script"]
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
    } else if (item.operation.command === "verify-feedback") {
      expanded.push(...await projectQualityGateTargetSessions(
        args.gameDir,
        target,
        args.auditSeed ?? 1_592_597_881,
      ));
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
  if (
    args.auditMaxSteps !== undefined &&
    (!Number.isInteger(args.auditMaxSteps) || args.auditMaxSteps < 1)
  ) {
    throw new Error("--audit-max-steps must be a positive integer");
  }
  if (
    args.auditMaxSegments !== undefined &&
    (!Number.isInteger(args.auditMaxSegments) || args.auditMaxSegments < 1)
  ) {
    throw new Error("--audit-max-segments must be a positive integer");
  }
  if (
    args.auditSeed !== undefined &&
    (!Number.isInteger(args.auditSeed) || args.auditSeed < 0 || args.auditSeed > 0xffff_ffff)
  ) {
    throw new Error("--audit-seed must be a uint32 integer");
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
