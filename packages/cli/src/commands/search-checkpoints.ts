import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import type {
  ChoiceSearchCheckpoint,
} from "@rpg-harness/engine";
import type { ForkSource } from "./fork";
import { qualityAuditInputRevision } from "./quality-certificate";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface SearchCheckpointReference {
  schemaVersion: 1;
  revision: string;
  inputRevision: string;
  file: string;
  queueNodes: number;
  totalExploredNodes: number;
}

export interface PersistedSearchCheckpoint {
  schemaVersion: 1;
  operation: "reach" | "reach-script";
  workKey: string;
  inputRevision: string;
  sourceSession: string;
  source: ForkSource;
  checkpoint: ChoiceSearchCheckpoint;
}

export async function persistSearchCheckpoint(args: {
  gameDir: string;
  operation: PersistedSearchCheckpoint["operation"];
  workKey: string;
  sourceSession: string;
  source: ForkSource;
  checkpoint: ChoiceSearchCheckpoint;
  inputRevision: string;
}): Promise<SearchCheckpointReference> {
  const artifact: PersistedSearchCheckpoint = {
    schemaVersion: 1,
    operation: args.operation,
    workKey: args.workKey,
    inputRevision: args.inputRevision,
    sourceSession: args.sourceSession,
    source: structuredClone(args.source),
    checkpoint: structuredClone(args.checkpoint),
  };
  const serialized = JSON.stringify(artifact);
  const revision = sha256(serialized);
  const file = searchCheckpointObjectFile(args.gameDir, revision);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${revision}-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, await gzipAsync(serialized));
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    schemaVersion: 1,
    revision,
    inputRevision: args.inputRevision,
    file: path.relative(args.gameDir, file).split(path.sep).join("/"),
    queueNodes: args.checkpoint.queue.length,
    totalExploredNodes: args.checkpoint.totalExploredNodes,
  };
}

export async function loadSearchCheckpoint(args: {
  gameDir: string;
  revision: string;
  operation: PersistedSearchCheckpoint["operation"];
  workKey: string;
}): Promise<PersistedSearchCheckpoint> {
  return loadSearchCheckpointAtInputRevision(
    args,
    await currentSearchInputRevision(args.gameDir),
  );
}

async function loadSearchCheckpointAtInputRevision(args: {
  gameDir: string;
  revision: string;
  operation: PersistedSearchCheckpoint["operation"];
  workKey: string;
}, inputRevision: string): Promise<PersistedSearchCheckpoint> {
  if (!isSha256(args.revision)) {
    throw new Error("search checkpoint revision must be a SHA-256 digest");
  }
  const compressed = await readFile(searchCheckpointObjectFile(
    args.gameDir,
    args.revision,
  ));
  const serialized = (await gunzipAsync(compressed)).toString("utf-8");
  if (sha256(serialized) !== args.revision) {
    throw new Error(`Search checkpoint content hash mismatch: ${args.revision}`);
  }
  const artifact = JSON.parse(serialized) as PersistedSearchCheckpoint;
  if (
    artifact.schemaVersion !== 1 ||
    artifact.operation !== args.operation ||
    artifact.workKey !== args.workKey ||
    !isSha256(artifact.inputRevision) ||
    typeof artifact.sourceSession !== "string" ||
    !artifact.sourceSession.trim() ||
    !artifact.source ||
    !Number.isInteger(artifact.source.selectedEntry) ||
    !Number.isInteger(artifact.source.sourceEntries) ||
    !artifact.checkpoint ||
    artifact.checkpoint.schemaVersion !== 1
  ) throw new Error(`Invalid search checkpoint artifact: ${args.revision}`);
  if (artifact.inputRevision !== inputRevision) {
    throw new Error(
      `Search checkpoint ${args.revision} was produced for authored/runtime revision ` +
      `${artifact.inputRevision}, current revision is ${inputRevision}`,
    );
  }
  return artifact;
}

/** Hash all authored behavior and local runtime sources, independent of audit policy. */
export async function currentSearchInputRevision(gameDir: string): Promise<string> {
  return qualityAuditInputRevision(gameDir, {
    personas: [],
    fuzzPersonas: [],
    policy: {},
    maxSteps: 0,
    maxSegments: 0,
    seeds: [],
  });
}

/** Validate a handoff reference without letting one corrupt artifact break the worklist. */
export async function searchCheckpointIsUsable(args: {
  gameDir: string;
  reference: SearchCheckpointReference;
  operation: PersistedSearchCheckpoint["operation"];
  workKey: string;
  inputRevision: string;
}): Promise<boolean> {
  if (
    args.reference.schemaVersion !== 1 ||
    !isSha256(args.reference.revision) ||
    args.reference.inputRevision !== args.inputRevision ||
    args.reference.file !== searchCheckpointRelativeFile(args.reference.revision) ||
    !Number.isInteger(args.reference.queueNodes) ||
    args.reference.queueNodes < 1 ||
    !Number.isInteger(args.reference.totalExploredNodes) ||
    args.reference.totalExploredNodes < 0
  ) return false;
  try {
    const artifact = await loadSearchCheckpointAtInputRevision({
      gameDir: args.gameDir,
      revision: args.reference.revision,
      operation: args.operation,
      workKey: args.workKey,
    }, args.inputRevision);
    return artifact.checkpoint.queue.length === args.reference.queueNodes &&
      artifact.checkpoint.totalExploredNodes === args.reference.totalExploredNodes;
  } catch {
    return false;
  }
}

function searchCheckpointObjectFile(gameDir: string, revision: string): string {
  return path.join(
    gameDir,
    ".rpg-harness",
    "evidence",
    "search",
    "objects",
    `${revision}.json.gz`,
  );
}

export function searchCheckpointRelativeFile(revision: string): string {
  return `.rpg-harness/evidence/search/objects/${revision}.json.gz`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
