import { assertSessionName, isSessionCheckpointRef } from "@rpg-harness/session-store";
import { scriptRevision, type Condition, type Game } from "@rpg-harness/engine";
import { loadGame } from "../loader";
import { normalizeAuthoringSource } from "../authoring-source";
import { listSessions } from "../session";
import { readSessionLineage, sessionFamily } from "../session-lineage";
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
  input: { type: "choose"; choiceId: string; optionId: string };
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
  source?: string;
  choiceId: string;
  prompt: string | null;
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
    staleChoiceEvents: number;
    unversionedChoiceEvents: number;
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
      convergedResponses: number;
      intentCompleteChoices: number;
      intentPartialChoices: number;
      intentMissingChoices: number;
      taggedOptions: number;
      untaggedOptions: number;
    };
    choices: AuthoredChoiceRow[];
    workItems: ChoiceAuthoringWorkItem[];
  };
}

export interface AuthoredChoiceRow {
  key: string;
  scriptId: string;
  scriptRevision?: string;
  scriptTitle: string;
  source?: string;
  beatIndex: number;
  prompt: string | null;
  choiceId?: string;
  optionCount: number;
  optionIds: string[];
  optionIntents: Array<{
    optionId?: string;
    text: string;
    aiTags: string[];
  }>;
  intentStatus: "complete" | "partial" | "missing";
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
      kind: "annotate-choice-intent";
      key: string;
      scriptId: string;
      choiceId: string;
      source?: string;
      beatIndex: number;
      prompt: string | null;
      missingOptionIds: string[];
      action: "add at least one aiTag to every stable option; use neutral explicitly when intended";
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
    }
  | {
      kind: "review-converged-response";
      key: string;
      scriptId: string;
      choiceId: string;
      source?: string;
      beatIndex: number;
      prompt: string | null;
      optionIds: string[];
      responseTrace: NarrativeResponse[];
      action: "review whether distinct options should share the same narrative response trace";
    };

export interface NarrativeResponse {
  type: "dialogue" | "narration";
  text: string;
  speakerId?: string;
}

interface RuntimeChoiceOption {
  id?: unknown;
  text?: unknown;
  available?: unknown;
}

interface RuntimeChoiceOutput {
  type: "choice";
  scriptId?: unknown;
  scriptRevision?: unknown;
  choiceId?: unknown;
  prompt?: unknown;
  options?: unknown;
}

export interface ChoiceCoverageArgs {
  gameDir: string;
  session?: string;
  family?: boolean;
  status: "pending" | ChoiceCoverageStatus | "all";
  format: "table" | "json";
}

export async function choiceCoverageCommand(
  args: ChoiceCoverageArgs,
): Promise<void> {
  const report = await collectChoiceCoverage(args.gameDir, args.session, args.family);
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
  responseTraces: Map<string, NarrativeResponse[]>;
  evidence?: ChoiceCoverageEvidence;
  currentObserved: boolean;
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
  includeDescendants = false,
): Promise<ChoiceCoverageReport> {
  if (onlySession !== undefined) assertSessionName(onlySession);
  const game = await loadGame(gameDir);
  const authored = collectAuthoredChoices(game, gameDir);
  const names = onlySession === undefined
    ? await listSessions(gameDir)
    : includeDescendants
      ? await sessionFamily(gameDir, onlySession)
      : [onlySession];
  const logs: Array<{ session: string; entries: LoggedStep[] }> = [];
  const sessionErrors: Array<{ session: string; error: string }> = [];
  if (onlySession !== undefined && !includeDescendants) {
    try {
      logs.push(...(await readSessionLineage(gameDir, onlySession)).map(
        ({ session, entries }) => ({ session, entries }),
      ));
    } catch (error) {
      sessionErrors.push({ session: onlySession, error: (error as Error).message });
    }
    return analyzeChoiceCoverage(
      logs,
      sessionErrors,
      authored,
    );
  }
  if (onlySession !== undefined && includeDescendants) {
    try {
      logs.push(...(await readSessionLineage(gameDir, onlySession)).map(
        ({ session, entries }) => ({ session, entries }),
      ));
    } catch (error) {
      sessionErrors.push({ session: onlySession, error: (error as Error).message });
    }
  }
  for (const session of names) {
    if (includeDescendants && session === onlySession) continue;
    try {
      logs.push({ session, entries: await readSessionLog(gameDir, session) });
    } catch (error) {
      sessionErrors.push({ session, error: (error as Error).message });
    }
  }
  return analyzeChoiceCoverage(
    logs,
    sessionErrors,
    authored,
  );
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
    responseTrace: NarrativeResponse[];
  }> = [];
  let untrackedChoiceEvents = 0;
  let staleChoiceEvents = 0;
  let unversionedChoiceEvents = 0;
  const currentObservedKeys = new Set<string>();
  const authoredRevisions = new Map(
    authoredChoices.map((choice) => [choice.scriptId, choice.scriptRevision]),
  );
  const authoredSources = new Map<string, string>(
    authoredChoices.flatMap((choice) =>
      choice.choiceId && choice.source
        ? [[`${choice.scriptId}/${choice.choiceId}`, choice.source] as const]
        : []
    ),
  );
  for (const { entries } of logs) {
    for (const entry of entries) {
      const output = asChoiceOutput(entry.output);
      if (typeof output?.scriptId === "string" && output.scriptRevision === undefined) {
        unversionedChoiceEvents += 1;
      }
    }
  }
  const isCurrentEvidence = (scriptId: string, revision?: string): boolean => {
    const authoredRevision = authoredRevisions.get(scriptId);
    return authoredRevision === undefined ||
      revision === authoredRevision;
  };

  for (const { session, entries } of logs) {
    let pending: { choice: MutableChoice; options: RuntimeChoiceOption[] } | null = null;
    let activeSelection: typeof explicitSelections[number] | null = null;
    for (let offset = 0; offset < entries.length; offset += 1) {
      const entry = entries[offset]!;
      const explicitDecision = asStableDecision(entry.decision);
      if (explicitDecision && isCurrentEvidence(
        explicitDecision.scriptId,
        explicitDecision.scriptRevision,
      )) {
        const selection = {
          session,
          ...explicitDecision,
          responseTrace: [] as NarrativeResponse[],
        };
        explicitSelections.push(selection);
        activeSelection = selection;
      }
      if (activeSelection) {
        const response = asNarrativeResponse(entry.output);
        if (response) {
          activeSelection.responseTrace.push(response);
        } else if (!isPacingChoice(entry.output)) {
          activeSelection = null;
        }
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
      // A one-button choice is authored pacing/acknowledgement, not a branch.
      // It remains an interactive engine output, but must not create coverage
      // debt or a coding work item for an AI author.
      if ((output.options as RuntimeChoiceOption[]).length < 2) continue;
      const stable = stableChoice(output);
      if (!stable) {
        untrackedChoiceEvents += 1;
        continue;
      }
      const currentEvidence = isCurrentEvidence(stable.scriptId, stable.scriptRevision);
      if (!currentEvidence) staleChoiceEvents += 1;
      const key = `${stable.scriptId}/${stable.choiceId}`;
      if (currentEvidence) currentObservedKeys.add(key);
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
            responseTraces: new Map(),
            currentObserved: false,
          };
          choice!.options.set(option.id, row);
        }
        row.text = option.text;
        row.index = index;
        if (currentEvidence) {
          row.currentObserved = true;
          row.everAvailable = option.available;
          row.evidence = undefined;
        }
        if (option.available && currentEvidence) {
          row.everAvailable = true;
          if (isSessionCheckpointRef(entry.checkpoint)) {
            row.evidence = {
              session,
              logEntry: offset + 1,
              checkpoint: entry.checkpoint,
              input: {
                type: "choose",
                choiceId: stable.choiceId,
                optionId: option.id,
              },
              fork: { from: session, at: offset + 1 },
              webPathTemplate: "/?session=<new-session>",
            };
          }
        }
      });
      pending = currentEvidence
        ? { choice, options: output.options as RuntimeChoiceOption[] }
        : null;
    }
  }

  for (const selection of explicitSelections) {
    const option = choices
      .get(`${selection.scriptId}/${selection.choiceId}`)
      ?.options.get(selection.optionId);
    option?.selectedSessions.add(selection.session);
    if (option && selection.responseTrace.length > 0) {
      option.responseTraces.set(
        narrativeResponseTraceKey(selection.responseTrace),
        selection.responseTrace,
      );
    }
  }

  for (const choice of choices.values()) {
    if (!currentObservedKeys.has(choice.key)) continue;
    for (const [optionId, option] of choice.options) {
      if (!option.currentObserved) choice.options.delete(optionId);
    }
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
            ...(authoredSources.get(choice.key)
              ? { source: authoredSources.get(choice.key)! }
              : {}),
            choiceId: choice.choiceId,
            prompt: choice.prompt,
            optionId: option.id,
            optionText: option.text,
            evidence: option.evidence,
          }]
        : [],
    ),
  );
  const optionRows = rows.flatMap((choice) => choice.options);
  const authoringChoices = authoredChoices.map((choice): AuthoredChoiceRow => ({
    ...choice,
    status: choice.choiceId === undefined
      ? "legacy"
      : currentObservedKeys.has(`${choice.scriptId}/${choice.choiceId}`)
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
    if (
      choice.choiceId &&
      choice.optionIds.length === choice.optionCount &&
      choice.intentStatus !== "complete"
    ) {
      authoringWorkItems.push({
        kind: "annotate-choice-intent",
        key: `${choice.key}/ai-intent`,
        scriptId: choice.scriptId,
        choiceId: choice.choiceId,
        ...(choice.source ? { source: choice.source } : {}),
        beatIndex: choice.beatIndex,
        prompt: choice.prompt,
        missingOptionIds: choice.optionIntents.flatMap((option) =>
          option.aiTags.length === 0 && option.optionId ? [option.optionId] : []
        ),
        action: "add at least one aiTag to every stable option; use neutral explicitly when intended",
      });
    }
  }
  const authoredByKey = new Map(
    authoringChoices.map((choice) => [`${choice.scriptId}/${choice.choiceId ?? ""}`, choice]),
  );
  for (const choice of choices.values()) {
    const authored = authoredByKey.get(choice.key);
    const responseGroups = new Map<string, {
      options: MutableOption[];
      trace: NarrativeResponse[];
    }>();
    for (const option of choice.options.values()) {
      if (
        !option.everAvailable ||
        option.selectedSessions.size === 0 ||
        option.responseTraces.size !== 1
      ) continue;
      const [entry] = option.responseTraces.entries();
      if (!entry) continue;
      const [responseKey, trace] = entry;
      const group = responseGroups.get(responseKey) ?? { options: [], trace };
      group.options.push(option);
      responseGroups.set(responseKey, group);
    }
    for (const group of responseGroups.values()) {
      if (group.options.length < 2) continue;
      const optionIds = group.options.map((option) => option.id);
      authoringWorkItems.push({
        kind: "review-converged-response",
        key: `${choice.key}/shared-response/${optionIds.join("+")}`,
        scriptId: choice.scriptId,
        choiceId: choice.choiceId,
        ...(authored?.source ? { source: authored.source } : {}),
        beatIndex: authored?.beatIndex ?? -1,
        prompt: choice.prompt,
        optionIds,
        responseTrace: group.trace,
        action: "review whether distinct options should share the same narrative response trace",
      });
    }
  }
  const convergedResponses = authoringWorkItems.filter((item) =>
    item.kind === "review-converged-response"
  ).length;
  const intentCompleteChoices = stableChoices.filter(
    (choice) => choice.intentStatus === "complete",
  ).length;
  const intentPartialChoices = stableChoices.filter(
    (choice) => choice.intentStatus === "partial",
  ).length;
  const intentMissingChoices = stableChoices.filter(
    (choice) => choice.intentStatus === "missing",
  ).length;
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
      staleChoiceEvents,
      unversionedChoiceEvents,
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
        convergedResponses,
        intentCompleteChoices,
        intentPartialChoices,
        intentMissingChoices,
        taggedOptions: stableChoices.reduce(
          (sum, choice) => sum + choice.optionIntents.filter(
            (option) => option.aiTags.length > 0,
          ).length,
          0,
        ),
        untaggedOptions: stableChoices.reduce(
          (sum, choice) => sum + choice.optionIntents.filter(
            (option) => option.aiTags.length === 0,
          ).length,
          0,
        ),
      },
      choices: authoringChoices,
      workItems: authoringWorkItems,
    },
  };
}

export function collectAuthoredChoices(game: Game, gameDir?: string): AuthoredChoiceRow[] {
  return game.scripts.flatMap((script) => script.beats.flatMap((beat, beatIndex) => {
    if (beat.type !== "choice" || beat.options.length < 2) return [];
    const source = script.source === undefined
      ? undefined
      : gameDir === undefined
        ? script.source
        : normalizeAuthoringSource(gameDir, script.source);
    const optionIntents = beat.options.map((option) => ({
      ...(option.id ? { optionId: option.id } : {}),
      text: option.text,
      aiTags: [...(option.aiTags ?? [])],
    }));
    const taggedOptions = optionIntents.filter((option) => option.aiTags.length > 0).length;
    const intentStatus = taggedOptions === 0
      ? "missing" as const
      : taggedOptions === optionIntents.length
        ? "complete" as const
        : "partial" as const;
    return [{
      key: beat.id === undefined
        ? `${script.id}/beat-${beatIndex}`
        : `${script.id}/${beat.id}`,
      scriptId: script.id,
      scriptRevision: scriptRevision(script),
      scriptTitle: script.title,
      ...(source ? { source } : {}),
      beatIndex,
      prompt: beat.prompt ?? null,
      ...(beat.id !== undefined ? { choiceId: beat.id } : {}),
      optionCount: beat.options.length,
      optionIds: beat.options.flatMap((option) => option.id ? [option.id] : []),
      optionIntents,
      intentStatus,
      status: beat.id === undefined ? "legacy" as const : "unseen" as const,
      ...(script.requires ? { requires: script.requires } : {}),
    }];
  }));
}

function asStableDecision(value: unknown): {
  scriptId: string;
  scriptRevision?: string;
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
        ...(typeof decision.scriptRevision === "string"
          ? { scriptRevision: decision.scriptRevision }
          : {}),
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
    `Runtime choice coverage: ${report.summary.selectedOptions}/${report.summary.options - report.summary.lockedOptions} executable options selected · ${report.summary.pendingOptions} pending · ${report.summary.staleChoiceEvents} stale · ${report.summary.unversionedChoiceEvents} unversioned · ${report.summary.untrackedChoiceEvents} unstable-id log events`,
    `Authored choice inventory: ${report.authoring.summary.stableChoices}/${report.authoring.summary.choices} choices stable · ${report.authoring.summary.stableOptions}/${report.authoring.summary.options} options stable · ${report.authoring.summary.unseenStableChoices} stable choices unseen · ${report.authoring.summary.legacyChoices} choices need ids · ${report.authoring.summary.convergedResponses} converged responses need review`,
    `AI intent coverage: ${report.authoring.summary.intentCompleteChoices}/${report.authoring.summary.stableChoices} stable choices complete · ${report.authoring.summary.taggedOptions}/${report.authoring.summary.stableOptions} stable options tagged · ${report.authoring.summary.intentPartialChoices} partial · ${report.authoring.summary.intentMissingChoices} missing`,
  ];
  if (rows.length === 0) lines.push("(no matching runtime choices)");
  for (const choice of rows) {
    lines.push("", `${choice.status.toUpperCase()}  ${choice.key}  ${choice.prompt ?? "—"}`);
    for (const option of choice.options) {
      const marker = option.status === "selected" ? "✓" : option.status === "pending" ? "○" : "×";
      const replay = option.evidence
        ? `fork ${option.evidence.session}@${option.evidence.logEntry}, then choose ${option.evidence.input.choiceId}/${option.evidence.input.optionId}`
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
      lines.push(item.kind === "stabilize-choice"
        ? `  ○ stabilize ${item.key} · ${location} · ${item.optionCount} options · ${item.prompt ?? "—"}`
        : item.kind === "reach-choice"
          ? `  ○ reach ${item.key} · ${location} · ${item.prompt ?? "—"}`
          : item.kind === "annotate-choice-intent"
            ? `  ○ annotate intent ${item.scriptId}/${item.choiceId} · ${location} · missing [${item.missingOptionIds.join(", ")}]`
            : `  △ review shared response ${item.key} · ${location} · ${item.optionIds.length} options share ${formatNarrativeResponseTrace(item.responseTrace)}`);
    }
    if (authoringItems.length > 20) {
      lines.push(`  … ${authoringItems.length - 20} more (use --format json for the complete worklist)`);
    }
  }
  return lines.join("\n") + "\n";
}

function asNarrativeResponse(value: unknown): NarrativeResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const output = value as Record<string, unknown>;
  if ((output.type !== "dialogue" && output.type !== "narration") ||
    typeof output.text !== "string") return null;
  return {
    type: output.type,
    text: output.text,
    ...(typeof output.speakerId === "string" ? { speakerId: output.speakerId } : {}),
  };
}

/** A single-option choice is a continue button, not a new semantic branch. */
function isPacingChoice(value: unknown): boolean {
  const output = asChoiceOutput(value);
  return Array.isArray(output?.options) && output.options.length === 1;
}

function narrativeResponseTraceKey(trace: NarrativeResponse[]): string {
  return JSON.stringify(trace.map((response) => [
    response.type,
    response.speakerId ?? null,
    response.text,
  ]));
}

function formatNarrativeResponseTrace(trace: NarrativeResponse[]): string {
  const preview = trace.slice(0, 2).map((response) => {
    const speaker = response.speakerId ? `${response.speakerId}: ` : "";
    return `${response.type} ${speaker}${JSON.stringify(response.text)}`;
  }).join(" → ");
  return `${trace.length}-beat trace ${preview}${trace.length > 2 ? " → …" : ""}`;
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
  scriptRevision?: string;
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
    ...(typeof output.scriptRevision === "string"
      ? { scriptRevision: output.scriptRevision }
      : {}),
    choiceId: output.choiceId,
    options: options as Array<{ id: string; text: string; available: boolean }>,
  };
}
