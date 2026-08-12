import { emptyVisualState, runLoop } from "@rpg-harness/engine";
import type { LoopReason, Output, VisualState } from "@rpg-harness/engine";
import {
  buildHubView,
  formatActivityForecast,
  formatHubCalendar,
} from "@rpg-harness/frontend-core";
import { access } from "node:fs/promises";
import path from "node:path";
import { loadGame } from "../loader";
import { diffVisualLines } from "../presenters/visualSummary";
import { personaDescriptions, personas } from "../test/personas";
import { appendLog, loadSession, saveSession, sessionDir } from "../session";
import { withSessionLock } from "@rpg-harness/session-store";
import { forkSession } from "./fork";
import {
  recordPlaytestReport,
  type PlaytestReport,
} from "../playtest-reports";
import {
  collectChoiceCoverage,
  type ChoiceCoverageReport,
  type ChoiceCoverageWorkItem,
} from "./choice-coverage";

export interface AutoplayArgs {
  gameDir: string;
  persona: string;
  verbose: boolean;
  maxSteps: number;
  seed?: number;
  session?: string;
  fromSession?: string;
  reportOnStop?: boolean;
  pretty?: boolean;
}

export interface AutoplaySummary {
  reason: LoopReason;
  decisions: number;
  steps: number;
  finalState: Awaited<ReturnType<typeof runLoop>>["finalState"];
  ending: string | null;
  session?: string;
  webPath?: string;
  fork?: Awaited<ReturnType<typeof forkSession>>;
  report?: PlaytestReport;
  choiceCoverage?: {
    summary: ChoiceCoverageReport["summary"];
    pendingBranches: ChoiceCoverageWorkItem[];
  };
}

export async function autoplayCommand(args: AutoplayArgs): Promise<void> {
  const summary = await runAutoplay(args);
  process.stdout.write(
    (args.pretty ? JSON.stringify(summary, null, 2) : JSON.stringify(summary)) +
      "\n",
  );
}

export async function runAutoplay(args: AutoplayArgs): Promise<AutoplaySummary> {
  if (!Number.isInteger(args.maxSteps) || args.maxSteps < 0) {
    throw new Error("--max-steps must be a non-negative integer");
  }
  if (args.fromSession && !args.session) {
    throw new Error("--from-session requires --session for the AI branch");
  }
  if (args.reportOnStop && !args.session) {
    throw new Error("--report-on-stop requires a persisted --session");
  }

  const game = await loadGame(args.gameDir);
  const persona = personas[args.persona];
  if (!persona) {
    const available = Object.entries(personaDescriptions)
      .map(([name, desc]) => `  ${name.padEnd(10)} — ${desc}`)
      .join("\n");
    throw new Error(
      `Unknown persona: ${args.persona}\n\nAvailable personas:\n${available}`,
    );
  }

  let fork: Awaited<ReturnType<typeof forkSession>> | undefined;
  if (args.fromSession && args.session) {
    try {
      await access(path.join(sessionDir(args.gameDir, args.fromSession), "state.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Source session does not exist: ${args.fromSession}`);
      }
      throw error;
    }
    fork = await forkSession({
      gameDir: args.gameDir,
      from: args.fromSession,
      to: args.session,
      pretty: false,
    });
  }
  if (args.seed !== undefined) {
    let s = args.seed;
    Math.random = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
  }

  process.stderr.write(
    `\n=== autoplay: ${game.title} (persona: ${args.persona}) ===\n\n`,
  );

  const assetMap = new Map((game.assets ?? []).map((a) => [a.path, a]));
  // Closure-tracked previous visual state so we only emit framing
  // lines on *changes* — without this every dialogue/narration that
  // carries an unchanged visualState would re-print the same banner.
  let prevVisuals: VisualState = emptyVisualState();

  const play = async () => {
    const initialState = args.session
      ? await loadSession(args.gameDir, args.session, game)
      : undefined;
    const result = await runLoop(game, initialState, persona, {
      maxSteps: args.maxSteps,
      onStep: async (entry, state) => {
        if (args.session && entry.input) {
          await saveSession(args.gameDir, args.session, state);
          await appendLog(args.gameDir, args.session, {
            t: Date.now(),
            source: `autoplay:${args.persona}`,
            input: entry.input,
            output: entry.output,
            ...(entry.decision ? { decision: entry.decision } : {}),
          }, state);
        }
        if (!args.verbose) return;
        const nextVisuals = entry.output.visualState;
        if (nextVisuals) {
          for (const line of diffVisualLines(
            prevVisuals,
            nextVisuals,
            assetMap,
          )) {
            process.stderr.write("  " + line + "\n");
          }
          // Snapshot: the engine mutates state.baseline.visuals
          // in place, so without a deep copy `prevVisuals` would
          // point to the same live object as `nextVisuals` and
          // future diffs would always be empty.
          prevVisuals = {
            bg: nextVisuals.bg,
            portraits: { ...nextVisuals.portraits },
            cg: nextVisuals.cg,
          };
        }
        const line = formatOutput(entry.output);
        if (line) process.stderr.write(line + "\n");
      },
    });
    // Persist the exact terminal state as well as each successful step. This
    // matters when a run stops between public outputs (max-steps) or an input
    // throws after mutating state: the issue checkpoint must capture the
    // actual stop site rather than the previous log entry's state.
    if (args.session) {
      await saveSession(args.gameDir, args.session, result.finalState);
    }
    return result;
  };
  const result = args.session
    ? await withSessionLock(args.gameDir, args.session, play)
    : await play();

  process.stderr.write(
    `\n=== done: ${result.reason} after ${countDecisions(result.trace)} decisions / ${result.trace.length} visible outputs ===\n`,
  );
  if (result.error) process.stderr.write(`error: ${result.error}\n`);

  const ending = detectTerminalScriptId(result);
  if (ending) process.stderr.write(`ending: ${ending}\n`);

  let report: PlaytestReport | undefined;
  if (args.reportOnStop && args.session && !result.done) {
    report = await recordPlaytestReport({
      gameDir: args.gameDir,
      session: args.session,
      area: "tooling",
      severity: result.reason === "error" ? "blocker" : "major",
      title: `Autoplay ${args.persona} stopped before game end (${result.reason})`,
      details: [
        `Built-in persona \`${args.persona}\` stopped after ${countDecisions(result.trace)} decisions and ${result.trace.length} visible outputs.`,
        `Reason: \`${result.reason}\`.`,
        ...(result.error ? [`Engine error: ${result.error}`] : []),
        ...(fork
          ? [
              `AI branch \`${args.session}\` was forked from player session \`${fork.fromSession}\` at source log entry ${fork.sourceLogEntry}.`,
            ]
          : []),
        "Reproduce from the attached immutable checkpoint, then convert the stop into a fixture or repair the persona/objective contract.",
      ].join(" "),
    });
  }

  const choiceCoverage = args.session
    ? await collectChoiceCoverage(args.gameDir, args.session)
    : undefined;

  return {
    reason: result.reason,
    decisions: countDecisions(result.trace),
    steps: result.trace.length,
    finalState: result.finalState,
    ending,
    ...(args.session
      ? {
          session: args.session,
          webPath: `/?session=${encodeURIComponent(args.session)}`,
        }
      : {}),
    ...(fork ? { fork } : {}),
    ...(report ? { report } : {}),
    ...(choiceCoverage
      ? {
          choiceCoverage: {
            summary: choiceCoverage.summary,
            pendingBranches: choiceCoverage.workItems,
          },
        }
      : {}),
  };
}

function countDecisions(trace: Array<{ input: unknown | null }>): number {
  return trace.reduce((count, entry) => count + (entry.input === null ? 0 : 1), 0);
}

export function detectTerminalScriptId(result: {
  done: boolean;
  trace: ReadonlyArray<{ output: Output }>;
  finalState: { baseline: { completionOrder: string[] } };
}): string | null {
  return result.done && result.trace.at(-1)?.output.type === "gameEnd"
    ? result.finalState.baseline.completionOrder.at(-1) ?? null
    : null;
}

function formatOutput(o: Output): string | null {
  switch (o.type) {
    case "narration":
      return `  ${o.text}`;
    case "dialogue":
      return `  ${o.speakerName}: 「${o.text}」`;
    case "choice":
      return (
        `  ? ${o.prompt ?? ""}\n` +
        o.options
          .map(
            (opt, i) =>
              `    ${i + 1}. ${opt.text}${
                opt.available ? "" : "  (locked)"
              }`,
          )
          .join("\n")
      );
    case "scriptComplete":
      return `  ─── ${o.completedId ?? "(start)"} ─── next: ${
        o.nextAvailable.map((s) => s.id).join(", ") || "(none)"
      }`;
    case "hubMenu": {
      const s = o.snapshot;
      const view = buildHubView(s);
      const opportunityByCategory = new Map(
        view.opportunityGroups.map((group) => [group.category, group]),
      );
      const calendar = formatHubCalendar(s);
      const stats = s.stats.map((st) => `${st.name}:${st.value}`).join(" ");
      const resources = (s.resourceGroups ?? [])
        .map(
          (group) =>
            `  {${group.title}: ${group.resources
              .map((resource) => `${resource.name}×${resource.quantity}`)
              .join("、")}}`,
        )
        .join("\n");
      let index = 0;
      const sections = view.sections
        .map((section) => {
          const acts = section.activities
            .map(({ activity }) => {
              index += 1;
              const primary =
                activity.id === view.primaryActivityId ? " ★" : "";
              const forecast = formatActivityForecast(activity);
              return `${index}. ${activity.title}${primary}${
                activity.available ? "" : " (locked)"
              }${forecast ? ` [${forecast}]` : ""}`;
            })
            .join("  ");
          return `    [${section.category} ${section.availableCount}/${
            section.activities.length
          }${
            opportunityByCategory.get(section.category)?.decisionRequired
              ? " choice"
              : ""
          }] ${acts}`;
        })
        .join("\n");
      return `  ${calendar ? `[${calendar}]  ` : ""}${stats}${
        resources ? `\n${resources}` : ""
      }${
        view.strategyDecisionRequired
          ? `\n  [strategy ${view.opportunityGroups.length} paths]`
          : ""
      }\n${sections}`;
    }
    case "gameEnd":
      return `  ═══ GAME END ═══${o.reason ? ` (${o.reason})` : ""}`;
    case "clear":
      return `  ─── scene ───`;
  }
}
