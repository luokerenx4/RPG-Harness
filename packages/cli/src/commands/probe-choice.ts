import { createHash } from "node:crypto";
import {
  createInitialState,
  peek,
  type ComposedState,
} from "@rpg-harness/engine";
import {
  assertSessionName,
  isSessionCheckpointRef,
  loadSessionCheckpoint,
} from "@rpg-harness/session-store";
import { loadGame } from "../loader";
import {
  explainPersonaChoice,
  type DeterministicChoicePersona,
  type PersonaChoiceDecision,
} from "../test/personas";
import { readSessionLog } from "./fork";

export const DEFAULT_CHOICE_PROBE_PERSONAS: DeterministicChoicePersona[] = [
  "objective",
  "greedy",
  "charmer",
  "rude",
  "hunter",
];

const DETERMINISTIC_CHOICE_PERSONAS = new Set<DeterministicChoicePersona>([
  ...DEFAULT_CHOICE_PROBE_PERSONAS,
  "extractor",
  "delver",
]);

export interface ProbeChoiceArgs {
  gameDir: string;
  session: string;
  at: number;
  personas: string[];
  pretty: boolean;
}

export interface ChoiceProbeSummary {
  source: {
    session: string;
    at: number;
    entries: number;
    mode: "checkpoint" | "initial-state" | "current-state";
    stateRevision: string;
    evaluatedStateRevision: string;
    checkpointRevision: string | null;
  };
  choice: {
    key: string | null;
    scriptId: string | null;
    choiceId: string | null;
    prompt: string | null;
    options: Array<{
      index: number;
      id: string | null;
      text: string;
      available: boolean;
      aiPriority: number | null;
      aiTags: string[];
    }>;
  };
  decisions: Array<PersonaChoiceDecision & { persona: DeterministicChoicePersona }>;
}

export async function probeChoiceCommand(args: ProbeChoiceArgs): Promise<void> {
  const summary = await runChoiceProbe(args);
  process.stdout.write(
    (args.pretty ? JSON.stringify(summary, null, 2) : JSON.stringify(summary)) +
      "\n",
  );
}

/** Re-evaluate a historical choice with the live game without advancing or persisting it. */
export async function runChoiceProbe(
  args: ProbeChoiceArgs,
): Promise<ChoiceProbeSummary> {
  if (!args.session) throw new Error("--session is required");
  if (!Number.isInteger(args.at) || args.at < 0) {
    throw new Error("--at must be a non-negative log entry number (0 selects initial state)");
  }
  if (args.personas.length === 0) throw new Error("--personas cannot be empty");
  const requested = args.personas.map((persona) => {
    if (!DETERMINISTIC_CHOICE_PERSONAS.has(persona as DeterministicChoicePersona)) {
      throw new Error(
        `Choice probe persona must be deterministic: ${persona}. Available: ${[
          ...DETERMINISTIC_CHOICE_PERSONAS,
        ].join(", ")}`,
      );
    }
    return persona as DeterministicChoicePersona;
  });
  if (new Set(requested).size !== requested.length) {
    throw new Error("--personas must not contain duplicates");
  }

  const game = await loadGame(args.gameDir);
  assertSessionName(args.session);
  const log = await readSessionLog(args.gameDir, args.session);
  if (args.at > log.length) {
    throw new Error(`--at ${args.at} exceeds source log length ${log.length}`);
  }
  const checkpoint = args.at > 0 ? log[args.at - 1]?.checkpoint : undefined;
  let sourceState: ComposedState;
  if (args.at === 0) {
    sourceState = createInitialState(game);
  } else if (isSessionCheckpointRef(checkpoint)) {
    sourceState = (await loadSessionCheckpoint(
      args.gameDir,
      args.session,
      checkpoint,
    )) as ComposedState;
  } else {
    throw new Error(
      `Log entry ${args.at} has no recoverable checkpoint; legacy logs cannot be probed against live scripts`,
    );
  }
  const source = {
    state: sourceState,
    selectedEntry: args.at,
    sourceEntries: log.length,
    mode: args.at === 0 ? "initial-state" as const : "checkpoint" as const,
  };
  const stateRevision = revisionOf(source.state);
  const result = await peek(game, source.state);
  if (result.output?.type !== "choice") {
    throw new Error(
      `Live output at ${args.session}@${args.at} is ${result.output?.type ?? "empty"}, not a choice`,
    );
  }
  const output = result.output;
  const scriptId = output.scriptId ?? null;
  const choiceId = output.choiceId ?? null;

  return {
    source: {
      session: args.session,
      at: source.selectedEntry,
      entries: source.sourceEntries,
      mode: source.mode,
      stateRevision,
      evaluatedStateRevision: revisionOf(result.state),
      checkpointRevision:
        isSessionCheckpointRef(checkpoint) ? checkpoint.revision : null,
    },
    choice: {
      key: scriptId && choiceId ? `${scriptId}/${choiceId}` : null,
      scriptId,
      choiceId,
      prompt: output.prompt ?? null,
      options: output.options.map((option, index) => ({
        index,
        id: option.id ?? null,
        text: option.text,
        available: option.available,
        aiPriority: option.aiPriority ?? null,
        aiTags: [...(option.aiTags ?? [])],
      })),
    },
    decisions: requested.map((persona) => ({
      persona,
      ...explainPersonaChoice(persona, output),
    })),
  };
}

function revisionOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
