import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import {
  appendFile,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export interface SessionCheckpointRef {
  schemaVersion: 1;
  file: string;
  revision: string;
}

export interface CheckpointedSessionEvent {
  checkpoint: SessionCheckpointRef;
  [key: string]: unknown;
}

export type SessionPublicAction =
  | { type: "next" }
  | {
      type: "choose";
      scriptId?: string;
      choiceId?: string;
      optionId?: string;
      text?: string;
    }
  | { type: "select"; scriptId: string; title?: string }
  | { type: "doActivity"; id: string; title?: string }
  | { type: "moveMap"; direction: "north" | "east" | "south" | "west" }
  | { type: "quit" };

export type SessionPublicDecisionBasis =
  | SessionPublicActivityDecisionBasis
  | SessionPublicChoiceDecisionBasis;

export interface SessionPublicActivityDecisionBasis {
  kind: "activity-evidence";
  /** Stable activity identity whose public Hub contract supplied this basis. */
  activityId: string;
  /** Public author-owned persona policy, not private model reasoning. */
  policyDescription: string;
  /** Exact public rule the persona attached to this decision, when authored. */
  publicIntent?: string;
  /** Bounded author-owned goal labels; the Hub snapshot/log remains authority. */
  objectives: Array<{
    id: string;
    title: string;
    scope: "main" | "side" | "mastery";
    terminal: boolean;
    focused: boolean;
  }>;
  /** May exceed objectives.length when more than three goals link the action. */
  totalObjectives: number;
  category?: string;
  aiTags: string[];
  recommended: boolean;
  /** Player-visible pre-dispatch forecast compacted from the selected Hub row. */
  forecast?: string;
  availableActivities: number;
  sameCategoryActivities: number;
}

export interface SessionPublicChoiceDecisionBasis {
  kind: "choice-evidence";
  /** Stable replay coordinate; presentation indexes are never sufficient. */
  scriptId: string;
  choiceId: string;
  optionId: string;
  /** Public author-owned persona policy, not private model reasoning. */
  policyDescription: string;
  /** Exact public selection rule the persona attached to this decision. */
  publicIntent?: string;
  /** Author-owned semantic vocabulary attached to the selected option. */
  aiTags: string[];
  /** Explicit authored preference when the option declares one. */
  aiPriority?: number;
  availableOptions: number;
}

/**
 * Shared co-play lineage. This is session data, not GUI preference: every
 * surface reads the same persona cursor and rebinds it to the state it wrote.
 */
export interface SessionCoPlayControl {
  schemaVersion: 1;
  persona: string;
  nextSeed: number;
  stateRevision: string;
  controller: string;
  lastAction?: SessionPublicAction;
  decisionBasis?: SessionPublicDecisionBasis;
  updatedAt: string;
}

const CO_PLAY_CONTROL_FILE = "co-play.json";

export function sessionStateRevision(state: unknown): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

export async function loadSessionCoPlayControl(
  gameDir: string,
  session: string,
): Promise<SessionCoPlayControl | null> {
  assertSessionName(session);
  try {
    const value = JSON.parse(await readFile(
      path.join(gameDir, ".rpg-harness", "sessions", session, CO_PLAY_CONTROL_FILE),
      "utf-8",
    )) as unknown;
    if (!isSessionCoPlayControl(value)) {
      throw new Error(`Invalid ${CO_PLAY_CONTROL_FILE} for session ${session}`);
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function loadBoundSessionCoPlayControl(
  gameDir: string,
  session: string,
  state: unknown,
): Promise<SessionCoPlayControl | null> {
  try {
    const control = await loadSessionCoPlayControl(gameDir, session);
    return control?.stateRevision === sessionStateRevision(state) ? control : null;
  } catch {
    // Control is advisory lineage, never gameplay authority. A torn/manual
    // edit drops continuation instead of blocking the save or AI recovery.
    return null;
  }
}

/** Caller must hold the session transaction lock while publishing gameplay. */
export async function writeSessionCoPlayControl(args: {
  gameDir: string;
  session: string;
  persona: string;
  nextSeed: number;
  state: unknown;
  controller: string;
  lastAction?: SessionPublicAction;
  decisionBasis?: SessionPublicDecisionBasis;
  now?: () => Date;
}): Promise<SessionCoPlayControl> {
  assertSessionName(args.session);
  if (!args.persona.trim()) throw new Error("Co-play persona cannot be empty");
  if (!args.controller.trim()) throw new Error("Co-play controller cannot be empty");
  if (
    !Number.isInteger(args.nextSeed) || args.nextSeed < 0 ||
    args.nextSeed > 0xffff_ffff
  ) throw new Error("Co-play nextSeed must be a uint32 integer");
  if (
    args.decisionBasis &&
    (!isSessionPublicDecisionBasis(args.decisionBasis) ||
      !isMatchingSessionDecisionBasis(args.lastAction, args.decisionBasis))
  ) throw new Error("Co-play decision basis must match its public action");
  const value: SessionCoPlayControl = {
    schemaVersion: 1,
    persona: args.persona,
    nextSeed: args.nextSeed,
    stateRevision: sessionStateRevision(args.state),
    controller: args.controller,
    ...(args.lastAction ? { lastAction: args.lastAction } : {}),
    ...(args.decisionBasis ? { decisionBasis: args.decisionBasis } : {}),
    updatedAt: (args.now ?? (() => new Date()))().toISOString(),
  };
  const dir = path.join(args.gameDir, ".rpg-harness", "sessions", args.session);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, CO_PLAY_CONTROL_FILE);
  const temporary = path.join(dir, `.co-play-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf-8");
  await rename(temporary, target);
  return value;
}

/** Preserve the persona RNG stream while another surface advances the world. */
export async function rebindSessionCoPlayControl(args: {
  gameDir: string;
  session: string;
  previousState: unknown;
  state: unknown;
  /** Omit for state normalization that must preserve the current owner label. */
  controller?: string;
  lastAction?: SessionPublicAction;
  decisionBasis?: SessionPublicDecisionBasis;
  now?: () => Date;
}): Promise<SessionCoPlayControl | null> {
  const current = await loadBoundSessionCoPlayControl(
    args.gameDir,
    args.session,
    args.previousState,
  );
  if (
    !current
  ) return null;
  try {
    return await writeSessionCoPlayControl({
      gameDir: args.gameDir,
      session: args.session,
      state: args.state,
      controller: args.controller ?? current.controller,
      ...(args.lastAction
        ? { lastAction: args.lastAction }
        : args.controller === undefined && current.lastAction
          ? { lastAction: current.lastAction }
          : {}),
      ...(args.decisionBasis
        ? { decisionBasis: args.decisionBasis }
        : args.controller === undefined && current.decisionBasis
          ? { decisionBasis: current.decisionBasis }
          : {}),
      ...(args.now ? { now: args.now } : {}),
      persona: current.persona,
      nextSeed: current.nextSeed,
    });
  } catch {
    // Gameplay has already been committed by callers. Losing advisory
    // continuation is safer than reporting that an accepted turn failed.
    return null;
  }
}

function isSessionCoPlayControl(value: unknown): value is SessionCoPlayControl {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const control = value as Record<string, unknown>;
  return control.schemaVersion === 1 &&
    typeof control.persona === "string" && control.persona.trim().length > 0 &&
    Number.isInteger(control.nextSeed) && (control.nextSeed as number) >= 0 &&
    (control.nextSeed as number) <= 0xffff_ffff &&
    typeof control.stateRevision === "string" && /^[a-f0-9]{64}$/.test(control.stateRevision) &&
    typeof control.controller === "string" && control.controller.trim().length > 0 &&
    typeof control.updatedAt === "string" &&
    (control.lastAction === undefined || isSessionPublicAction(control.lastAction)) &&
    (control.decisionBasis === undefined ||
      (isSessionPublicDecisionBasis(control.decisionBasis) &&
        control.lastAction !== undefined &&
        isMatchingSessionDecisionBasis(
          control.lastAction,
          control.decisionBasis,
        )));
}

function isSessionPublicDecisionBasis(
  value: unknown,
): value is SessionPublicDecisionBasis {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const basis = value as Record<string, unknown>;
  if (basis.kind === "choice-evidence") {
    return typeof basis.scriptId === "string" && !!basis.scriptId.trim() &&
      basis.scriptId.length <= 160 &&
      typeof basis.choiceId === "string" && !!basis.choiceId.trim() &&
      basis.choiceId.length <= 160 &&
      typeof basis.optionId === "string" && !!basis.optionId.trim() &&
      basis.optionId.length <= 160 &&
      typeof basis.policyDescription === "string" &&
      !!basis.policyDescription.trim() && basis.policyDescription.length <= 320 &&
      (basis.publicIntent === undefined ||
        (typeof basis.publicIntent === "string" &&
          !!basis.publicIntent.trim() && basis.publicIntent.length <= 320)) &&
      Array.isArray(basis.aiTags) && basis.aiTags.length <= 8 &&
      basis.aiTags.every((tag) =>
        typeof tag === "string" && !!tag.trim() && tag.length <= 80
      ) &&
      (basis.aiPriority === undefined ||
        typeof basis.aiPriority === "number" && Number.isFinite(basis.aiPriority)) &&
      Number.isSafeInteger(basis.availableOptions) &&
      (basis.availableOptions as number) >= 1;
  }
  if (
    basis.kind !== "activity-evidence" ||
    typeof basis.activityId !== "string" || !basis.activityId.trim() ||
    typeof basis.policyDescription !== "string" ||
    !basis.policyDescription.trim() || basis.policyDescription.length > 320 ||
    (basis.publicIntent !== undefined &&
      (typeof basis.publicIntent !== "string" ||
        !basis.publicIntent.trim() || basis.publicIntent.length > 320)) ||
    !Array.isArray(basis.objectives) ||
    basis.objectives.length > 3 ||
    !Number.isSafeInteger(basis.totalObjectives) ||
    (basis.totalObjectives as number) < basis.objectives.length ||
    (basis.category !== undefined &&
      (typeof basis.category !== "string" || !basis.category.trim() ||
        basis.category.length > 80)) ||
    !Array.isArray(basis.aiTags) || basis.aiTags.length > 8 ||
    !basis.aiTags.every((tag) =>
      typeof tag === "string" && tag.trim().length > 0 && tag.length <= 80
    ) ||
    typeof basis.recommended !== "boolean" ||
    (basis.forecast !== undefined &&
      (typeof basis.forecast !== "string" || !basis.forecast.trim() ||
        basis.forecast.length > 480)) ||
    !Number.isSafeInteger(basis.availableActivities) ||
    (basis.availableActivities as number) < 1 ||
    !Number.isSafeInteger(basis.sameCategoryActivities) ||
    (basis.sameCategoryActivities as number) < 1 ||
    (basis.sameCategoryActivities as number) >
      (basis.availableActivities as number)
  ) return false;
  return basis.objectives.every((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const objective = value as Record<string, unknown>;
    return typeof objective.id === "string" && objective.id.trim().length > 0 &&
      objective.id.length <= 160 &&
      typeof objective.title === "string" && objective.title.trim().length > 0 &&
      objective.title.length <= 320 &&
      (objective.scope === "main" || objective.scope === "side" ||
        objective.scope === "mastery") &&
      typeof objective.terminal === "boolean" &&
      typeof objective.focused === "boolean";
  });
}

function isMatchingSessionDecisionBasis(
  action: SessionPublicAction | undefined,
  basis: SessionPublicDecisionBasis,
): boolean {
  if (!action) return false;
  if (basis.kind === "activity-evidence") {
    return action.type === "doActivity" && action.id === basis.activityId;
  }
  return action.type === "choose" &&
    action.scriptId === basis.scriptId && action.choiceId === basis.choiceId &&
    action.optionId === basis.optionId;
}

function isSessionPublicAction(value: unknown): value is SessionPublicAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  switch (action.type) {
    case "next":
    case "quit":
      return true;
    case "choose":
      return (action.scriptId === undefined || typeof action.scriptId === "string") &&
        (action.choiceId === undefined || typeof action.choiceId === "string") &&
        (action.optionId === undefined || typeof action.optionId === "string") &&
        (action.text === undefined || typeof action.text === "string");
    case "select":
      return typeof action.scriptId === "string" &&
        (action.title === undefined || typeof action.title === "string");
    case "doActivity":
      return typeof action.id === "string" &&
        (action.title === undefined || typeof action.title === "string");
    case "moveMap":
      return action.direction === "north" || action.direction === "east" ||
        action.direction === "south" || action.direction === "west";
    default:
      return false;
  }
}

export interface SessionLockOptions {
  timeoutMs?: number;
  staleAfterMs?: number;
  retryMs?: number;
  /** Deterministic concurrency seam used by lease recovery tests. */
  onStaleLeaseConfirmed?: () => void | Promise<void>;
  /** Pauses after this reclaimer's live UUID claim is atomically published. */
  onRecoveryClaimAcquired?: () => void | Promise<void>;
  /** Pauses after the exact stale owner inode is pinned and revalidated. */
  onStaleOwnerPinned?: () => void | Promise<void>;
  /** Pauses after a proven-dead owner is displaced from the public gate. */
  onStaleOwnerDisplaced?: () => void | Promise<void>;
  /** Pauses after the metadata temp file is opened but before it is written. */
  onLeaseMetadataOpened?: () => void | Promise<void>;
  /** Pauses after the atomic owner link is published, before operation entry. */
  onLockPublished?: () => void | Promise<void>;
  /** Pauses after recovery-claim scan, immediately before owner publication. */
  onBeforeLockPublication?: () => void | Promise<void>;
  /** Pauses stale recovery after exact inode verification, before unlink. */
  onStaleOwnerVerifiedBeforeUnlink?: () => void | Promise<void>;
  /** Pauses a release after exact ownership verification, before unlink. */
  onOwnedLeaseVerifiedBeforeUnlink?: () => void | Promise<void>;
}

interface SessionLeaseOwner {
  schemaVersion: 1;
  token: string;
  pid: number;
  processIdentity: string | null;
  createdAt: number;
  recovery?: true;
}

interface SessionLease {
  lockFile: string;
  owner: SessionLeaseOwner;
  ownerStat: Stats;
  heartbeat: ReturnType<typeof setInterval>;
}

interface PreparedSessionLease {
  preparedFile: string;
  owner: SessionLeaseOwner;
  ownerStat: Stats;
}

interface SessionLeaseObservation {
  lockDev: number;
  lockIno: number;
  lockSize: number;
  token: string | null;
  pid: number | null;
  processIdentity: string | null;
  contentHash: string;
  heartbeatMtimeMs: number;
}

interface RecoveryClaim {
  file: string;
  pinFile: string;
  owner: SessionLeaseOwner;
  stat: Stats;
  heartbeat: ReturnType<typeof setInterval>;
}

const RECOVERY_CLAIM_PREFIX = ".transaction-lock.recovery-";
const RECOVERY_CLAIM_SUFFIX = ".claim";
const RECOVERY_PIN_PREFIX = ".transaction-lock.recovery-pin-";
const UUID_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const RECOVERY_CLAIM_PATTERN = new RegExp(
  `^\\.transaction-lock\\.recovery-(${UUID_SOURCE})\\.claim$`,
  "i",
);
const PREPARED_OWNER_PATTERN = new RegExp(
  `^\\.transaction-lock\\.owner-(${UUID_SOURCE})\\.prepared$`,
  "i",
);
const PREPARED_RECOVERY_PATTERN = new RegExp(
  `^\\.transaction-lock\\.recovery-(${UUID_SOURCE})\\.claim\\.prepared$`,
  "i",
);

let ownProcessIdentity: Promise<string | null> | null = null;

export interface CompactSessionCheckpointsOptions {
  apply?: boolean;
}

export interface SessionCheckpointCompactionSummary {
  mode: "dry-run" | "apply";
  legacyFiles: number;
  uniqueRevisions: number;
  objectsAlreadyPresent: number;
  objectsCreated: number;
  legacyFilesRemoved: number;
  legacyBytes: number;
  objectBytesRequired: number;
  reclaimableBytes: number;
}

// Cross-process transaction boundary shared by `rpgh step` and the local Web
// bridge. A hard link publishes one fully-written owner file with an atomic
// EEXIST CAS. There is no empty-directory or partially initialized public
// state for a stale observer to mistake for an abandoned owner.
export async function withSessionLock<T>(
  gameDir: string,
  session: string,
  operation: () => Promise<T>,
  options: SessionLockOptions = {},
): Promise<T> {
  assertSessionName(session);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleAfterMs = options.staleAfterMs ?? 30_000;
  const retryMs = options.retryMs ?? 20;
  const lockFile = path.join(
    gameDir,
    ".rpg-harness",
    "sessions",
    session,
    ".transaction-lock",
  );
  const sessionDir = path.dirname(lockFile);
  await mkdir(sessionDir, { recursive: true });
  await cleanupAbandonedPreparedLeases(sessionDir, staleAfterMs);
  const processIdentity = await getOwnProcessIdentity();
  const started = Date.now();
  let prepared: PreparedSessionLease | null = await prepareSessionLease(
    sessionDir,
    processIdentity,
    options.onLeaseMetadataOpened,
  );
  let linked = false;

  try {
    while (true) {
      if (await recoverAbandonedSessionClaims(sessionDir, staleAfterMs)) {
        if (Date.now() - started >= timeoutMs) {
          throw new Error(
            `Timed out waiting for interrupted session lock recovery: ${session}`,
          );
        }
        await delay(retryMs);
        continue;
      }
      await options.onBeforeLockPublication?.();
      try {
        await link(prepared.preparedFile, lockFile);
        linked = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (
          await removeIfStale(
            lockFile,
            staleAfterMs,
            options.onStaleLeaseConfirmed,
            options.onRecoveryClaimAcquired,
            options.onStaleOwnerPinned,
            options.onStaleOwnerVerifiedBeforeUnlink,
            options.onStaleOwnerDisplaced,
          )
        ) continue;
        if (Date.now() - started >= timeoutMs) {
          throw new Error(
            `Timed out waiting for session transaction lock: ${session}`,
          );
        }
        await delay(retryMs);
        continue;
      }

      try {
        await options.onLockPublished?.();
        await verifyOwnedSessionLock(lockFile, prepared);
        // A recovery fence can appear only by pinning an older public inode or
        // by pinning this fresh inode after a stale observation. In the latter
        // case its exact revalidation removes the fence without moving us. Do
        // not enter the operation until either case has settled.
        while (await recoverAbandonedSessionClaims(sessionDir, staleAfterMs)) {
          await verifyOwnedSessionLock(lockFile, prepared);
          if (Date.now() - started >= timeoutMs) {
            throw new Error(
              `Timed out waiting for interrupted session lock recovery: ${session}`,
            );
          }
          await delay(retryMs);
        }
        await verifyOwnedSessionLock(lockFile, prepared);
      } catch (error) {
        // A stale reclaimer may have verified the previous public inode before
        // this owner linked, then unlink this still-fenced publication by name.
        // The operation has not started and our private prepared inode remains
        // authoritative, so treat this as acquisition contention and retry.
        if (!(await canRetryLostPublication(lockFile, prepared))) throw error;
        linked = false;
        if (Date.now() - started >= timeoutMs) throw error;
        await delay(retryMs);
        continue;
      }
      break;
    }

    await unlink(prepared.preparedFile);
    const heartbeatMs = Math.max(1, Math.floor(staleAfterMs / 3));
    const heartbeat = setInterval(() => {
      const now = new Date();
      void utimes(lockFile, now, now).catch(() => {
        // A missing path means recovery/release already won. Token/inode
        // scoped cleanup below can never remove a replacement owner.
      });
    }, heartbeatMs);
    heartbeat.unref();
    const lease: SessionLease = {
      lockFile,
      owner: prepared.owner,
      ownerStat: prepared.ownerStat,
      heartbeat,
    };
    prepared = null;
    try {
      return await operation();
    } finally {
      await releaseSessionLease(
        lease,
        staleAfterMs,
        options.onOwnedLeaseVerifiedBeforeUnlink,
      );
    }
  } finally {
    if (prepared) {
      if (linked) {
        await unlinkOwnedSessionLock(lockFile, prepared).catch(() => {});
      }
      await rm(prepared.preparedFile, { force: true });
    }
  }
}

async function canRetryLostPublication(
  lockFile: string,
  prepared: PreparedSessionLease,
): Promise<boolean> {
  const [current, privateOwner, serialized] = await Promise.all([
    statIfPresent(lockFile),
    statIfPresent(prepared.preparedFile),
    readFile(prepared.preparedFile, "utf-8").catch(() => null),
  ]);
  if (
    privateOwner === null ||
    privateOwner.dev !== prepared.ownerStat.dev ||
    privateOwner.ino !== prepared.ownerStat.ino ||
    serialized === null ||
    !sameSessionLeaseOwner(serialized, prepared.owner)
  ) {
    return false;
  }
  return (
    current === null ||
    current.dev !== prepared.ownerStat.dev ||
    current.ino !== prepared.ownerStat.ino
  );
}

async function prepareSessionLease(
  sessionDir: string,
  processIdentity: string | null,
  onLeaseMetadataOpened?: () => void | Promise<void>,
): Promise<PreparedSessionLease> {
  const token = randomUUID();
  // Build complete owner metadata outside the public lock. Contenders can
  // therefore observe only an empty acquisition gate or one fully published
  // owner — never a token marker whose open metadata fd can later resurrect.
  const preparedFile = path.join(
    sessionDir,
    `.transaction-lock.owner-${token}.prepared`,
  );
  const owner: SessionLeaseOwner = {
    schemaVersion: 1,
    token,
    pid: process.pid,
    processIdentity,
    createdAt: Date.now(),
  };
  try {
    const handle = await open(preparedFile, "wx");
    try {
      await onLeaseMetadataOpened?.();
      await handle.writeFile(JSON.stringify(owner), "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const [ownerStat, serialized] = await Promise.all([
      stat(preparedFile),
      readFile(preparedFile, "utf-8"),
    ]);
    if (!sameSessionLeaseOwner(serialized, owner)) {
      throw new Error("Session lease metadata changed during preparation");
    }
    return { preparedFile, owner, ownerStat };
  } catch (error) {
    await rm(preparedFile, { force: true });
    throw error;
  }
}

async function verifyOwnedSessionLock(
  lockFile: string,
  prepared: PreparedSessionLease,
): Promise<void> {
  const [currentLock, serialized] = await Promise.all([
    stat(lockFile),
    readFile(lockFile, "utf-8"),
  ]);
  if (
    currentLock.dev !== prepared.ownerStat.dev ||
    currentLock.ino !== prepared.ownerStat.ino ||
    !sameSessionLeaseOwner(serialized, prepared.owner)
  ) {
    throw new Error("Session lease ownership was lost during publication");
  }
}

function sameSessionLeaseOwner(
  serialized: string,
  expected: SessionLeaseOwner,
): boolean {
  try {
    const current = JSON.parse(serialized) as Partial<SessionLeaseOwner>;
    return (
      current.schemaVersion === 1 &&
      current.token === expected.token &&
      current.pid === expected.pid &&
      current.processIdentity === expected.processIdentity &&
      current.createdAt === expected.createdAt
    );
  } catch {
    return false;
  }
}

async function releaseSessionLease(
  lease: SessionLease,
  staleAfterMs: number,
  onOwnedLeaseVerifiedBeforeUnlink?: () => void | Promise<void>,
): Promise<void> {
  clearInterval(lease.heartbeat);
  const claim = await tryAcquireRecoveryClaim(
    path.dirname(lease.lockFile),
    staleAfterMs,
  );
  try {
    await unlinkOwnedSessionLock(lease.lockFile, {
      preparedFile: "",
      owner: lease.owner,
      ownerStat: lease.ownerStat,
    }, onOwnedLeaseVerifiedBeforeUnlink);
  } finally {
    await releaseRecoveryClaim(claim);
  }
}

async function unlinkOwnedSessionLock(
  lockFile: string,
  prepared: PreparedSessionLease,
  onOwnedLeaseVerifiedBeforeUnlink?: () => void | Promise<void>,
): Promise<void> {
  const current = await statIfPresent(lockFile);
  if (
    current === null ||
    current.dev !== prepared.ownerStat.dev ||
    current.ino !== prepared.ownerStat.ino
  ) return;
  let serialized: string;
  try {
    serialized = await readFile(lockFile, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!sameSessionLeaseOwner(serialized, prepared.owner)) return;
  await onOwnedLeaseVerifiedBeforeUnlink?.();
  const verifiedAgain = await statIfPresent(lockFile);
  if (
    verifiedAgain === null ||
    verifiedAgain.dev !== prepared.ownerStat.dev ||
    verifiedAgain.ino !== prepared.ownerStat.ino
  ) return;
  try {
    await unlink(lockFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function recoverAbandonedSessionClaims(
  sessionDir: string,
  staleAfterMs: number,
): Promise<boolean> {
  const entries = await readdir(sessionDir);
  const claims = entries.flatMap((entry) => {
    const match = RECOVERY_CLAIM_PATTERN.exec(entry);
    return match?.[1] ? [{ entry, token: match[1] }] : [];
  });
  for (const claim of claims) {
    const file = path.join(sessionDir, claim.entry);
    const observed = await observeSessionLease(file);
    if (
      observed === null ||
      !isObservationStale(observed, staleAfterMs) ||
      await isLeaseOwnerAlive(observed)
    ) continue;
    const confirmed = await observeSessionLease(file);
    if (
      confirmed === null ||
      !sameLeaseObservation(observed, confirmed) ||
      !isObservationStale(confirmed, staleAfterMs) ||
      await isLeaseOwnerAlive(confirmed)
    ) continue;
    // A claim path contains an unguessable token and is never reused, so an
    // exact stale claim cannot suffer path ABA while it is being cleaned.
    await rm(recoveryPinFile(sessionDir, claim.token), { force: true });
    await rm(file, { force: true });
  }
  const remaining = await readdir(sessionDir);
  return remaining.some((entry) => RECOVERY_CLAIM_PATTERN.test(entry));
}

async function cleanupAbandonedPreparedLeases(
  sessionDir: string,
  staleAfterMs: number,
): Promise<void> {
  const entries = await readdir(sessionDir);
  for (const entry of entries) {
    const ownerMatch = PREPARED_OWNER_PATTERN.exec(entry);
    const recoveryMatch = PREPARED_RECOVERY_PATTERN.exec(entry);
    const filenameToken = ownerMatch?.[1] ?? recoveryMatch?.[1];
    if (!filenameToken) continue;
    const file = path.join(sessionDir, entry);
    const observed = await observeSessionLease(file);
    if (
      observed === null ||
      !isObservationStale(observed, staleAfterMs) ||
      await isLeaseOwnerAlive(observed)
    ) continue;
    const confirmed = await observeSessionLease(file);
    if (
      confirmed !== null &&
      (confirmed.token === null || confirmed.token === filenameToken) &&
      sameLeaseObservation(observed, confirmed) &&
      isObservationStale(confirmed, staleAfterMs) &&
      !(await isLeaseOwnerAlive(confirmed))
    ) await rm(file, { force: true });
  }
}

// Call this while holding the session transaction lock. The immutable,
// content-addressed state file makes each log event a reproducible fork point
// without inflating log.jsonl with a full ComposedState on every line.
export async function appendCheckpointedSessionEvent(
  gameDir: string,
  session: string,
  event: Record<string, unknown>,
  state: unknown,
): Promise<SessionCheckpointRef> {
  assertSessionName(session);
  const dir = path.join(gameDir, ".rpg-harness", "sessions", session);
  await mkdir(dir, { recursive: true });
  const checkpoint = await storeCheckpointState(gameDir, state);
  await appendFile(
    path.join(dir, "log.jsonl"),
    JSON.stringify({ ...event, checkpoint }) + "\n",
    "utf-8",
  );
  return checkpoint;
}

/** Persist a recoverable state object without mutating any session log. */
export async function storeCheckpointState(
  gameDir: string,
  state: unknown,
): Promise<SessionCheckpointRef> {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("checkpoint state must be a JSON object");
  }
  const serialized = JSON.stringify(state);
  const revision = createHash("sha256").update(serialized).digest("hex");
  await persistCheckpointObject(gameDir, revision, serialized);
  return {
    schemaVersion: 1,
    file: path.posix.join("checkpoints", `${revision}.json`),
    revision,
  };
}

export async function loadSessionCheckpoint(
  gameDir: string,
  session: string,
  checkpoint: SessionCheckpointRef,
): Promise<unknown> {
  assertSessionName(session);
  assertCheckpointRef(checkpoint);
  const objectFile = checkpointObjectFile(gameDir, checkpoint.revision);
  let serialized: string;
  try {
    serialized = await readVerifiedCheckpoint(objectFile, checkpoint.revision);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A development workspace may be compacted while an older GUI process is
    // still alive. The legacy location is only a migration source; all new
    // writes go to the project object store.
    const legacyFile = path.join(
      gameDir,
      ".rpg-harness",
      "sessions",
      session,
      ...checkpoint.file.split("/"),
    );
    serialized = await readVerifiedCheckpoint(legacyFile, checkpoint.revision);
  }
  return JSON.parse(serialized) as unknown;
}

// Consolidate pre-object-store checkpoint files without rewriting immutable
// session logs. The entire source set is hash-verified before --apply mutates
// anything, and every global object is durable and verified before its legacy
// copies are unlinked, so an interrupted run is safe to resume.
export async function compactSessionCheckpoints(
  gameDir: string,
  options: CompactSessionCheckpointsOptions = {},
): Promise<SessionCheckpointCompactionSummary> {
  const apply = options.apply ?? false;
  const sources = await collectLegacyCheckpointFiles(gameDir);
  const byRevision = new Map<string, LegacyCheckpointFile[]>();
  let legacyBytes = 0;
  for (const source of sources) {
    const serialized = await readVerifiedCheckpoint(source.file, source.revision);
    const bytes = Buffer.byteLength(serialized);
    source.bytes = bytes;
    legacyBytes += bytes;
    const group = byRevision.get(source.revision) ?? [];
    group.push(source);
    byRevision.set(source.revision, group);
  }

  let objectsAlreadyPresent = 0;
  let objectBytesRequired = 0;
  const missing = new Set<string>();
  for (const [revision, group] of byRevision) {
    const target = checkpointObjectFile(gameDir, revision);
    try {
      await readVerifiedCheckpoint(target, revision);
      objectsAlreadyPresent += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.add(revision);
      objectBytesRequired += group[0]?.bytes ?? 0;
    }
  }

  let objectsCreated = 0;
  let legacyFilesRemoved = 0;
  if (apply) {
    for (const [revision, group] of byRevision) {
      if (missing.has(revision)) {
        const source = group[0];
        if (!source) continue;
        const serialized = await readVerifiedCheckpoint(source.file, revision);
        await persistCheckpointObject(gameDir, revision, serialized);
        await readVerifiedCheckpoint(checkpointObjectFile(gameDir, revision), revision);
        objectsCreated += 1;
      }
      for (const source of group) {
        await unlink(source.file);
        legacyFilesRemoved += 1;
      }
    }
    for (const directory of new Set(sources.map((source) => path.dirname(source.file)))) {
      try {
        await rmdir(directory);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
      }
    }
  }

  return {
    mode: apply ? "apply" : "dry-run",
    legacyFiles: sources.length,
    uniqueRevisions: byRevision.size,
    objectsAlreadyPresent,
    objectsCreated,
    legacyFilesRemoved,
    legacyBytes,
    objectBytesRequired,
    reclaimableBytes: legacyBytes - objectBytesRequired,
  };
}

export function isSessionCheckpointRef(
  value: unknown,
): value is SessionCheckpointRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return (
    ref.schemaVersion === 1 &&
    typeof ref.revision === "string" &&
    /^[a-f0-9]{64}$/.test(ref.revision) &&
    ref.file === `checkpoints/${ref.revision}.json`
  );
}

function assertCheckpointRef(
  checkpoint: SessionCheckpointRef,
): void {
  if (!isSessionCheckpointRef(checkpoint)) {
    throw new Error("Invalid session checkpoint reference");
  }
}

interface LegacyCheckpointFile {
  file: string;
  revision: string;
  bytes: number;
}

async function collectLegacyCheckpointFiles(
  gameDir: string,
): Promise<LegacyCheckpointFile[]> {
  const sessionsRoot = path.join(gameDir, ".rpg-harness", "sessions");
  let sessions;
  try {
    sessions = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const sources: LegacyCheckpointFile[] = [];
  for (const session of sessions.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!session.isDirectory()) continue;
    const directory = path.join(sessionsRoot, session.name, "checkpoints");
    let files;
    try {
      files = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile()) continue;
      const match = /^([a-f0-9]{64})\.json$/.exec(file.name);
      if (!match?.[1]) {
        if (file.name.endsWith(".json")) {
          throw new Error(
            `Invalid legacy checkpoint filename: ${path.join(directory, file.name)}`,
          );
        }
        continue;
      }
      sources.push({
        file: path.join(directory, file.name),
        revision: match[1],
        bytes: 0,
      });
    }
  }
  return sources;
}

function checkpointObjectFile(gameDir: string, revision: string): string {
  return path.join(
    gameDir,
    ".rpg-harness",
    "objects",
    "checkpoints",
    revision.slice(0, 2),
    `${revision}.json`,
  );
}

async function persistCheckpointObject(
  gameDir: string,
  revision: string,
  serialized: string,
): Promise<void> {
  const target = checkpointObjectFile(gameDir, revision);
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true });
  try {
    await readVerifiedCheckpoint(target, revision);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(directory, `.${revision}-${randomUUID()}.tmp`);
  await writeFile(temporary, serialized, "utf-8");
  await rename(temporary, target);
}

async function readVerifiedCheckpoint(
  file: string,
  expectedRevision: string,
): Promise<string> {
  const serialized = await readFile(file, "utf-8");
  const revision = createHash("sha256").update(serialized).digest("hex");
  if (revision !== expectedRevision) {
    throw new Error(
      `Session checkpoint revision mismatch: expected ${expectedRevision}, got ${revision}`,
    );
  }
  return serialized;
}

async function removeIfStale(
  lockFile: string,
  staleAfterMs: number,
  onStaleLeaseConfirmed?: () => void | Promise<void>,
  onRecoveryClaimAcquired?: () => void | Promise<void>,
  onStaleOwnerPinned?: () => void | Promise<void>,
  onStaleOwnerVerifiedBeforeUnlink?: () => void | Promise<void>,
  onStaleOwnerDisplaced?: () => void | Promise<void>,
): Promise<boolean> {
  const sessionDir = path.dirname(lockFile);
  const observed = await observeSessionLease(lockFile);
  if (observed === null) return true;
  if (!isObservationStale(observed, staleAfterMs)) return false;

  // A live owner wins even if its event loop was briefly too busy to
  // heartbeat. PID alone is insufficient because an unrelated process may
  // reuse it after a crash; the recorded process-start identity must match.
  if (await isLeaseOwnerAlive(observed)) return false;

  // Re-read immediately before takeover. A heartbeat, replacement token, or
  // inode change means the first observation is no longer authoritative.
  const confirmed = await observeSessionLease(lockFile);
  if (
    confirmed === null ||
    !sameLeaseObservation(observed, confirmed) ||
    !isObservationStale(confirmed, staleAfterMs) ||
    await isLeaseOwnerAlive(confirmed)
  ) {
    return confirmed === null;
  }
  await onStaleLeaseConfirmed?.();

  const claim = await tryAcquireRecoveryClaim(sessionDir, staleAfterMs);
  try {
    await onRecoveryClaimAcquired?.();
    // Pin the originally confirmed inode separately from this reclaimer's
    // live claim. Multiple reclaimers may pin it, but every initializer waits
    // for all claims before operation entry.
    try {
      await link(lockFile, claim.pinFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    const [pinned, current] = await Promise.all([
      observeSessionLease(claim.pinFile),
      observeSessionLease(lockFile),
    ]);
    if (
      pinned === null ||
      current === null ||
      !sameLeaseObservation(confirmed, pinned) ||
      !sameLeaseObservation(confirmed, current) ||
      !isObservationStale(current, staleAfterMs) ||
      await isLeaseOwnerAlive(current)
    ) return current === null;
    await onStaleOwnerPinned?.();

    // Unlink only after the exact inode/content/death proof is pinned. A new
    // owner can publish immediately afterward, but this recovery path never
    // touches the public name again, so no ABA replacement can be displaced.
    const pinnedBeforeUnlink = await statIfPresent(lockFile);
    if (
      pinnedBeforeUnlink === null ||
      pinnedBeforeUnlink.dev !== confirmed.lockDev ||
      pinnedBeforeUnlink.ino !== confirmed.lockIno
    ) return false;
    await onStaleOwnerVerifiedBeforeUnlink?.();
    await unlink(lockFile);
    await onStaleOwnerDisplaced?.();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  } finally {
    await releaseRecoveryClaim(claim);
  }
}

async function tryAcquireRecoveryClaim(
  sessionDir: string,
  staleAfterMs: number,
): Promise<RecoveryClaim> {
  const owner: SessionLeaseOwner = {
    schemaVersion: 1,
    token: randomUUID(),
    pid: process.pid,
    processIdentity: await getOwnProcessIdentity(),
    createdAt: Date.now(),
    recovery: true,
  };
  const file = path.join(
    sessionDir,
    `${RECOVERY_CLAIM_PREFIX}${owner.token}${RECOVERY_CLAIM_SUFFIX}`,
  );
  const pinFile = recoveryPinFile(sessionDir, owner.token);
  const preparedFile = path.join(
    sessionDir,
    `${RECOVERY_CLAIM_PREFIX}${owner.token}${RECOVERY_CLAIM_SUFFIX}.prepared`,
  );
  let ownerStat: Stats;
  try {
    const handle = await open(preparedFile, "wx");
    try {
      await handle.writeFile(JSON.stringify(owner), "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    ownerStat = await stat(preparedFile);
    await link(preparedFile, file);
  } catch (error) {
    await rm(preparedFile, { force: true });
    throw error;
  }
  try {
    const current = await stat(file);
    if (
      current.dev !== ownerStat.dev ||
      current.ino !== ownerStat.ino ||
      !sameSessionLeaseOwner(await readFile(file, "utf-8"), owner)
    ) throw new Error("Session recovery claim ownership was lost");
  } catch (error) {
    await unlinkOwnedSessionLock(file, {
      preparedFile,
      owner,
      ownerStat,
    });
    await rm(preparedFile, { force: true });
    throw error;
  }
  await rm(preparedFile, { force: true });
  const heartbeatMs = Math.max(1, Math.floor(staleAfterMs / 3));
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(file, now, now).catch(() => {});
  }, heartbeatMs);
  heartbeat.unref();
  return { file, pinFile, owner, stat: ownerStat, heartbeat };
}

async function releaseRecoveryClaim(claim: RecoveryClaim): Promise<void> {
  clearInterval(claim.heartbeat);
  await rm(claim.pinFile, { force: true });
  const current = await statIfPresent(claim.file);
  if (
    current === null ||
    current.dev !== claim.stat.dev ||
    current.ino !== claim.stat.ino
  ) return;
  const serialized = await readFile(claim.file, "utf-8").catch(() => null);
  if (serialized === null || !sameSessionLeaseOwner(serialized, claim.owner)) return;
  await rm(claim.file, { force: true });
}

function recoveryPinFile(sessionDir: string, token: string | null): string {
  return path.join(sessionDir, `${RECOVERY_PIN_PREFIX}${token ?? "invalid"}`);
}

async function statIfPresent(file: string): Promise<Stats | null> {
  try {
    return await stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function observeSessionLease(
  lockFile: string,
): Promise<SessionLeaseObservation | null> {
  let lockStat: Stats;
  let serialized: string;
  try {
    lockStat = await stat(lockFile);
    if (lockStat.isDirectory()) {
      throw new Error(
        `Legacy session lock directory requires manual cleanup after confirming no old RPG Harness process is active: ${lockFile}`,
      );
    }
    serialized = await readFile(lockFile, "utf-8");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Legacy session lock directory")
    ) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (
      (error as NodeJS.ErrnoException).code === "EISDIR" ||
      (error as NodeJS.ErrnoException).code === "EACCES"
    ) {
      throw new Error(
        `Legacy session lock directory requires manual cleanup after confirming no old RPG Harness process is active: ${lockFile}`,
      );
    }
    throw error;
  }

  let owner: Partial<SessionLeaseOwner>;
  try {
    owner = JSON.parse(serialized) as Partial<SessionLeaseOwner>;
  } catch {
    owner = {};
  }
  const token = typeof owner.token === "string" ? owner.token : null;
  const pid =
    typeof owner.pid === "number" &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0
      ? owner.pid
      : null;
  const processIdentity =
    typeof owner.processIdentity === "string"
      ? owner.processIdentity
      : null;
  return {
    lockDev: lockStat.dev,
    lockIno: lockStat.ino,
    lockSize: lockStat.size,
    token,
    pid: owner.schemaVersion === 1 && token !== null ? pid : null,
    processIdentity:
      owner.schemaVersion === 1 && token !== null
        ? processIdentity
        : null,
    contentHash: createHash("sha256").update(serialized).digest("hex"),
    heartbeatMtimeMs: lockStat.mtimeMs,
  };
}

function isObservationStale(
  observation: SessionLeaseObservation,
  staleAfterMs: number,
): boolean {
  return Date.now() - observation.heartbeatMtimeMs > staleAfterMs;
}

function sameLeaseObservation(
  left: SessionLeaseObservation,
  right: SessionLeaseObservation,
): boolean {
  return (
    left.lockDev === right.lockDev &&
    left.lockIno === right.lockIno &&
    left.lockSize === right.lockSize &&
    left.token === right.token &&
    left.pid === right.pid &&
    left.processIdentity === right.processIdentity &&
    left.contentHash === right.contentHash &&
    left.heartbeatMtimeMs === right.heartbeatMtimeMs
  );
}

async function isLeaseOwnerAlive(
  observation: SessionLeaseObservation,
): Promise<boolean> {
  if (observation.pid === null || !isProcessAlive(observation.pid)) return false;
  // Unsupported/temporarily unavailable identity probes fail closed: they may
  // delay crash recovery, but never steal a real long-running transaction.
  if (observation.processIdentity === null) return true;
  const currentIdentity = await getProcessStartIdentity(observation.pid);
  return currentIdentity === null || currentIdentity === observation.processIdentity;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function getOwnProcessIdentity(): Promise<string | null> {
  if (!ownProcessIdentity) {
    ownProcessIdentity = getProcessStartIdentity(process.pid);
  }
  return ownProcessIdentity;
}

async function getProcessStartIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const [bootId, processStat] = await Promise.all([
        readFile("/proc/sys/kernel/random/boot_id", "utf-8"),
        readFile(`/proc/${pid}/stat`, "utf-8"),
      ]);
      // comm (field 2) is parenthesized and may itself contain spaces. Fields
      // after the last ')' begin at field 3; starttime is field 22 (index 19).
      const close = processStat.lastIndexOf(")");
      if (close < 0) return null;
      const fields = processStat.slice(close + 1).trim().split(/\s+/);
      const startTicks = fields[19];
      return startTicks && /^\d+$/.test(startTicks) &&
        /^[a-f0-9-]+$/i.test(bootId.trim())
        ? `linux:${bootId.trim()}:${startTicks}`
        : null;
    } catch {
      return null;
    }
  }

  if (process.platform === "darwin") {
    const started = await execFileText("/bin/ps", ["-o", "lstart=", "-p", String(pid)]);
    const normalized = started?.trim().replace(/\s+/g, " ") ?? "";
    return /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(normalized)
      ? `darwin:${normalized}`
      : null;
  }

  if (process.platform === "win32") {
    const ticks = await execFileText("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
    ]);
    const normalized = ticks?.trim() ?? "";
    return /^\d+$/.test(normalized) ? `win32:${normalized}` : null;
  }

  return null;
}

function execFileText(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        encoding: "utf-8",
        timeout: 2_000,
        // `ps lstart` is localized on Darwin. Preserve the inherited process
        // environment (notably PATH/SystemRoot), but force machine-stable
        // output so owner and contender identities cannot differ by locale.
        env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
      },
      (error, stdout) => {
        resolve(error || stdout.trim() === "" ? null : stdout);
      },
    );
  });
}

export function assertSessionName(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error(`Invalid session name: ${JSON.stringify(name)}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
