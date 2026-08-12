import {
  collectChoiceCoverage,
  type ChoiceCoverageWorkItem,
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
  });
  if (summary.targetChoice?.status !== "selected") {
    throw new Error(
      `Choice coverage work item was not selected: ${workItem.key}${
        summary.error ? ` (${summary.error})` : ""
      }`,
    );
  }
  return { ...summary, workItem };
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
