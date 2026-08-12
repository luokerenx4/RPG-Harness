import { getPlaytestReport, reproducePlaytestReport } from "../playtest-reports";
import { runChoiceCoverageWorkItem } from "./cover-choice";
import { inspectScript } from "./inspect-script";
import { inspectSession } from "./inspect-session";
import { runReachChoice } from "./reach-choice";
import { collectSessionTranscript } from "./transcript";
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
  status: "clean" | "executed" | "prepared" | "failed";
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
      return executed(selection, operation, "isolated-session", true, target, result);
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
      return executed(selection, operation, "isolated-session", true, target, result);
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
        pretty: false,
      });
      const wroteSession = result.session !== undefined;
      return result.found ? executed(
        selection,
        operation,
        wroteSession ? "isolated-session" : "read-only",
        wroteSession,
        result.session ?? null,
        result,
      ) : failed(selection, operation, result);
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

function failed(
  selection: NonNullable<WorkResult["selection"]>,
  operation: DevelopmentOperation,
  result: unknown,
): WorkResult {
  return {
    schemaVersion: 1,
    status: "failed",
    selection,
    operation,
    safety: { mode: "read-only", writes: false, targetSession: null },
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
