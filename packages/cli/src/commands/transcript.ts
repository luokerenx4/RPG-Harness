import { assertSessionName, isSessionCheckpointRef } from "@rpg-harness/session-store";
import { access } from "node:fs/promises";
import { readSessionLineage, type SessionLineageSlice } from "../session-lineage";
import { sessionDir } from "../session";

export interface TranscriptArgs {
  gameDir: string;
  session: string;
  tail: number;
  format: "text" | "json";
}

export interface TranscriptEvent {
  index: number;
  session: string;
  logEntry: number;
  source?: string;
  input?: unknown;
  decision?: { scriptId: string; choiceId: string; optionId: string };
  activityDecision?: {
    activityId: string;
    title: string;
    kind: "script" | "action";
    category?: string;
    aiTags?: string[];
    recommended?: boolean;
    actionKind?: string;
    pacingInstanceId?: string;
    relatedObjectiveIds?: string[];
    focusedObjectiveId?: string;
  };
  inputResult?: { accepted: boolean; code: string; message: string };
  output?: Record<string, unknown>;
  fork?: Record<string, unknown>;
  checkpoint?: { schemaVersion: 1; file: string; revision: string };
}

export interface SessionTranscript {
  schemaVersion: 1;
  session: string;
  lineage: Array<{
    session: string;
    includedEntries: number;
    totalEntries: number;
  }>;
  summary: {
    totalEvents: number;
    returnedEvents: number;
    omittedEvents: number;
    narration: number;
    dialogue: number;
    choices: number;
    decisions: number;
    activities: number;
    rejectedInputs: number;
    scriptsCompleted: number;
    terminal: boolean;
  };
  events: TranscriptEvent[];
}

export async function transcriptCommand(args: TranscriptArgs): Promise<void> {
  const transcript = await collectSessionTranscript(args.gameDir, args.session, args.tail);
  process.stdout.write(
    args.format === "json"
      ? JSON.stringify(transcript, null, 2) + "\n"
      : formatSessionTranscript(transcript),
  );
}

export async function collectSessionTranscript(
  gameDir: string,
  session: string,
  tail = 80,
): Promise<SessionTranscript> {
  assertSessionName(session);
  if (!Number.isInteger(tail) || tail < 0) {
    throw new Error("--tail must be a non-negative integer (0 means all events)");
  }
  try {
    await access(sessionDir(gameDir, session));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Session does not exist: ${session}`);
    }
    throw error;
  }
  const lineage = await readSessionLineage(gameDir, session);
  const allEvents = buildTranscriptEvents(lineage);
  const events = tail === 0 ? allEvents : allEvents.slice(-tail);
  return {
    schemaVersion: 1,
    session,
    lineage: lineage.map(({ session: name, includedEntries, totalEntries }) => ({
      session: name,
      includedEntries,
      totalEntries,
    })),
    summary: summarize(allEvents, events.length),
    events,
  };
}

export function buildTranscriptEvents(lineage: SessionLineageSlice[]): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const slice of lineage) {
    slice.entries.forEach((entry, offset) => {
      const event: TranscriptEvent = {
        index: events.length + 1,
        session: slice.session,
        logEntry: offset + 1,
      };
      if (typeof entry.source === "string") event.source = entry.source;
      const input = compactInput(entry.input);
      if (input !== undefined) event.input = input;
      const decision = stableDecision(entry.decision);
      if (decision) event.decision = decision;
      const activityDecision = stableActivityDecision(entry.activityDecision);
      if (activityDecision) event.activityDecision = activityDecision;
      const inputResult = compactInputResult(entry.inputResult);
      if (inputResult) event.inputResult = inputResult;
      const output = compactOutput(entry.output);
      if (output) event.output = output;
      const fork = compactFork(entry.fork);
      if (fork) event.fork = fork;
      if (isSessionCheckpointRef(entry.checkpoint)) event.checkpoint = entry.checkpoint;
      if (
        input !== undefined || decision || activityDecision || inputResult || output || fork
      ) events.push(event);
    });
  }
  return events;
}

function summarize(all: TranscriptEvent[], returnedEvents: number): SessionTranscript["summary"] {
  const outputs = all.flatMap((event) => event.output ? [event.output] : []);
  return {
    totalEvents: all.length,
    returnedEvents,
    omittedEvents: all.length - returnedEvents,
    narration: outputs.filter((output) => output.type === "narration").length,
    dialogue: outputs.filter((output) => output.type === "dialogue").length,
    choices: outputs.filter((output) => output.type === "choice").length,
    decisions: all.filter((event) => event.decision !== undefined).length,
    activities: all.filter((event) =>
      isRecord(event.input) && event.input.type === "doActivity"
    ).length,
    rejectedInputs: all.filter((event) => event.inputResult?.accepted === false).length,
    scriptsCompleted: outputs.filter((output) => output.type === "scriptComplete").length,
    terminal: outputs.some((output) => output.type === "gameEnd"),
  };
}

function compactInput(value: unknown): unknown | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  switch (value.type) {
    case "choose":
      return Number.isInteger(value.index)
        ? { type: "choose", index: value.index }
        : typeof value.choiceId === "string" && typeof value.optionId === "string"
          ? { type: "choose", choiceId: value.choiceId, optionId: value.optionId }
          : { type: "choose" };
    case "select":
      return typeof value.scriptId === "string"
        ? { type: "select", scriptId: value.scriptId }
        : { type: "select" };
    case "doActivity":
      return typeof value.id === "string" ? { type: "doActivity", id: value.id } : { type: "doActivity" };
    case "next":
    case "quit":
      return { type: value.type };
    default:
      return { type: value.type };
  }
}

function compactOutput(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "narration":
      return { type: "narration", text: stringOrEmpty(value.text) };
    case "dialogue":
      return {
        type: "dialogue",
        ...(typeof value.speakerId === "string" ? { speakerId: value.speakerId } : {}),
        ...(typeof value.speakerName === "string" ? { speakerName: value.speakerName } : {}),
        text: stringOrEmpty(value.text),
      };
    case "choice":
      return {
        type: "choice",
        ...(typeof value.scriptId === "string" ? { scriptId: value.scriptId } : {}),
        ...(typeof value.choiceId === "string" ? { choiceId: value.choiceId } : {}),
        ...(typeof value.prompt === "string" ? { prompt: value.prompt } : {}),
        options: Array.isArray(value.options)
          ? value.options.filter(isRecord).map((option, index) => ({
              index,
              ...(typeof option.id === "string" ? { id: option.id } : {}),
              text: stringOrEmpty(option.text),
              available: option.available === true,
              ...(typeof option.lockedReason === "string"
                ? { lockedReason: option.lockedReason }
                : {}),
              ...(typeof option.aiPriority === "number"
                ? { aiPriority: option.aiPriority }
                : {}),
              ...(Array.isArray(option.aiTags) && option.aiTags.every(
                  (tag) => typeof tag === "string"
                )
                ? { aiTags: option.aiTags }
                : {}),
            }))
          : [],
      };
    case "scriptComplete":
      return {
        type: "scriptComplete",
        completedId: typeof value.completedId === "string" ? value.completedId : null,
        nextAvailable: Array.isArray(value.nextAvailable)
          ? value.nextAvailable.filter(isRecord).flatMap((script) =>
              typeof script.id === "string" ? [script.id] : []
            )
          : [],
      };
    case "hubMenu": {
      const snapshot = isRecord(value.snapshot) ? value.snapshot : {};
      return {
        type: "hubMenu",
        ...(typeof snapshot.day === "number" ? { day: snapshot.day } : {}),
        ...(typeof snapshot.slotName === "string" ? { slotName: snapshot.slotName } : {}),
        activeObjectives: Array.isArray(snapshot.objectives)
          ? snapshot.objectives.filter(isRecord).filter((objective) => objective.status === "active")
              .flatMap((objective) => typeof objective.id === "string" ? [objective.id] : [])
          : [],
        focusedObjective: Array.isArray(snapshot.objectives)
          ? snapshot.objectives.filter(isRecord).find((objective) =>
              objective.status === "active" && objective.focus === true
            )?.id ?? null
          : null,
        availableActivities: Array.isArray(snapshot.activities)
          ? snapshot.activities.filter(isRecord).filter((activity) => activity.available === true)
              .flatMap((activity) => typeof activity.id === "string" ? [activity.id] : [])
          : [],
      };
    }
    case "gameEnd":
      return {
        type: "gameEnd",
        ...(typeof value.endingId === "string" ? { endingId: value.endingId } : {}),
        ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
      };
    case "clear":
      return { type: "clear" };
    default:
      return { type: value.type };
  }
}

function stableDecision(value: unknown): TranscriptEvent["decision"] | null {
  if (!isRecord(value)) return null;
  return typeof value.scriptId === "string" &&
    typeof value.choiceId === "string" &&
    typeof value.optionId === "string"
    ? { scriptId: value.scriptId, choiceId: value.choiceId, optionId: value.optionId }
    : null;
}

function stableActivityDecision(
  value: unknown,
): TranscriptEvent["activityDecision"] | null {
  if (
    !isRecord(value) ||
    typeof value.activityId !== "string" ||
    typeof value.title !== "string" ||
    (value.kind !== "script" && value.kind !== "action")
  ) return null;
  const stringArray = (candidate: unknown): string[] | undefined =>
    Array.isArray(candidate) && candidate.every((item) => typeof item === "string")
      ? candidate
      : undefined;
  const aiTags = stringArray(value.aiTags);
  const relatedObjectiveIds = stringArray(value.relatedObjectiveIds);
  return {
    activityId: value.activityId,
    title: value.title,
    kind: value.kind,
    ...(typeof value.category === "string" ? { category: value.category } : {}),
    ...(aiTags ? { aiTags } : {}),
    ...(typeof value.recommended === "boolean"
      ? { recommended: value.recommended }
      : {}),
    ...(typeof value.actionKind === "string" ? { actionKind: value.actionKind } : {}),
    ...(typeof value.pacingInstanceId === "string"
      ? { pacingInstanceId: value.pacingInstanceId }
      : {}),
    ...(relatedObjectiveIds ? { relatedObjectiveIds } : {}),
    ...(typeof value.focusedObjectiveId === "string"
      ? { focusedObjectiveId: value.focusedObjectiveId }
      : {}),
  };
}

function compactInputResult(value: unknown): TranscriptEvent["inputResult"] | null {
  if (!isRecord(value)) return null;
  return typeof value.accepted === "boolean" &&
      typeof value.code === "string" &&
      typeof value.message === "string"
    ? { accepted: value.accepted, code: value.code, message: value.message }
    : null;
}

function compactFork(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return {
    ...(typeof value.fromSession === "string" ? { fromSession: value.fromSession } : {}),
    ...(Number.isInteger(value.sourceLogEntry) ? { sourceLogEntry: value.sourceLogEntry } : {}),
    ...(typeof value.mode === "string" ? { mode: value.mode } : {}),
  };
}

export function formatSessionTranscript(transcript: SessionTranscript): string {
  const { summary } = transcript;
  const lines = [
    `Transcript: ${transcript.session} · ${summary.returnedEvents}/${summary.totalEvents} events` +
      (summary.omittedEvents > 0 ? ` (${summary.omittedEvents} earlier omitted; use --tail 0)` : ""),
    `Lineage: ${transcript.lineage.map((slice) =>
      `${slice.session}@${slice.includedEntries}/${slice.totalEntries}`
    ).join(" -> ")}`,
    `Summary: ${summary.narration} narration · ${summary.dialogue} dialogue · ${summary.choices} choices · ${summary.decisions} decisions · ${summary.activities} activities · ${summary.rejectedInputs} rejected inputs · terminal=${summary.terminal}`,
  ];
  for (const event of transcript.events) {
    const prefix = `#${event.index} ${event.session}:${event.logEntry}` +
      (event.source ? ` [${event.source}]` : "");
    if (event.fork) {
      lines.push(`${prefix} ${formatFork(event.fork)}`);
      continue;
    }
    const input = formatInput(event.input);
    const decision = event.decision
      ? ` decision=${event.decision.scriptId}/${event.decision.choiceId}/${event.decision.optionId}`
      : "";
    const activityDecision = formatActivityDecision(event.activityDecision);
    const inputResult = event.inputResult?.accepted === false
      ? ` rejected=${event.inputResult.code}(${event.inputResult.message})`
      : "";
    lines.push(`${prefix}${input ? ` ${input}${activityDecision} ->` : ""} ${formatOutput(event.output)}${decision}${inputResult}`);
  }
  return lines.join("\n") + "\n";
}

function formatActivityDecision(
  decision: TranscriptEvent["activityDecision"] | undefined,
): string {
  if (!decision) return "";
  const semantics = [
    ...(decision.category ? [`category=${decision.category}`] : []),
    ...(decision.aiTags?.length ? [`tags=${decision.aiTags.join(",")}`] : []),
    ...(decision.relatedObjectiveIds?.length
      ? [`objectives=${decision.relatedObjectiveIds.join(",")}`]
      : []),
    ...(decision.focusedObjectiveId
      ? [`focus=${decision.focusedObjectiveId}`]
      : []),
    ...(decision.recommended === true ? ["recommended"] : []),
  ];
  return ` "${decision.title}"${semantics.length ? ` [${semantics.join("; ")}]` : ""}`;
}

function formatFork(fork: Record<string, unknown>): string {
  return `fork from=${String(fork.fromSession ?? "?")}@${String(fork.sourceLogEntry ?? "?")} mode=${String(fork.mode ?? "?")}`;
}

function formatInput(value: unknown): string {
  if (!isRecord(value) || typeof value.type !== "string") return "";
  if (value.type === "choose") {
    return typeof value.choiceId === "string" && typeof value.optionId === "string"
      ? `choose ${value.choiceId}/${value.optionId}`
      : `choose ${String(value.index ?? "?")}`;
  }
  if (value.type === "select") return `select ${String(value.scriptId ?? "?")}`;
  if (value.type === "doActivity") return `activity ${String(value.id ?? "?")}`;
  return value.type;
}

function formatOutput(value: Record<string, unknown> | undefined): string {
  if (!value || typeof value.type !== "string") return "event";
  if (value.type === "narration") return `narration: ${String(value.text ?? "")}`;
  if (value.type === "dialogue") {
    return `dialogue ${String(value.speakerName ?? value.speakerId ?? "?")}: ${String(value.text ?? "")}`;
  }
  if (value.type === "choice") {
    const identity = [value.scriptId, value.choiceId].filter(Boolean).join("/");
    const options = Array.isArray(value.options)
      ? value.options.filter(isRecord).map((option) =>
          `${String(option.index)}:${String(option.id ?? "legacy")}${option.available ? "" : `×(${String(option.lockedReason ?? "locked")})`}`
        ).join(", ")
      : "";
    return `choice ${identity || "legacy"}: ${String(value.prompt ?? "")} [${options}]`;
  }
  if (value.type === "hubMenu") {
    const available = Array.isArray(value.availableActivities)
      ? value.availableActivities.join(",")
      : "";
    const calendar = typeof value.slotName === "string" && value.slotName.length > 0
      ? ` day=${String(value.day ?? "?")} slot=${value.slotName}`
      : "";
    const focus = typeof value.focusedObjective === "string"
      ? ` focus=${value.focusedObjective}`
      : "";
    return `hub${calendar}${focus} available=[${available}]`;
  }
  if (value.type === "scriptComplete") return `scriptComplete ${String(value.completedId ?? "-")}`;
  if (value.type === "gameEnd") return `gameEnd${value.reason ? `: ${String(value.reason)}` : ""}`;
  return value.type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}
