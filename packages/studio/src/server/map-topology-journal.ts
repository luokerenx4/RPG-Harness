import { randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { MapTopologyError } from "./map-topology-error";

const JOURNAL_ROOT = ".studio-transactions";
const MANIFEST = "manifest.json";
const COMMITTED = "COMMITTED";

export interface MapTopologyJournalMutation {
  id: string;
  absolute: string;
  original: string;
  updated: string;
  temporary?: string;
}

export interface MapTopologyJournal {
  gameDir: string;
  directory: string;
}

interface MapTopologyJournalManifest {
  version: 1;
  kind: "map-topology";
  createdAt: string;
  entries: Array<{
    id: string;
    target: string;
    originalBase64: string;
    updatedBase64: string;
    temporary?: string;
  }>;
}

/** Persist byte-exact recovery evidence before the first source replacement. */
export async function prepareMapTopologyJournal(
  mutations: readonly MapTopologyJournalMutation[],
): Promise<MapTopologyJournal> {
  if (mutations.length === 0) throw new Error("cannot journal an empty topology transaction");
  const mapsDirs = new Set(mutations.map((mutation) => path.dirname(path.resolve(mutation.absolute))));
  if (mapsDirs.size !== 1) throw new Error("topology transaction sources must share one maps directory");
  const mapsDir = [...mapsDirs][0]!;
  if (path.basename(mapsDir) !== "maps") {
    throw new Error(`topology transaction source is not inside a maps directory: ${mapsDir}`);
  }
  const gameDir = path.dirname(mapsDir);
  const root = path.join(gameDir, JOURNAL_ROOT);
  const directory = path.join(root, `map-topology-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const manifest: MapTopologyJournalManifest = {
    version: 1,
    kind: "map-topology",
    createdAt: new Date().toISOString(),
    entries: mutations.map((mutation) => ({
      id: mutation.id,
      target: path.relative(gameDir, mutation.absolute),
      originalBase64: Buffer.from(mutation.original, "utf-8").toString("base64"),
      updatedBase64: Buffer.from(mutation.updated, "utf-8").toString("base64"),
      ...(mutation.temporary
        ? { temporary: path.relative(gameDir, mutation.temporary) }
        : {}),
    })),
  };
  const temporary = path.join(directory, `${MANIFEST}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  await rename(temporary, path.join(directory, MANIFEST));
  return { gameDir, directory };
}

/** A committed marker makes cleanup retry-safe without undoing a successful response. */
export async function markMapTopologyJournalCommitted(
  journal: MapTopologyJournal,
): Promise<void> {
  await writeFile(path.join(journal.directory, COMMITTED), "committed\n", "utf-8");
}

export async function discardMapTopologyJournal(
  journal: MapTopologyJournal,
): Promise<void> {
  await rm(journal.directory, { recursive: true });
  await removeEmptyJournalRoot(journal.gameDir);
}

/**
 * Recover any transaction interrupted by process exit. Prepared transactions
 * roll back with byte CAS; committed transactions are retained and cleaned.
 */
export async function recoverMapTopologyTransactions(gameDir: string): Promise<string[]> {
  const root = path.join(path.resolve(gameDir), JOURNAL_ROOT);
  const directories = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (nodeErrorCode(error) === "ENOENT") return [];
    throw error;
  });
  const recovered: string[] = [];
  for (const entry of directories.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.name.startsWith("map-topology-")) continue;
    if (!entry.isDirectory()) {
      throw recoveryError(entry.name, "journal path is not a directory");
    }
    const directory = path.join(root, entry.name);
    const manifestPath = path.join(directory, MANIFEST);
    const manifestExists = await recoveryFileExists(manifestPath, entry.name, "manifest");
    if (!manifestExists) {
      // Source renames never begin before manifest publication.
      await rm(directory, { recursive: true });
      continue;
    }
    let manifest: MapTopologyJournalManifest;
    try {
      manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf-8")), gameDir);
    } catch (error) {
      throw recoveryError(entry.name, `invalid journal manifest: ${(error as Error).message}`);
    }
    const committed = await recoveryFileExists(
      path.join(directory, COMMITTED),
      entry.name,
      "commit marker",
    );
    if (committed) {
      await cleanupRecoveryTemps(gameDir, manifest, entry.name);
      await removeRecoveredDirectory(directory, entry.name);
      recovered.push(entry.name);
      continue;
    }
    for (const item of [...manifest.entries].reverse()) {
      const absolute = resolveJournalTarget(gameDir, item.target);
      const original = Buffer.from(item.originalBase64, "base64").toString("utf-8");
      const updated = Buffer.from(item.updatedBase64, "base64").toString("utf-8");
      const current = await readFile(absolute, "utf-8").catch((error) => {
        if (["ENOENT", "ENOTDIR"].includes(nodeErrorCode(error))) return undefined;
        throw recoveryError(entry.name, `could not read map ${item.id}: ${(error as Error).message}`);
      });
      if (current === original) continue;
      if (current !== updated) {
        throw recoveryError(
          entry.name,
          `map ${item.id} was externally changed; recovery evidence was preserved`,
        );
      }
      const temporary = `${absolute}.studio.topology.recover.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, original, "utf-8");
        await rename(temporary, absolute);
      } catch (error) {
        await rm(temporary).catch(() => {});
        throw recoveryError(entry.name, `could not restore map ${item.id}: ${(error as Error).message}`);
      }
    }
    await cleanupRecoveryTemps(gameDir, manifest, entry.name);
    await removeRecoveredDirectory(directory, entry.name);
    recovered.push(entry.name);
  }
  await removeEmptyJournalRoot(gameDir);
  return recovered;
}

function validateManifest(raw: unknown, gameDir: string): MapTopologyJournalManifest {
  if (!isRecord(raw)) throw new Error("manifest must be an object");
  assertExactKeys(raw, ["version", "kind", "createdAt", "entries"], "manifest");
  if (raw.version !== 1 || raw.kind !== "map-topology" || !Array.isArray(raw.entries)) {
    throw new Error("unsupported map topology journal");
  }
  if (typeof raw.createdAt !== "string" || Number.isNaN(Date.parse(raw.createdAt))) {
    throw new Error("invalid map topology journal creation time");
  }
  if (raw.entries.length === 0) throw new Error("map topology journal must not be empty");
  const ids = new Set<string>();
  const targets = new Set<string>();
  const entries = raw.entries.map((value) => {
    if (!isRecord(value)) throw new Error("invalid map topology journal entry");
    assertExactKeys(
      value,
      ["id", "target", "originalBase64", "updatedBase64", "temporary"],
      "journal entry",
    );
    const entry = value;
    if (
      typeof entry.id !== "string" || !entry.id ||
      typeof entry.target !== "string" ||
      typeof entry.originalBase64 !== "string" ||
      typeof entry.updatedBase64 !== "string" ||
      (entry.temporary !== undefined && typeof entry.temporary !== "string")
    ) {
      throw new Error("invalid map topology journal entry");
    }
    if (ids.has(entry.id)) throw new Error(`duplicate journal map id: ${entry.id}`);
    const absolute = resolveJournalTarget(gameDir, entry.target);
    const extension = path.extname(absolute);
    if (path.basename(absolute, extension) !== entry.id) {
      throw new Error(`journal target does not match map id ${entry.id}: ${entry.target}`);
    }
    if (targets.has(absolute)) throw new Error(`duplicate journal target: ${entry.target}`);
    decodeJournalSource(entry.originalBase64, `${entry.id} original`);
    decodeJournalSource(entry.updatedBase64, `${entry.id} update`);
    if (entry.temporary !== undefined) {
      const temporary = resolveJournalTemporary(gameDir, entry.temporary);
      if (!temporary.startsWith(`${absolute}.studio.topology.`)) {
        throw new Error(`journal temporary does not match map id ${entry.id}: ${entry.temporary}`);
      }
    }
    ids.add(entry.id);
    targets.add(absolute);
    return {
      id: entry.id,
      target: entry.target,
      originalBase64: entry.originalBase64,
      updatedBase64: entry.updatedBase64,
      ...(entry.temporary !== undefined ? { temporary: entry.temporary } : {}),
    };
  });
  return {
    version: 1,
    kind: "map-topology",
    createdAt: raw.createdAt,
    entries,
  };
}

function decodeJournalSource(encoded: string, label: string): string {
  const bytes = Buffer.from(encoded, "base64");
  const decoded = bytes.toString("utf-8");
  if (bytes.toString("base64") !== encoded || !Buffer.from(decoded, "utf-8").equals(bytes)) {
    throw new Error(`invalid UTF-8 base64 for ${label}`);
  }
  return decoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unknown) throw new Error(`unknown ${label} field: ${unknown}`);
}

function resolveJournalTemporary(gameDir: string, relative: string): string {
  const root = path.resolve(gameDir);
  const mapsDir = path.join(root, "maps");
  const absolute = path.resolve(root, relative);
  if (
    path.dirname(absolute) !== mapsDir ||
    !/[.]studio[.]topology[.][a-f0-9-]+[.]tmp$/.test(path.basename(absolute))
  ) {
    throw new Error(`journal temporary escapes canonical maps directory: ${relative}`);
  }
  return absolute;
}

function resolveJournalTarget(gameDir: string, relative: string): string {
  const root = path.resolve(gameDir);
  const mapsDir = path.join(root, "maps");
  const absolute = path.resolve(root, relative);
  if (path.dirname(absolute) !== mapsDir || !/[.]ya?ml$/.test(path.basename(absolute))) {
    throw new Error(`journal target escapes canonical maps directory: ${relative}`);
  }
  return absolute;
}

function recoveryError(transaction: string, detail: string): MapTopologyError {
  return new MapTopologyError(
    `map topology recovery required for ${transaction}: ${detail}`,
    500,
    "map_topology_recovery_required",
  );
}

async function recoveryFileExists(
  absolute: string,
  transaction: string,
  label: string,
): Promise<boolean> {
  try {
    const entry = await lstat(absolute);
    if (!entry.isFile()) {
      throw recoveryError(transaction, `${label} is not a regular file`);
    }
    return true;
  } catch (error) {
    if (error instanceof MapTopologyError) throw error;
    if (["ENOENT", "ENOTDIR"].includes(nodeErrorCode(error))) return false;
    throw recoveryError(transaction, `could not inspect ${label}: ${(error as Error).message}`);
  }
}

async function cleanupRecoveryTemps(
  gameDir: string,
  manifest: MapTopologyJournalManifest,
  transaction: string,
): Promise<void> {
  for (const entry of manifest.entries) {
    if (!entry.temporary) continue;
    const temporary = resolveJournalTemporary(gameDir, entry.temporary);
    try {
      await rm(temporary);
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") {
        throw recoveryError(transaction, `could not remove staged source ${entry.id}: ${(error as Error).message}`);
      }
    }
  }
}

async function removeRecoveredDirectory(directory: string, transaction: string): Promise<void> {
  try {
    await rm(directory, { recursive: true });
  } catch (error) {
    throw recoveryError(transaction, `could not clean recovered journal: ${(error as Error).message}`);
  }
}

async function removeEmptyJournalRoot(gameDir: string): Promise<void> {
  const root = path.join(path.resolve(gameDir), JOURNAL_ROOT);
  try {
    await rmdir(root);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(nodeErrorCode(error))) throw error;
  }
}

function nodeErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}
