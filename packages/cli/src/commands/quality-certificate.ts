import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AiAuditConfig } from "@rpg-harness/engine";
import type { ProjectQualityAuditSummary } from "./sweep";

export interface QualityAuditInputs {
  personas: string[];
  policy: AiAuditConfig;
  maxSteps: number;
  maxSegments: number;
  seed: number;
}

export interface QualityAuditCertificate {
  schemaVersion: 1;
  revision: string;
  inputRevision: string;
  createdAt: string;
  sessionPrefix: string;
  audit: ProjectQualityAuditSummary;
}

interface QualityAuditCertificatePayload {
  schemaVersion: 1;
  inputRevision: string;
  createdAt: string;
  sessionPrefix: string;
  audit: ProjectQualityAuditSummary;
}

const SOURCE_BINARY_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".ogg",
  ".otf",
  ".png",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
]);

/**
 * Hash every authored behavior input plus the local Headless evaluator. This
 * deliberately invalidates more often than a hand-maintained version string:
 * an engine or audit implementation edit must never inherit an obsolete green
 * project verdict just because game.yaml stayed unchanged.
 */
export async function qualityAuditInputRevision(
  gameDir: string,
  inputs: QualityAuditInputs,
): Promise<string> {
  const sourceRoots = [
    { label: "game", root: path.resolve(gameDir), game: true },
    { label: "cli", root: path.resolve(import.meta.dirname, ".."), game: false },
    {
      label: "engine",
      root: path.resolve(import.meta.dirname, "../../../engine/src"),
      game: false,
    },
    {
      label: "parser",
      root: path.resolve(import.meta.dirname, "../../../parser/src"),
      game: false,
    },
    {
      label: "frontend-core",
      root: path.resolve(import.meta.dirname, "../../../frontend-core/src"),
      game: false,
    },
    {
      label: "session-store",
      root: path.resolve(import.meta.dirname, "../../../session-store/src"),
      game: false,
    },
  ];
  const files: Array<{ path: string; revision: string }> = [];
  for (const source of sourceRoots) {
    const entries = await collectSourceFiles(source.root, source.game);
    for (const file of entries) {
      const content = await readFile(file);
      files.push({
        path: `${source.label}/${toPosix(path.relative(source.root, file))}`,
        revision: createHash("sha256").update(content).digest("hex"),
      });
    }
  }
  const workspaceRoot = path.resolve(import.meta.dirname, "../../../..");
  for (const relative of [
    "bun.lock",
    "package.json",
    "tsconfig.base.json",
    "packages/cli/package.json",
    "packages/engine/package.json",
    "packages/frontend-core/package.json",
    "packages/parser/package.json",
    "packages/session-store/package.json",
  ]) {
    const content = await readFile(path.join(workspaceRoot, relative));
    files.push({
      path: `workspace/${relative}`,
      revision: createHash("sha256").update(content).digest("hex"),
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return createHash("sha256")
    .update(canonicalJson({
      schemaVersion: 1,
      inputs,
      runtime: {
        bun: process.versions.bun ?? null,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
      },
      files,
    }))
    .digest("hex");
}

export async function readQualityAuditCertificate(
  gameDir: string,
  inputRevision: string,
): Promise<{ certificate: QualityAuditCertificate; file: string } | null> {
  const referenceFile = qualityAuditCertificateReferenceFile(gameDir, inputRevision);
  let reference: unknown;
  try {
    reference = JSON.parse(await readFile(referenceFile, "utf-8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
  if (
    !isRecord(reference) ||
    reference.schemaVersion !== 1 ||
    reference.inputRevision !== inputRevision ||
    !isSha256(reference.certificateRevision)
  ) return null;
  const file = qualityAuditCertificateObjectFile(
    gameDir,
    reference.certificateRevision,
  );
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf-8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  const certificate = value as unknown as QualityAuditCertificate;
  if (
    certificate.inputRevision !== inputRevision ||
    !isSha256(certificate.revision) ||
    certificateRevision(withoutRevision(certificate)) !== certificate.revision ||
    certificate.audit?.qualityGate?.status !== "passed"
  ) return null;
  return { certificate, file };
}

export async function writeQualityAuditCertificate(
  gameDir: string,
  args: {
    inputRevision: string;
    sessionPrefix: string;
    audit: ProjectQualityAuditSummary;
  },
): Promise<{ certificate: QualityAuditCertificate; file: string }> {
  if (args.audit.qualityGate?.status !== "passed") {
    throw new Error("Only a passed project audit can be certified");
  }
  const payload: QualityAuditCertificatePayload = {
    schemaVersion: 1,
    inputRevision: args.inputRevision,
    createdAt: new Date().toISOString(),
    sessionPrefix: args.sessionPrefix,
    audit: args.audit,
  };
  const certificate: QualityAuditCertificate = {
    ...payload,
    revision: certificateRevision(payload),
  };
  const file = qualityAuditCertificateObjectFile(gameDir, certificate.revision);
  await mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomically(file, certificate);
  const referenceFile = qualityAuditCertificateReferenceFile(
    gameDir,
    args.inputRevision,
  );
  await mkdir(path.dirname(referenceFile), { recursive: true });
  await writeJsonAtomically(referenceFile, {
    schemaVersion: 1,
    inputRevision: args.inputRevision,
    certificateRevision: certificate.revision,
  });
  return { certificate, file };
}

function qualityAuditCertificateReferenceFile(
  gameDir: string,
  inputRevision: string,
): string {
  return path.join(
    gameDir,
    ".rpg-harness",
    "evidence",
    "quality",
    "inputs",
    `${inputRevision}.json`,
  );
}

function qualityAuditCertificateObjectFile(
  gameDir: string,
  certificateRevision: string,
): string {
  return path.join(
    gameDir,
    ".rpg-harness",
    "evidence",
    "quality",
    "objects",
    `${certificateRevision}.json`,
  );
}

async function writeJsonAtomically(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf-8");
  await rename(temporary, file);
}

async function collectSourceFiles(root: string, game: boolean): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relative = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;
      if (entry.isDirectory()) {
        if (shouldSkipDirectory(relative, game)) continue;
        await visit(path.join(directory, entry.name), relative);
        continue;
      }
      if (!entry.isFile() || shouldSkipFile(relative, game)) continue;
      files.push(path.join(directory, entry.name));
    }
  }
  await visit(root, "");
  return files;
}

function shouldSkipDirectory(relative: string, game: boolean): boolean {
  const segments = relative.split(path.sep);
  if (segments.some((segment) => segment.startsWith("."))) return true;
  if (!game) return segments.includes("dist") || segments.includes("node_modules");
  return segments[0] === "tests";
}

function shouldSkipFile(relative: string, game: boolean): boolean {
  const normalized = toPosix(relative);
  const base = path.basename(relative);
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(base)) return true;
  if (game && normalized === "README.md") return true;
  return SOURCE_BINARY_EXTENSIONS.has(path.extname(base).toLowerCase());
}

function certificateRevision(payload: QualityAuditCertificatePayload): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function withoutRevision(
  certificate: QualityAuditCertificate,
): QualityAuditCertificatePayload {
  const { revision: _revision, ...payload } = certificate;
  return payload;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}
