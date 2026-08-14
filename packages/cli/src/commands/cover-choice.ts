import {
  attachDevelopmentBranchHandoff,
  assertTargetEmpty,
  forkSession,
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
  /** Include every descendant of sourceSession, matching family-scoped discovery. */
  family?: boolean;
  /**
   * Optional player-facing premiere branch. The autonomous cover run remains
   * the proof branch; this session opens on the first authored response after
   * the selected option so GUI players can actually watch and continue it.
   */
  playerSession?: string;
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
  playerHandoff?: {
    session: string;
    webPath: string;
    sourceSession: string;
    sourceLogEntry: number;
  };
}

export async function coverChoiceCommand(args: CoverChoiceArgs): Promise<void> {
  const summary = await runChoiceCoverageWorkItem(args, {
    writeTelemetry: (text) => {
      process.stderr.write(text);
    },
  });
  process.stdout.write(
    (args.pretty ? JSON.stringify(summary, null, 2) : JSON.stringify(summary)) +
      "\n",
  );
}

export async function runChoiceCoverageWorkItem(
  args: CoverChoiceArgs,
  internalHooks: { writeTelemetry?: (text: string) => void } = {},
): Promise<CoverChoiceSummary> {
  if (!args.session) throw new Error("--session is required");
  if (!Number.isInteger(args.maxSteps) || args.maxSteps < 1) {
    throw new Error("--max-steps must be a positive integer for choice coverage");
  }
  if (args.playerSession) {
    if (args.playerSession === args.session) {
      throw new Error("Choice proof and player premiere sessions must differ");
    }
    // Fail before spending an autonomous run or publishing its proof branch.
    // The final fork still repeats this check under the player-session lock.
    await assertTargetEmpty(args.gameDir, args.playerSession);
  }
  const coverage = await collectChoiceCoverage(
    args.gameDir,
    args.sourceSession,
    args.family ?? false,
  );
  if (coverage.sessionErrors.length > 0) {
    throw new Error(
      `Cannot read choice coverage: ${coverage.sessionErrors
        .map(({ session, error }) => `${session}: ${error}`)
        .join("; ")}`,
    );
  }
  const workItem = selectWorkItem(coverage.workItems, args.key);
  const summary = await runAutoplay(
    {
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
    },
    internalHooks.writeTelemetry
      ? { writeTelemetry: internalHooks.writeTelemetry }
      : {},
  );
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
  const log = await readSessionLog(args.gameDir, args.session);
  const selectedLogEntry = findTargetSelectionEntry(log, workItem);
  if (selectedLogEntry === null) {
    throw new Error(`Choice coverage selection has no recoverable log entry: ${workItem.key}`);
  }
  const handoff = {
    schemaVersion: 1,
    workKey: `choice-branch/${workItem.key}`,
    priority: "P3",
    kind: "choice-branch",
    title: `Explore authored choice: ${workItem.optionText}`,
    operation: "cover",
    state: "covered",
    preparedAt: new Date().toISOString(),
    ...(workItem.source ? { target: workItem.source } : {}),
    coordinates: {
      scriptId: workItem.scriptId,
      choiceId: workItem.choiceId,
      optionId: workItem.optionId,
    },
  } as const;
  await attachDevelopmentBranchHandoff(args.gameDir, args.session, handoff);
  let playerHandoff: CoverChoiceSummary["playerHandoff"];
  if (args.playerSession) {
    const premiere = await forkSession({
      gameDir: args.gameDir,
      from: args.session,
      to: args.playerSession,
      at: selectedLogEntry,
      pretty: false,
    });
    await attachDevelopmentBranchHandoff(args.gameDir, args.playerSession, {
      ...handoff,
      premiere: {
        ...(workItem.prompt ? { prompt: workItem.prompt } : {}),
        optionText: workItem.optionText,
      },
    });
    playerHandoff = {
      session: args.playerSession,
      webPath: `/?session=${encodeURIComponent(args.playerSession)}`,
      sourceSession: args.session,
      sourceLogEntry: premiere.sourceLogEntry,
    };
  }
  return {
    ...summary,
    workItem,
    targetScriptCompleted,
    responseTrace: extractTargetResponse(
      log,
      workItem,
    ),
    ...(playerHandoff ? { playerHandoff } : {}),
  };
}

function findTargetSelectionEntry(
  entries: LoggedStep[],
  workItem: ChoiceCoverageWorkItem,
): number | null {
  const index = entries.findIndex((entry) => {
    const decision = entry.decision as Record<string, unknown> | undefined;
    return decision?.scriptId === workItem.scriptId &&
      decision.choiceId === workItem.choiceId &&
      decision.optionId === workItem.optionId;
  });
  return index < 0 ? null : index + 1;
}

function extractTargetResponse(
  entries: LoggedStep[],
  workItem: ChoiceCoverageWorkItem,
): NarrativeResponse[] {
  const selectedEntry = findTargetSelectionEntry(entries, workItem);
  if (selectedEntry === null) return [];
  const trace: NarrativeResponse[] = [];
  for (const entry of entries.slice(selectedEntry - 1)) {
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
