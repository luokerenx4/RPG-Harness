import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AiAuditConfig } from "@rpg-harness/engine";
import { loadGame } from "../loader";
import type {
  ProjectQualityAuditSummary,
  ProjectQualityFuzzAuditSummary,
} from "./sweep";

export interface QualityAuditInputs {
  personas: string[];
  fuzzPersonas: string[];
  policy: AiAuditConfig;
  maxSteps: number;
  maxSegments: number;
  seeds: number[];
}

export interface QualityAuditCertificate {
  schemaVersion: 4;
  revision: string;
  inputRevision: string;
  createdAt: string;
  sessionPrefix: string;
  audits: ProjectQualityAuditSummary[];
  fuzzAudits: ProjectQualityFuzzAuditSummary[];
  surfaces: QualitySurfaceEvidence[];
}

export interface CurrentQualityAuditCertificate {
  certificate: QualityAuditCertificate;
  file: string;
}

interface QualityAuditCertificatePayload {
  schemaVersion: 4;
  inputRevision: string;
  createdAt: string;
  sessionPrefix: string;
  audits: ProjectQualityAuditSummary[];
  fuzzAudits: ProjectQualityFuzzAuditSummary[];
  surfaces: QualitySurfaceEvidence[];
}

export interface QualitySurfaceEvidence {
  schemaVersion: 1;
  id: "web-input-contract";
  status: "passed";
  revision: string;
  interactions: Array<{ surface: string; input: unknown }>;
}

const execFileAsync = promisify(execFile);
const REQUIRED_WEB_INTERACTIONS = [
  { surface: "narration", input: { type: "next" } },
  {
    surface: "choice",
    input: { type: "choose", choiceId: "route", optionId: "friends" },
  },
  {
    surface: "hub-activity",
    input: { type: "doActivity", id: "invite:kasumi" },
  },
  {
    surface: "script-select",
    input: { type: "select", scriptId: "ending" },
  },
] as const;

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
  options: { workspaceRoot?: string } = {},
): Promise<string> {
  const workspaceRoot = options.workspaceRoot ??
    path.resolve(import.meta.dirname, "../../../..");
  const sourceRoots = [
    { label: "game", root: path.resolve(gameDir), game: true },
    {
      label: "cli",
      root: path.join(workspaceRoot, "packages", "cli", "src"),
      game: false,
    },
    {
      label: "engine",
      root: path.join(workspaceRoot, "packages", "engine", "src"),
      game: false,
    },
    {
      label: "parser",
      root: path.join(workspaceRoot, "packages", "parser", "src"),
      game: false,
    },
    {
      label: "frontend-core",
      root: path.join(workspaceRoot, "packages", "frontend-core", "src"),
      game: false,
    },
    {
      label: "session-store",
      root: path.join(workspaceRoot, "packages", "session-store", "src"),
      game: false,
    },
    {
      label: "web",
      root: path.join(workspaceRoot, "packages", "web", "src"),
      game: false,
    },
    {
      label: "web-dev",
      root: path.join(workspaceRoot, "packages", "web", "dev"),
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
  for (const relative of [
    "bun.lock",
    "package.json",
    "tsconfig.base.json",
    "packages/cli/package.json",
    "packages/engine/package.json",
    "packages/frontend-core/package.json",
    "packages/parser/package.json",
    "packages/session-store/package.json",
    "packages/web/package.json",
    "packages/web/vite.config.ts",
    "packages/web/index.html",
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
    reference.schemaVersion !== 4 ||
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
  if (!isRecord(value) || value.schemaVersion !== 4) return null;
  const certificate = value as unknown as QualityAuditCertificate;
  if (
    certificate.inputRevision !== inputRevision ||
    !isSha256(certificate.revision) ||
    certificateRevision(withoutRevision(certificate)) !== certificate.revision ||
    !hasPassingAudits(certificate.audits) ||
    !hasPassingFuzzAudits(certificate.fuzzAudits, certificate.audits) ||
    !hasRequiredQualitySurfaces(certificate.surfaces)
  ) return null;
  return { certificate, file };
}

/** Find the newest intact certificate whose exact game/evaluator inputs still match. */
export async function findCurrentQualityAuditCertificate(
  gameDir: string,
): Promise<CurrentQualityAuditCertificate | null> {
  const objectsDir = path.join(
    gameDir,
    ".rpg-harness",
    "evidence",
    "quality",
    "objects",
  );
  let entries: string[];
  try {
    entries = (await readdir(objectsDir))
      .filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const game = await loadGame(gameDir);
  const currentByInputs = new Map<string, string>();
  const candidates: CurrentQualityAuditCertificate[] = [];
  for (const entry of entries) {
    const file = path.join(objectsDir, entry);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(file, "utf-8"));
    } catch {
      continue;
    }
    if (!isRecord(value) || value.schemaVersion !== 4) continue;
    const certificate = value as unknown as QualityAuditCertificate;
    const filenameRevision = entry.slice(0, -".json".length);
    if (
      certificate.revision !== filenameRevision ||
      certificateRevision(withoutRevision(certificate)) !== certificate.revision ||
      !hasPassingAudits(certificate.audits) ||
      !hasPassingFuzzAudits(certificate.fuzzAudits, certificate.audits) ||
      !hasRequiredQualitySurfaces(certificate.surfaces)
    ) continue;
    const firstAudit = certificate.audits[0]!;
    const policy = firstAudit.qualityGate!.policy;
    const personas = firstAudit.lanes.map((lane) => lane.persona);
    if (
      !game.aiAudit ||
      canonicalJson(game.aiAudit) !== canonicalJson(policy) ||
      personas.length === 0
    ) continue;
    const inputs: QualityAuditInputs = {
      personas,
      fuzzPersonas: game.aiAudit.fuzzPersonas ?? [],
      policy,
      maxSteps: firstAudit.maxSteps,
      maxSegments: firstAudit.maxSegments,
      seeds: certificate.audits.map((audit) => audit.seed),
    };
    const inputsKey = canonicalJson(inputs);
    let currentRevision = currentByInputs.get(inputsKey);
    if (!currentRevision) {
      currentRevision = await qualityAuditInputRevision(gameDir, inputs);
      currentByInputs.set(inputsKey, currentRevision);
    }
    if (currentRevision === certificate.inputRevision) {
      candidates.push({ certificate, file });
    }
  }
  candidates.sort((left, right) =>
    right.certificate.createdAt.localeCompare(left.certificate.createdAt)
  );
  return candidates[0] ?? null;
}

export async function writeQualityAuditCertificate(
  gameDir: string,
  args: {
    inputRevision: string;
    sessionPrefix: string;
    audits: ProjectQualityAuditSummary[];
    fuzzAudits: ProjectQualityFuzzAuditSummary[];
  },
): Promise<{ certificate: QualityAuditCertificate; file: string }> {
  if (!hasPassingAudits(args.audits)) {
    throw new Error("Only a non-empty matrix of passed project audits can be certified");
  }
  if (!hasPassingFuzzAudits(args.fuzzAudits, args.audits)) {
    throw new Error("Only completed project fuzz audits can be certified");
  }
  const surfaces = await runQualitySurfaceChecks();
  const payload: QualityAuditCertificatePayload = {
    schemaVersion: 4,
    inputRevision: args.inputRevision,
    createdAt: new Date().toISOString(),
    sessionPrefix: args.sessionPrefix,
    audits: args.audits,
    fuzzAudits: args.fuzzAudits,
    surfaces,
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
    schemaVersion: 4,
    inputRevision: args.inputRevision,
    certificateRevision: certificate.revision,
  });
  return { certificate, file };
}

export async function runQualitySurfaceChecks(
  workspaceRoot = path.resolve(import.meta.dirname, "../../../.."),
): Promise<QualitySurfaceEvidence[]> {
  const checker = path.join(
    workspaceRoot,
    "packages",
    "web",
    "dev",
    "quality-surface-check.tsx",
  );
  const { stdout } = await execFileAsync("bun", [checker], {
    maxBuffer: 1024 * 1024,
  });
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `Web quality surface check returned invalid JSON: ${(error as Error).message}`,
    );
  }
  if (!isQualitySurfaceEvidence(value)) {
    throw new Error("Web quality surface check did not return passing evidence");
  }
  return [value];
}

function hasRequiredQualitySurfaces(
  surfaces: unknown,
): surfaces is QualitySurfaceEvidence[] {
  return Array.isArray(surfaces) && surfaces.length === 1 &&
    isQualitySurfaceEvidence(surfaces[0]);
}

function isQualitySurfaceEvidence(value: unknown): value is QualitySurfaceEvidence {
  if (!(isRecord(value) &&
    value.schemaVersion === 1 &&
    value.id === "web-input-contract" &&
    value.status === "passed" &&
    isSha256(value.revision) &&
    Array.isArray(value.interactions))) return false;
  const serialized = JSON.stringify(value.interactions);
  return serialized === JSON.stringify(REQUIRED_WEB_INTERACTIONS) &&
    value.revision === createHash("sha256").update(serialized).digest("hex");
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

function hasPassingAudits(
  value: unknown,
): value is ProjectQualityAuditSummary[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const seeds = value.flatMap((audit) =>
    isRecord(audit) && Number.isInteger(audit.seed) ? [audit.seed as number] : []
  );
  if (seeds.length !== value.length || new Set(seeds).size !== seeds.length) return false;
  const first = value[0];
  if (!isRecord(first) || !isRecord(first.qualityGate)) return false;
  const firstPolicy = first.qualityGate.policy;
  const firstPersonas = Array.isArray(first.lanes)
    ? first.lanes.flatMap((lane) =>
      isRecord(lane) && typeof lane.persona === "string" ? [lane.persona] : []
    )
    : [];
  if (
    !isRecord(firstPolicy) ||
    firstPersonas.length === 0 ||
    (Array.isArray(firstPolicy.seeds) && canonicalJson(firstPolicy.seeds) !== canonicalJson(seeds))
  ) return false;
  return value.every((audit) =>
    isRecord(audit) &&
    Number.isInteger(audit.seed) &&
    isRecord(audit.qualityGate) &&
    audit.qualityGate.status === "passed" &&
    canonicalJson(audit.qualityGate.policy) === canonicalJson(firstPolicy) &&
    Array.isArray(audit.lanes) &&
    canonicalJson(audit.lanes.map((lane) => isRecord(lane) ? lane.persona : null)) ===
      canonicalJson(firstPersonas) &&
    audit.maxSteps === first.maxSteps &&
    audit.maxSegments === first.maxSegments
  );
}

function hasPassingFuzzAudits(
  value: unknown,
  audits: ProjectQualityAuditSummary[],
): value is ProjectQualityFuzzAuditSummary[] {
  if (!Array.isArray(value)) return false;
  const expectedSeeds = audits.map((audit) => audit.seed);
  if (value.length === 0) {
    return (audits[0]?.qualityGate?.policy.fuzzPersonas?.length ?? 0) === 0;
  }
  const expectedPersonas = audits[0]?.qualityGate?.policy.fuzzPersonas ?? [];
  return value.length === expectedSeeds.length && value.every((audit, index) =>
    isRecord(audit) &&
    audit.seed === expectedSeeds[index] &&
    audit.maxSteps === audits[index]?.maxSteps &&
    audit.maxSegments === audits[index]?.maxSegments &&
    isRecord(audit.source) &&
    audit.source.stateRevision === audits[index]?.source.stateRevision &&
    isRecord(audit.totals) &&
    audit.totals.completed === expectedPersonas.length &&
    audit.totals.lanes === expectedPersonas.length &&
    audit.totals.errors === 0 &&
    audit.totals.rejectedInputs === 0 &&
    audit.totals.openReports === 0 &&
    Array.isArray(audit.lanes) &&
    canonicalJson(audit.lanes.map((lane) => isRecord(lane) ? lane.persona : null)) ===
      canonicalJson(expectedPersonas) &&
    audit.lanes.every((lane) => isRecord(lane) && lane.reason === "completed" &&
      typeof lane.ending === "string" && lane.ending.length > 0 &&
      Number.isInteger(lane.decisions) && (lane.decisions as number) >= 0 &&
      isSha256(lane.pathRevision))
  );
}

function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}
