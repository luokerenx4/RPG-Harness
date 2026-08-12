import {
  readSessionLog,
  type LoggedStep,
} from "./fork";
import {
  collectChoiceCoverage,
  type ChoiceCoverageWorkItem,
  type NarrativeResponse,
} from "./choice-coverage";
import {
  runAutoplay,
  type AutoplaySummary,
} from "./autoplay";

export interface CoverChoiceArgs {
  gameDir: string;
  session: string;
  sourceSession?: string;
  key?: string;
  persona: string;
  maxSteps: number;
  verbose: boolean;
  pretty: boolean;
}

export interface CoverChoiceSummary extends AutoplaySummary {
  workItem: ChoiceCoverageWorkItem;
  targetScriptCompleted: boolean;
  responseTrace: NarrativeResponse[];
}

export async function coverChoiceCommand(args: CoverChoiceArgs): Promise<void> {
  const summary = await runChoiceCoverageWorkItem(args);
  process.stdout.write(
    (args.pretty ? JSON.stringify(summary, null, 2) : JSON.stringify(summary)) +
      "\n",
  );
}

export async function runChoiceCoverageWorkItem(
  args: CoverChoiceArgs,
): Promise<CoverChoiceSummary> {
  if (!args.session) throw new Error("--session is required");
  if (!Number.isInteger(args.maxSteps) || args.maxSteps < 1) {
    throw new Error("--max-steps must be a positive integer for choice coverage");
  }
  const coverage = await collectChoiceCoverage(args.gameDir, args.sourceSession);
  if (coverage.sessionErrors.length > 0) {
    throw new Error(
      `Cannot read choice coverage: ${coverage.sessionErrors
        .map(({ session, error }) => `${session}: ${error}`)
        .join("; ")}`,
    );
  }
  const workItem = selectWorkItem(coverage.workItems, args.key);
  const summary = await runAutoplay({
    gameDir: args.gameDir,
    persona: args.persona,
    verbose: args.verbose,
    maxSteps: args.maxSteps,
    session: args.session,
    fromSession: workItem.evidence.fork.from,
    fromLogEntry: workItem.evidence.fork.at,
    targetChoice: {
      key: workItem.key,
      scriptId: workItem.scriptId,
      choiceId: workItem.choiceId,
      optionId: workItem.optionId,
      optionText: workItem.optionText,
    },
    stopAfterTargetScript: true,
  });
  if (summary.targetChoice?.status !== "selected") {
    throw new Error(
      `Choice coverage work item was not selected: ${workItem.key}${
        summary.error ? ` (${summary.error})` : ""
      }`,
    );
  }
  const targetScriptCompleted =
    summary.finalState.baseline.scripts[workItem.scriptId]?.completed === true;
  if (!targetScriptCompleted) {
    throw new Error(
      `Choice coverage response did not finish target script: ${workItem.scriptId}`,
    );
  }
  return {
    ...summary,
    workItem,
    targetScriptCompleted,
    responseTrace: extractTargetResponse(
      await readSessionLog(args.gameDir, args.session),
      workItem,
    ),
  };
}

function extractTargetResponse(
  entries: LoggedStep[],
  workItem: ChoiceCoverageWorkItem,
): NarrativeResponse[] {
  const start = entries.findIndex((entry) => {
    const decision = entry.decision as Record<string, unknown> | undefined;
    return decision?.scriptId === workItem.scriptId &&
      decision.choiceId === workItem.choiceId &&
      decision.optionId === workItem.optionId;
  });
  if (start < 0) return [];
  const trace: NarrativeResponse[] = [];
  for (const entry of entries.slice(start)) {
    const output = entry.output as Record<string, unknown> | undefined;
    if (output?.type === "narration" && typeof output.text === "string") {
      trace.push({ type: "narration", text: output.text });
      continue;
    }
    if (output?.type === "dialogue" && typeof output.text === "string") {
      trace.push({
        type: "dialogue",
        text: output.text,
        ...(typeof output.speakerId === "string"
          ? { speakerId: output.speakerId }
          : {}),
      });
      continue;
    }
    if (output?.type === "choice" &&
      Array.isArray(output.options) && output.options.length === 1) {
      continue;
    }
    if (trace.length > 0) break;
  }
  return trace;
}

function selectWorkItem(
  workItems: ChoiceCoverageWorkItem[],
  key?: string,
): ChoiceCoverageWorkItem {
  if (key === undefined) {
    const first = workItems[0];
    if (!first) throw new Error("No executable pending choice branches");
    return first;
  }
  const selected = workItems.find((item) => item.key === key);
  if (selected) return selected;
  const available = workItems.map((item) => item.key).join("\n  ");
  throw new Error(
    `Pending choice branch not found: ${key}${
      available ? `\n\nAvailable work items:\n  ${available}` : ""
    }`,
  );
}
