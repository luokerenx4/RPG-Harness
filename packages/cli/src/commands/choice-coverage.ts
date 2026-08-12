import { assertSessionName, isSessionCheckpointRef } from "@rpg-harness/session-store";
import type { Condition, Game } from "@rpg-harness/engine";
import path from "node:path";
import { loadGame } from "../loader";
import { listSessions } from "../session";
import { readSessionLineage } from "../session-lineage";
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
  authoring: {
    summary: {
      choices: number;
      stableChoices: number;
      legacyChoices: number;
      options: number;
      stableOptions: number;
      observedStableChoices: number;
      unseenStableChoices: number;
    };
    choices: AuthoredChoiceRow[];
    workItems: ChoiceAuthoringWorkItem[];
  };
}

export interface AuthoredChoiceRow {
  key: string;
  scriptId: string;
  scriptTitle: string;
  source?: string;
  beatIndex: number;
  prompt: string | null;
  choiceId?: string;
  optionCount: number;
  optionIds: string[];
  status: "observed" | "unseen" | "legacy";
  requires?: Condition;
}

export type ChoiceAuthoringWorkItem =
  | {
      kind: "stabilize-choice";
      key: string;
      scriptId: string;
      source?: string;
      beatIndex: number;
      prompt: string | null;
      optionCount: number;
      action: "add stable choice.id and option.id values";
    }
  | {
      kind: "reach-choice";
      key: string;
      scriptId: string;
      choiceId: string;
      source?: string;
      beatIndex: number;
      prompt: string | null;
      requires?: Condition;
      action: "reach this authored choice in a recoverable session";
    };

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
  const game = await loadGame(gameDir);
  const authored = collectAuthoredChoices(game, gameDir);
  const names = onlySession === undefined ? await listSessions(gameDir) : [onlySession];
  const logs: Array<{ session: string; entries: LoggedStep[] }> = [];
  const sessionErrors: Array<{ session: string; error: string }> = [];
  if (onlySession !== undefined) {
    try {
      logs.push(...(await readSessionLineage(gameDir, onlySession)).map(
        ({ session, entries }) => ({ session, entries }),
      ));
    } catch (error) {
      sessionErrors.push({ session: onlySession, error: (error as Error).message });
    }
    return analyzeChoiceCoverage(logs, sessionErrors, authored);
  }
  for (const session of names) {
    try {
      logs.push({ session, entries: await readSessionLog(gameDir, session) });
    } catch (error) {
      sessionErrors.push({ session, error: (error as Error).message });
    }
  }
  return analyzeChoiceCoverage(logs, sessionErrors, authored);
}

export function analyzeChoiceCoverage(
  logs: Array<{ session: string; entries: LoggedStep[] }>,
  sessionErrors: Array<{ session: string; error: string }> = [],
  authoredChoices: AuthoredChoiceRow[] = [],
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
  const observedKeys = new Set(rows.map((choice) => choice.key));
  const authoringChoices = authoredChoices.map((choice): AuthoredChoiceRow => ({
    ...choice,
    status: choice.choiceId === undefined
      ? "legacy"
      : observedKeys.has(`${choice.scriptId}/${choice.choiceId}`)
        ? "observed"
        : "unseen",
  }));
  const stableChoices = authoringChoices.filter((choice) => choice.choiceId !== undefined);
  const authoringWorkItems: ChoiceAuthoringWorkItem[] = [];
  for (const choice of authoringChoices) {
    if (choice.status === "legacy") {
      authoringWorkItems.push({
        kind: "stabilize-choice" as const,
        key: choice.key,
        scriptId: choice.scriptId,
        ...(choice.source ? { source: choice.source } : {}),
        beatIndex: choice.beatIndex,
        prompt: choice.prompt,
        optionCount: choice.optionCount,
        action: "add stable choice.id and option.id values" as const,
      });
      continue;
    }
    if (choice.status === "unseen" && choice.choiceId) {
      authoringWorkItems.push({
        kind: "reach-choice" as const,
        key: choice.key,
        scriptId: choice.scriptId,
        choiceId: choice.choiceId,
        ...(choice.source ? { source: choice.source } : {}),
        beatIndex: choice.beatIndex,
        prompt: choice.prompt,
        ...(choice.requires ? { requires: choice.requires } : {}),
        action: "reach this authored choice in a recoverable session" as const,
      });
    }
  }
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
    authoring: {
      summary: {
        choices: authoringChoices.length,
        stableChoices: stableChoices.length,
        legacyChoices: authoringChoices.length - stableChoices.length,
        options: authoringChoices.reduce((sum, choice) => sum + choice.optionCount, 0),
        stableOptions: authoringChoices.reduce((sum, choice) => sum + choice.optionIds.length, 0),
        observedStableChoices: stableChoices.filter((choice) => choice.status === "observed").length,
        unseenStableChoices: stableChoices.filter((choice) => choice.status === "unseen").length,
      },
      choices: authoringChoices,
      workItems: authoringWorkItems,
    },
  };
}

export function collectAuthoredChoices(game: Game, gameDir?: string): AuthoredChoiceRow[] {
  return game.scripts.flatMap((script) => script.beats.flatMap((beat, beatIndex) => {
    if (beat.type !== "choice") return [];
    const source = script.source === undefined
      ? undefined
      : gameDir === undefined
        ? script.source
        : path.relative(gameDir, script.source).split(path.sep).join("/");
    return [{
      key: beat.id === undefined
        ? `${script.id}/beat-${beatIndex}`
        : `${script.id}/${beat.id}`,
      scriptId: script.id,
      scriptTitle: script.title,
      ...(source ? { source } : {}),
      beatIndex,
      prompt: beat.prompt ?? null,
      ...(beat.id !== undefined ? { choiceId: beat.id } : {}),
      optionCount: beat.options.length,
      optionIds: beat.options.flatMap((option) => option.id ? [option.id] : []),
      status: beat.id === undefined ? "legacy" as const : "unseen" as const,
      ...(script.requires ? { requires: script.requires } : {}),
    }];
  }));
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
    `Runtime choice coverage: ${report.summary.selectedOptions}/${report.summary.options - report.summary.lockedOptions} executable options selected · ${report.summary.pendingOptions} pending · ${report.summary.untrackedChoiceEvents} legacy log events`,
    `Authored choice inventory: ${report.authoring.summary.stableChoices}/${report.authoring.summary.choices} choices stable · ${report.authoring.summary.stableOptions}/${report.authoring.summary.options} options stable · ${report.authoring.summary.unseenStableChoices} stable choices unseen · ${report.authoring.summary.legacyChoices} choices need ids`,
  ];
  if (rows.length === 0) lines.push("(no matching runtime choices)");
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
  const authoringItems = statuses === "pending" || statuses === "all"
    ? report.authoring.workItems
    : [];
  if (authoringItems.length > 0) {
    lines.push("", `AUTHORING WORK (${authoringItems.length})`);
    for (const item of authoringItems.slice(0, 20)) {
      const location = `${item.source ?? item.scriptId}:beat-${item.beatIndex}`;
      lines.push(
        item.kind === "stabilize-choice"
          ? `  ○ stabilize ${item.key} · ${location} · ${item.optionCount} options · ${item.prompt ?? "—"}`
          : `  ○ reach ${item.key} · ${location} · ${item.prompt ?? "—"}`,
      );
    }
    if (authoringItems.length > 20) {
      lines.push(`  … ${authoringItems.length - 20} more (use --format json for the complete worklist)`);
    }
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
