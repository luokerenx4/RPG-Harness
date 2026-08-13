import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isSessionCheckpointRef,
  loadSessionCheckpoint,
  storeCheckpointState,
  type SessionCheckpointRef,
} from "@rpg-harness/session-store";
import { scriptRevision, type ComposedState } from "@rpg-harness/engine";
import { loadGame } from "../loader";
import { sessionDir } from "../session";
import { readSessionLineage, sessionFamily } from "../session-lineage";
import { collectAuthoredChoices, collectChoiceCoverage } from "./choice-coverage";
import { collectScriptCoverage } from "./coverage";
import { readSessionLog, type LoggedStep } from "./fork";

export interface CoverageCertificateStoryFact {
  scriptId: string;
  scriptRevision: string;
  witness: {
    session: string;
    checkpoint: SessionCheckpointRef;
  };
}

export interface CoverageCertificateChoiceFact {
  scriptId: string;
  scriptRevision: string;
  choiceId: string;
  optionId: string;
  status: "selected" | "locked";
  witness: {
    session: string;
    logEntry: number;
    checkpoint: SessionCheckpointRef;
    event:
      | {
          kind: "decision";
          scriptId: string;
          scriptRevision: string;
          choiceId: string;
          optionId: string;
        }
      | {
          kind: "locked-presentation";
          scriptId: string;
          scriptRevision: string;
          choiceId: string;
          optionId: string;
          available: false;
        };
  };
}

export interface CoverageCertificate {
  schemaVersion: 1;
  revision: string;
  game: { title: string };
  scope: { rootSession: string; family: boolean };
  story: CoverageCertificateStoryFact[];
  choices: CoverageCertificateChoiceFact[];
}

export interface CreateCoverageCertificateArgs {
  gameDir: string;
  session: string;
  family?: boolean;
  out?: string;
}

export interface CoverageCertificateVerification {
  valid: boolean;
  revision: string | null;
  issues: string[];
  summary: {
    storyFacts: number;
    requiredScripts: number;
    choiceFacts: number;
    requiredOptions: number;
    checkpointObjects: number;
  };
}

interface ScopedLog {
  session: string;
  entries: LoggedStep[];
}

interface ChoiceWitnessCandidate {
  session: string;
  logEntry: number;
  checkpoint: SessionCheckpointRef;
  event: CoverageCertificateChoiceFact["witness"]["event"];
}

export async function createCoverageCertificate(
  args: CreateCoverageCertificateArgs,
): Promise<{ certificate: CoverageCertificate; file: string }> {
  const family = args.family ?? false;
  const [game, storyReport, choiceReport, logs] = await Promise.all([
    loadGame(args.gameDir),
    collectScriptCoverage(args.gameDir, args.session, family),
    collectChoiceCoverage(args.gameDir, args.session, family),
    collectScopedLogs(args.gameDir, args.session, family),
  ]);
  const blockers = certificateBlockers(storyReport, choiceReport);
  if (blockers.length > 0) {
    throw new Error(`Cannot certify incomplete development evidence:\n- ${blockers.join("\n- ")}`);
  }

  const story: CoverageCertificateStoryFact[] = [];
  for (const row of storyReport.scripts) {
    if (row.status === "ignored") continue;
    const script = game.scripts.find((candidate) => candidate.id === row.id);
    const session = row.completedSessions[0];
    if (!script || !session) {
      throw new Error(`Missing completion witness for script: ${row.id}`);
    }
    const state = JSON.parse(
      await readFile(path.join(sessionDir(args.gameDir, session), "state.json"), "utf-8"),
    ) as ComposedState;
    const checkpoint = await storeCheckpointState(args.gameDir, state);
    story.push({
      scriptId: row.id,
      scriptRevision: scriptRevision(script),
      witness: { session, checkpoint },
    });
  }

  const candidates = await collectChoiceWitnesses(args.gameDir, logs);
  const choices: CoverageCertificateChoiceFact[] = [];
  for (const choice of choiceReport.choices) {
    const authored = game.scripts.find((script) => script.id === choice.scriptId);
    if (!authored) throw new Error(`Unknown witnessed script: ${choice.scriptId}`);
    const revision = scriptRevision(authored);
    for (const option of choice.options) {
      if (option.status === "pending") {
        throw new Error(`Pending option cannot be certified: ${choice.key}/${option.id}`);
      }
      const status = option.status === "selected" ? "selected" : "locked";
      const key = choiceWitnessKey(
        choice.scriptId,
        revision,
        choice.choiceId,
        option.id,
        status,
      );
      const witness = candidates.get(key);
      if (!witness) {
        throw new Error(`No recoverable ${status} witness for option: ${choice.key}/${option.id}`);
      }
      choices.push({
        scriptId: choice.scriptId,
        scriptRevision: revision,
        choiceId: choice.choiceId,
        optionId: option.id,
        status,
        witness,
      });
    }
  }

  story.sort((a, b) => a.scriptId.localeCompare(b.scriptId));
  choices.sort((a, b) => choiceFactKeyFromFact(a).localeCompare(choiceFactKeyFromFact(b)));
  const payload: Omit<CoverageCertificate, "revision"> = {
    schemaVersion: 1,
    game: { title: game.title },
    scope: { rootSession: args.session, family },
    story,
    choices,
  };
  const certificate: CoverageCertificate = {
    ...payload,
    revision: certificateRevision(payload),
  };
  const file = args.out === undefined
    ? path.join(
        args.gameDir,
        ".rpg-harness",
        "evidence",
        "coverage",
        `${certificate.revision}.json`,
      )
    : path.resolve(args.out);
  await writeCertificate(file, certificate);
  return { certificate, file };
}

export async function readCoverageCertificate(file: string): Promise<CoverageCertificate> {
  const value = JSON.parse(await readFile(file, "utf-8")) as unknown;
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Invalid coverage certificate schema");
  }
  return value as unknown as CoverageCertificate;
}

export async function verifyCoverageCertificate(
  gameDir: string,
  certificate: CoverageCertificate,
): Promise<CoverageCertificateVerification> {
  const issues: string[] = [];
  const game = await loadGame(gameDir);
  const payload = withoutRevision(certificate);
  const computedRevision = certificateRevision(payload);
  if (!isSha256(certificate.revision) || computedRevision !== certificate.revision) {
    issues.push(
      `certificate revision mismatch: expected ${computedRevision}, got ${String(certificate.revision)}`,
    );
  }
  if (certificate.game?.title !== game.title) {
    issues.push(`game title mismatch: expected ${JSON.stringify(game.title)}`);
  }

  const scripts = new Map(game.scripts.map((script) => [script.id, script]));
  const requiredScripts = game.scripts.filter((script) => !script.coverage?.ignore);
  const storyFacts = new Map<string, CoverageCertificateStoryFact>();
  for (const fact of Array.isArray(certificate.story) ? certificate.story : []) {
    if (storyFacts.has(fact.scriptId)) issues.push(`duplicate story fact: ${fact.scriptId}`);
    storyFacts.set(fact.scriptId, fact);
  }
  for (const script of requiredScripts) {
    const fact = storyFacts.get(script.id);
    const revision = scriptRevision(script);
    if (!fact) {
      issues.push(`missing story fact: ${script.id}`);
      continue;
    }
    if (fact.scriptRevision !== revision) {
      issues.push(`stale story fact: ${script.id}`);
      continue;
    }
    try {
      const state = await loadSessionCheckpoint(
        gameDir,
        fact.witness.session,
        fact.witness.checkpoint,
      ) as ComposedState;
      if (state.baseline?.scripts?.[script.id]?.completedRevision !== revision) {
        issues.push(`story checkpoint does not prove current completion: ${script.id}`);
      }
    } catch (error) {
      issues.push(`unreadable story checkpoint ${script.id}: ${(error as Error).message}`);
    }
  }
  for (const scriptId of storyFacts.keys()) {
    if (!scripts.has(scriptId) || scripts.get(scriptId)?.coverage?.ignore) {
      issues.push(`unexpected story fact: ${scriptId}`);
    }
  }

  const authoredChoices = collectAuthoredChoices(game, gameDir);
  const expectedOptions = new Map<string, { scriptRevision: string }>();
  for (const choice of authoredChoices) {
    if (!choice.choiceId) {
      issues.push(`authored choice lacks a stable id: ${choice.key}`);
      continue;
    }
    if (choice.optionIds.length !== choice.optionCount) {
      issues.push(`authored choice has unstable option ids: ${choice.key}`);
    }
    if (choice.intentStatus !== "complete") {
      issues.push(`authored choice has incomplete AI intent: ${choice.key}`);
    }
    for (const optionId of choice.optionIds) {
      expectedOptions.set(
        choiceOptionKey(choice.scriptId, choice.choiceId, optionId),
        { scriptRevision: choice.scriptRevision! },
      );
    }
  }

  const choiceFacts = new Map<string, CoverageCertificateChoiceFact>();
  const checkpointRevisions = new Set<string>();
  for (const fact of Array.isArray(certificate.choices) ? certificate.choices : []) {
    const key = choiceOptionKey(fact.scriptId, fact.choiceId, fact.optionId);
    if (choiceFacts.has(key)) issues.push(`duplicate choice fact: ${key}`);
    choiceFacts.set(key, fact);
  }
  for (const [key, expected] of expectedOptions) {
    const fact = choiceFacts.get(key);
    if (!fact) {
      issues.push(`missing choice fact: ${key}`);
      continue;
    }
    if (fact.scriptRevision !== expected.scriptRevision) {
      issues.push(`stale choice fact: ${key}`);
    }
    if (fact.status !== "selected" && fact.status !== "locked") {
      issues.push(`invalid choice status: ${key}`);
    }
    const event = fact.witness?.event;
    if (
      !event ||
      event.scriptId !== fact.scriptId ||
      event.scriptRevision !== fact.scriptRevision ||
      event.choiceId !== fact.choiceId ||
      event.optionId !== fact.optionId ||
      (fact.status === "selected" && event.kind !== "decision") ||
      (fact.status === "locked" && event.kind !== "locked-presentation")
    ) {
      issues.push(`choice witness event mismatch: ${key}`);
    }
    try {
      await loadSessionCheckpoint(
        gameDir,
        fact.witness.session,
        fact.witness.checkpoint,
      );
      checkpointRevisions.add(fact.witness.checkpoint.revision);
    } catch (error) {
      issues.push(`unreadable choice checkpoint ${key}: ${(error as Error).message}`);
    }
  }
  for (const key of choiceFacts.keys()) {
    if (!expectedOptions.has(key)) issues.push(`unexpected choice fact: ${key}`);
  }
  for (const fact of storyFacts.values()) {
    if (isSessionCheckpointRef(fact.witness?.checkpoint)) {
      checkpointRevisions.add(fact.witness.checkpoint.revision);
    }
  }

  return {
    valid: issues.length === 0,
    revision: isSha256(certificate.revision) ? certificate.revision : null,
    issues,
    summary: {
      storyFacts: storyFacts.size,
      requiredScripts: requiredScripts.length,
      choiceFacts: choiceFacts.size,
      requiredOptions: expectedOptions.size,
      checkpointObjects: checkpointRevisions.size,
    },
  };
}

export async function coverageCertificateCommand(args: {
  gameDir: string;
  session: string;
  family: boolean;
  out?: string;
  pretty: boolean;
}): Promise<void> {
  const { certificate, file } = await createCoverageCertificate(args);
  const verification = await verifyCoverageCertificate(args.gameDir, certificate);
  if (!verification.valid) {
    throw new Error(`Generated invalid coverage certificate: ${verification.issues.join("; ")}`);
  }
  process.stdout.write(JSON.stringify({
    file,
    revision: certificate.revision,
    scope: certificate.scope,
    ...verification.summary,
    valid: true,
  }, null, args.pretty ? 2 : undefined) + "\n");
}

export async function verifyCoverageCertificateCommand(args: {
  gameDir: string;
  file: string;
  pretty: boolean;
}): Promise<void> {
  const certificate = await readCoverageCertificate(args.file);
  const verification = await verifyCoverageCertificate(args.gameDir, certificate);
  process.stdout.write(
    JSON.stringify(verification, null, args.pretty ? 2 : undefined) + "\n",
  );
  if (!verification.valid) process.exitCode = 1;
}

function certificateBlockers(
  story: Awaited<ReturnType<typeof collectScriptCoverage>>,
  choices: Awaited<ReturnType<typeof collectChoiceCoverage>>,
): string[] {
  const blockers = story.sessionErrors.map(
    (error) => `story session ${error.session}: ${error.error}`,
  );
  blockers.push(...story.scripts.flatMap((row) =>
    row.status !== "completed" && row.status !== "ignored"
      ? [`story ${row.id} is ${row.status}`]
      : [],
  ));
  blockers.push(...choices.sessionErrors.map(
    (error) => `choice session ${error.session}: ${error.error}`,
  ));
  if (choices.summary.pendingOptions > 0) {
    blockers.push(`${choices.summary.pendingOptions} choice options are pending`);
  }
  if (choices.authoring.workItems.length > 0) {
    blockers.push(`${choices.authoring.workItems.length} choice authoring items remain`);
  }
  return blockers;
}

async function collectScopedLogs(
  gameDir: string,
  rootSession: string,
  family: boolean,
): Promise<ScopedLog[]> {
  const lineage = await readSessionLineage(gameDir, rootSession);
  const logs = lineage.map(({ session, entries }) => ({ session, entries }));
  if (!family) return logs;
  for (const session of await sessionFamily(gameDir, rootSession)) {
    if (session === rootSession) continue;
    logs.push({ session, entries: await readSessionLog(gameDir, session) });
  }
  return logs;
}

async function collectChoiceWitnesses(
  gameDir: string,
  logs: ScopedLog[],
): Promise<Map<string, ChoiceWitnessCandidate>> {
  const witnesses = new Map<string, ChoiceWitnessCandidate>();
  for (const { session, entries } of logs) {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (!isSessionCheckpointRef(entry.checkpoint)) continue;
      const decision = stableDecision(entry.decision);
      const output = stableChoiceOutput(entry.output);
      const decisionKey = decision
        ? choiceWitnessKey(
            decision.scriptId,
            decision.scriptRevision,
            decision.choiceId,
            decision.optionId,
            "selected",
          )
        : null;
      const lockedOptions = output?.options.filter((option) => {
        if (option.available) return false;
        return !witnesses.has(choiceWitnessKey(
          output.scriptId,
          output.scriptRevision,
          output.choiceId,
          option.id,
          "locked",
        ));
      }) ?? [];
      if ((!decisionKey || witnesses.has(decisionKey)) && lockedOptions.length === 0) {
        continue;
      }
      const checkpointState = await loadSessionCheckpoint(
        gameDir,
        session,
        entry.checkpoint,
      );
      const checkpoint = await storeCheckpointState(gameDir, checkpointState);
      if (decision && decisionKey && !witnesses.has(decisionKey)) {
        witnesses.set(decisionKey, {
          session,
          logEntry: index + 1,
          checkpoint,
          event: { kind: "decision", ...decision },
        });
      }
      if (!output) continue;
      for (const option of lockedOptions) {
        const key = choiceWitnessKey(
          output.scriptId,
          output.scriptRevision,
          output.choiceId,
          option.id,
          "locked",
        );
        if (!witnesses.has(key)) {
          witnesses.set(key, {
            session,
            logEntry: index + 1,
            checkpoint,
            event: {
              kind: "locked-presentation",
              scriptId: output.scriptId,
              scriptRevision: output.scriptRevision,
              choiceId: output.choiceId,
              optionId: option.id,
              available: false,
            },
          });
        }
      }
    }
  }
  return witnesses;
}

function stableDecision(value: unknown): {
  scriptId: string;
  scriptRevision: string;
  choiceId: string;
  optionId: string;
} | null {
  if (!isRecord(value)) return null;
  return typeof value.scriptId === "string" &&
    typeof value.scriptRevision === "string" &&
    typeof value.choiceId === "string" &&
    typeof value.optionId === "string"
    ? {
        scriptId: value.scriptId,
        scriptRevision: value.scriptRevision,
        choiceId: value.choiceId,
        optionId: value.optionId,
      }
    : null;
}

function stableChoiceOutput(value: unknown): {
  scriptId: string;
  scriptRevision: string;
  choiceId: string;
  options: Array<{ id: string; available: boolean }>;
} | null {
  if (!isRecord(value) || value.type !== "choice" || !Array.isArray(value.options)) {
    return null;
  }
  if (
    typeof value.scriptId !== "string" ||
    typeof value.scriptRevision !== "string" ||
    typeof value.choiceId !== "string"
  ) return null;
  const options: Array<{ id: string; available: boolean }> = [];
  for (const option of value.options) {
    if (!isRecord(option) || typeof option.id !== "string" ||
      typeof option.available !== "boolean") return null;
    options.push({ id: option.id, available: option.available });
  }
  return {
    scriptId: value.scriptId,
    scriptRevision: value.scriptRevision,
    choiceId: value.choiceId,
    options,
  };
}

function choiceFactKey(
  scriptId: string,
  choiceId: string,
  optionId: string,
  status: "selected" | "locked",
): string {
  return `${choiceOptionKey(scriptId, choiceId, optionId)}/${status}`;
}

function choiceWitnessKey(
  scriptId: string,
  scriptRevision: string,
  choiceId: string,
  optionId: string,
  status: "selected" | "locked",
): string {
  return `${scriptRevision}/${choiceFactKey(scriptId, choiceId, optionId, status)}`;
}

function choiceOptionKey(scriptId: string, choiceId: string, optionId: string): string {
  return `${scriptId}/${choiceId}/${optionId}`;
}

function choiceFactKeyFromFact(fact: CoverageCertificateChoiceFact): string {
  return choiceFactKey(fact.scriptId, fact.choiceId, fact.optionId, fact.status);
}

function certificateRevision(payload: Omit<CoverageCertificate, "revision">): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function withoutRevision(
  certificate: CoverageCertificate,
): Omit<CoverageCertificate, "revision"> {
  const { revision: _revision, ...payload } = certificate;
  return payload;
}

async function writeCertificate(
  file: string,
  certificate: CoverageCertificate,
): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.coverage-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(certificate, null, 2) + "\n", "utf-8");
  await rename(temporary, file);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
