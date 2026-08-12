import { emptyVisualState, runLoop } from "@rpg-harness/engine";
import type { Output, VisualState } from "@rpg-harness/engine";
import {
  buildHubView,
  formatActivityForecast,
  formatHubCalendar,
} from "@rpg-harness/frontend-core";
import { loadGame } from "../loader";
import { diffVisualLines } from "../presenters/visualSummary";
import { personaDescriptions, personas } from "../test/personas";

interface Args {
  gameDir: string;
  persona: string;
  verbose: boolean;
  maxSteps: number;
  seed?: number;
}

export async function autoplayCommand(args: Args): Promise<void> {
  const game = await loadGame(args.gameDir);
  const persona = personas[args.persona];
  if (!persona) {
    process.stderr.write(
      `Unknown persona: ${args.persona}\n\nAvailable personas:\n`,
    );
    for (const [name, desc] of Object.entries(personaDescriptions)) {
      process.stderr.write(`  ${name.padEnd(10)} — ${desc}\n`);
    }
    process.exit(2);
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

  const result = await runLoop(game, undefined, persona, {
    maxSteps: args.maxSteps,
    onStep: args.verbose
      ? (entry) => {
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
        }
      : undefined,
  });

  process.stderr.write(
    `\n=== done: ${result.reason} in ${result.trace.length} steps ===\n`,
  );
  if (result.error) process.stderr.write(`error: ${result.error}\n`);

  const ending = findEnding(
    result.finalState as { baseline: { completionOrder: string[] } },
  );
  if (ending) process.stderr.write(`ending: ${ending}\n`);

  process.stdout.write(
    JSON.stringify({
      reason: result.reason,
      steps: result.trace.length,
      finalState: result.finalState,
      ending,
    }) + "\n",
  );
}

function findEnding(state: {
  baseline: { completionOrder: string[] };
}): string | null {
  const completed = state.baseline.completionOrder;
  for (let i = completed.length - 1; i >= 0; i--) {
    const id = completed[i];
    if (id && /^00[5-9]/.test(id)) return id;
  }
  return null;
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
