import { collectDanglingRefs, loadGame } from "../loader";

interface Args {
  gameDir: string;
  missing: boolean;
  format: "table" | "json";
  // The "asset pack" query: narrow to assets whose refs.characters
  // includes this id — a character's full design package (sheets,
  // portraits, CGs they appear in) in one view.
  character?: string;
}

interface AssetRow {
  path: string;
  kind: string;
  ans: boolean;
  txt: boolean;
  source: boolean;
  web: boolean;
  placeholder: string;
}

// `rpgh assets list [--missing] [--format json]`
//
// Surfaces the asset manifest for a game so an author (or AI helper)
// can see which slots still need art. With --missing, narrows to
// "spec exists, no TUI rendering committed" — the worklist for the
// next round of generation. The whole point of the asset system is
// to make this list reviewable in PRs without binary diffs; this
// command is just the convenient query view.
export async function assetsListCommand(args: Args): Promise<void> {
  const game = await loadGame(args.gameDir);
  const dangling = collectDanglingRefs(game, game.assets ?? []);
  const specs = args.character
    ? (game.assets ?? []).filter((a) =>
        a.refs?.characters?.includes(args.character!),
      )
    : game.assets ?? [];
  const all: AssetRow[] = specs.map((a) => ({
    path: a.path,
    kind: a.kind,
    ans: a.renderings.tuiAns !== undefined,
    txt: a.renderings.tuiTxt !== undefined,
    source: a.renderings.source !== undefined,
    web: a.renderings.web !== undefined,
    placeholder: a.placeholder,
  }));
  // "missing" = no TUI rendering present (no .ans, no .txt). Source
  // PNGs and web variants don't count as TUI-renderable — without a
  // text rendering the TUI must fall back to placeholder mode.
  const rows = args.missing ? all.filter((r) => !r.ans && !r.txt) : all;

  if (args.format === "json") {
    process.stdout.write(
      JSON.stringify({ assets: rows, dangling }, null, 2) + "\n",
    );
    return;
  }

  if (rows.length === 0) {
    process.stdout.write(
      args.missing
        ? "All assets have at least one TUI rendering.\n"
        : "No assets declared.\n",
    );
    writeDanglingSection(dangling);
    return;
  }

  // Compact human-readable table. Padded path column makes the
  // status flags align without pulling in a table-formatting dep.
  const pathWidth = Math.max(
    "PATH".length,
    ...rows.map((r) => r.path.length),
  );
  const kindWidth = Math.max("KIND".length, ...rows.map((r) => r.kind.length));
  const header = `${pad("PATH", pathWidth)}  ${pad(
    "KIND",
    kindWidth,
  )}  ANS  TXT  SRC  WEB  PLACEHOLDER`;
  process.stdout.write(header + "\n");
  process.stdout.write("─".repeat(header.length) + "\n");
  for (const r of rows) {
    process.stdout.write(
      [
        pad(r.path, pathWidth),
        pad(r.kind, kindWidth),
        mark(r.ans),
        mark(r.txt),
        mark(r.source),
        mark(r.web),
        truncate(r.placeholder, 60),
      ].join("  ") + "\n",
    );
  }
  process.stdout.write(
    `\n${rows.length} asset${rows.length === 1 ? "" : "s"}${
      args.missing ? " missing TUI renderings" : ""
    }.\n`,
  );
  writeDanglingSection(dangling);
}

// Referenced-but-unresolvable section. These are the assets a player
// will hit as placeholder text in-game: scripts/characters point at
// them but no spec.yaml (or portraits-map emotion) exists. Printed on
// every run — an author who never sees this section never ships a
// ghost reference.
function writeDanglingSection(d: {
  missingAssets: Array<{ assetPath: string; referencedBy: string[] }>;
  missingEmotions: Array<{
    characterId: string;
    emotion: string;
    referencedBy: string[];
  }>;
}): void {
  if (d.missingAssets.length === 0 && d.missingEmotions.length === 0) return;
  process.stdout.write(
    `\nMISSING — referenced in scripts/characters but no spec exists:\n`,
  );
  for (const m of d.missingAssets) {
    process.stdout.write(
      `  ✗ ${m.assetPath}\n      referenced by: ${m.referencedBy.join(", ")}\n`,
    );
  }
  for (const m of d.missingEmotions) {
    process.stdout.write(
      `  ✗ ${m.characterId} portraits.${m.emotion} (emotion not in character's portraits map)\n` +
        `      referenced by: ${m.referencedBy.join(", ")}\n`,
    );
  }
}

interface PromptsArgs {
  gameDir: string;
  // Optional specific asset path. When given, print just that asset's
  // prompt (no separators, no header) — designed to be piped:
  //   rpgh assets prompts ./game assets/portraits/k-smile | pbcopy
  // When omitted, print all assets' prompts with delimiters.
  assetPath?: string;
  missing: boolean;
  format: "text" | "json";
}

// `rpgh assets prompts <game-dir> [<asset-path>] [--missing] [--format text|json]`
//
// Surfaces the generation prompt(s) for asset specs so authors can
// pipe them into an image generator (Midjourney, SD, Claude, etc.)
// without copy-pasting from yaml. Single-asset form prints just the
// prompt text — pipe-friendly. Multi-asset form prints kind/path
// headers + prompts separated by `---` lines so the output is
// scannable AND mechanically splittable.
export async function assetsPromptsCommand(args: PromptsArgs): Promise<void> {
  const game = await loadGame(args.gameDir);
  const all = game.assets ?? [];

  // Single-asset form: locate it, print just the prompt verbatim, exit.
  // No path → 2; not-found → 2 with stderr. The convention matches how
  // git plumbing commands emit "missing object" errors.
  if (args.assetPath) {
    const found = all.find((a) => a.path === args.assetPath);
    if (!found) {
      process.stderr.write(
        `asset not found: ${args.assetPath}\n` +
          `available: ${all.map((a) => a.path).join(", ") || "(none)"}\n`,
      );
      process.exit(2);
    }
    process.stdout.write(found.prompt);
    if (!found.prompt.endsWith("\n")) process.stdout.write("\n");
    return;
  }

  // Multi-asset form: optionally filter to missing.
  const rows = args.missing
    ? all.filter(
        (a) =>
          a.renderings.tuiAns === undefined && a.renderings.tuiTxt === undefined,
      )
    : all;

  if (args.format === "json") {
    process.stdout.write(
      JSON.stringify(
        rows.map((a) => ({
          path: a.path,
          kind: a.kind,
          placeholder: a.placeholder,
          prompt: a.prompt,
        })),
        null,
        2,
      ) + "\n",
    );
    return;
  }

  if (rows.length === 0) {
    process.stdout.write(
      args.missing
        ? "All assets have at least one TUI rendering.\n"
        : "No assets declared.\n",
    );
    return;
  }

  // Text form: one entry per asset, `# <kind>: <path>` header, then
  // the placeholder as a `> blockquote`, then the prompt body, then
  // a `---` separator. Markdown-friendly so the output drops cleanly
  // into a generator's prompt input or a tracking document.
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i]!;
    process.stdout.write(`# ${a.kind}: ${a.path}\n`);
    process.stdout.write(`> ${a.placeholder}\n\n`);
    process.stdout.write(a.prompt.trimEnd() + "\n");
    if (i < rows.length - 1) process.stdout.write("\n---\n\n");
  }
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function mark(b: boolean): string {
  return b ? " ✓ " : " · ";
}

function truncate(s: string, w: number): string {
  if (s.length <= w) return s;
  return s.slice(0, w - 1) + "…";
}
