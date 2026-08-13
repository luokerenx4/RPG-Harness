import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  BehaviorCycleDiagnostic,
  ComposedState,
  LoopReason,
  LoopFailure,
  ModuleHookName,
  StallDiagnostic,
} from "@rpg-harness/engine";
import {
  appendCheckpointedSessionEvent,
  assertSessionName,
  isSessionCheckpointRef,
  loadSessionCheckpoint,
  withSessionLock,
} from "@rpg-harness/session-store";
import { saveSession, sessionDir } from "./session";

export const PLAYTEST_AREAS = [
  "narrative",
  "gameplay",
  "engine",
  "ui",
  "tooling",
] as const;
export type PlaytestArea = (typeof PLAYTEST_AREAS)[number];

export const PLAYTEST_SEVERITIES = [
  "note",
  "minor",
  "major",
  "blocker",
] as const;
export type PlaytestSeverity = (typeof PLAYTEST_SEVERITIES)[number];

const REPORTS_FILE = "issues.jsonl";
const ISSUE_CHECKPOINTS_DIR = "issue-checkpoints";

export interface PlaytestCheckpointRef {
  schemaVersion: 1;
  file: string;
  revision: string;
}

export interface PlaytestEvidence {
  statePath: string;
  logPath: string;
  logEntry: number | null;
  currentScriptId: string | null;
  lastCompletedScriptId: string | null;
  lastEvent: {
    input: unknown;
    output: unknown;
    inputResult?: unknown;
    activityDecision?: unknown;
  } | null;
  visualState?: {
    bg: string | null;
    portraits: Record<string, string | null>;
    cg: string | null;
  };
  checkpoint?: PlaytestCheckpointRef;
  /** Frozen state immediately before the Web input that produced the incident. */
  replayCheckpoint?: PlaytestCheckpointRef;
  stall?: StallDiagnostic;
  behaviorCycle?: BehaviorCycleDiagnostic;
  failure?: PlaytestFailureEvidence;
  autoplay?: PlaytestAutoplayEvidence;
  auditMatrix?: PlaytestAuditMatrixEvidence;
  /** Author-owned files and stable runtime symbols implicated by the trace. */
  sourceTargets?: PlaytestSourceTarget[];
  captureErrors?: string[];
}

export interface PlaytestSourceTarget {
  kind:
    | "module-action"
    | "module-persona"
    | "module-hook"
    | "module-trigger"
    | "module-setup"
    | "preset"
    | "script";
  file: string;
  moduleId?: string;
  actionKind?: string;
  actionId?: string;
  activityId?: string;
  persona?: string;
  hookName?: ModuleHookName;
  triggerId?: string;
  triggerStage?: NonNullable<LoopFailure["trigger"]>["stage"];
  beatIndex?: number;
  labelName?: string;
  setupPhase?: "initialize" | "engine";
  runtimePhase?: "prime" | "input";
  scriptId?: string;
  scriptRevision?: string;
  choiceId?: string;
}

export interface PlaytestFailureEvidence {
  phase: LoopFailure["phase"];
  name: string;
  message: string;
  input: unknown;
  output: unknown;
  decision?: LoopFailure["decision"];
  activityDecision?: LoopFailure["activityDecision"];
  stack?: string;
  hook?: LoopFailure["hook"];
  trigger?: LoopFailure["trigger"];
  moduleIds?: string[];
}

/**
 * Base incident evidence frozen at one session transaction boundary.
 *
 * This is exported only from this implementation module so autonomous runners
 * can carry the snapshot across a later report-append transaction. It is not a
 * user-authored report payload.
 */
export type PlaytestEvidenceSnapshot = Omit<
  PlaytestEvidence,
  "stall" | "behaviorCycle" | "failure" | "autoplay" | "auditMatrix"
>;

export interface PlaytestAutoplayEvidence {
  /** Checkpoint replay for playable runs; fresh initialization reruns from seed. */
  replayMode?: "checkpoint" | "fresh-initialization";
  replayCheckpoint?: PlaytestCheckpointRef;
  initializationModuleId?: string;
  /** Log boundary in the report session at that instant (0 before its first entry). */
  replayLogEntry: number;
  persona: string;
  maxSteps: number;
  seed?: number;
  stopReason: LoopReason;
  decisions: number;
  rejectedInputs: number;
  steps: number;
  /** Semantic decisions from the original failing run, for replay diagnostics. */
  decisionPathRevision: string;
  sourceSession?: string;
  sourceLogEntry?: number;
}

/** True only when an autoplay finding carries every input needed for causal replay. */
export function hasCausalAutoplayEvidence(
  evidence: PlaytestAutoplayEvidence | undefined,
): evidence is PlaytestAutoplayEvidence {
  const validReplay = evidence?.replayMode === "fresh-initialization"
    ? typeof evidence.initializationModuleId === "string" &&
      evidence.initializationModuleId.trim().length > 0
    : isPlaytestCheckpointRef(evidence?.replayCheckpoint);
  return evidence !== undefined && validReplay &&
    Number.isInteger(evidence.replayLogEntry) && evidence.replayLogEntry >= 0 &&
    typeof evidence.persona === "string" && evidence.persona.trim().length > 0 &&
    Number.isInteger(evidence.maxSteps) && evidence.maxSteps >= 0 &&
    Number.isInteger(evidence.seed) && evidence.seed! >= 0 &&
    evidence.seed! <= 0xffff_ffff &&
    typeof evidence.decisionPathRevision === "string" &&
    /^[a-f0-9]{64}$/.test(evidence.decisionPathRevision);
}

export interface PlaytestAuditMatrixEvidence {
  sourceRevision: string;
  sessionPrefix: string;
  /** Present on reports created after deterministic audit verification shipped. */
  maxSteps?: number;
  /** Bounded autoplay slices available to every lane. Defaults to one on legacy evidence. */
  maxSegments?: number;
  seed?: number;
  policy: {
    personas?: string[];
    fuzzPersonas?: string[];
    minUniqueEndings?: number;
    minUniqueDecisionPaths?: number;
    maxActivityRepetitions?: number;
    maxActivityRepetitionsByKind?: Record<string, number>;
    requiredActivityTags?: string[];
    requiredScripts?: string[];
  };
  observed: {
    uniqueEndings: number;
    uniqueDecisionPaths: number;
    coveredActivityTags?: string[];
    completedScripts?: string[];
    maxActivityRepetition?: {
      persona: string;
      activityKind: string;
      count: number;
      limit: number;
      objectiveIds?: string[];
    };
  };
  classification:
    | "identical-path"
    | "convergent-paths"
    | "divergent-endings"
    | "incomplete";
  violations: string[];
  lanes: Array<{
    persona: string;
    /** Whether this lane's persona is repeatable without a persona RNG seed. */
    deterministic?: boolean;
    session: string;
    webPath: string;
    ending: string | null;
    reason: string;
    pathRevision: string;
    activityTags?: string[];
    completedScripts?: string[];
    semanticActivityCounts?: Record<string, number>;
    semanticActivityActionCounts?: Record<string, number>;
    semanticActivityObjectives?: Record<string, string[]>;
  }>;
  choiceDivergences: Array<{
    scriptId: string;
    choiceId: string;
    selections: Array<{ optionId: string; personas: string[] }>;
    notReachedBy: string[];
  }>;
}

/** True only when an audit finding retains a deterministic rerun matrix. */
export function hasVerifiableAuditEvidence(
  evidence: PlaytestAuditMatrixEvidence | undefined,
): evidence is PlaytestAuditMatrixEvidence {
  if (
    evidence === undefined ||
    !Number.isInteger(evidence.maxSteps) || evidence.maxSteps! < 0 ||
    (evidence.maxSegments !== undefined &&
      (!Number.isInteger(evidence.maxSegments) || evidence.maxSegments! < 1)) ||
    !Number.isInteger(evidence.seed) || evidence.seed! < 0 ||
    !Array.isArray(evidence.lanes) || evidence.lanes.length === 0
  ) return false;
  const personas = evidence.lanes.map((lane) => lane.persona);
  if (evidence.policy.maxActivityRepetitions !== undefined ||
    evidence.policy.maxActivityRepetitionsByKind !== undefined) {
    if (!isOptionalPositiveInteger(evidence.policy.maxActivityRepetitions) ||
      !isActivityRepetitionLimitRecord(evidence.policy.maxActivityRepetitionsByKind) ||
      evidence.lanes.some((lane) =>
        !isSemanticActivityCountRecord(lane.semanticActivityCounts) ||
        !isOptionalSemanticActivityCountRecord(lane.semanticActivityActionCounts) ||
        Object.entries(lane.semanticActivityCounts ?? {}).some(([kind, instances]) =>
          (lane.semanticActivityActionCounts?.[kind] ?? instances) < instances
        )
      ) ||
      JSON.stringify(evidence.observed.maxActivityRepetition) !==
        JSON.stringify(maximumActivityRepetition(evidence.policy, evidence.lanes))) {
      return false;
    }
  }
  return personas.every((persona) =>
    typeof persona === "string" && persona.trim().length > 0
  ) &&
    evidence.lanes.every((lane) => typeof lane.deterministic === "boolean") &&
    new Set(personas).size === personas.length;
}

export interface PlaytestReport {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  status: "open" | "resolved" | "superseded";
  session: string;
  area: PlaytestArea;
  severity: PlaytestSeverity;
  title: string;
  origin?: {
    kind: "player-feedback";
    surface: "web";
    projectInputRevision?: string;
  };
  details?: string;
  target?: string;
  resolvedAt?: string;
  resolution?: string;
  supersededAt?: string;
  supersededReason?: string;
  verification?: PlaytestVerification;
  evidence: PlaytestEvidence;
}

export function hasRecoverableIssueCheckpoint(report: PlaytestReport): boolean {
  return isPlaytestCheckpointRef(report.evidence.checkpoint);
}

export function hasCausallyVerifiableAutoplayReport(
  report: PlaytestReport,
): boolean {
  const autoplay = report.evidence.autoplay;
  const freshInitialization = autoplay?.replayMode === "fresh-initialization";
  return hasCausalAutoplayEvidence(autoplay) && (
    freshInitialization
      ? report.evidence.failure?.phase === "setup" &&
        report.evidence.failure.moduleIds?.includes(
          autoplay.initializationModuleId!,
        ) === true &&
        report.evidence.sourceTargets?.some((target) =>
          target.kind === "module-setup" &&
          target.setupPhase === "initialize" &&
          target.moduleId === autoplay.initializationModuleId
        ) === true
      : hasRecoverableIssueCheckpoint(report)
  );
}

export function hasVerifiableAuditReport(report: PlaytestReport): boolean {
  return hasRecoverableIssueCheckpoint(report) &&
    hasVerifiableAuditEvidence(report.evidence.auditMatrix);
}

export interface PlaytestAuditVerification {
  kind: "ai-audit";
  verifiedAt: string;
  issueCheckpointRevision: string;
  sessionPrefix: string;
  sourceRevision: string;
  maxSteps: number;
  maxSegments?: number;
  seed: number;
  policy: {
    personas?: string[];
    fuzzPersonas?: string[];
    minUniqueEndings?: number;
    minUniqueDecisionPaths?: number;
    maxActivityRepetitions?: number;
    maxActivityRepetitionsByKind?: Record<string, number>;
    requiredActivityTags?: string[];
    requiredScripts?: string[];
  };
  observed: {
    uniqueEndings: number;
    uniqueDecisionPaths: number;
    coveredActivityTags?: string[];
    completedScripts?: string[];
    maxActivityRepetition?: {
      persona: string;
      activityKind: string;
      count: number;
      limit: number;
      objectiveIds?: string[];
    };
  };
  classification:
    | "identical-path"
    | "convergent-paths"
    | "divergent-endings";
  lanes: Array<{
    persona: string;
    session: string;
    webPath: string;
    ending: string;
    pathRevision: string;
    activityTags?: string[];
    completedScripts?: string[];
    semanticActivityCounts?: Record<string, number>;
    semanticActivityActionCounts?: Record<string, number>;
    semanticActivityObjectives?: Record<string, string[]>;
  }>;
}

export interface PlaytestAutoplayVerification {
  kind: "autoplay";
  verifiedAt: string;
  /** Causal replay start, before any input that contributed to the finding. */
  replayMode?: "checkpoint" | "fresh-initialization";
  initializationModuleId?: string;
  replayCheckpointRevision?: string;
  /** Exact stopped state retained for GUI/headless incident inspection. */
  issueCheckpointRevision?: string;
  originalStopReason: LoopReason;
  persona: string;
  maxSteps: number;
  seed?: number;
  session: string;
  webPath: string;
  result: {
    reason: "completed";
    ending: string;
    decisions: number;
    rejectedInputs: number;
    steps: number;
    decisionPathRevision: string;
    completedScripts: string[];
    objectiveChanges: number;
  };
}

export interface PlaytestPlayerFeedbackVerification {
  kind: "player-feedback";
  verifiedAt: string;
  originalInputRevision: string;
  fixedInputRevision: string;
  certificateRevision: string;
  certificateCreatedAt: string;
  worklistRevision: string;
  unrelatedWorkItems: 0;
}

export type PlaytestVerification =
  | PlaytestAuditVerification
  | PlaytestAutoplayVerification
  | PlaytestPlayerFeedbackVerification;

export type RecordPlaytestAutoplayEvidence = Omit<
  PlaytestAutoplayEvidence,
  "replayCheckpoint"
> & {
  /** Internal state payload; persisted content-addressably and never embedded in the report. */
  replayState?: ComposedState;
};

export interface RecordPlaytestReportArgs {
  gameDir: string;
  session: string;
  area: PlaytestArea;
  severity: PlaytestSeverity;
  title: string;
  origin?: PlaytestReport["origin"];
  details?: string;
  target?: string;
  sourceTargets?: PlaytestSourceTarget[];
  stall?: StallDiagnostic;
  behaviorCycle?: BehaviorCycleDiagnostic;
  failure?: LoopFailure;
  autoplay?: RecordPlaytestAutoplayEvidence;
  auditMatrix?: PlaytestAuditMatrixEvidence;
  /** @internal Evidence captured while the causal session transaction was held. */
  evidenceSnapshot?: PlaytestEvidenceSnapshot;
}

export interface ResolvePlaytestReportArgs {
  gameDir: string;
  id: string;
  session?: string;
  resolution?: string;
}

export interface SupersedePlaytestReportArgs {
  gameDir: string;
  id: string;
  session?: string;
  reason: string;
}

/** @internal Only verification commands may persist structured proof. */
export type ResolveVerifiedPlaytestReportArgs = ResolvePlaytestReportArgs & {
  verification: PlaytestVerification;
};

type ResolvePlaytestReportInternalArgs =
  | ({ mode: "manual" } & ResolvePlaytestReportArgs)
  | ({ mode: "verified" } & ResolveVerifiedPlaytestReportArgs)
  | ({ mode: "supersede" } & SupersedePlaytestReportArgs);

export interface ReproducePlaytestReportArgs {
  gameDir: string;
  id: string;
  to: string;
  session?: string;
  checkpoint?: "issue" | "autoplay-replay" | "player-replay";
}

export async function recordPlaytestReport(
  args: RecordPlaytestReportArgs,
): Promise<PlaytestReport> {
  assertSessionName(args.session);
  if (!args.title.trim()) throw new Error("Playtest report title cannot be empty");
  if (
    args.origin &&
    (
      args.origin.kind !== "player-feedback" ||
      args.origin.surface !== "web" ||
      (args.origin.projectInputRevision !== undefined &&
        !/^[a-f0-9]{64}$/.test(args.origin.projectInputRevision))
    )
  ) {
    throw new Error("Invalid playtest report origin");
  }
  if (
    Number(Boolean(args.autoplay)) +
        Number(Boolean(args.auditMatrix)) +
        Number(Boolean(args.origin?.projectInputRevision)) > 1
  ) {
    throw new Error(
      "A playtest report cannot combine multiple structured causes",
    );
  }
  if ((args.autoplay || args.auditMatrix) && !args.evidenceSnapshot) {
    throw new Error(
      "Structured autoplay and audit reports require incident evidence frozen inside their causal session transaction",
    );
  }
  return withSessionLock(args.gameDir, args.session, async () => {
    const createdAt = new Date().toISOString();
    const autoplay = args.autoplay
      ? await persistAutoplayEvidence(args.gameDir, args.session, args.autoplay)
      : undefined;
    const incidentEvidence = args.evidenceSnapshot ??
      await capturePlaytestEvidenceSnapshot(args.gameDir, args.session);
    const report: PlaytestReport = {
      schemaVersion: 1,
      id: `pt-${createdAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`,
      createdAt,
      status: "open",
      session: args.session,
      area: args.area,
      severity: args.severity,
      title: args.title.trim(),
      ...(args.origin ? { origin: structuredClone(args.origin) } : {}),
      ...(args.details?.trim() ? { details: args.details.trim() } : {}),
      ...(args.target?.trim() ? { target: args.target.trim() } : {}),
      evidence: {
        ...incidentEvidence,
        ...(args.sourceTargets?.length
          ? { sourceTargets: structuredClone(args.sourceTargets) }
          : {}),
        ...(args.stall ? { stall: args.stall } : {}),
        ...(args.behaviorCycle ? { behaviorCycle: args.behaviorCycle } : {}),
        ...(args.failure ? { failure: compactLoopFailure(args.failure) } : {}),
        ...(autoplay ? { autoplay } : {}),
        ...(args.auditMatrix ? { auditMatrix: args.auditMatrix } : {}),
      },
    };

    const dir = sessionDir(args.gameDir, args.session);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, REPORTS_FILE);
    const reports = await readReportFile(file);
    reports.push(report);
    await writeReportFileAtomically(file, reports);
    return report;
  });
}

function compactLoopFailure(failure: LoopFailure): PlaytestFailureEvidence {
  return {
    phase: failure.phase,
    name: failure.name,
    message: failure.message,
    input: structuredClone(failure.input),
    output: compactOutput(failure.output),
    ...(failure.decision ? { decision: structuredClone(failure.decision) } : {}),
    ...(failure.activityDecision
      ? { activityDecision: structuredClone(failure.activityDecision) }
      : {}),
    ...(failure.stack ? { stack: failure.stack } : {}),
    ...(failure.moduleIds?.length ? { moduleIds: [...failure.moduleIds] } : {}),
    ...(failure.hook ? { hook: structuredClone(failure.hook) } : {}),
    ...(failure.trigger
      ? { trigger: structuredClone(failure.trigger) }
      : {}),
  };
}

async function persistAutoplayEvidence(
  gameDir: string,
  session: string,
  input: RecordPlaytestAutoplayEvidence,
): Promise<PlaytestAutoplayEvidence> {
  const { replayState, ...evidence } = input;
  if (evidence.replayMode === "fresh-initialization") {
    if (replayState !== undefined) {
      throw new Error("Fresh initialization evidence cannot embed a replay state");
    }
    return evidence;
  }
  if (replayState === undefined) {
    throw new Error("Checkpoint autoplay evidence requires a replay state");
  }
  const replayCheckpoint = await persistPlaytestCheckpoint(
    gameDir,
    session,
    JSON.stringify(replayState, null, 2),
  );
  return { ...evidence, replayCheckpoint };
}

export async function listPlaytestReports(
  gameDir: string,
  session?: string,
): Promise<PlaytestReport[]> {
  if (session !== undefined) {
    assertSessionName(session);
    return readReportFile(path.join(sessionDir(gameDir, session), REPORTS_FILE));
  }

  const root = path.join(gameDir, ".rpg-harness", "sessions");
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const reports = (
    await Promise.all(
      names.map((name) =>
        readReportFile(path.join(sessionDir(gameDir, name), REPORTS_FILE)),
      ),
    )
  ).flat();
  return reports.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function resolvePlaytestReport(
  args: ResolvePlaytestReportArgs,
): Promise<PlaytestReport> {
  // Keep this runtime guard even though the public type omits `verification`:
  // JavaScript callers and TypeScript casts must not mint their own proof.
  if ("verification" in args) {
    throw new Error(
      "Manual report resolution does not accept verification evidence; run verify-autoplay or verify-audit instead",
    );
  }
  const snapshot: ResolvePlaytestReportInternalArgs = {
    mode: "manual",
    gameDir: args.gameDir,
    id: args.id,
    ...(args.session !== undefined ? { session: args.session } : {}),
    ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
  };
  return resolvePlaytestReportInternal(snapshot);
}

/** @internal Verification commands call this only after performing a replay. */
export async function resolveVerifiedPlaytestReport(
  args: ResolveVerifiedPlaytestReportArgs,
): Promise<PlaytestReport> {
  const snapshot: ResolvePlaytestReportInternalArgs = {
    mode: "verified",
    gameDir: args.gameDir,
    id: args.id,
    verification: structuredClone(args.verification),
    ...(args.session !== undefined ? { session: args.session } : {}),
    ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
  };
  return resolvePlaytestReportInternal(snapshot);
}

/**
 * Retire an issue whose causal prerequisites no longer exist. This is not a
 * claim that the bug was fixed: the mandatory reason preserves that distinction
 * in history while removing an unreplayable item from the active worklist.
 */
export async function supersedePlaytestReport(
  args: SupersedePlaytestReportArgs,
): Promise<PlaytestReport> {
  if (!args.reason.trim()) {
    throw new Error("Superseding a playtest report requires a reason");
  }
  const snapshot: ResolvePlaytestReportInternalArgs = {
    mode: "supersede",
    gameDir: args.gameDir,
    id: args.id,
    reason: args.reason.trim(),
    ...(args.session !== undefined ? { session: args.session } : {}),
  };
  return resolvePlaytestReportInternal(snapshot);
}

async function resolvePlaytestReportInternal(
  args: ResolvePlaytestReportInternalArgs,
): Promise<PlaytestReport> {
  if (!args.id.trim()) throw new Error("Playtest report id cannot be empty");
  if (args.session !== undefined) {
    assertSessionName(args.session);
    return withSessionLock(args.gameDir, args.session, () =>
      resolvePlaytestReportInLockedSession(args, args.session!)
    );
  }

  // A global lookup has no single lock to acquire. Read complete files
  // optimistically so an unrelated long autoplay cannot block resolution. Only
  // a session that contains the id, or whose trailing line is currently being
  // appended, needs its transaction lock before a conclusive re-read.
  const matches: string[] = [];
  for (const session of await reportSessions(args.gameDir)) {
    const file = path.join(sessionDir(args.gameDir, session), REPORTS_FILE);
    const discovery = await readReportFileForDiscovery(file);
    const optimisticCount = discovery.reports
      .filter((report) => report.id === args.id).length;
    if (optimisticCount > 1) {
      throw new Error(`Duplicate playtest report id: ${args.id}`);
    }
    if (optimisticCount === 0 && !discovery.trailingPartial) continue;
    const found = await withSessionLock(args.gameDir, session, async () => {
      const reports = await readReportFile(file);
      const count = reports.filter((report) => report.id === args.id).length;
      if (count > 1) throw new Error(`Duplicate playtest report id: ${args.id}`);
      return count === 1;
    });
    if (found) matches.push(session);
  }
  if (matches.length === 0) {
    throw new Error(`Playtest report not found: ${args.id}`);
  }
  if (matches.length > 1) {
    throw new Error(`Duplicate playtest report id: ${args.id}`);
  }
  const session = matches[0]!;
  return withSessionLock(args.gameDir, session, () =>
    resolvePlaytestReportInLockedSession(args, session)
  );
}

/** Resolve from a fresh issues.jsonl read while the owning session lock is held. */
async function resolvePlaytestReportInLockedSession(
  args: ResolvePlaytestReportInternalArgs,
  session: string,
): Promise<PlaytestReport> {
  const file = path.join(sessionDir(args.gameDir, session), REPORTS_FILE);
  const reports = await readReportFile(file);
  const indexes = reports.flatMap((report, index) =>
    report.id === args.id ? [index] : []
  );
  if (indexes.length === 0) {
    throw new Error(`Playtest report not found: ${args.id}`);
  }
  if (indexes.length > 1) {
    throw new Error(`Duplicate playtest report id: ${args.id}`);
  }
  const index = indexes[0]!;
  const current = reports[index]!;
  if (current.session !== session) {
    throw new Error(
      `Playtest report session mismatch: ${current.id} names ${current.session}, stored under ${session}`,
    );
  }
  if (current.status === "superseded") {
    if (args.mode === "supersede" && args.reason === current.supersededReason) {
      return current;
    }
    throw new Error(`Playtest report is already superseded: ${current.id}`);
  }
  if (current.status === "resolved") {
    if (args.mode === "supersede") {
      throw new Error(`Resolved playtest report cannot be superseded: ${current.id}`);
    }
    if (args.mode === "verified") {
      throw new Error(
        `Playtest report was resolved concurrently by another verification: ${current.id}`,
      );
    }
    if (
      args.resolution?.trim() &&
      args.resolution.trim() !== current.resolution
    ) {
      throw new Error(
        `Playtest report was resolved concurrently with a different resolution: ${current.id}`,
      );
    }
    return current;
  }
  if (args.mode === "supersede") {
    const superseded: PlaytestReport = {
      ...current,
      status: "superseded",
      supersededAt: new Date().toISOString(),
      supersededReason: args.reason,
    };
    reports[index] = superseded;
    await writeReportFileAtomically(file, reports);
    return superseded;
  }
  const verification = args.mode === "verified" ? args.verification : undefined;
  assertVerificationMatchesReport(current, verification, args.resolution);
  const resolved: PlaytestReport = {
    ...current,
    status: "resolved",
    resolvedAt: new Date().toISOString(),
    ...(args.resolution?.trim() ? { resolution: args.resolution.trim() } : {}),
    ...(verification ? { verification } : {}),
  };
  reports[index] = resolved;
  await writeReportFileAtomically(file, reports);
  return resolved;
}

function assertVerificationMatchesReport(
  report: PlaytestReport,
  verification: PlaytestVerification | undefined,
  resolution: string | undefined,
): void {
  const autoplay = report.evidence.autoplay;
  const audit = report.evidence.auditMatrix;
  const playerFeedbackRevision = report.origin?.kind === "player-feedback"
    ? report.origin.projectInputRevision
    : undefined;
  if (
    Number(Boolean(autoplay)) +
        Number(Boolean(audit)) +
        Number(Boolean(playerFeedbackRevision)) > 1
  ) {
    throw new Error(
      `Playtest report has conflicting structured evidence and cannot be resolved: ${report.id}`,
    );
  }
  if (autoplay && hasCausallyVerifiableAutoplayReport(report)) {
    if (verification?.kind !== "autoplay") {
      throw new Error(
        `Structured autoplay report ${report.id} requires causal autoplay verification; run verify-autoplay instead of resolving it manually`,
      );
    }
    const freshInitialization = autoplay.replayMode === "fresh-initialization";
    if (freshInitialization) {
      if (
        verification.replayMode !== "fresh-initialization" ||
        verification.initializationModuleId !== autoplay.initializationModuleId ||
        verification.replayCheckpointRevision !== undefined ||
        verification.issueCheckpointRevision !== undefined
      ) {
        throw new Error(
          `Fresh initialization verification mode mismatch for report ${report.id}`,
        );
      }
    } else {
      const issueCheckpoint = report.evidence.checkpoint;
      if (!isPlaytestCheckpointRef(issueCheckpoint)) {
        throw new Error(`Autoplay report has no recoverable issue checkpoint: ${report.id}`);
      }
      if (!isPlaytestCheckpointRef(autoplay.replayCheckpoint)) {
        throw new Error(`Autoplay report has no recoverable replay checkpoint: ${report.id}`);
      }
      if (
        verification.replayMode === "fresh-initialization" ||
        verification.replayCheckpointRevision !== autoplay.replayCheckpoint.revision ||
        verification.issueCheckpointRevision !== issueCheckpoint.revision
      ) {
        throw new Error(
          `Autoplay verification checkpoint mismatch for report ${report.id}`,
        );
      }
    }
    if (
      verification.originalStopReason !== autoplay.stopReason ||
      verification.persona !== autoplay.persona ||
      verification.maxSteps !== autoplay.maxSteps ||
      verification.seed !== autoplay.seed
    ) {
      throw new Error(
        `Autoplay verification replay parameters do not match report ${report.id}`,
      );
    }
    if (
      verification.result.reason !== "completed" ||
      typeof verification.result.ending !== "string" ||
      !verification.result.ending.trim()
    ) {
      throw new Error(
        `Autoplay verification has no terminal gameEnd identity for report ${report.id}`,
      );
    }
    return;
  }
  if (autoplay && !resolution?.trim()) {
    throw new Error(
      `Legacy autoplay report ${report.id} needs an explicit review or supersession reason before manual resolution`,
    );
  }
  if (audit && hasVerifiableAuditReport(report)) {
    if (verification?.kind !== "ai-audit") {
      throw new Error(
        `Structured AI audit report ${report.id} requires audit verification; run verify-audit instead of resolving it manually`,
      );
    }
    assertAuditVerificationMatches(report, audit, verification);
    return;
  }
  if (audit && !resolution?.trim()) {
    throw new Error(
      `Legacy AI audit report ${report.id} needs an explicit review or supersession reason before manual resolution`,
    );
  }
  if (playerFeedbackRevision) {
    if (verification?.kind !== "player-feedback") {
      throw new Error(
        `Player feedback report ${report.id} requires project revision and quality-certificate verification; run verify-feedback instead of resolving it manually`,
      );
    }
    if (
      verification.originalInputRevision !== playerFeedbackRevision ||
      verification.fixedInputRevision === playerFeedbackRevision ||
      !/^[a-f0-9]{64}$/.test(verification.fixedInputRevision) ||
      !/^[a-f0-9]{64}$/.test(verification.certificateRevision) ||
      !/^[a-f0-9]{16}$/.test(verification.worklistRevision) ||
      verification.unrelatedWorkItems !== 0
    ) {
      throw new Error(
        `Player feedback verification does not prove a changed, clean, certified project for report ${report.id}`,
      );
    }
  }
}

function assertAuditVerificationMatches(
  report: PlaytestReport,
  audit: PlaytestAuditMatrixEvidence,
  verification: PlaytestAuditVerification,
): void {
  if (
    verification.issueCheckpointRevision !== report.evidence.checkpoint!.revision ||
    verification.sourceRevision !== audit.sourceRevision
  ) {
    throw new Error(`AI audit verification source mismatch for report ${report.id}`);
  }
  if (
    verification.maxSteps !== audit.maxSteps ||
    (verification.maxSegments ?? 1) !== (audit.maxSegments ?? 1) ||
    verification.seed !== audit.seed ||
    JSON.stringify(sortJson(verification.policy)) !== JSON.stringify(sortJson(audit.policy))
  ) {
    throw new Error(`AI audit verification replay parameters do not match report ${report.id}`);
  }
  const originalPersonas = audit.lanes.map((lane) => lane.persona);
  const verifiedPersonas = verification.lanes.map((lane) => lane.persona);
  if (JSON.stringify(verifiedPersonas) !== JSON.stringify(originalPersonas)) {
    throw new Error(`AI audit verification persona matrix does not match report ${report.id}`);
  }
  if (verification.lanes.some((lane) =>
    typeof lane.ending !== "string" || !lane.ending.trim() ||
    !/^[a-f0-9]{64}$/.test(lane.pathRevision)
  )) {
    throw new Error(`AI audit verification has an incomplete lane for report ${report.id}`);
  }
  const uniqueEndings = new Set(verification.lanes.map((lane) => lane.ending)).size;
  const uniqueDecisionPaths = new Set(
    verification.lanes.map((lane) => lane.pathRevision),
  ).size;
  const expectedClassification = uniqueEndings > 1
    ? "divergent-endings"
    : uniqueDecisionPaths > 1
      ? "convergent-paths"
      : "identical-path";
  if (
    verification.observed.uniqueEndings !== uniqueEndings ||
    verification.observed.uniqueDecisionPaths !== uniqueDecisionPaths ||
    verification.classification !== expectedClassification ||
    (verification.policy.minUniqueEndings !== undefined &&
      uniqueEndings < verification.policy.minUniqueEndings) ||
    (verification.policy.minUniqueDecisionPaths !== undefined &&
      uniqueDecisionPaths < verification.policy.minUniqueDecisionPaths)
  ) {
    throw new Error(`AI audit verification does not satisfy the frozen policy for report ${report.id}`);
  }
  const coveredTags = new Set(
    verification.lanes.flatMap((lane) => lane.activityTags ?? []),
  );
  const completedScripts = new Set(
    verification.lanes.flatMap((lane) => lane.completedScripts ?? []),
  );
  const observedTags = verification.observed.coveredActivityTags;
  const observedScripts = verification.observed.completedScripts;
  if (
    (observedTags !== undefined &&
      JSON.stringify([...observedTags].sort()) !==
        JSON.stringify([...coveredTags].sort())) ||
    (observedScripts !== undefined &&
      JSON.stringify([...observedScripts].sort()) !==
        JSON.stringify([...completedScripts].sort())) ||
    (verification.policy.requiredActivityTags ?? []).some((tag) => !coveredTags.has(tag)) ||
    (verification.policy.requiredScripts ?? []).some((script) =>
      !completedScripts.has(script)
    )
  ) {
    throw new Error(`AI audit verification does not satisfy the frozen policy for report ${report.id}`);
  }
  if (verification.policy.maxActivityRepetitions !== undefined ||
    verification.policy.maxActivityRepetitionsByKind !== undefined) {
    if (verification.lanes.some((lane) =>
      !isSemanticActivityCountRecord(lane.semanticActivityCounts) ||
      !isOptionalSemanticActivityCountRecord(lane.semanticActivityActionCounts) ||
      Object.entries(lane.semanticActivityCounts ?? {}).some(
        ([kind, instances]) =>
          (lane.semanticActivityActionCounts?.[kind] ?? instances) < instances,
      )
    )) {
      throw new Error(`AI audit verification lacks activity repetition evidence for report ${report.id}`);
    }
    const maximum = maximumActivityRepetition(verification.policy, verification.lanes);
    if (
      JSON.stringify(verification.observed.maxActivityRepetition) !== JSON.stringify(maximum) ||
      (maximum !== undefined && maximum.count > maximum.limit)
    ) {
      throw new Error(`AI audit verification does not satisfy the frozen policy for report ${report.id}`);
    }
  }
}

function isSemanticActivityCountRecord(value: unknown): value is Record<string, number> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.entries(value).every(([id, count]) =>
      id.trim().length > 0 && Number.isInteger(count) && (count as number) > 0
    );
}

function isOptionalSemanticActivityCountRecord(
  value: unknown,
): value is Record<string, number> | undefined {
  return value === undefined || isSemanticActivityCountRecord(value);
}

function isOptionalPositiveInteger(value: unknown): value is number | undefined {
  return value === undefined || (Number.isInteger(value) && (value as number) > 0);
}

function isActivityRepetitionLimitRecord(
  value: unknown,
): value is Record<string, number> | undefined {
  return value === undefined || (
    value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length > 0 &&
    Object.entries(value).every(([kind, limit]) =>
      /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(kind) &&
      Number.isInteger(limit) && (limit as number) > 0
    )
  );
}

function maximumActivityRepetition(
  policy: {
    maxActivityRepetitions?: number;
    maxActivityRepetitionsByKind?: Record<string, number>;
  },
  lanes: Array<{
    persona: string;
    semanticActivityCounts?: Record<string, number>;
    semanticActivityObjectives?: Record<string, string[]>;
  }>,
): {
  persona: string;
  activityKind: string;
  count: number;
  limit: number;
  objectiveIds?: string[];
} | undefined {
  return lanes.flatMap((lane) => Object.entries(lane.semanticActivityCounts ?? {}).flatMap(
    ([activityKind, count]) => {
      const limit = policy.maxActivityRepetitionsByKind?.[activityKind] ??
        policy.maxActivityRepetitions;
      if (limit === undefined) return [];
      return [{
      persona: lane.persona,
      activityKind,
      count,
      limit,
      ...(lane.semanticActivityObjectives?.[activityKind]?.length
        ? { objectiveIds: [...lane.semanticActivityObjectives[activityKind]!].sort() }
        : {}),
      }];
    },
  )).sort((left, right) =>
    right.count * left.limit - left.count * right.limit ||
    right.count - left.count ||
    left.persona.localeCompare(right.persona) ||
    left.activityKind.localeCompare(right.activityKind)
  )[0];
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}

export async function getPlaytestReport(
  gameDir: string,
  id: string,
  session?: string,
): Promise<PlaytestReport> {
  if (!id.trim()) throw new Error("Playtest report id cannot be empty");
  if (session !== undefined) assertSessionName(session);
  const matches = (await listPlaytestReports(gameDir, session)).filter(
    (report) => report.id === id,
  );
  if (matches.length === 0) throw new Error(`Playtest report not found: ${id}`);
  if (matches.length > 1) throw new Error(`Duplicate playtest report id: ${id}`);
  return matches[0]!;
}

export async function reproducePlaytestReport(
  args: ReproducePlaytestReportArgs,
) {
  assertSessionName(args.to);
  const report = await getPlaytestReport(args.gameDir, args.id, args.session);
  const checkpointKind = args.checkpoint ?? (
    report.origin?.kind === "player-feedback" &&
      isPlaytestCheckpointRef(report.evidence.replayCheckpoint)
      ? "player-replay"
      : "issue"
  );
  const prepared = await loadPlaytestReportCheckpointSource(
    args.gameDir,
    report,
    checkpointKind,
  );

  return withSessionLock(args.gameDir, args.to, async () => {
    await assertReproductionTargetEmpty(args.gameDir, args.to);
    await saveSession(args.gameDir, args.to, prepared.state);
    const provenance = {
      schemaVersion: 1,
      fromReport: report.id,
      fromSession: report.session,
      sourceLogEntry: prepared.sourceLogEntry,
      mode: checkpointKind === "autoplay-replay"
        ? "playtest-replay-checkpoint" as const
        : checkpointKind === "player-replay"
        ? "player-feedback-replay-checkpoint" as const
        : "playtest-checkpoint" as const,
      ...(checkpointKind === "player-replay" && report.evidence.lastEvent
        ? { replayInput: structuredClone(report.evidence.lastEvent.input) }
        : {}),
      createdAt: new Date().toISOString(),
    };
    await writeFile(
      path.join(sessionDir(args.gameDir, args.to), "fork.json"),
      JSON.stringify(provenance, null, 2) + "\n",
      "utf-8",
    );
    await appendCheckpointedSessionEvent(
      args.gameDir,
      args.to,
      { t: Date.now(), source: "playtest-report", report: provenance },
      prepared.state,
    );
    return {
      session: args.to,
      ...provenance,
      webPath: `/?session=${encodeURIComponent(args.to)}`,
    };
  });
}

/** @internal Load immutable report state without routing through a live session. */
export async function loadPlaytestReportCheckpointSource(
  gameDir: string,
  report: PlaytestReport,
  checkpointKind: "issue" | "autoplay-replay" | "player-replay" = "issue",
): Promise<{ state: ComposedState; sourceLogEntry: number }> {
  const checkpoint = checkpointKind === "autoplay-replay"
    ? report.evidence.autoplay?.replayCheckpoint
    : checkpointKind === "player-replay"
    ? report.evidence.replayCheckpoint
    : report.evidence.checkpoint;
  if (!isPlaytestCheckpointRef(checkpoint)) {
    throw new Error(
      checkpointKind === "autoplay-replay"
        ? `Playtest report ${report.id} has no causal autoplay replay checkpoint; record a fresh autoplay finding`
        : checkpointKind === "player-replay"
        ? `Playtest report ${report.id} has no causal player-input replay checkpoint; record fresh Web feedback after an accepted input`
        : `Playtest report ${report.id} has no recoverable checkpoint; record a new report at the issue site`,
    );
  }
  const state = await loadPlaytestCheckpoint(
    gameDir,
    report.session,
    checkpoint,
  ) as ComposedState;
  const sourceLogEntry = checkpointKind === "autoplay-replay"
    ? report.evidence.autoplay?.replayLogEntry
    : checkpointKind === "player-replay"
    ? Math.max(0, (report.evidence.logEntry ?? 1) - 1)
    : report.evidence.logEntry ?? 0;
  if (!Number.isInteger(sourceLogEntry) || sourceLogEntry! < 0) {
    throw new Error(
      `Playtest report ${report.id} has no valid ${checkpointKind} source log coordinate`,
    );
  }
  return { state, sourceLogEntry: sourceLogEntry! };
}

export function formatPlaytestReports(reports: PlaytestReport[]): string {
  if (reports.length === 0) return "(no playtest reports)";
  const rows = reports.map((report) => [
    report.id,
    report.status,
    report.severity,
    report.area,
    report.session,
    report.evidence.currentScriptId ?? "—",
    report.title,
  ]);
  const headers = [
    "ID",
    "STATUS",
    "SEVERITY",
    "AREA",
    "SESSION",
    "SCRIPT",
    "TITLE",
  ];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  return [headers, ...rows]
    .map((row) =>
      row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd(),
    )
    .join("\n");
}

async function reportSessions(gameDir: string): Promise<string[]> {
  const root = path.join(gameDir, ".rpg-harness", "sessions");
  try {
    const names = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const candidates = await Promise.all(names.map(async (session) => {
      try {
        const info = await stat(path.join(root, session, REPORTS_FILE));
        return info.isFile() ? session : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    }));
    return candidates.filter((session): session is string => session !== null);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Capture state and log evidence without acquiring a lock.
 *
 * Callers that need evidence causally tied to a preceding session mutation
 * must invoke this while holding that session's transaction lock. Ordinary
 * report recording invokes it from inside its own lock.
 */
export async function capturePlaytestEvidenceSnapshot(
  gameDir: string,
  session: string,
): Promise<PlaytestEvidenceSnapshot> {
  const dir = sessionDir(gameDir, session);
  const stateFile = path.join(dir, "state.json");
  const logFile = path.join(dir, "log.jsonl");
  const relativeRoot = path.join(".rpg-harness", "sessions", session);
  const captureErrors: string[] = [];
  let currentScriptId: string | null = null;
  let lastCompletedScriptId: string | null = null;
  let logEntry: number | null = null;
  let lastEvent: PlaytestEvidence["lastEvent"] = null;
  let visualState: PlaytestEvidence["visualState"];
  let checkpoint: PlaytestCheckpointRef | undefined;
  let replayCheckpoint: PlaytestCheckpointRef | undefined;

  try {
    const serialized = await readFile(stateFile, "utf-8");
    const state = JSON.parse(serialized) as {
      baseline?: {
        currentScriptId?: unknown;
        completionOrder?: unknown;
        visuals?: unknown;
      };
    };
    if (typeof state.baseline?.currentScriptId === "string") {
      currentScriptId = state.baseline.currentScriptId;
    }
    const order = state.baseline?.completionOrder;
    if (Array.isArray(order)) {
      const last = order[order.length - 1];
      if (typeof last === "string") lastCompletedScriptId = last;
    }
    visualState = compactVisualState(state.baseline?.visuals);
    checkpoint = await persistPlaytestCheckpoint(gameDir, session, serialized);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      captureErrors.push(`state.json: ${(error as Error).message}`);
    }
  }

  try {
    const lines = (await readFile(logFile, "utf-8"))
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    if (lines.length > 0) {
      logEntry = lines.length;
      const entry = JSON.parse(lines[lines.length - 1] ?? "null") as {
        input?: unknown;
        output?: unknown;
        inputResult?: unknown;
        activityDecision?: unknown;
        replayCheckpoint?: unknown;
      } | null;
      if (entry) {
        lastEvent = {
          input: entry.input ?? null,
          output: compactOutput(entry.output),
          ...(entry.inputResult !== undefined ? { inputResult: entry.inputResult } : {}),
          ...(entry.activityDecision !== undefined
            ? { activityDecision: compactActivityDecision(entry.activityDecision) }
            : {}),
        };
        if (isSessionCheckpointRef(entry.replayCheckpoint)) {
          const replayState = await loadSessionCheckpoint(
            gameDir,
            session,
            entry.replayCheckpoint,
          );
          replayCheckpoint = await persistPlaytestCheckpoint(
            gameDir,
            session,
            JSON.stringify(replayState, null, 2),
          );
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      captureErrors.push(`log.jsonl: ${(error as Error).message}`);
    }
  }

  return {
    statePath: path.join(relativeRoot, "state.json"),
    logPath: path.join(relativeRoot, "log.jsonl"),
    logEntry,
    currentScriptId,
    lastCompletedScriptId,
    lastEvent,
    ...(visualState !== undefined ? { visualState } : {}),
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    ...(replayCheckpoint !== undefined ? { replayCheckpoint } : {}),
    ...(captureErrors.length > 0 ? { captureErrors } : {}),
  };
}

function compactActivityDecision(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return pick(value as Record<string, unknown>, [
    "activityId",
    "title",
    "kind",
    "category",
    "aiTags",
    "recommended",
    "actionKind",
    "pacingInstanceId",
    "relatedObjectiveIds",
    "focusedObjectiveId",
  ]);
}

function compactVisualState(
  value: unknown,
): PlaytestEvidence["visualState"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const visuals = value as Record<string, unknown>;
  const bg = typeof visuals.bg === "string" ? visuals.bg : null;
  const cg = typeof visuals.cg === "string" ? visuals.cg : null;
  const portraits: Record<string, string | null> = {};
  if (
    visuals.portraits &&
    typeof visuals.portraits === "object" &&
    !Array.isArray(visuals.portraits)
  ) {
    for (const [slot, asset] of Object.entries(
      visuals.portraits as Record<string, unknown>,
    )) {
      if (typeof asset === "string" || asset === null) portraits[slot] = asset;
    }
  }
  return { bg, portraits, cg };
}

async function persistPlaytestCheckpoint(
  gameDir: string,
  session: string,
  serialized: string,
): Promise<PlaytestCheckpointRef> {
  const revision = createHash("sha256").update(serialized).digest("hex");
  const relativeFile = path.posix.join(
    ISSUE_CHECKPOINTS_DIR,
    `${revision}.json`,
  );
  const dir = path.join(sessionDir(gameDir, session), ISSUE_CHECKPOINTS_DIR);
  const target = path.join(dir, `${revision}.json`);
  await mkdir(dir, { recursive: true });
  try {
    await stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const temporary = path.join(dir, `.${revision}-${randomUUID()}.tmp`);
    await writeFile(temporary, serialized, "utf-8");
    await rename(temporary, target);
  }
  return { schemaVersion: 1, file: relativeFile, revision };
}

function isPlaytestCheckpointRef(
  value: unknown,
): value is PlaytestCheckpointRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return (
    ref.schemaVersion === 1 &&
    typeof ref.revision === "string" &&
    /^[a-f0-9]{64}$/.test(ref.revision) &&
    ref.file === `${ISSUE_CHECKPOINTS_DIR}/${ref.revision}.json`
  );
}

async function loadPlaytestCheckpoint(
  gameDir: string,
  session: string,
  checkpoint: PlaytestCheckpointRef,
): Promise<unknown> {
  if (!isPlaytestCheckpointRef(checkpoint)) {
    throw new Error("Invalid playtest checkpoint reference");
  }
  const serialized = await readFile(
    path.join(sessionDir(gameDir, session), ...checkpoint.file.split("/")),
    "utf-8",
  );
  const revision = createHash("sha256").update(serialized).digest("hex");
  if (revision !== checkpoint.revision) {
    throw new Error(
      `Playtest checkpoint revision mismatch: expected ${checkpoint.revision}, got ${revision}`,
    );
  }
  return JSON.parse(serialized) as unknown;
}

async function assertReproductionTargetEmpty(
  gameDir: string,
  session: string,
): Promise<void> {
  for (const file of [
    "state.json",
    "log.jsonl",
    "fork.json",
    "checkpoints",
    REPORTS_FILE,
    ISSUE_CHECKPOINTS_DIR,
  ]) {
    try {
      await access(path.join(sessionDir(gameDir, session), file));
      throw new Error(`Target session already exists: ${session}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function compactOutput(output: unknown): unknown {
  if (!output || typeof output !== "object") return output ?? null;
  const obj = output as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "unknown";
  if (type === "dialogue") {
    return pick(obj, ["type", "speakerId", "speakerName", "text"]);
  }
  if (type === "narration") return pick(obj, ["type", "text"]);
  if (type === "choice") {
    return pick(obj, [
      "type",
      "scriptId",
      "scriptRevision",
      "choiceId",
      "prompt",
      "options",
    ]);
  }
  if (type === "hubMenu") {
    const snapshot = obj.snapshot as
      | {
          day?: unknown;
          maxDay?: unknown;
          slot?: unknown;
          slotName?: unknown;
          stats?: Array<{ id?: unknown; value?: unknown; max?: unknown }>;
          affections?: Array<{ id?: unknown; value?: unknown }>;
          objectives?: Array<{
            id?: unknown;
            title?: unknown;
            description?: unknown;
            status?: unknown;
            scope?: unknown;
            terminal?: unknown;
            focus?: unknown;
            requirements?: unknown;
            relatedActivityIds?: unknown;
          }>;
          resourceGroups?: Array<{
            id: unknown;
            title: unknown;
            description?: unknown;
            resources: Array<{
              id: unknown;
              name: unknown;
              quantity: unknown;
            }>;
          }>;
          activities?: Array<{
            id?: unknown;
            kind?: unknown;
            title?: unknown;
            description?: unknown;
            category?: unknown;
            aiTags?: unknown;
            effectsHint?: unknown;
            available?: unknown;
            recommended?: unknown;
            pacingInstanceId?: unknown;
            lockedReason?: unknown;
            requires?: unknown;
            forecast?: unknown;
            actionKind?: unknown;
            payload?: unknown;
          }>;
        }
      | undefined;
    return {
      type,
      day: snapshot?.day ?? null,
      maxDay: snapshot?.maxDay ?? null,
      slot: snapshot?.slot ?? null,
      slotName: snapshot?.slotName ?? null,
      stats: (snapshot?.stats ?? []).map((stat) => ({
        id: stat.id ?? null,
        value: stat.value ?? null,
        max: stat.max ?? null,
      })),
      affections: (snapshot?.affections ?? []).map((affection) => ({
        id: affection.id ?? null,
        value: affection.value ?? null,
      })),
      ...(snapshot?.objectives !== undefined
        ? {
            objectives: snapshot.objectives.map((objective) => ({
              id: objective.id ?? null,
              title: objective.title ?? null,
              description: objective.description ?? null,
              status: objective.status ?? null,
              scope: objective.scope ?? null,
              terminal: objective.terminal ?? null,
              focus: objective.focus ?? null,
              requirements: objective.requirements ?? [],
              relatedActivityIds: objective.relatedActivityIds ?? [],
            })),
          }
        : {}),
      ...(snapshot?.resourceGroups !== undefined
        ? {
            resourceGroups: snapshot.resourceGroups.map((group) => ({
              id: group.id,
              title: group.title,
              description: group.description ?? null,
              resources: group.resources.map((resource) => ({
                id: resource.id,
                name: resource.name,
                quantity: resource.quantity,
              })),
            })),
          }
        : {}),
      activities: (snapshot?.activities ?? []).map((activity) => ({
        id: activity.id ?? null,
        kind: activity.kind ?? null,
        title: activity.title ?? null,
        ...(activity.description !== undefined
          ? { description: activity.description }
          : {}),
        category: activity.category ?? null,
        ...(activity.pacingInstanceId !== undefined
          ? { pacingInstanceId: activity.pacingInstanceId }
          : {}),
        ...(activity.aiTags !== undefined ? { aiTags: activity.aiTags } : {}),
        ...(activity.effectsHint !== undefined
          ? { effectsHint: activity.effectsHint }
          : {}),
        available: activity.available ?? null,
        ...(activity.recommended !== undefined
          ? { recommended: activity.recommended }
          : {}),
        ...(activity.forecast !== undefined
          ? { forecast: activity.forecast }
          : {}),
        ...(activity.lockedReason !== undefined
          ? { lockedReason: activity.lockedReason }
          : {}),
        ...(activity.requires !== undefined
          ? { requires: activity.requires }
          : {}),
        ...(activity.actionKind !== undefined
          ? { actionKind: activity.actionKind }
          : {}),
        ...(activity.payload !== undefined
          ? { payload: activity.payload }
          : {}),
      })),
    };
  }
  return pick(obj, [
    "type",
    "scriptId",
    "reason",
    "endingId",
    "nextAvailable",
    "text",
  ]);
}

function pick(
  source: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

async function readReportFile(file: string): Promise<PlaytestReport[]> {
  let content: string;
  try {
    content = await readFile(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as PlaytestReport;
      } catch (error) {
        throw new Error(`${file}:${index + 1}: invalid report JSON — ${(error as Error).message}`);
      }
    });
}

async function readReportFileForDiscovery(file: string): Promise<{
  reports: PlaytestReport[];
  trailingPartial: boolean;
}> {
  let content: string;
  try {
    content = await readFile(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { reports: [], trailingPartial: false };
    }
    throw error;
  }
  const lines = content.split(/\r?\n/);
  let lastContentIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]!.trim()) {
      lastContentIndex = index;
      break;
    }
  }
  const reports: PlaytestReport[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      reports.push(JSON.parse(line) as PlaytestReport);
    } catch (error) {
      const mayBeActiveAppend = index === lastContentIndex && !/[\r\n]\s*$/.test(content);
      if (mayBeActiveAppend) return { reports, trailingPartial: true };
      throw new Error(
        `${file}:${index + 1}: invalid report JSON — ${(error as Error).message}`,
      );
    }
  }
  return { reports, trailingPartial: false };
}

async function writeReportFileAtomically(
  file: string,
  reports: PlaytestReport[],
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    reports.map((report) => JSON.stringify(report)).join("\n") + "\n",
    "utf-8",
  );
  await rename(temporary, file);
}
