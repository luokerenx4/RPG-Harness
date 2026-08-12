import { assertSessionName, isSessionCheckpointRef } from "@rpg-harness/session-store";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { listSessions } from "../session";
import { sessionDir } from "../session";
import { readSessionLog, type LoggedStep } from "./fork";

export type ChoiceCoverageStatus =
  | "covered"
  | "partial"
  | "uncovered"
  | "locked";

export interface ChoiceCoverageEvidence {
  session: string;
  logEntry: number;
  checkpoint: { schemaVersion: 1; file: string; revision: string };
  input: { type: "choose"; index: number };
  fork: { from: string; at: number };
  webPathTemplate: "/?session=<new-session>";
}

export interface ChoiceCoverageOptionRow {
  id: string;
  text: string;
  index: number;
  status: "selected" | "pending" | "locked";
  selectedSessions: string[];
  evidence?: ChoiceCoverageEvidence;
}

export interface ChoiceCoverageRow {
  key: string;
  scriptId: string;
  choiceId: string;
  prompt: string | null;
  status: ChoiceCoverageStatus;
  options: ChoiceCoverageOptionRow[];
}

export interface ChoiceCoverageWorkItem {
  key: string;
  scriptId: string;
  choiceId: string;
  optionId: string;
  optionText: string;
  evidence: ChoiceCoverageEvidence;
}

export interface ChoiceCoverageReport {
  summary: {
    choices: number;
    covered: number;
    partial: number;
    uncovered: number;
    locked: number;
    options: number;
    selectedOptions: number;
    pendingOptions: number;
    lockedOptions: number;
    untrackedChoiceEvents: number;
  };
  sessions: string[];
  sessionErrors: Array<{ session: string; error: string }>;
  choices: ChoiceCoverageRow[];
  workItems: ChoiceCoverageWorkItem[];
}

interface RuntimeChoiceOption {
  id?: unknown;
  text?: unknown;
  available?: unknown;
}

interface RuntimeChoiceOutput {
  type: "choice";
  scriptId?: unknown;
  choiceId?: unknown;
  prompt?: unknown;
  options?: unknown;
}

export interface ChoiceCoverageArgs {
  gameDir: string;
  session?: string;
  status: "pending" | ChoiceCoverageStatus | "all";
  format: "table" | "json";
}

export async function choiceCoverageCommand(
  args: ChoiceCoverageArgs,
): Promise<void> {
  const report = await collectChoiceCoverage(args.gameDir, args.session);
  const choices = report.choices.filter((choice) =>
    args.status === "all"
      ? true
      : args.status === "pending"
        ? choice.status === "partial" || choice.status === "uncovered"
        : choice.status === args.status,
  );
  const workKeys = new Set(
    choices.flatMap((choice) =>
      choice.options
        .filter((option) => option.status === "pending")
        .map((option) => `${choice.key}/${option.id}`),
    ),
  );
  const payload = {
    ...report,
    choices,
    workItems: report.workItems.filter((item) => workKeys.has(item.key)),
  };
  process.stdout.write(
    args.format === "json"
      ? JSON.stringify(payload, null, 2) + "\n"
      : formatChoiceCoverage(report, args.status),
  );
}

interface MutableOption {
  id: string;
  text: string;
  index: number;
  everAvailable: boolean;
  selectedSessions: Set<string>;
  evidence?: ChoiceCoverageEvidence;
}

interface MutableChoice {
  key: string;
  scriptId: string;
  choiceId: string;
  prompt: string | null;
  options: Map<string, MutableOption>;
}

export async function collectChoiceCoverage(
  gameDir: string,
  onlySession?: string,
): Promise<ChoiceCoverageReport> {
  if (onlySession !== undefined) assertSessionName(onlySession);
  const names = onlySession === undefined ? await listSessions(gameDir) : [onlySession];
  const logs: Array<{ session: string; entries: LoggedStep[] }> = [];
  const sessionErrors: Array<{ session: string; error: string }> = [];
  if (onlySession !== undefined) {
    try {
      logs.push(...await readChoiceCoverageLineage(gameDir, onlySession));
    } catch (error) {
      sessionErrors.push({ session: onlySession, error: (error as Error).message });
    }
    return analyzeChoiceCoverage(logs, sessionErrors);
  }
  for (const session of names) {
    try {
      logs.push({ session, entries: await readSessionLog(gameDir, session) });
    } catch (error) {
      sessionErrors.push({ session, error: (error as Error).message });
    }
  }
  return analyzeChoiceCoverage(logs, sessionErrors);
}

async function readChoiceCoverageLineage(
  gameDir: string,
  session: string,
  limit?: number,
  seen: Set<string> = new Set(),
): Promise<Array<{ session: string; entries: LoggedStep[] }>> {
  assertSessionName(session);
  if (seen.has(session)) {
    throw new Error(`Fork lineage cycle detected at session: ${session}`);
  }
  seen.add(session);
  const entries = (await readSessionLog(gameDir, session)).slice(0, limit);
  const provenance = await readForkProvenance(gameDir, session);
  if (!provenance) return [{ session, entries }];
  const ancestors = await readChoiceCoverageLineage(
    gameDir,
    provenance.fromSession,
    provenance.sourceLogEntry,
    seen,
  );
  return [...ancestors, { session, entries }];
}

async function readForkProvenance(
  gameDir: string,
  session: string,
): Promise<{ fromSession: string; sourceLogEntry: number } | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(sessionDir(gameDir, session), "fork.json"), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (
    typeof value.fromSession !== "string" ||
    !Number.isInteger(value.sourceLogEntry) ||
    (value.sourceLogEntry as number) < 0
  ) {
    throw new Error(`Invalid fork provenance for session: ${session}`);
  }
  assertSessionName(value.fromSession);
  return {
    fromSession: value.fromSession,
    sourceLogEntry: value.sourceLogEntry as number,
  };
}

export function analyzeChoiceCoverage(
  logs: Array<{ session: string; entries: LoggedStep[] }>,
  sessionErrors: Array<{ session: string; error: string }> = [],
): ChoiceCoverageReport {
  const choices = new Map<string, MutableChoice>();
  const explicitSelections: Array<{
    session: string;
    scriptId: string;
    choiceId: string;
    optionId: string;
  }> = [];
  let untrackedChoiceEvents = 0;

  for (const { session, entries } of logs) {
    let pending: { choice: MutableChoice; options: RuntimeChoiceOption[] } | null = null;
    for (let offset = 0; offset < entries.length; offset += 1) {
      const entry = entries[offset]!;
      const explicitDecision = asStableDecision(entry.decision);
      if (explicitDecision) {
        explicitSelections.push({ session, ...explicitDecision });
      }
      const input = asChooseInput(entry.input);
      if (!explicitDecision && input && pending) {
        const selected = pending.options[input.index];
        const selectedId = typeof selected?.id === "string" ? selected.id : null;
        if (selectedId) {
          pending.choice.options.get(selectedId)?.selectedSessions.add(session);
        }
      }
      pending = null;

      const output = asChoiceOutput(entry.output);
      if (!output) continue;
      const stable = stableChoice(output);
      if (!stable) {
        untrackedChoiceEvents += 1;
        continue;
      }
      const key = `${stable.scriptId}/${stable.choiceId}`;
      let choice = choices.get(key);
      if (!choice) {
        choice = {
          key,
          scriptId: stable.scriptId,
          choiceId: stable.choiceId,
          prompt: typeof output.prompt === "string" ? output.prompt : null,
          options: new Map(),
        };
        choices.set(key, choice);
      }
      stable.options.forEach((option, index) => {
        let row = choice!.options.get(option.id);
        if (!row) {
          row = {
            id: option.id,
            text: option.text,
            index,
            everAvailable: false,
            selectedSessions: new Set(),
          };
          choice!.options.set(option.id, row);
        }
        row.text = option.text;
        row.index = index;
        if (option.available) {
          row.everAvailable = true;
          if (isSessionCheckpointRef(entry.checkpoint)) {
            row.evidence = {
              session,
              logEntry: offset + 1,
              checkpoint: entry.checkpoint,
              input: { type: "choose", index },
              fork: { from: session, at: offset + 1 },
              webPathTemplate: "/?session=<new-session>",
            };
          }
        }
      });
      pending = { choice, options: output.options as RuntimeChoiceOption[] };
    }
  }

  for (const selection of explicitSelections) {
    choices
      .get(`${selection.scriptId}/${selection.choiceId}`)
      ?.options.get(selection.optionId)
      ?.selectedSessions.add(selection.session);
  }

  const rows = [...choices.values()]
    .map(finalizeChoice)
    .sort((a, b) => a.key.localeCompare(b.key));
  const workItems = rows.flatMap((choice) =>
    choice.options.flatMap((option) =>
      option.status === "pending" && option.evidence
        ? [{
            key: `${choice.key}/${option.id}`,
            scriptId: choice.scriptId,
            choiceId: choice.choiceId,
            optionId: option.id,
            optionText: option.text,
            evidence: option.evidence,
          }]
        : [],
    ),
  );
  const optionRows = rows.flatMap((choice) => choice.options);
  const countChoice = (status: ChoiceCoverageStatus) =>
    rows.filter((choice) => choice.status === status).length;
  const countOption = (status: ChoiceCoverageOptionRow["status"]) =>
    optionRows.filter((option) => option.status === status).length;
  return {
    summary: {
      choices: rows.length,
      covered: countChoice("covered"),
      partial: countChoice("partial"),
      uncovered: countChoice("uncovered"),
      locked: countChoice("locked"),
      options: optionRows.length,
      selectedOptions: countOption("selected"),
      pendingOptions: countOption("pending"),
      lockedOptions: countOption("locked"),
      untrackedChoiceEvents,
    },
    sessions: logs.map(({ session }) => session).sort(),
    sessionErrors,
    choices: rows,
    workItems,
  };
}

function asStableDecision(value: unknown): {
  scriptId: string;
  choiceId: string;
  optionId: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const decision = value as Record<string, unknown>;
  return typeof decision.scriptId === "string" &&
    typeof decision.choiceId === "string" &&
    typeof decision.optionId === "string"
    ? {
        scriptId: decision.scriptId,
        choiceId: decision.choiceId,
        optionId: decision.optionId,
      }
    : null;
}

export function formatChoiceCoverage(
  report: ChoiceCoverageReport,
  statuses: "pending" | ChoiceCoverageStatus | "all",
): string {
  const rows = report.choices.filter((choice) =>
    statuses === "all"
      ? true
      : statuses === "pending"
        ? choice.status === "partial" || choice.status === "uncovered"
        : choice.status === statuses,
  );
  const lines = [
    `Choice coverage: ${report.summary.selectedOptions}/${report.summary.options - report.summary.lockedOptions} executable options selected · ${report.summary.pendingOptions} pending · ${report.summary.untrackedChoiceEvents} untracked events`,
  ];
  if (rows.length === 0) lines.push("(no matching choices)");
  for (const choice of rows) {
    lines.push("", `${choice.status.toUpperCase()}  ${choice.key}  ${choice.prompt ?? "—"}`);
    for (const option of choice.options) {
      const marker = option.status === "selected" ? "✓" : option.status === "pending" ? "○" : "×";
      const replay = option.evidence
        ? `fork ${option.evidence.session}@${option.evidence.logEntry}, then choose ${option.evidence.input.index}`
        : "no executable checkpoint";
      lines.push(`  ${marker} ${option.id}: ${option.text}  [${option.status}; ${replay}]`);
    }
  }
  if (report.sessionErrors.length > 0) {
    lines.push("", "SESSION ERRORS");
    for (const error of report.sessionErrors) lines.push(`  ${error.session}: ${error.error}`);
  }
  return lines.join("\n") + "\n";
}

function finalizeChoice(choice: MutableChoice): ChoiceCoverageRow {
  const options = [...choice.options.values()]
    .map((option): ChoiceCoverageOptionRow => {
      const status = option.selectedSessions.size > 0
        ? "selected"
        : option.everAvailable
          ? "pending"
          : "locked";
      return {
        id: option.id,
        text: option.text,
        index: option.index,
        status,
        selectedSessions: [...option.selectedSessions].sort(),
        ...(option.evidence ? { evidence: option.evidence } : {}),
      };
    })
    .sort((a, b) => a.index - b.index);
  const selected = options.filter((option) => option.status === "selected").length;
  const pending = options.filter((option) => option.status === "pending").length;
  const status: ChoiceCoverageStatus = pending === 0
    ? selected === 0 ? "locked" : "covered"
    : selected === 0 ? "uncovered" : "partial";
  return {
    key: choice.key,
    scriptId: choice.scriptId,
    choiceId: choice.choiceId,
    prompt: choice.prompt,
    status,
    options,
  };
}

function asChoiceOutput(value: unknown): RuntimeChoiceOutput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const output = value as Record<string, unknown>;
  return output.type === "choice" && Array.isArray(output.options)
    ? output as unknown as RuntimeChoiceOutput
    : null;
}

function asChooseInput(value: unknown): { type: "choose"; index: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  return input.type === "choose" && Number.isInteger(input.index)
    ? { type: "choose", index: input.index as number }
    : null;
}

function stableChoice(output: RuntimeChoiceOutput): {
  scriptId: string;
  choiceId: string;
  options: Array<{ id: string; text: string; available: boolean }>;
} | null {
  if (typeof output.scriptId !== "string" || typeof output.choiceId !== "string") {
    return null;
  }
  const options = output.options as RuntimeChoiceOption[];
  if (options.some((option) =>
    typeof option.id !== "string" ||
    typeof option.text !== "string" ||
    typeof option.available !== "boolean"
  )) return null;
  return {
    scriptId: output.scriptId,
    choiceId: output.choiceId,
    options: options as Array<{ id: string; text: string; available: boolean }>,
  };
}
