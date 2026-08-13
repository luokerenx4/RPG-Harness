import { getPlaytestReport, reproducePlaytestReport } from "../playtest-reports";
import { runChoiceCoverageWorkItem } from "./cover-choice";
import type { CoverChoiceSummary } from "./cover-choice";
import { inspectScript } from "./inspect-script";
import { inspectSession } from "./inspect-session";
import {
  runReachChoice,
  summarizeReachPath,
  type ReachChoiceSummary,
} from "./reach-choice";
import { runReachScript, type ReachScriptSummary } from "./reach-script";
import { verifyAuditReport } from "./verify-audit";
import { verifyAutoplayReport } from "./verify-autoplay";
import { verifyFeedbackReport } from "./verify-feedback";
import { collectSessionTranscript } from "./transcript";
import {
  attachDevelopmentBranchHandoff,
  type DevelopmentBranchHandoff,
} from "./fork";
import {
  collectDevelopmentWorklist,
  type DevelopmentOperation,
  type DevelopmentWorkItem,
} from "./worklist";

export interface WorkArgs {
  gameDir: string;
  key?: string;
  session?: string;
  newSession?: string;
  persona?: string;
  maxSteps?: number;
  maxNodes?: number;
  pretty: boolean;
}

export interface WorkResult {
  schemaVersion: 1;
  status: "clean" | "executed" | "paused" | "prepared" | "failed";
  selection: {
    key: string;
    priority: DevelopmentWorkItem["priority"];
    kind: DevelopmentWorkItem["kind"];
    actionability: DevelopmentWorkItem["actionability"];
    title: string;
  } | null;
  operation: DevelopmentOperation | null;
  safety: {
    mode: "none" | "read-only" | "isolated-session" | "authoring";
    writes: boolean;
    targetSession: string | null;
  };
  result: unknown;
}

export async function workCommand(args: WorkArgs): Promise<void> {
  const result = await runDevelopmentWorkItem(args);
  process.stdout.write(
    (args.pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result)) + "\n",
  );
  if (result.status === "failed") process.exitCode = 1;
}

/** Select and execute one structured worklist operation with explicit write boundaries. */
export async function runDevelopmentWorkItem(args: WorkArgs): Promise<WorkResult> {
  validateLimits(args);
  const worklist = await collectDevelopmentWorklist(args.gameDir, args.session);
  const item = selectWorkItem(worklist.items, args.key);
  if (!item) {
    return {
      schemaVersion: 1,
      status: "clean",
      selection: null,
      operation: null,
      safety: { mode: "none", writes: false, targetSession: null },
      result: { summary: worklist.summary },
    };
  }

  return executeDevelopmentWorkItem(args, item);
}

/** Execute an already selected/frozen item without re-ranking the live queue. */
export async function executeDevelopmentWorkItem(
  args: WorkArgs,
  item: DevelopmentWorkItem,
): Promise<WorkResult> {
  validateLimits(args);

  const selection = {
    key: item.key,
    priority: item.priority,
    kind: item.kind,
    actionability: item.actionability,
    title: item.title,
  };
  const operation = item.operation;

  switch (operation.command) {
    case "inspect-session":
      return executed(selection, operation, "read-only", false, null, await inspectSession({
        gameDir: args.gameDir,
        session: operation.args.session,
        surfaces: operation.args.surfaces,
        pretty: false,
      }));
    case "inspect-report":
      return executed(selection, operation, "read-only", false, null, await getPlaytestReport(
        args.gameDir,
        operation.args.reportId,
        operation.args.session,
      ));
    case "transcript":
      return executed(selection, operation, "read-only", false, null, await collectSessionTranscript(
        args.gameDir,
        operation.args.session,
        operation.args.tail,
      ));
    case "inspect-script":
      return executed(selection, operation, "read-only", false, null, await inspectScript({
        gameDir: args.gameDir,
        scriptId: operation.args.scriptId,
        ...(args.session !== undefined ? { session: args.session } : {}),
        pretty: false,
      }));
    case "reproduce": {
      const target = requireNewSession(args, item);
      const result = await reproducePlaytestReport({
        gameDir: args.gameDir,
        id: operation.args.reportId,
        session: operation.args.session,
        to: target,
      });
      const handoff = await attachWorkHandoff(args, item, target, "reproduced");
      return executed(selection, operation, "isolated-session", true, target, {
        ...result,
        handoff,
      });
    }
    case "verify-audit": {
      const target = requireNewSession(args, item);
      const result = await verifyAuditReport({
        gameDir: args.gameDir,
        reportId: operation.args.reportId,
        sessionPrefix: target,
      });
      return result.status === "verified"
        ? executed(selection, operation, "isolated-session", true, target, result)
        : failedAfterWrite(selection, operation, target, result);
    }
    case "verify-autoplay": {
      const target = requireNewSession(args, item);
      const result = await verifyAutoplayReport({
        gameDir: args.gameDir,
        reportId: operation.args.reportId,
        sessionPrefix: target,
      });
      return result.status === "verified"
        ? executed(selection, operation, "isolated-session", true, target, result)
        : failedAfterWrite(selection, operation, target, result);
    }
    case "verify-feedback": {
      const target = requireNewSession(args, item);
      const report = await getPlaytestReport(args.gameDir, operation.args.reportId);
      const result = await verifyFeedbackReport({
        gameDir: args.gameDir,
        reportId: operation.args.reportId,
        sessionPrefix: target,
        resolution: `AI changed the project after this feedback and passed the current project quality gate.`,
      });
      return result.status === "verified"
        ? executed(selection, operation, "isolated-session", true, target, result)
        : failedAfterWrite(selection, operation, target, result);
    }
    case "cover": {
      const target = requireNewSession(args, item);
      const result = await runChoiceCoverageWorkItem({
        gameDir: args.gameDir,
        session: target,
        ...(operation.args.sourceSession
          ? { sourceSession: operation.args.sourceSession }
          : {}),
        key: operation.args.key,
        persona: args.persona ?? "objective",
        maxSteps: args.maxSteps ?? 1000,
        verbose: false,
        pretty: false,
      });
      const handoff = await attachWorkHandoff(args, item, target, "covered");
      return executed(
        selection,
        operation,
        "isolated-session",
        true,
        target,
        { ...compactCoverResult(result), handoff },
      );
    }
    case "reach": {
      const target = requireNewSession(args, item);
      const fromSession = operation.args.fromSession === "<source-session>"
        ? args.session
        : operation.args.fromSession;
      if (!fromSession) {
        throw new Error(
          `Work item ${item.key} needs a source lineage; pass --session NAME`,
        );
      }
      const result = await runReachChoice({
        gameDir: args.gameDir,
        fromSession,
        session: target,
        key: operation.args.key,
        maxNodes: args.maxNodes ?? 5000,
        maxSteps: args.maxSteps ?? 250,
        reportOnMiss: false,
        reportOnQuality: true,
        pretty: false,
      });
      const wroteSession = result.session !== undefined;
      const handoff = wroteSession
        ? await attachWorkHandoff(
            args,
            item,
            result.session!,
            result.found ? "target-reached" : "closest",
          )
        : undefined;
      const compact = {
        ...compactReachResult(result),
        ...(handoff ? { handoff } : {}),
      };
      return result.found
        ? executed(
            selection,
            operation,
            wroteSession ? "isolated-session" : "read-only",
            wroteSession,
            result.session ?? null,
            compact,
          )
        : result.status === "paused"
          ? pausedAfterWrite(
              selection,
              operation,
              result.session ?? target,
              compact,
            )
          : failedAfterWrite(
              selection,
              operation,
              result.session ?? target,
              compact,
            );
    }
    case "reach-script": {
      const target = requireNewSession(args, item);
      const fromSession = operation.args.fromSession === "<source-session>"
        ? args.session
        : operation.args.fromSession;
      if (!fromSession) {
        throw new Error(
          `Work item ${item.key} needs a source lineage; pass --session NAME`,
        );
      }
      const result = await runReachScript({
        gameDir: args.gameDir,
        fromSession,
        session: target,
        scriptId: operation.args.scriptId,
        maxNodes: args.maxNodes ?? 5000,
        maxSteps: args.maxSteps ?? 250,
        pretty: false,
      });
      const handoff = await attachWorkHandoff(
        args,
        item,
        result.session ?? target,
        result.found ? "covered" : "closest",
      );
      const compact = { ...compactReachScriptResult(result), handoff };
      return result.found
        ? executed(
            selection,
            operation,
            "isolated-session",
            true,
            result.session ?? null,
            compact,
          )
        : result.status === "paused"
          ? pausedAfterWrite(
              selection,
              operation,
              result.session ?? target,
              compact,
            )
          : failedAfterWrite(
              selection,
              operation,
              result.session ?? target,
              compact,
            );
    }
    case "edit": {
      const scriptId = typeof item.coordinates.scriptId === "string"
        ? item.coordinates.scriptId
        : null;
      const context = scriptId
        ? await inspectScript({
            gameDir: args.gameDir,
            scriptId,
            ...(args.session !== undefined ? { session: args.session } : {}),
            pretty: false,
          })
        : null;
      return {
        schemaVersion: 1,
        status: "prepared",
        selection,
        operation,
        safety: { mode: "authoring", writes: false, targetSession: null },
        result: {
          target: operation.args.target,
          key: operation.args.key,
          ...(operation.args.beatIndex !== undefined
            ? { beatIndex: operation.args.beatIndex }
            : {}),
          coordinates: item.coordinates,
          context,
          note: "Authoring judgment is required; no source files were changed.",
        },
      };
    }
  }
}

async function attachWorkHandoff(
  args: WorkArgs,
  item: DevelopmentWorkItem,
  session: string,
  state: DevelopmentBranchHandoff["state"],
): Promise<DevelopmentBranchHandoff> {
  const coordinates = workHandoffCoordinates(item);
  return attachDevelopmentBranchHandoff(args.gameDir, session, {
    schemaVersion: 1,
    workKey: item.key,
    priority: item.priority,
    kind: item.kind,
    title: item.title,
    operation: item.operation.command,
    state,
    preparedAt: new Date().toISOString(),
    ...(item.target ? { target: item.target } : {}),
    ...(coordinates ? { coordinates } : {}),
  });
}

function workHandoffCoordinates(
  item: DevelopmentWorkItem,
): NonNullable<DevelopmentBranchHandoff["coordinates"]> | null {
  const coordinates = Object.fromEntries(
    (["reportId", "scriptId", "choiceId", "optionId"] as const)
      .flatMap((key) =>
        typeof item.coordinates[key] === "string" && item.coordinates[key].trim()
          ? [[key, item.coordinates[key]]]
          : []
      ),
  ) as NonNullable<DevelopmentBranchHandoff["coordinates"]>;
  return Object.keys(coordinates).length > 0 ? coordinates : null;
}

function compactCoverResult(result: CoverChoiceSummary) {
  return {
    reason: result.reason,
    ...(result.error ? { error: result.error } : {}),
    progress: result.progress,
    decisionPath: result.decisionPath,
    inputs: result.decisions,
    rejectedInputs: result.rejectedInputs,
    visibleOutputs: result.steps,
    ending: result.ending,
    session: result.session,
    webPath: result.webPath,
    ...(result.fork ? { fork: result.fork } : {}),
    ...(result.report ? { report: result.report } : {}),
    ...(result.choiceCoverage
      ? { choiceCoverage: { summary: result.choiceCoverage.summary } }
      : {}),
    targetChoice: result.targetChoice,
    targetScriptCompleted: result.targetScriptCompleted,
    responseTrace: result.responseTrace,
    ...(result.playerHandoff ? { playerHandoff: result.playerHandoff } : {}),
    workItem: {
      key: result.workItem.key,
      scriptId: result.workItem.scriptId,
      choiceId: result.workItem.choiceId,
      optionId: result.workItem.optionId,
    },
  };
}

function compactReachResult(result: ReachChoiceSummary) {
  return {
    status: result.status,
    found: result.found,
    reason: result.reason,
    target: {
      key: result.target.key,
      scriptId: result.target.scriptId,
      choiceId: result.target.choiceId,
    },
    path: result.path,
    search: {
      exploredNodes: result.exploredNodes,
      visitedStates: result.visitedStates,
      deepestSteps: result.deepestSteps,
      attemptedSources: result.attemptedSources,
    },
    source: result.source,
    requestedSession: result.requestedSession,
    ...(result.session ? { session: result.session } : {}),
    ...(result.webPath ? { webPath: result.webPath } : {}),
    ...(result.fork ? { fork: result.fork } : {}),
    output: compactOutput(result.output),
    replayVerified: result.replayVerified,
    ...(!result.found ? { closest: compactClosest(result.closest) } : {}),
    ...(result.report ? { report: result.report } : {}),
    ...(result.continuation ? { continuation: result.continuation } : {}),
  };
}

function compactReachScriptResult(result: ReachScriptSummary) {
  return {
    status: result.status,
    found: result.found,
    reason: result.reason,
    target: result.target,
    path: result.path,
    search: result.search,
    source: result.source,
    requestedSession: result.requestedSession,
    ...(result.session ? { session: result.session } : {}),
    ...(result.webPath ? { webPath: result.webPath } : {}),
    ...(result.fork ? { fork: result.fork } : {}),
    output: compactOutput(result.output),
    replayVerified: result.replayVerified,
    ...(!result.found ? { closest: compactClosest(result.closest) } : {}),
    ...(result.continuation ? { continuation: result.continuation } : {}),
  };
}

function compactOutput(output: ReachChoiceSummary["output"]) {
  if (output?.type !== "choice") return output === null ? null : { type: output.type };
  return {
    type: output.type,
    scriptId: output.scriptId,
    choiceId: output.choiceId,
    prompt: output.prompt,
    options: output.options.map((option) => ({
      id: option.id,
      available: option.available,
      ...(option.lockedReason ? { lockedReason: option.lockedReason } : {}),
    })),
  };
}

function compactClosest(closest: ReachChoiceSummary["closest"]) {
  return {
    path: summarizeReachPath(closest.inputs),
    steps: closest.steps,
    progress: closest.progress,
    satisfiedRequirements: closest.satisfiedRequirements,
    totalRequirements: closest.totalRequirements,
    targetScriptCompleted: closest.targetScriptCompleted,
    targetScriptActive: closest.targetScriptActive,
    requirements: closest.requirements,
    outputType: closest.outputType,
    ...(closest.guidanceProgress !== undefined
      ? { guidanceProgress: closest.guidanceProgress }
      : {}),
    ...(closest.guidancePreparation !== undefined
      ? { guidancePreparation: closest.guidancePreparation }
      : {}),
    ...(closest.guidanceRequirement
      ? { guidanceRequirement: closest.guidanceRequirement }
      : {}),
  };
}

function failedAfterWrite(
  selection: NonNullable<WorkResult["selection"]>,
  operation: DevelopmentOperation,
  targetSession: string,
  result: unknown,
): WorkResult {
  return {
    schemaVersion: 1,
    status: "failed",
    selection,
    operation,
    safety: {
      mode: "isolated-session",
      writes: true,
      targetSession,
    },
    result,
  };
}

function pausedAfterWrite(
  selection: NonNullable<WorkResult["selection"]>,
  operation: DevelopmentOperation,
  targetSession: string,
  result: unknown,
): WorkResult {
  return {
    schemaVersion: 1,
    status: "paused",
    selection,
    operation,
    safety: {
      mode: "isolated-session",
      writes: true,
      targetSession,
    },
    result,
  };
}

function selectWorkItem(
  items: DevelopmentWorkItem[],
  key?: string,
): DevelopmentWorkItem | null {
  if (key === undefined) return items[0] ?? null;
  const selected = items.find((item) => item.key === key);
  if (selected) return selected;
  throw new Error(
    `Development work item not found: ${key}${
      items.length > 0
        ? `\n\nAvailable work items:\n  ${items.map((item) => item.key).join("\n  ")}`
        : "\n\nThe development worklist is clean"
    }`,
  );
}

function requireNewSession(args: WorkArgs, item: DevelopmentWorkItem): string {
  if (!args.newSession) {
    throw new Error(
      `Work item ${item.key} creates an isolated branch; pass --new-session NAME`,
    );
  }
  return args.newSession;
}

function executed(
  selection: NonNullable<WorkResult["selection"]>,
  operation: DevelopmentOperation,
  mode: WorkResult["safety"]["mode"],
  writes: boolean,
  targetSession: string | null,
  result: unknown,
): WorkResult {
  return {
    schemaVersion: 1,
    status: "executed",
    selection,
    operation,
    safety: { mode, writes, targetSession },
    result,
  };
}

function validateLimits(args: WorkArgs): void {
  if (args.maxSteps !== undefined && (!Number.isInteger(args.maxSteps) || args.maxSteps < 1)) {
    throw new Error("--max-steps must be a positive integer");
  }
  if (args.maxNodes !== undefined && (!Number.isInteger(args.maxNodes) || args.maxNodes < 1)) {
    throw new Error("--max-nodes must be a positive integer");
  }
}
