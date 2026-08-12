#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { peekCommand } from "./commands/peek";
import { stepCommand } from "./commands/step";
import { sessionsCommand } from "./commands/sessions";
import { playCommand } from "./commands/play";
import { testCommand } from "./commands/test";
import { autoplayCommand } from "./commands/autoplay";
import { initCommand } from "./commands/init";
import { screenshotCommand } from "./commands/screenshot";
import { assetsListCommand, assetsPromptsCommand } from "./commands/assets";
import { studioCommand } from "./commands/studio";

const HELP = `rpgh — RPG-Harness (the RH engine): a headless RPG Maker for the terminal

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

  test     <game-dir>
      Run all fixtures under <game-dir>/tests/*.yaml. Exits 1 on failure.

  autoplay <game-dir> --persona NAME [-v|--verbose] [--max-steps N] [--seed N]
      Have a built-in AI persona play through the game and report the ending.
      Personas: greedy / charmer / rude / random
      Without -v, only prints the final JSON summary to stdout.

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
    case "test":
      return runTest(rest);
    case "autoplay":
      return runAutoplay(rest);
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
    },
    allowPositionals: true,
  });
  const gameDir = requirePositional(
    positionals,
    "rpgh autoplay <game-dir> [--persona NAME] [-v] [--max-steps N] [--seed N]",
  );
  await autoplayCommand({
    gameDir,
    persona: values.persona ?? "greedy",
    verbose: Boolean(values.verbose),
    maxSteps: Number(values["max-steps"] ?? "1000"),
    ...(values.seed !== undefined ? { seed: Number(values.seed) } : {}),
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
