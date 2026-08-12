#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { peekCommand } from "./commands/peek";
import { stepCommand } from "./commands/step";
import { sessionsCommand } from "./commands/sessions";
import { coverageCommand } from "./commands/coverage";
import { choiceCoverageCommand } from "./commands/choice-coverage";
import { worklistCommand } from "./commands/worklist";
import { workCommand } from "./commands/work";
import { inspectScriptCommand } from "./commands/inspect-script";
import { inspectSessionCommand } from "./commands/inspect-session";
import {
  DEFAULT_CHOICE_PROBE_PERSONAS,
  probeChoiceCommand,
} from "./commands/probe-choice";
import { transcriptCommand } from "./commands/transcript";
import { forkCommand } from "./commands/fork";
import { playCommand } from "./commands/play";
import { testCommand } from "./commands/test";
import { autoplayCommand } from "./commands/autoplay";
import { auditCommand, DEFAULT_AUDIT_PERSONAS } from "./commands/audit";
import { coverChoiceCommand } from "./commands/cover-choice";
import { reachChoiceCommand } from "./commands/reach-choice";
import { reachScriptCommand } from "./commands/reach-script";
import { initCommand } from "./commands/init";
import { screenshotCommand } from "./commands/screenshot";
import { assetsListCommand, assetsPromptsCommand } from "./commands/assets";
import { studioCommand } from "./commands/studio";
import {
  reportCommand,
  reportsCommand,
  inspectReportCommand,
  reproduceCommand,
  resolveCommand,
} from "./commands/report";
import {
  PLAYTEST_AREAS,
  PLAYTEST_SEVERITIES,
  type PlaytestArea,
  type PlaytestSeverity,
} from "./playtest-reports";
import { loadGame } from "./loader";

const HELP = `rpgh — RPG-Harness: the AI-native RPG Maker runtime and playtest CLI

USAGE
  rpgh <command> [args]

COMMANDS
  play     [<game-dir>]
      Run the interactive TUI (ink). Requires a real terminal.
      Without <game-dir>, scans ./ and ./examples for folders with
      game.yaml and shows a picker.

  peek     <game-dir> [--session NAME] [--pretty]
      Print the current Output for the session without applying any input.
      Defaults to session "default". Creates an initial state if none exists.

  step     <game-dir> --input JSON [--session NAME] [--pretty]
      Apply one Input and return the next Output. Persists state.
      Example: rpgh step ./my-game --input '{"type":"next"}'

  sessions <game-dir>
      List existing sessions (one per line, stdout). Empty status to stderr.

  coverage <game-dir> [--session NAME] [--status pending|completed|started|uncovered|ignored|all]
           [--format table|json]
      Aggregate real save sessions into story coverage. Defaults to pending
      scripts (started + uncovered), producing an AI-ready playtest worklist.

  choices  <game-dir> [--session NAME] [--status pending|covered|partial|uncovered|locked|all]
           [--format table|json]
      Aggregate stable choice/option ids from recoverable session logs. Pending
      options include exact fork checkpoints and executable choose inputs;
      authoring work also identifies missing stable ids and semantic AI intent.

  worklist <game-dir> [--session NAME] [--format table|json]
      Merge open playtest reports, unreadable sessions, story gaps, executable
      choice branches, and authoring debt into one prioritized AI development
      queue. Every item carries structured coordinates and its next operation.

  work <game-dir> [--key WORK-KEY] [--session SOURCE]
       [--new-session NAME] [--persona NAME] [--max-steps N]
       [--max-nodes N] [--pretty]
      Select one structured worklist item (highest priority by default) and
      execute its operation. Diagnostics are read-only; branch-producing work
      requires an explicit fresh --new-session; edits return authoring context.
      Branch results return compact evidence plus the named GUI session, not
      full saves or pending queues. An unreachable target exits non-zero.

  inspect-script <game-dir> <script-id> [--session NAME] [--pretty]
      Inspect one authored script, including requirements, source coordinates,
      stable choices and AI intent. With --session, evaluate availability and
      state-dependent onBeatBefore replacements on an isolated read-only clone.

  inspect-session <game-dir> --session NAME [--surfaces state,log] [--pretty]
      Diagnose state JSON, log JSONL, and the latest verifiable checkpoint.
      Strictly read-only: reports recovery evidence without overwriting a save.

  probe-choice <game-dir> --session NAME --at N [--personas CSV] [--pretty]
      Re-evaluate one historical choice with the live game and explain each
      deterministic persona's option selection. Strictly read-only: creates no
      branch, session event, or playtest report.

  transcript <game-dir> --session NAME [--tail N] [--format text|json]
      Print a compact player-visible history across the session's exact fork
      lineage. Keeps choices, stable decisions, activities and checkpoints;
      omits full save state and visual payloads. --tail 0 prints all events.

  fork     <game-dir> --from NAME --to NAME [--at N] [--pretty]
      Fork a save from a recoverable log checkpoint. --at is the 1-based log
      entry whose resulting state becomes the new session. Legacy entries
      without checkpoints are rejected rather than nondeterministically replayed.

  test     <game-dir>
      Run all fixtures under <game-dir>/tests/*.yaml. Exits 1 on failure.

  autoplay <game-dir> --persona NAME [-v|--verbose] [--max-steps N] [--seed N]
           [--session NAME] [--from-session PLAYER] [--from-at N]
           [--report-on-stop] [--pretty]
      Have a built-in or project-registered AI persona play through the game.
      Built-ins: objective / greedy / charmer / rude / random / hunter.
      Project modules may register more; use an unknown name to list them.
      --session persists every AI step as the same recoverable save/log used
      by GUI, Headless, and TUI. Without -v, only prints final JSON to stdout.
      --from-session atomically forks a player/GUI save into --session before
      the AI moves, so autonomous play never mutates the player's branch.
      --report-on-stop turns a non-terminal stop into a checkpointed coding issue.
      --max-steps is an exact AI-decision budget; visible outputs are counted separately.
      Persisted runs also return executable pending choice branches.

  audit    <game-dir> --from-session PLAYER --session-prefix PREFIX
           [--from-at N] [--personas CSV] [--max-steps N] [--seed N]
           [--no-report-on-stop] [--pretty]
      Fork one immutable player checkpoint into an isolated AI persona matrix.
      Preflights every target before running, then summarizes endings, stalls,
      masked behavior cycles, semantic path diversity, choice divergences,
      budget checkpoints, reports, and Web paths.
      Defaults to game.yaml ai_audit.personas, or the built-in
      objective,greedy,charmer,rude,hunter fallback. Including random requires
      --seed so the audit can be reproduced exactly.

  cover    <game-dir> --session NAME [--source-session NAME] [--key WORK-KEY]
           [--persona NAME] [-v|--verbose] [--max-steps N] [--pretty]
      Execute one pending stable choice branch. Forks its exact checkpoint,
      verifies the stable choice/option after live edits, selects by option id
      (not array position), then lets the persona continue on the AI branch.

  reach    <game-dir> --from-session NAME --session AI [--from-at N]
           [--key SCRIPT/CHOICE] [--max-nodes N] [--max-steps N]
           [--report-on-miss] [--pretty]
      Search the public Headless state space for an unseen stable authored
      choice, then replay the discovered inputs into a GUI-compatible AI fork.
      Unless --from-at is explicit, a terminal source automatically retries
      its recoverable historical choice checkpoints within one node budget.
      Search is read-only; a found path is accepted only when replay reaches
      the same stable choice and produces the identical persisted state.
      --report-on-miss persists only the closest state and files a structured
      coding issue with its path and unmet target requirements. A miss exits
      non-zero whether or not a report was requested.

  reach-script <game-dir> --script ID --from-session NAME --session AI
               [--from-at N] [--max-nodes N] [--max-steps N] [--pretty]
      Search public Headless inputs until an authored script completes, then
      replay the exact path into a GUI-compatible AI fork. Without --from-at,
      recoverable decision checkpoints across the fork ancestry share the
      search budget.
      A miss is read-only and exits non-zero.

  report   <game-dir> --title TEXT [--session NAME] [--area AREA]
           [--severity LEVEL] [--details TEXT] [--target FILE] [--pretty]
      Record an actionable playtest issue and attach evidence from the current
      save + latest input/output. Areas: narrative / gameplay / engine / ui /
      tooling. Severities: note / minor / major / blocker.

  reports  <game-dir> [--session NAME] [--status open|resolved|all]
           [--format json|table]
      List structured playtest issues. Defaults to open issues across all sessions.

  inspect-report <game-dir> <report-id> [--session NAME] [--pretty]
      Print one complete playtest finding with its captured evidence and checkpoint.

  resolve  <game-dir> <report-id> [--session NAME] [--resolution TEXT] [--pretty]
      Mark a playtest issue resolved after its fix has been verified.

  reproduce <game-dir> <report-id> --to NAME [--session NAME] [--pretty]
      Fork the immutable save snapshot captured with a playtest issue. Prints
      the named session and its Web query path for GUI or headless replay.

  init     <dir> [--preset vn|training] [--eject] [--force]
      Scaffold a minimal RPG-Harness game in <dir>. Creates game.yaml,
      a sample character, a sample script, a test fixture, README, .gitignore.
      Refuses if <dir> is non-empty unless --force.
      --preset selects the game-loop shape: "vn" (default, pure visual
      novel) or "training" (hub + day/slot/stats). --eject additionally
      copies the preset's main-loop source into <dir>/preset/ with
      imports rewritten so the author can edit run.ts directly.

  assets   <game-dir> list [--missing] [--format table|json]
      List visual assets declared under <game-dir>/assets/. Each row
      shows which renderings (tui.ans, tui.txt, source.quality.png /
      source.compressed.{webp,png,jpg,jpeg}, web.*) are
      present and the spec's placeholder text. --missing narrows to
      assets without any TUI rendering — the worklist for the next
      round of art generation.

  assets   <game-dir> prompts [<asset-path>] [--missing] [--format text|json]
      Print the generation prompt(s) for asset specs so authors can
      pipe them into an image generator. With <asset-path>, prints
      just that asset's prompt (pipe-friendly). Without, prints all
      prompts with markdown-style separators; --missing filters to
      assets without any TUI rendering.

  studio   <game-dir> [--api-port N] [--web-port N] [--no-open]
      Launch the browser-based authoring workbench. Boots an API
      server + Vite dev server, opens the browser to the asset
      gallery. Browse specs, view thumbnails, copy generation
      prompts, upload source PNGs, regenerate tui.{ans,txt} via
      chafa, inline-edit spec.yaml. Ports default to 4174 (api) /
      5173 (web); both auto-fall-back to the next free slot if the
      default is occupied.

  screenshot <game-dir> [--keys "K1,K2,..."] [--cols N] [--rows N]
             [--wait-ms N] [--out FILE]
      Spawn the TUI inside a PTY, replay a key sequence, and dump the
      rendered terminal as plain text. Used to capture what the user
      actually sees in their terminal — closes the test loop for ink
      rendering the same way Playwright does for web. Keys are
      comma-separated: named (Enter, Esc, Space, Up, Down, Tab,
      Backspace, Left, Right) or literal chars; ":NNN" inserts a delay.
      Example: --keys "Enter,Enter,Enter,2" navigates the hub picker
      into a new game, advances two beats, then picks activity 2.

FLAGS
  --session NAME   Session id (folder under .rpg-harness/sessions/). Default: "default"
  --input JSON     Engine Input as JSON string (for "step")
  --pretty         Indent JSON output (for "peek" and "step")

State is persisted at <game-dir>/.rpg-harness/sessions/<name>/state.json.
A log of (input, output) pairs is appended to log.jsonl per session.
`;

const args = process.argv.slice(2);
const [subcommand, ...rest] = args;

async function main(): Promise<void> {
  if (!subcommand || subcommand === "-h" || subcommand === "--help") {
    process.stdout.write(HELP);
    return;
  }
  switch (subcommand) {
    case "play":
      return runPlay(rest);
    case "peek":
      return runPeek(rest);
    case "step":
      return runStep(rest);
    case "sessions":
      return runSessions(rest);
    case "coverage":
      return runCoverage(rest);
    case "choices":
      return runChoiceCoverage(rest);
    case "worklist":
      return runWorklist(rest);
    case "work":
      return runWork(rest);
    case "inspect-script":
      return runInspectScript(rest);
    case "inspect-session":
      return runInspectSession(rest);
    case "probe-choice":
      return runProbeChoice(rest);
    case "transcript":
      return runTranscript(rest);
    case "fork":
      return runFork(rest);
    case "test":
      return runTest(rest);
    case "autoplay":
      return runAutoplay(rest);
    case "audit":
      return runAuditCommand(rest);
    case "cover":
      return runCoverChoice(rest);
    case "reach":
      return runReachChoice(rest);
    case "reach-script":
      return runReachScript(rest);
    case "report":
      return runReport(rest);
    case "reports":
      return runReports(rest);
    case "inspect-report":
      return runInspectReport(rest);
    case "resolve":
      return runResolve(rest);
    case "reproduce":
      return runReproduce(rest);
    case "init":
      return runInit(rest);
    case "screenshot":
      return runScreenshot(rest);
    case "assets":
      return runAssets(rest);
    case "studio":
      return runStudio(rest);
    default:
      process.stderr.write(`Unknown command: ${subcommand}\n\n${HELP}`);
      process.exit(1);
  }
}

function requirePositional(positionals: string[], usage: string): string {
  if (positionals.length !== 1 || !positionals[0]) {
    process.stderr.write(`Usage: ${usage}\n`);
    process.exit(2);
  }
  return positionals[0];
}

async function runPlay(args: string[]): Promise<void> {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  if (positionals.length > 1) {
    process.stderr.write("Usage: rpgh play [<game-dir>]\n");
    process.exit(2);
  }
  const gameDir = positionals[0];
  await playCommand(gameDir ? { gameDir } : {});
}

async function runPeek(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      session: { type: "string", default: "default" },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const gameDir = requirePositional(
    positionals,
    "rpgh peek <game-dir> [--session NAME] [--pretty]",
  );
  await peekCommand({
    gameDir,
    session: values.session ?? "default",
    pretty: Boolean(values.pretty),
  });
}

async function runStep(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      session: { type: "string", default: "default" },
      input: { type: "string" },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const gameDir = requirePositional(
    positionals,
    "rpgh step <game-dir> --input JSON [--session NAME] [--pretty]",
  );
  if (!values.input) {
    process.stderr.write("Missing required flag: --input\n");
    process.exit(2);
  }
  await stepCommand({
    gameDir,
    session: values.session ?? "default",
    input: values.input,
    pretty: Boolean(values.pretty),
  });
}

async function runSessions(args: string[]): Promise<void> {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const gameDir = requirePositional(positionals, "rpgh sessions <game-dir>");
  await sessionsCommand({ gameDir });
}

async function runCoverage(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      session: { type: "string" },
      status: { type: "string", default: "pending" },
      format: { type: "string", default: "table" },
    },
    allowPositionals: true,
  });
  const gameDir = requirePositional(
    positionals,
    "rpgh coverage <game-dir> [--session NAME] [--status pending|completed|started|uncovered|ignored|all] [--format table|json]",
  );
  const status = values.status ?? "pending";
  const allowedStatuses = [
    "pending",
    "completed",
    "started",
    "uncovered",
    "ignored",
    "all",
  ] as const;
  if (!allowedStatuses.includes(status as (typeof allowedStatuses)[number])) {
    process.stderr.write(`--status must be one of: ${allowedStatuses.join(", ")} (got ${status})\n`);
    process.exit(2);
  }
  const format = values.format ?? "table";
  if (format !== "table" && format !== "json") {
    process.stderr.write(`--format must be 'table' or 'json' (got ${format})\n`);
    process.exit(2);
  }
  await coverageCommand({
    gameDir,
    ...(values.session !== undefined ? { session: values.session } : {}),
    status: status as (typeof allowedStatuses)[number],
    format,
  });
}

async function runChoiceCoverage(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      session: { type: "string" },
      status: { type: "string", default: "pending" },
      format: { type: "string", default: "table" },
    },
    allowPositionals: true,
  });
  const gameDir = requirePositional(
    positionals,
    "rpgh choices <game-dir> [--session NAME] [--status pending|covered|partial|uncovered|locked|all] [--format table|json]",
  );
  const status = values.status ?? "pending";
  const allowed = ["pending", "covered", "partial", "uncovered", "locked", "all"] as const;
  if (!allowed.includes(status as (typeof allowed)[number])) {
    process.stderr.write(`--status must be one of: ${allowed.join(", ")} (got ${status})\n`);
    process.exit(2);
  }
  const format = values.format ?? "table";
  if (format !== "table" && format !== "json") {
    process.stderr.write(`--format must be 'table' or 'json' (got ${format})\n`);
    process.exit(2);
  }
  await choiceCoverageCommand({
    gameDir,
    ...(values.session !== undefined ? { session: values.session } : {}),
    status: status as (typeof allowed)[number],
    format,
  });
}

async function runWorklist(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      session: { type: "string" },
      format: { type: "string", default: "table" },
    },
    allowPositionals: true,
  });
  const gameDir = requirePositional(
    positionals,
    "rpgh worklist <game-dir> [--session NAME] [--format table|json]",
  );
  const format = values.format ?? "table";
  if (format !== "table" && format !== "json") {
    process.stderr.write(`--format must be 'table' or 'json' (got ${format})\n`);
    process.exit(2);
  }
  await worklistCommand({
    gameDir,
    ...(values.session !== undefined ? { session: values.session } : {}),
    format,
  });
}

async function runWork(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      key: { type: "string" },
      session: { type: "string" },
      "new-session": { type: "string" },
      persona: { type: "string", default: "objective" },
      "max-steps": { type: "string" },
      "max-nodes": { type: "string" },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const gameDir = requirePositional(
    positionals,
    "rpgh work <game-dir> [--key WORK-KEY] [--session SOURCE] [--new-session NAME] [--persona NAME] [--max-steps N] [--max-nodes N] [--pretty]",
  );
  await workCommand({
    gameDir,
    ...(values.key !== undefined ? { key: values.key } : {}),
    ...(values.session !== undefined ? { session: values.session } : {}),
    ...(values["new-session"] !== undefined
      ? { newSession: values["new-session"] }
      : {}),
    ...(values.persona !== undefined ? { persona: values.persona } : {}),
    ...(values["max-steps"] !== undefined
      ? { maxSteps: Number(values["max-steps"]) }
      : {}),
    ...(values["max-nodes"] !== undefined
      ? { maxNodes: Number(values["max-nodes"]) }
      : {}),
    pretty: Boolean(values.pretty),
  });
}

async function runInspectScript(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      session: { type: "string" },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  if (positionals.length !== 2 || !positionals[0] || !positionals[1]) {
    process.stderr.write(
      "Usage: rpgh inspect-script <game-dir> <script-id> [--session NAME] [--pretty]\n",
    );
    process.exit(2);
  }
  await inspectScriptCommand({
    gameDir: positionals[0],
    scriptId: positionals[1],
    ...(values.session !== undefined ? { session: values.session } : {}),
    pretty: Boolean(values.pretty),
  });
}

async function runInspectSession(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      session: { type: "string" },
      surfaces: { type: "string", default: "state,log" },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const gameDir = requirePositional(
    positionals,
    "rpgh inspect-session <game-dir> --session NAME [--surfaces state,log] [--pretty]",
  );
  if (!values.session) {
    process.stderr.write("Missing required flag: --session NAME\n");
    process.exit(2);
  }
  const surfaces = String(values.surfaces ?? "")
    .split(",")
    .map((surface) => surface.trim())
    .filter(Boolean);
  if (
    surfaces.length === 0 ||
    new Set(surfaces).size !== surfaces.length ||
    surfaces.some((surface) => surface !== "state" && surface !== "log")
  ) {
    process.stderr.write("--surfaces must be a unique CSV subset of: state,log\n");
    process.exit(2);
  }
  await inspectSessionCommand({
    gameDir,
    session: values.session,
    surfaces: surfaces as Array<"state" | "log">,
    pretty: Boolean(values.pretty),
  });
}

async function runProbeChoice(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      session: { type: "string" },
      at: { type: "string" },
      personas: {
        type: "string",
        default: DEFAULT_CHOICE_PROBE_PERSONAS.join(","),
      },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const gameDir = requirePositional(
    positionals,
    "rpgh probe-choice <game-dir> --session NAME --at N [--personas CSV] [--pretty]",
  );
  if (!values.session || values.at === undefined) {
    process.stderr.write("Missing required flags: --session NAME --at N\n");
    process.exit(2);
  }
  await probeChoiceCommand({
    gameDir,
    session: values.session,
    at: Number(values.at),
    personas: String(values.personas ?? "")
      .split(",")
      .map((persona) => persona.trim())
      .filter(Boolean),
    pretty: Boolean(values.pretty),
  });
}

async function runTranscript(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      session: { type: "string" },
      tail: { type: "string", default: "80" },
      format: { type: "string", default: "text" },
    },
    allowPositionals: true,
  });
  const gameDir = requirePositional(
    positionals,
    "rpgh transcript <game-dir> --session NAME [--tail N] [--format text|json]",
  );
  if (!values.session) {
    process.stderr.write("Missing required flag: --session NAME\n");
    process.exit(2);
  }
  const format = values.format ?? "text";
  if (format !== "text" && format !== "json") {
    process.stderr.write(`--format must be 'text' or 'json' (got ${format})\n`);
    process.exit(2);
  }
  await transcriptCommand({
    gameDir,
    session: values.session,
    tail: Number(values.tail ?? "80"),
    format,
  });
}

async function runFork(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      at: { type: "string" },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const gameDir = requirePositional(
    positionals,
    "rpgh fork <game-dir> --from NAME --to NAME [--at N] [--pretty]",
  );
  if (!values.from || !values.to) {
    process.stderr.write("Missing required flags: --from NAME --to NAME\n");
    process.exit(2);
  }
  await forkCommand({
    gameDir,
    from: values.from,
    to: values.to,
    ...(values.at !== undefined ? { at: Number(values.at) } : {}),
    pretty: Boolean(values.pretty),
  });
}

async function runTest(args: string[]): Promise<void> {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const gameDir = requirePositional(positionals, "rpgh test <game-dir>");
  await testCommand({ gameDir });
}

async function runInit(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      force: { type: "boolean", default: false },
      preset: { type: "string", default: "vn" },
      eject: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const dir = requirePositional(
    positionals,
    "rpgh init <dir> [--preset vn|training] [--eject] [--force]",
  );
  await initCommand({
    dir,
    force: Boolean(values.force),
    preset: String(values.preset ?? "vn"),
    eject: Boolean(values.eject),
  });
}

async function runAutoplay(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      persona: { type: "string", default: "greedy" },
      verbose: { type: "boolean", short: "v", default: false },
      "max-steps": { type: "string", default: "1000" },
      seed: { type: "string" },
      session: { type: "string" },
      "from-session": { type: "string" },
      "from-at": { type: "string" },
      "report-on-stop": { type: "boolean", default: false },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const gameDir = requirePositional(
    positionals,
    "rpgh autoplay <game-dir> [--persona NAME] [-v] [--max-steps N] [--seed N] [--session NAME] [--from-session PLAYER] [--from-at N] [--report-on-stop] [--pretty]",
  );
  await autoplayCommand({
    gameDir,
    persona: values.persona ?? "greedy",
    verbose: Boolean(values.verbose),
    maxSteps: Number(values["max-steps"] ?? "1000"),
    ...(values.seed !== undefined ? { seed: Number(values.seed) } : {}),
    ...(values.session !== undefined ? { session: values.session } : {}),
    ...(values["from-session"] !== undefined
      ? { fromSession: values["from-session"] }
      : {}),
    ...(values["from-at"] !== undefined
      ? { fromLogEntry: Number(values["from-at"]) }
      : {}),
    reportOnStop: Boolean(values["report-on-stop"]),
    pretty: Boolean(values.pretty),
  });
}

async function runAuditCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      "from-session": { type: "string" },
      "from-at": { type: "string" },
      "session-prefix": { type: "string" },
      personas: { type: "string" },
      "max-steps": { type: "string", default: "1000" },
      seed: { type: "string" },
      "no-report-on-stop": { type: "boolean", default: false },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const gameDir = requirePositional(
    positionals,
    "rpgh audit <game-dir> --from-session PLAYER --session-prefix PREFIX [--from-at N] [--personas CSV] [--max-steps N] [--seed N] [--no-report-on-stop] [--pretty]",
  );
  if (!values["from-session"] || !values["session-prefix"]) {
    process.stderr.write("Missing required flags: --from-session PLAYER --session-prefix PREFIX\n");
    process.exit(2);
  }
  const game = await loadGame(gameDir);
  const requestedPersonas = values.personas === undefined
    ? game.aiAudit?.personas ?? [...DEFAULT_AUDIT_PERSONAS]
    : String(values.personas)
      .split(",")
      .map((persona) => persona.trim())
      .filter(Boolean);
  await auditCommand({
    gameDir,
    fromSession: values["from-session"],
    ...(values["from-at"] !== undefined
      ? { fromLogEntry: Number(values["from-at"]) }
      : {}),
    sessionPrefix: values["session-prefix"],
    personas: requestedPersonas,
    maxSteps: Number(values["max-steps"] ?? "1000"),
    ...(values.seed !== undefined ? { seed: Number(values.seed) } : {}),
    reportOnStop: !Boolean(values["no-report-on-stop"]),
    pretty: Boolean(values.pretty),
  });
}

async function runCoverChoice(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      session: { type: "string" },
      "source-session": { type: "string" },
      key: { type: "string" },
      persona: { type: "string", default: "objective" },
      verbose: { type: "boolean", short: "v", default: false },
      "max-steps": { type: "string", default: "1000" },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const gameDir = requirePositional(
    positionals,
    "rpgh cover <game-dir> --session NAME [--source-session NAME] [--key WORK-KEY] [--persona NAME] [-v] [--max-steps N] [--pretty]",
  );
  if (!values.session) {
    process.stderr.write("Missing required flag: --session NAME\n");
    process.exit(2);
  }
  await coverChoiceCommand({
    gameDir,
    session: values.session,
    ...(values["source-session"] !== undefined
      ? { sourceSession: values["source-session"] }
      : {}),
    ...(values.key !== undefined ? { key: values.key } : {}),
    persona: values.persona ?? "objective",
    verbose: Boolean(values.verbose),
    maxSteps: Number(values["max-steps"] ?? "1000"),
    pretty: Boolean(values.pretty),
  });
}

async function runReachChoice(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      "from-session": { type: "string" },
      "from-at": { type: "string" },
      session: { type: "string" },
      key: { type: "string" },
      "max-nodes": { type: "string", default: "5000" },
      "max-steps": { type: "string", default: "250" },
      "report-on-miss": { type: "boolean", default: false },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const gameDir = requirePositional(
    positionals,
    "rpgh reach <game-dir> --from-session NAME --session AI [--from-at N] [--key SCRIPT/CHOICE] [--max-nodes N] [--max-steps N] [--report-on-miss] [--pretty]",
  );
  if (!values["from-session"] || !values.session) {
    process.stderr.write(
      "Missing required flags: --from-session NAME --session AI\n",
    );
    process.exit(2);
  }
  await reachChoiceCommand({
    gameDir,
    fromSession: values["from-session"],
    ...(values["from-at"] !== undefined
      ? { fromLogEntry: Number(values["from-at"]) }
      : {}),
    session: values.session,
    ...(values.key !== undefined ? { key: values.key } : {}),
    maxNodes: Number(values["max-nodes"] ?? "5000"),
    maxSteps: Number(values["max-steps"] ?? "250"),
    reportOnMiss: Boolean(values["report-on-miss"]),
    pretty: Boolean(values.pretty),
  });
}

async function runReachScript(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      script: { type: "string" },
      "from-session": { type: "string" },
      "from-at": { type: "string" },
      session: { type: "string" },
      "max-nodes": { type: "string", default: "5000" },
      "max-steps": { type: "string", default: "250" },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const gameDir = requirePositional(
    positionals,
    "rpgh reach-script <game-dir> --script ID --from-session NAME --session AI [--from-at N] [--max-nodes N] [--max-steps N] [--pretty]",
  );
  if (!values.script || !values["from-session"] || !values.session) {
    process.stderr.write(
      "Missing required flags: --script ID --from-session NAME --session AI\n",
    );
    process.exit(2);
  }
  await reachScriptCommand({
    gameDir,
    scriptId: values.script,
    fromSession: values["from-session"],
    ...(values["from-at"] !== undefined
      ? { fromLogEntry: Number(values["from-at"]) }
      : {}),
    session: values.session,
    maxNodes: Number(values["max-nodes"] ?? "5000"),
    maxSteps: Number(values["max-steps"] ?? "250"),
    pretty: Boolean(values.pretty),
  });
}

async function runReport(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      session: { type: "string", default: "default" },
      area: { type: "string", default: "narrative" },
      severity: { type: "string", default: "minor" },
      title: { type: "string" },
      details: { type: "string" },
      target: { type: "string" },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const gameDir = requirePositional(
    positionals,
    "rpgh report <game-dir> --title TEXT [--session NAME] [--area AREA] [--severity LEVEL] [--details TEXT] [--target FILE] [--pretty]",
  );
  if (!values.title) {
    process.stderr.write("Missing required flag: --title\n");
    process.exit(2);
  }
  const area = values.area ?? "narrative";
  if (!PLAYTEST_AREAS.includes(area as PlaytestArea)) {
    process.stderr.write(
      `--area must be one of: ${PLAYTEST_AREAS.join(", ")} (got ${area})\n`,
    );
    process.exit(2);
  }
  const severity = values.severity ?? "minor";
  if (!PLAYTEST_SEVERITIES.includes(severity as PlaytestSeverity)) {
    process.stderr.write(
      `--severity must be one of: ${PLAYTEST_SEVERITIES.join(", ")} (got ${severity})\n`,
    );
    process.exit(2);
  }
  await reportCommand({
    gameDir,
    session: values.session ?? "default",
    area: area as PlaytestArea,
    severity: severity as PlaytestSeverity,
    title: values.title,
    ...(values.details !== undefined ? { details: values.details } : {}),
    ...(values.target !== undefined ? { target: values.target } : {}),
    pretty: Boolean(values.pretty),
  });
}

async function runReports(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      session: { type: "string" },
      format: { type: "string", default: "json" },
      status: { type: "string", default: "open" },
    },
    allowPositionals: true,
  });
  const gameDir = requirePositional(
    positionals,
    "rpgh reports <game-dir> [--session NAME] [--status open|resolved|all] [--format json|table]",
  );
  const format = values.format ?? "json";
  if (format !== "json" && format !== "table") {
    process.stderr.write(
      `--format must be 'json' or 'table' (got ${format})\n`,
    );
    process.exit(2);
  }
  const status = values.status ?? "open";
  if (status !== "open" && status !== "resolved" && status !== "all") {
    process.stderr.write(
      `--status must be 'open', 'resolved', or 'all' (got ${status})\n`,
    );
    process.exit(2);
  }
  await reportsCommand({
    gameDir,
    ...(values.session !== undefined ? { session: values.session } : {}),
    format,
    status,
  });
}

async function runInspectReport(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      session: { type: "string" },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  if (positionals.length !== 2 || !positionals[0] || !positionals[1]) {
    process.stderr.write(
      "Usage: rpgh inspect-report <game-dir> <report-id> [--session NAME] [--pretty]\n",
    );
    process.exit(2);
  }
  await inspectReportCommand({
    gameDir: positionals[0],
    id: positionals[1],
    ...(values.session !== undefined ? { session: values.session } : {}),
    pretty: Boolean(values.pretty),
  });
}

async function runResolve(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      session: { type: "string" },
      resolution: { type: "string" },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  if (positionals.length !== 2 || !positionals[0] || !positionals[1]) {
    process.stderr.write(
      "Usage: rpgh resolve <game-dir> <report-id> [--session NAME] [--resolution TEXT] [--pretty]\n",
    );
    process.exit(2);
  }
  await resolveCommand({
    gameDir: positionals[0],
    id: positionals[1],
    ...(values.session !== undefined ? { session: values.session } : {}),
    ...(values.resolution !== undefined
      ? { resolution: values.resolution }
      : {}),
    pretty: Boolean(values.pretty),
  });
}

async function runReproduce(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      to: { type: "string" },
      session: { type: "string" },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  if (positionals.length !== 2 || !positionals[0] || !positionals[1]) {
    process.stderr.write(
      "Usage: rpgh reproduce <game-dir> <report-id> --to NAME [--session NAME] [--pretty]\n",
    );
    process.exit(2);
  }
  if (!values.to) {
    process.stderr.write("Missing required flag: --to NAME\n");
    process.exit(2);
  }
  await reproduceCommand({
    gameDir: positionals[0],
    id: positionals[1],
    to: values.to,
    ...(values.session !== undefined ? { session: values.session } : {}),
    pretty: Boolean(values.pretty),
  });
}

async function runScreenshot(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      keys: { type: "string", default: "" },
      cols: { type: "string", default: "100" },
      rows: { type: "string", default: "30" },
      "wait-ms": { type: "string", default: "400" },
      session: { type: "string" },
      out: { type: "string" },
    },
    allowPositionals: true,
  });
  const gameDir = requirePositional(
    positionals,
    "rpgh screenshot <game-dir> [--keys ...] [--cols N] [--rows N] [--wait-ms N] [--out FILE]",
  );
  await screenshotCommand({
    gameDir,
    keys: values.keys ?? "",
    cols: Number(values.cols ?? "100"),
    rows: Number(values.rows ?? "30"),
    waitMs: Number(values["wait-ms"] ?? "400"),
    ...(values.session !== undefined ? { session: values.session } : {}),
    ...(values.out !== undefined ? { out: values.out } : {}),
  });
}

async function runAssets(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "list") return runAssetsList(rest);
  if (sub === "prompts") return runAssetsPrompts(rest);
  process.stderr.write(
    "Usage:\n" +
      "  rpgh assets list    <game-dir> [--missing] [--character <id>] [--format table|json]\n" +
      "  rpgh assets prompts <game-dir> [<asset-path>] [--missing] [--format text|json]\n",
  );
  process.exit(2);
}

async function runAssetsList(rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      missing: { type: "boolean", default: false },
      format: { type: "string", default: "table" },
      character: { type: "string" },
    },
    allowPositionals: true,
  });
  const gameDir = requirePositional(
    positionals,
    "rpgh assets list <game-dir> [--missing] [--character <id>] [--format table|json]",
  );
  const fmt = values.format ?? "table";
  if (fmt !== "table" && fmt !== "json") {
    process.stderr.write(`--format must be 'table' or 'json' (got ${fmt})\n`);
    process.exit(2);
  }
  await assetsListCommand({
    gameDir,
    missing: Boolean(values.missing),
    format: fmt as "table" | "json",
    ...(values.character ? { character: values.character } : {}),
  });
}

async function runAssetsPrompts(rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      missing: { type: "boolean", default: false },
      format: { type: "string", default: "text" },
    },
    allowPositionals: true,
  });
  // Two positional forms:
  //   <game-dir>                          → all prompts
  //   <game-dir> <asset-path>             → single asset's prompt
  if (positionals.length < 1 || positionals.length > 2 || !positionals[0]) {
    process.stderr.write(
      "Usage: rpgh assets prompts <game-dir> [<asset-path>] [--missing] [--format text|json]\n",
    );
    process.exit(2);
  }
  const fmt = values.format ?? "text";
  if (fmt !== "text" && fmt !== "json") {
    process.stderr.write(`--format must be 'text' or 'json' (got ${fmt})\n`);
    process.exit(2);
  }
  await assetsPromptsCommand({
    gameDir: positionals[0],
    ...(positionals[1] !== undefined ? { assetPath: positionals[1] } : {}),
    missing: Boolean(values.missing),
    format: fmt as "text" | "json",
  });
}

async function runStudio(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      "api-port": { type: "string", default: "4174" },
      "web-port": { type: "string", default: "5173" },
      "no-open": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const gameDir = requirePositional(
    positionals,
    "rpgh studio <game-dir> [--api-port N] [--web-port N] [--no-open]",
  );
  await studioCommand({
    gameDir,
    apiPort: Number(values["api-port"] ?? "4174"),
    webPort: Number(values["web-port"] ?? "5173"),
    open: !values["no-open"],
  });
}

main().catch((err) => {
  process.stderr.write(`Error: ${(err as Error).message}\n`);
  process.exit(1);
});
