import {
  assertSessionName,
  isSessionCheckpointRef,
  withSessionLock,
} from "@rpg-harness/session-store";
import { scriptRevision, type Condition, type Game } from "@rpg-harness/engine";
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
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

interface ChoiceLogObservation {
  logEntry: number;
  scriptId: string;
  scriptRevision?: string;
  choiceId: string;
  prompt: string | null;
  options: Array<{ id: string; text: string; available: boolean }>;
  checkpoint?: ChoiceCoverageEvidence["checkpoint"];
}

interface ChoiceLogSelection {
  scriptId: string;
  scriptRevision?: string;
  choiceId: string;
  optionId: string;
  responseTrace: NarrativeResponse[];
}

interface ChoiceLogScanState {
  pending?: {
    scriptId: string;
    scriptRevision?: string;
    choiceId: string;
    options: Array<{ id: string; text: string; available: boolean }>;
  };
  activeSelection?: number;
}

interface ChoiceLogSummary {
  entryCount: number;
  untrackedChoiceEvents: number;
  unversionedChoiceEvents: number;
  observations: ChoiceLogObservation[];
  selections: ChoiceLogSelection[];
  scanState: ChoiceLogScanState;
}

interface ChoiceLogSignature {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  endsWithNewline: boolean;
}

interface ChoiceLogIndexEntry {
  signature: ChoiceLogSignature | null;
  summary: ChoiceLogSummary;
}

interface ChoiceLogIndex {
  schemaVersion: 1;
  contentHash: string;
  sessions: Record<string, ChoiceLogIndexEntry>;
}

const CHOICE_LOG_INDEX_FILE = "choice-coverage-log-index-v1.json";

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
  if (onlySession === undefined) {
    return collectIndexedChoiceCoverage(gameDir, names, authored);
  }
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

async function collectIndexedChoiceCoverage(
  gameDir: string,
  names: string[],
  authored: AuthoredChoiceRow[],
): Promise<ChoiceCoverageReport> {
  const index = await readChoiceLogIndex(gameDir);
  const nextSessions = Object.create(null) as Record<string, ChoiceLogIndexEntry>;
  const summaries: Array<{ session: string; summary: ChoiceLogSummary }> = [];
  const sessionErrors: Array<{ session: string; error: string }> = [];
  let changed = false;
  for (const session of names) {
    try {
      let entry: ChoiceLogIndexEntry;
      try {
        entry = await indexedChoiceLogSummary(gameDir, session, index.sessions[session]);
      } catch (error) {
        if (!(error instanceof RetryableChoiceLogReadError)) throw error;
        // GUI and Headless append under this same transaction boundary. Only
        // the rare partial-tail reader waits; ordinary global scans stay free
        // of thousands of per-session lock acquisitions.
        entry = await withSessionLock(gameDir, session, () =>
          indexedChoiceLogSummary(gameDir, session, index.sessions[session])
        );
      }
      nextSessions[session] = entry;
      summaries.push({ session, summary: entry.summary });
      if (entry !== index.sessions[session]) changed = true;
    } catch (error) {
      sessionErrors.push({ session, error: (error as Error).message });
      if (index.sessions[session] !== undefined) changed = true;
    }
  }
  if (!changed && Object.keys(index.sessions).length !== names.length) changed = true;
  if (changed) {
    // Coverage remains a read operation. A read-only checkout or a racing
    // cache publisher may lose acceleration, but never evidence or the report.
    await writeChoiceLogIndex(gameDir, nextSessions).catch(() => {});
  }
  return analyzeChoiceCoverageSummaries(summaries, sessionErrors, authored);
}

async function indexedChoiceLogSummary(
  gameDir: string,
  session: string,
  cached?: ChoiceLogIndexEntry,
): Promise<ChoiceLogIndexEntry> {
  const file = path.join(gameDir, ".rpg-harness", "sessions", session, "log.jsonl");
  let handle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (cached?.signature === null) return cached;
    return { signature: null, summary: emptyChoiceLogSummary() };
  }
  try {
    const fileStat = await handle.stat();
    const baseSignature = signatureFromStat(fileStat, true);
    if (cached?.signature && sameChoiceLogSignature(cached.signature, baseSignature)) {
      return cached;
    }
    const canAppend = cached?.signature !== null && cached?.signature !== undefined &&
      cached.signature.dev === fileStat.dev &&
      cached.signature.ino === fileStat.ino &&
      cached.signature.size < fileStat.size &&
      cached.signature.endsWithNewline;
    const start = canAppend ? cached!.signature!.size : 0;
    const buffer = Buffer.allocUnsafe(fileStat.size - start);
    let cursor = 0;
    while (cursor < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        cursor,
        buffer.length - cursor,
        start + cursor,
      );
      if (bytesRead === 0) break;
      cursor += bytesRead;
    }
    if (cursor !== buffer.length) {
      throw new RetryableChoiceLogReadError(`Session log changed while indexing: ${session}`);
    }
    const verifiedStat = await handle.stat();
    if (!sameChoiceLogFileIdentity(fileStat, verifiedStat)) {
      throw new RetryableChoiceLogReadError(`Session log changed while indexing: ${session}`);
    }
    const text = buffer.toString("utf-8");
    const summary = canAppend
      ? summarizeChoiceLog(parseLoggedSteps(text, cached!.summary.entryCount), cached!.summary)
      : summarizeChoiceLog(parseLoggedSteps(text, 0));
    return {
      signature: signatureFromStat(fileStat, buffer.length === 0
        ? true
        : buffer[buffer.length - 1] === 0x0a),
      summary,
    };
  } finally {
    await handle.close();
  }
}

function parseLoggedSteps(text: string, previousEntries: number): LoggedStep[] {
  const lines = text.split(/\r?\n/);
  const hasTerminatingNewline = /(?:\r?\n)$/.test(text);
  const nonemptyLines = lines.filter((line) => line.trim().length > 0);
  return nonemptyLines.map(
    (line, index) => {
      try {
        return JSON.parse(line) as LoggedStep;
      } catch (error) {
        const message =
          `Invalid JSON in log entry ${previousEntries + index + 1}: ${(error as Error).message}`;
        if (!hasTerminatingNewline && index === nonemptyLines.length - 1) {
          throw new RetryableChoiceLogReadError(message);
        }
        throw new Error(message);
      }
    },
  );
}

class RetryableChoiceLogReadError extends Error {}

function summarizeChoiceLog(
  entries: LoggedStep[],
  previous: ChoiceLogSummary = emptyChoiceLogSummary(),
): ChoiceLogSummary {
  const summary = structuredClone(previous);
  let pending = summary.scanState.pending;
  let activeSelection = summary.scanState.activeSelection;
  for (let localOffset = 0; localOffset < entries.length; localOffset += 1) {
    const entry = entries[localOffset]!;
    const logEntry = summary.entryCount + localOffset + 1;
    const output = asChoiceOutput(entry.output);
    if (typeof output?.scriptId === "string" && output.scriptRevision === undefined) {
      summary.unversionedChoiceEvents += 1;
    }
    const explicitDecision = asStableDecision(entry.decision);
    if (explicitDecision) {
      summary.selections.push({ ...explicitDecision, responseTrace: [] });
      activeSelection = summary.selections.length - 1;
    }
    if (activeSelection !== undefined) {
      const selection = summary.selections[activeSelection];
      const response = asNarrativeResponse(entry.output);
      if (selection && response) {
        selection.responseTrace.push(response);
      } else if (!isPacingChoice(entry.output)) {
        activeSelection = undefined;
      }
    }
    const input = asChooseInput(entry.input);
    if (!explicitDecision && input && pending) {
      const selected = pending.options[input.index];
      if (selected) {
        summary.selections.push({
          scriptId: pending.scriptId,
          ...(pending.scriptRevision ? { scriptRevision: pending.scriptRevision } : {}),
          choiceId: pending.choiceId,
          optionId: selected.id,
          responseTrace: [],
        });
      }
    }
    pending = undefined;
    if (!output || (output.options as RuntimeChoiceOption[]).length < 2) continue;
    const stable = stableChoice(output);
    if (!stable) {
      summary.untrackedChoiceEvents += 1;
      continue;
    }
    summary.observations.push({
      logEntry,
      scriptId: stable.scriptId,
      ...(stable.scriptRevision ? { scriptRevision: stable.scriptRevision } : {}),
      choiceId: stable.choiceId,
      prompt: typeof output.prompt === "string" ? output.prompt : null,
      options: stable.options,
      ...(isSessionCheckpointRef(entry.checkpoint) ? { checkpoint: entry.checkpoint } : {}),
    });
    pending = stable;
  }
  summary.entryCount += entries.length;
  summary.scanState = {
    ...(pending ? { pending } : {}),
    ...(activeSelection !== undefined ? { activeSelection } : {}),
  };
  return summary;
}

function emptyChoiceLogSummary(): ChoiceLogSummary {
  return {
    entryCount: 0,
    untrackedChoiceEvents: 0,
    unversionedChoiceEvents: 0,
    observations: [],
    selections: [],
    scanState: {},
  };
}

function signatureFromStat(
  fileStat: Stats,
  endsWithNewline: boolean,
): ChoiceLogSignature {
  return {
    dev: fileStat.dev,
    ino: fileStat.ino,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    ctimeMs: fileStat.ctimeMs,
    endsWithNewline,
  };
}

function sameChoiceLogSignature(
  left: ChoiceLogSignature,
  right: ChoiceLogSignature,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameChoiceLogFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function readChoiceLogIndex(gameDir: string): Promise<ChoiceLogIndex> {
  try {
    const value = JSON.parse(await readFile(choiceLogIndexPath(gameDir), "utf-8")) as unknown;
    return parseChoiceLogIndex(value) ?? emptyChoiceLogIndex();
  } catch {
    // This file is disposable acceleration, never evidence. Missing,
    // unreadable, malformed, or structurally invalid caches all cold-scan the
    // authoritative session JSONL instead of turning into development work.
    return emptyChoiceLogIndex();
  }
}

async function writeChoiceLogIndex(
  gameDir: string,
  sessions: Record<string, ChoiceLogIndexEntry>,
): Promise<void> {
  const target = choiceLogIndexPath(gameDir);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  const index: ChoiceLogIndex = {
    schemaVersion: 1,
    contentHash: choiceLogIndexContentHash(sessions),
    sessions,
  };
  try {
    await writeFile(temporary, JSON.stringify(index), "utf-8");
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

function choiceLogIndexPath(gameDir: string): string {
  return path.join(gameDir, ".rpg-harness", "cache", CHOICE_LOG_INDEX_FILE);
}

function parseChoiceLogIndex(value: unknown): ChoiceLogIndex | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const index = value as Partial<ChoiceLogIndex>;
  if (!(index.schemaVersion === 1 && !!index.sessions &&
    typeof index.sessions === "object" && !Array.isArray(index.sessions) &&
    typeof index.contentHash === "string" &&
    index.contentHash === choiceLogIndexContentHash(
      index.sessions as Record<string, ChoiceLogIndexEntry>,
    ))) return null;
  const sessions = Object.create(null) as Record<string, ChoiceLogIndexEntry>;
  for (const [session, entry] of Object.entries(index.sessions)) {
    if (!isChoiceLogIndexEntry(entry)) return null;
    sessions[session] = entry;
  }
  return {
    schemaVersion: 1,
    contentHash: index.contentHash,
    sessions,
  };
}

function isChoiceLogIndexEntry(value: unknown): value is ChoiceLogIndexEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<ChoiceLogIndexEntry>;
  return (entry.signature === null || isChoiceLogSignature(entry.signature)) &&
    isChoiceLogSummary(entry.summary);
}

function isChoiceLogSignature(value: unknown): value is ChoiceLogSignature {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const signature = value as Partial<ChoiceLogSignature>;
  return [signature.dev, signature.ino, signature.size, signature.mtimeMs, signature.ctimeMs]
    .every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0) &&
    typeof signature.endsWithNewline === "boolean";
}

function isChoiceLogSummary(value: unknown): value is ChoiceLogSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const summary = value as Partial<ChoiceLogSummary>;
  return [summary.entryCount, summary.untrackedChoiceEvents, summary.unversionedChoiceEvents]
    .every((part) => Number.isInteger(part) && (part as number) >= 0) &&
    Array.isArray(summary.observations) && summary.observations.every(isChoiceLogObservation) &&
    Array.isArray(summary.selections) && summary.selections.every(isChoiceLogSelection) &&
    isChoiceLogScanState(summary.scanState, summary.selections.length);
}

function isChoiceLogObservation(value: unknown): value is ChoiceLogObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const observation = value as Partial<ChoiceLogObservation>;
  return Number.isInteger(observation.logEntry) && (observation.logEntry as number) > 0 &&
    typeof observation.scriptId === "string" &&
    (observation.scriptRevision === undefined || typeof observation.scriptRevision === "string") &&
    typeof observation.choiceId === "string" &&
    (observation.prompt === null || typeof observation.prompt === "string") &&
    Array.isArray(observation.options) && observation.options.every(isIndexedChoiceOption) &&
    (observation.checkpoint === undefined || isSessionCheckpointRef(observation.checkpoint));
}

function isChoiceLogSelection(value: unknown): value is ChoiceLogSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const selection = value as Partial<ChoiceLogSelection>;
  return typeof selection.scriptId === "string" &&
    (selection.scriptRevision === undefined || typeof selection.scriptRevision === "string") &&
    typeof selection.choiceId === "string" && typeof selection.optionId === "string" &&
    Array.isArray(selection.responseTrace) &&
    selection.responseTrace.every((response) => asNarrativeResponse(response) !== null);
}

function isChoiceLogScanState(value: unknown, selectionCount: number): value is ChoiceLogScanState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<ChoiceLogScanState>;
  return (state.pending === undefined || (
      typeof state.pending.scriptId === "string" &&
      (state.pending.scriptRevision === undefined || typeof state.pending.scriptRevision === "string") &&
      typeof state.pending.choiceId === "string" && Array.isArray(state.pending.options) &&
      state.pending.options.every(isIndexedChoiceOption)
    )) &&
    (state.activeSelection === undefined || (
      Number.isInteger(state.activeSelection) && state.activeSelection >= 0 &&
      state.activeSelection < selectionCount
    ));
}

function isIndexedChoiceOption(
  value: unknown,
): value is { id: string; text: string; available: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const option = value as Record<string, unknown>;
  return typeof option.id === "string" && typeof option.text === "string" &&
    typeof option.available === "boolean";
}

function emptyChoiceLogIndex(): ChoiceLogIndex {
  const sessions = Object.create(null) as Record<string, ChoiceLogIndexEntry>;
  return {
    schemaVersion: 1,
    contentHash: choiceLogIndexContentHash(sessions),
    sessions,
  };
}

function choiceLogIndexContentHash(
  sessions: Record<string, ChoiceLogIndexEntry>,
): string {
  return createHash("sha256").update(JSON.stringify(sessions)).digest("hex");
}

export function analyzeChoiceCoverage(
  logs: Array<{ session: string; entries: LoggedStep[] }>,
  sessionErrors: Array<{ session: string; error: string }> = [],
  authoredChoices: AuthoredChoiceRow[] = [],
): ChoiceCoverageReport {
  return analyzeChoiceCoverageSummaries(
    logs.map(({ session, entries }) => ({
      session,
      summary: summarizeChoiceLog(entries),
    })),
    sessionErrors,
    authoredChoices,
  );
}

function analyzeChoiceCoverageSummaries(
  logs: Array<{ session: string; summary: ChoiceLogSummary }>,
  sessionErrors: Array<{ session: string; error: string }> = [],
  authoredChoices: AuthoredChoiceRow[] = [],
): ChoiceCoverageReport {
  const choices = new Map<string, MutableChoice>();
  const explicitSelections: Array<ChoiceLogSelection & { session: string }> = [];
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
  const isCurrentEvidence = (scriptId: string, revision?: string): boolean => {
    const authoredRevision = authoredRevisions.get(scriptId);
    return authoredRevision === undefined ||
      revision === authoredRevision;
  };

  for (const { session, summary } of logs) {
    untrackedChoiceEvents += summary.untrackedChoiceEvents;
    unversionedChoiceEvents += summary.unversionedChoiceEvents;
    for (const observation of summary.observations) {
      const currentEvidence = isCurrentEvidence(
        observation.scriptId,
        observation.scriptRevision,
      );
      if (!currentEvidence) staleChoiceEvents += 1;
      const key = `${observation.scriptId}/${observation.choiceId}`;
      if (currentEvidence) currentObservedKeys.add(key);
      let choice = choices.get(key);
      if (!choice) {
        choice = {
          key,
          scriptId: observation.scriptId,
          choiceId: observation.choiceId,
          prompt: observation.prompt,
          options: new Map(),
        };
        choices.set(key, choice);
      }
      observation.options.forEach((option, index) => {
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
          if (observation.checkpoint) {
            row.evidence = {
              session,
              logEntry: observation.logEntry,
              checkpoint: observation.checkpoint,
              input: {
                type: "choose",
                choiceId: observation.choiceId,
                optionId: option.id,
              },
              fork: { from: session, at: observation.logEntry },
              webPathTemplate: "/?session=<new-session>",
            };
          }
        }
      });
    }
    for (const selection of summary.selections) {
      if (!isCurrentEvidence(selection.scriptId, selection.scriptRevision)) continue;
      explicitSelections.push({ session, ...selection });
    }
  }

  // A fork can contain a stable decision without repeating its parent's
  // choice output, and its name can sort before that parent. Resolve all
  // selections only after every session has contributed its observations.
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
