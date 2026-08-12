import type { PlaytestReport } from "../playtest-reports";
import { listPlaytestReports } from "../playtest-reports";
import {
  collectScriptCoverage,
  type ScriptCoverageReport,
} from "./coverage";
import {
  collectChoiceCoverage,
  type ChoiceAuthoringWorkItem,
  type ChoiceCoverageReport,
} from "./choice-coverage";
import { sessionFamily } from "../session-lineage";

export type DevelopmentWorkPriority = "P0" | "P1" | "P2" | "P3";
export type DevelopmentWorkKind =
  | "session-error"
  | "playtest-report"
  | "story-coverage"
  | "choice-branch"
  | "choice-authoring";

export type DevelopmentOperation =
  | {
      command: "inspect-session";
      args: { session: string; surfaces: Array<"state" | "log"> };
    }
  | {
      command: "reproduce";
      args: { reportId: string; session: string; to: "<new-session>" };
    }
  | {
      command: "verify-audit";
      args: { reportId: string; sessionPrefix: "<new-session>" };
    }
  | {
      command: "inspect-report";
      args: { reportId: string; session: string };
    }
  | {
      command: "transcript";
      args: { session: string; tail: 80 };
    }
  | {
      command: "inspect-script";
      args: { scriptId: string };
    }
  | {
      command: "cover";
      args: {
        key: string;
        session: "<new-session>";
        sourceSession?: string;
      };
    }
  | {
      command: "reach";
      args: {
        key: string;
        fromSession: string;
        session: "<new-session>";
      };
    }
  | {
      command: "reach-script";
      args: {
        scriptId: string;
        fromSession: string;
        session: "<new-session>";
      };
    }
  | {
      command: "edit";
      args: { target: string; key: string; beatIndex?: number };
    };

export interface DevelopmentWorkItem {
  key: string;
  kind: DevelopmentWorkKind;
  priority: DevelopmentWorkPriority;
  actionability: "executable" | "diagnostic" | "authoring";
  title: string;
  target?: string;
  detail: string;
  operation: DevelopmentOperation;
  executor: {
    command: "work";
    args: {
      key: string;
      session?: string;
      newSession?: "<new-session>";
    };
  };
  coordinates: Record<string, unknown>;
}

type DevelopmentWorkItemDraft = Omit<DevelopmentWorkItem, "executor">;

export interface DevelopmentWorklist {
  summary: {
    status: "clean" | "work-pending" | "critical";
    total: number;
    byPriority: Record<DevelopmentWorkPriority, number>;
    byKind: Record<DevelopmentWorkKind, number>;
    byActionability: Record<DevelopmentWorkItem["actionability"], number>;
    openReports: number;
    sessionErrors: number;
    storyPending: number;
    choiceBranches: number;
    authoringItems: number;
  };
  session?: string;
  /** Sessions whose isolated evidence contributed to this queue. */
  evidenceSessions: string[];
  items: DevelopmentWorkItem[];
}

export interface DevelopmentWorklistArgs {
  gameDir: string;
  session?: string;
  format: "table" | "json";
}

export async function worklistCommand(
  args: DevelopmentWorklistArgs,
): Promise<void> {
  const report = await collectDevelopmentWorklist(args.gameDir, args.session);
  process.stdout.write(
    args.format === "json"
      ? JSON.stringify(report, null, 2) + "\n"
      : formatDevelopmentWorklist(report),
  );
}

export async function collectDevelopmentWorklist(
  gameDir: string,
  session?: string,
): Promise<DevelopmentWorklist> {
  const evidenceSessions = session === undefined
    ? null
    : new Set(await sessionFamily(gameDir, session));
  const [story, choices, reports] = await Promise.all([
    collectScriptCoverage(gameDir, session, session !== undefined),
    collectChoiceCoverage(gameDir, session, session !== undefined),
    listPlaytestReports(gameDir),
  ]);
  return analyzeDevelopmentWorklist({
    story,
    choices,
    reports: reports.filter((report) =>
      report.status === "open" &&
      (evidenceSessions === null || evidenceSessions.has(report.session))
    ),
    ...(session !== undefined ? { session } : {}),
  });
}

export function analyzeDevelopmentWorklist(input: {
  story: ScriptCoverageReport;
  choices: ChoiceCoverageReport;
  reports: PlaytestReport[];
  session?: string;
}): DevelopmentWorklist {
  const items: DevelopmentWorkItemDraft[] = [];

  const sessionErrors = new Map<string, {
    surfaces: Set<"state" | "log">;
    errors: Set<string>;
  }>();
  for (const [surface, errors] of [
    ["state", input.story.sessionErrors],
    ["log", input.choices.sessionErrors],
  ] as const) {
    for (const error of errors) {
      const current = sessionErrors.get(error.session) ?? {
        surfaces: new Set<"state" | "log">(),
        errors: new Set<string>(),
      };
      current.surfaces.add(surface);
      current.errors.add(error.error);
      sessionErrors.set(error.session, current);
    }
  }
  for (const [session, diagnostic] of sessionErrors) {
    const surfaces = [...diagnostic.surfaces].sort();
    const errors = [...diagnostic.errors].sort();
    items.push({
      key: `session-error/${session}`,
      kind: "session-error",
      priority: "P0",
      actionability: "diagnostic",
      title: `Session ${session} cannot be analyzed`,
      detail: errors.join("; "),
      operation: { command: "inspect-session", args: { session, surfaces } },
      coordinates: { session, surfaces, errors },
    });
  }

  for (const report of input.reports) {
    const auditMatrix = report.evidence.auditMatrix;
    const auditVerifiable = auditMatrix !== undefined &&
      Number.isInteger(auditMatrix.maxSteps) && auditMatrix.maxSteps! >= 0 &&
      auditMatrix.lanes.length > 0;
    items.push({
      key: `report/${report.id}`,
      kind: "playtest-report",
      priority: reportPriority(report.severity),
      actionability: report.evidence.checkpoint ? "executable" : "diagnostic",
      title: report.title,
      ...(report.target ? { target: report.target } : {}),
      detail: `${report.severity} ${report.area} finding in ${report.session}`,
      operation: auditVerifiable && report.evidence.checkpoint
        ? {
            command: "verify-audit",
            args: { reportId: report.id, sessionPrefix: "<new-session>" },
          }
        : report.evidence.checkpoint
        ? {
            command: "reproduce",
            args: { reportId: report.id, session: report.session, to: "<new-session>" },
          }
        : {
            command: "inspect-report",
            args: { reportId: report.id, session: report.session },
          },
      coordinates: {
        reportId: report.id,
        session: report.session,
        area: report.area,
        severity: report.severity,
        logEntry: report.evidence.logEntry,
        currentScriptId: report.evidence.currentScriptId,
        ...(report.evidence.checkpoint
          ? { checkpoint: report.evidence.checkpoint }
          : {}),
        ...(report.evidence.auditMatrix
          ? { auditMatrix: report.evidence.auditMatrix }
          : {}),
      },
    });
  }

  const preciselyReachableScripts = new Set(
    input.choices.authoring.workItems
      .filter((item) => item.kind === "reach-choice")
      .map((item) => item.scriptId),
  );
  for (const script of input.story.scripts) {
    if (script.status !== "started" && script.status !== "stale" && script.status !== "uncovered") continue;
    if (script.status === "uncovered" && preciselyReachableScripts.has(script.id)) {
      continue;
    }
    const startedSession = script.startedSessions[0];
    const sourceSession = startedSession ?? input.session ?? "<source-session>";
    items.push({
      key: `story/${script.id}`,
      kind: "story-coverage",
      priority: script.status === "started" || script.status === "stale" ? "P1" : "P2",
      actionability: "executable",
      title: script.status === "started"
        ? `Finish started script: ${script.title}`
        : script.status === "stale"
          ? `Re-verify edited script: ${script.title}`
        : `Reach uncovered script: ${script.title}`,
      detail: `${script.id} is ${script.status} in real session coverage`,
      operation: {
        command: "reach-script",
        args: {
          scriptId: script.id,
          fromSession: sourceSession,
          session: "<new-session>",
        },
      },
      coordinates: {
        scriptId: script.id,
        status: script.status,
        completedSessions: script.completedSessions,
        startedSessions: script.startedSessions,
        staleSessions: script.staleSessions,
      },
    });
  }

  for (const workItem of input.choices.workItems) {
    items.push({
      key: `choice-branch/${workItem.key}`,
      kind: "choice-branch",
      priority: "P2",
      actionability: "executable",
      title: `Exercise choice branch: ${workItem.optionText}`,
      detail: `${workItem.choiceId}/${workItem.optionId} has an executable checkpoint but no selected evidence`,
      operation: {
        command: "cover",
        args: {
          key: workItem.key,
          session: "<new-session>",
          // The checkpoint is authoritative even when first discovered in an
          // isolated AI descendant. Fork that exact evidence session; the
          // player's source remains untouched and continues to scope the queue.
          sourceSession: workItem.evidence.session,
        },
      },
      coordinates: {
        scriptId: workItem.scriptId,
        choiceId: workItem.choiceId,
        optionId: workItem.optionId,
        evidence: workItem.evidence,
      },
    });
  }

  for (const workItem of input.choices.authoring.workItems) {
    items.push(authoringItem(workItem, input.session));
  }

  items.sort((left, right) =>
    priorityRank(left.priority) - priorityRank(right.priority) ||
    kindRank(left.kind) - kindRank(right.kind) ||
    left.key.localeCompare(right.key)
  );
  const finalizedItems: DevelopmentWorkItem[] = items.map((item) => ({
    ...item,
    executor: workExecutor(item, input.session),
  }));

  const byPriority = countBy(
    ["P0", "P1", "P2", "P3"] as const,
    finalizedItems,
    (item) => item.priority,
  );
  const byKind = countBy(
    [
      "session-error",
      "playtest-report",
      "story-coverage",
      "choice-branch",
      "choice-authoring",
    ] as const,
    finalizedItems,
    (item) => item.kind,
  );
  const byActionability = countBy(
    ["executable", "diagnostic", "authoring"] as const,
    finalizedItems,
    (item) => item.actionability,
  );
  return {
    summary: {
      status: byPriority.P0 > 0
        ? "critical"
        : finalizedItems.length > 0
          ? "work-pending"
          : "clean",
      total: finalizedItems.length,
      byPriority,
      byKind,
      byActionability,
      openReports: input.reports.length,
      sessionErrors: sessionErrors.size,
      storyPending: input.story.summary.started + (input.story.summary.stale ?? 0) + input.story.summary.uncovered,
      choiceBranches: input.choices.workItems.length,
      authoringItems: input.choices.authoring.workItems.length,
    },
    ...(input.session !== undefined ? { session: input.session } : {}),
    evidenceSessions: [...new Set([
      ...input.story.sessions,
      ...input.choices.sessions,
      ...input.reports.map((report) => report.session),
    ])].sort(),
    items: finalizedItems,
  };
}

export function formatDevelopmentWorklist(report: DevelopmentWorklist): string {
  const summary = report.summary;
  const lines = [
    `Development worklist: ${summary.total} items · ${summary.byPriority.P0} P0 · ${summary.byPriority.P1} P1 · ${summary.byPriority.P2} P2 · ${summary.byPriority.P3} P3`,
    `Actionability: ${summary.byActionability.executable} executable · ${summary.byActionability.diagnostic} diagnostic · ${summary.byActionability.authoring} authoring`,
    `Sources: ${summary.openReports} open reports · ${summary.sessionErrors} session errors · ${summary.storyPending} story gaps · ${summary.choiceBranches} choice branches · ${summary.authoringItems} authoring items`,
    `Evidence sessions: ${report.evidenceSessions.join(", ") || "none"}`,
  ];
  if (report.items.length === 0) {
    lines.push("(clean: no actionable development work)");
    return lines.join("\n") + "\n";
  }
  for (const item of report.items) {
    lines.push(
      `${item.priority}  ${item.actionability.padEnd(10)}  ${item.kind.padEnd(16)}  ${item.key}  ${item.title}`,
      `    next: ${formatExecutor(item.executor)}`,
    );
  }
  return lines.join("\n") + "\n";
}

function authoringItem(
  item: ChoiceAuthoringWorkItem,
  sourceSession?: string,
): DevelopmentWorkItemDraft {
  const target = item.source ?? item.scriptId;
  const common = {
    key: `choice-authoring/${item.key}`,
    kind: "choice-authoring" as const,
    target,
    coordinates: { ...item },
  };
  if (item.kind === "reach-choice") {
    return {
      ...common,
      priority: "P2",
      actionability: "executable",
      title: `Reach authored choice: ${item.prompt ?? item.key}`,
      detail: item.action,
      operation: {
        command: "reach",
        args: {
          key: `${item.scriptId}/${item.choiceId}`,
          fromSession: sourceSession ?? "<source-session>",
          session: "<new-session>",
        },
      },
    };
  }
  const priority = item.kind === "stabilize-choice" ? "P1" : item.kind === "annotate-choice-intent" ? "P3" : "P2";
  const title = item.kind === "stabilize-choice"
    ? `Stabilize authored choice: ${item.prompt ?? item.key}`
    : item.kind === "annotate-choice-intent"
      ? `Annotate AI intent: ${item.prompt ?? item.key}`
      : `Review converged choice responses: ${item.prompt ?? item.key}`;
  return {
    ...common,
    priority,
    actionability: "authoring",
    title,
    detail: item.action,
    operation: {
      command: "edit",
      args: { target, key: item.key, beatIndex: item.beatIndex },
    },
  };
}

function reportPriority(
  severity: PlaytestReport["severity"],
): DevelopmentWorkPriority {
  if (severity === "blocker") return "P0";
  if (severity === "major") return "P1";
  if (severity === "minor") return "P2";
  return "P3";
}

function priorityRank(priority: DevelopmentWorkPriority): number {
  return Number(priority.slice(1));
}

function kindRank(kind: DevelopmentWorkKind): number {
  return [
    "session-error",
    "playtest-report",
    "story-coverage",
    "choice-branch",
    "choice-authoring",
  ].indexOf(kind);
}

function countBy<const Key extends string>(
  keys: readonly Key[],
  items: DevelopmentWorkItem[],
  select: (item: DevelopmentWorkItem) => Key,
): Record<Key, number> {
  return Object.fromEntries(keys.map((key) => [
    key,
    items.filter((item) => select(item) === key).length,
  ])) as Record<Key, number>;
}

function workExecutor(
  item: DevelopmentWorkItemDraft,
  sourceSession?: string,
): DevelopmentWorkItem["executor"] {
  const createsBranch = item.operation.command === "reproduce" ||
    item.operation.command === "verify-audit" ||
    item.operation.command === "cover" ||
    item.operation.command === "reach" ||
    item.operation.command === "reach-script";
  return {
    command: "work",
    args: {
      key: item.key,
      ...(sourceSession !== undefined ? { session: sourceSession } : {}),
      ...(createsBranch ? { newSession: "<new-session>" as const } : {}),
    },
  };
}

function formatExecutor(executor: DevelopmentWorkItem["executor"]): string {
  const args = [
    `--key ${shellQuote(executor.args.key)}`,
    ...(executor.args.session ? [`--session ${shellQuote(executor.args.session)}`] : []),
    ...(executor.args.newSession ? ["--new-session <new-session>"] : []),
  ];
  return `${executor.command} ${args.join(" ")}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
