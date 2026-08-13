# RPG-Harness

A headless RPG Maker — an AI-first coding harness for GalGame-shaped games.

The engine owns the universal pieces (characters, items, enemies, weapons, skills, scripts, actions, a Condition DSL, 15 lifecycle hooks, reactive triggers, one write path). Everything game-specific — the combat math, the hub layout, the raid loop, the ending semantics — is yours to write as `modules/*.ts` and, if you want, an ejected `preset/run.ts`. Pure visual novels can stay in markdown; anything more interesting drops into TypeScript without touching the engine.

A game is a folder. A human can play that same folder in the terminal or the Web shell; an AI plays it headlessly by reading stdout and writing stdin, with no SDK required. The same AI can turn findings into evidence-backed coding issues, then extend the game: fix scripts, design mechanics, ship modules, and lock the result down as a replayable fixture.

```bash
bun install
bun run play              # boot 妖刀奇譚 — the bundled flagship game
bun run dev:web           # play the same game in the browser
bun run autoplay          # watch an AI persona play through
```

In the local shared Web shell, ordinary play is co-play: choose any built-in
or project-module AI persona in the HUD and hand it exactly one decision. The
turn is fenced to the save revision visible in the GUI, persists through the
same Headless `autoplay:<persona>` log, and returns control immediately. A
stochastic persona retains its continuation RNG cursor across successive
hand-offs; the player's next click takes the next turn without a stop-task
race. `rpgh personas <game-dir>` exposes the same project-extensible registry
to other tools.

## Make your own

```bash
bun packages/cli/src/bin.ts init ./my-game    # scaffold a minimal game
bun packages/cli/src/bin.ts play ./my-game    # play it
```

Or in another terminal, **edit `scripts/001_intro.md` while the game is running** — the engine watches for `.md` / `.yaml` changes and reloads the next time a beat resolves. Live authoring with no restart.

In local Web development, the GUI and CLI also share the `web` save session:

```bash
bun run dev:web
bun run rpgh peek examples/sengoku-raid --session web
bun run rpgh report examples/sengoku-raid --session web --title "..."
# Open any named Headless/AI branch in the GUI:
# http://127.0.0.1:5174/?session=ai-branch
```

Every browser input is classified against the visible public Output and appended
to that game's normal `state.json` / `log.jsonl` with the same `inputResult`
used by Headless. Stable GUI choices submit authored `choiceId` / `optionId`
rather than presentation indexes. A rejected input leaves the live generator
and screen untouched, shows a recoverable notice, and remains visible to
`rpgh transcript` as diagnostic evidence. In a shared local session, the Web
shell also follows the append-only log cursor: a rejected Headless/TUI input is
shown on the unchanged GUI screen with its controller label, even though the
save-state revision correctly did not move.
Each event also points at an immutable, content-addressed state checkpoint, so a
GUI finding is immediately forkable and reportable by a Headless agent. A
project stores each unique checkpoint body once under
`.rpg-harness/objects/checkpoints/`, even when many GUI and Headless branches
reference it. `rpgh compact-checkpoints <game-dir>` safely previews migration
of older per-session copies; add `--apply` only after the hash preflight passes.
A clean session family can be frozen with `rpgh certify`: the resulting compact
certificate binds every tracked script completion and stable choice option to
the current authored revision and a verified object. `rpgh verify-certificate`
can validate that evidence without the original session directories, and any
later story edit makes the affected facts stale instead of silently preserving
an obsolete green check.
A report also freezes its own issue checkpoint, so `rpgh reproduce` still opens
the observed state after the live save and ordinary replay log are cleared.
Web feedback after an accepted input additionally freezes the state from just
before that input. Its incident checkpoint remains the exact screen the player
reported, while `reproduce` defaults to the causal boundary and returns the
original `replayInput` so repaired live code can execute the same action again.
Structured autoplay findings additionally freeze the pre-run state and replay
seed: their verifier reruns the whole causal path, not merely the already-stuck
final save, and the ordinary `resolve` command cannot bypass that proof.
Findings created before causal replay evidence existed remain reproducible from
their incident checkpoint and may be explicitly reviewed with ordinary
`resolve`; the worklist does not send them to an impossible verifier. If a
structured finding later loses its persona or checkpoint artifact, `rpgh
supersede ... --reason TEXT` retires it with an audit trail without pretending
that a causal verifier proved the bug fixed.
The GUI watches content revisions and reloads when another surface advances the
session. Compare-and-swap still rejects a stale write if both act inside the
same polling window, so progress is never silently overwritten. Static Web
builds keep their backend-free localStorage fallback.

## Install (experimental — only when you need it)

The canonical way to run anything in this repo is `bun packages/cli/src/bin.ts <command>` or `bun run rpgh <command>` from the repo root. That covers nearly every dev workflow.

The one case it doesn't cover is **running `rpgh studio` against a game directory that lives outside this repo** — `studio` is a browser workbench (PR-stage; see `packages/studio/`) and you'll want a global `rpgh` command for that. There's no distribution / upgrade story yet, so treat this as a self-serve symlink:

```bash
# 1. confirm ~/.local/bin is on your PATH (or pick another PATH dir):
echo "$PATH" | tr ':' '\n' | grep -q "$HOME/.local/bin" && echo OK

# 2. symlink the CLI entrypoint:
ln -sf "$(pwd)/packages/cli/src/bin.ts" ~/.local/bin/rpgh

# 3. verify:
rpgh --help
```

Caveats:
- Requires `bun` on PATH — the symlink target is a `.ts` file with `#!/usr/bin/env bun` as the shebang.
- The symlink is pinned to this clone's absolute path. Move the repo and `rpgh` breaks.
- No upgrade mechanism. Pull the repo to update.
- `bun link --global` doesn't work cleanly for monorepo workspace packages (1.3.14) — it leaves a broken symlink. Use the manual `ln -sf` above instead.

When/if RPG-Harness stabilizes and we ship a real distribution (npm publish or a single-binary release), the install story becomes one line and this section gets folded into the main quick-start.

To uninstall: `rm ~/.local/bin/rpgh`.

## Let an AI play (or write)

Two skills ship with the repo:

- **[`rpg-harness-player`](.claude/skills/rpg-harness-player/SKILL.md)** — read this and an AI knows how to play RPG-Harness games by running `rpgh peek` / `rpgh step` in a shell loop. No SDK, no API key.
- **[`rpg-harness-author`](.claude/skills/rpg-harness-author/SKILL.md)** — read this and an AI knows how to extend an RPG-Harness game: new scripts, new characters, new branches, new tests. The full DSL is documented inline.

Drop into Claude Code inside any RPG-Harness game folder containing `.claude/skills/`:

```
> Read .claude/skills/rpg-harness-player/SKILL.md and play through this game
> as a thoughtful character who's curious but doesn't oversell themselves.
```

or

```
> Read .claude/skills/rpg-harness-author/SKILL.md, then add a third character
> named "凉" who shows up in script 003 as a wild card.
```

The AI discovers the format on its own. To enable this in a game folder created via `rpgh init`, copy `.claude/` from the RPG-Harness repo into your game folder.

## What's in the box

```
rpg-harness/
├── packages/
│   ├── engine/         Pure state-machine runtime. No DOM, no Node-specific APIs.
│   ├── parser/         Markdown + frontmatter + YAML fence → engine AST.
│   ├── frontend-core/  Renderer-agnostic Output→ScreenModel reducer, shared by every shell.
│   ├── cli/            The `rpgh` binary: play / step / report / test / authoring tools.
│   ├── web/            Browser (React DOM) shell — engine bundled in-tab, games baked at build time, saves in localStorage. Static; deployable to any host.
│   └── studio/         Browser-based asset workbench (chafa render loop, spec editor).
├── examples/
│   ├── sengoku-raid/    "妖刀奇譚" — bundled flagship. Extraction-shooter raid loop +
│   │                    GalGame bonds + 3 endings + most of the engine surface
│   │                    (13/15 module hooks, full Condition AST, selfSwitch,
│   │                    composite triggers, weapon.custom)
│   ├── hook-test/       (hidden) engine fixture — full Module.onX coverage
│   ├── eject-test/      (hidden) engine fixture — training preset eject reference
│   └── _invalid_typo/   (hidden) negative fixture — validator must reject
└── .claude/skills/
    ├── rpg-harness-player/SKILL.md   for AIs that play
    └── rpg-harness-author/SKILL.md   for AIs that write content
```

The three `(hidden)` directories declare `hidden: true` in their `game.yaml`;
`bun run play` skips them automatically. They're still loadable by explicit
path, and `bun run test:fixtures` runs them as engine regression coverage.

## Three game modes

The same harness underneath, three preset loop shapes on top. Pick whichever fits the game; drop into a module (or eject the preset) when you want a fourth.

**Pure VN**: scripts only. Between scripts, the engine yields a
`scriptComplete` picker. Affection + flags + branching. Classic visual novel.
No module required.

**Training mode**: add a `training:` block to `game.yaml` and the hub becomes a
calendar-driven activity menu. Day/time slots, stats with caps, an `actions/`
folder of daily activities, optional combat mini-loop, end conditions that
trigger ending scripts. Story scripts coexist with daily actions as activities
in the hub. The `examples/eject-test/` fixture is the minimal reference for
this mode.

**Extraction-shooter** (like `sengoku-raid`): no `training:` block — instead, a
declared `maps/` directory carries the hub-city map (`edo_castle`) plus the
network of raid maps grouped by `chain:` tags. The player's location lives in
`state.baseline.currentMapId`; the engine's `enterMap` primitive + bundled
`moveToMap` handler drive transitions. A game module provides custom hub
rendering for in-raid stats (companion HP, pulse counters) via `onHubBuild`,
and observes `onActionComplete` for `moveToMap` dispatches to layer raid-side
effects (turn count, encounter rolls). Raids are repeatable expeditions
through chains of flat maps — set-piece scenes still use scripts (intros,
character first-meets, bonding beats); the random raid content lives in
module action handlers with `ctx.rng()`.

See `examples/sengoku-raid/README.md` for the flagship's full design.

## How a play session is structured

`rpgh play <game-dir>` boots into a **Hub** where you pick what to do:

```
樱花季 / Cherry Blossom Season
RPG-Harness · headless RPG Maker

▸ 新游戏
  继续: play-20260521-143012    进行中 · 003_invitation · 2 完成
  继续: claude-thoughtful       ✓ 005c_bea_good
  退出

↑↓/jk 选择 · Enter 确认 · q 退出
```

- **新游戏** auto-creates a fresh session (named by timestamp).
- **继续: X** resumes that save (autosaves after every advance).
- **Esc** during play opens an in-game menu (Continue / Return to Hub / Quit).

Saves live at `<game-dir>/.rpg-harness/sessions/<name>/state.json` — plain JSON, `git diff`-able, copyable between machines.

## Command surfaces

```bash
rpgh init     <dir> [--force]                                  # scaffold a new game
rpgh play     <game-dir>                                       # interactive TUI (ink, hot-reloading)
rpgh step     <game-dir> --input <json> [--session NAME] [--full] # headless persisted step
rpgh peek     <game-dir> [--session NAME] [--full]             # compact current decision
rpgh autoplay <game-dir> --persona NAME [-v]                   # built-in AI plays/forks/reports stops
rpgh report   <game-dir> --title TEXT [--session NAME]         # capture a playtest coding issue + evidence
rpgh reports  <game-dir> [--session NAME] [--format json|table] # list open playtest findings
rpgh resolve  <game-dir> <report-id> [--resolution TEXT]       # close an ordinary finding (structured findings require verification)
rpgh verify-feedback <game-dir> <report-id> --session-prefix RUN --resolution TEXT # prove changed + clean + certified repair
rpgh supersede <game-dir> <report-id> --reason TEXT            # retire unreplayable evidence without claiming a verified fix
rpgh reproduce <game-dir> <report-id> --to NAME               # fork immutable incident/causal feedback state
rpgh test     <game-dir>                                       # run fixtures
rpgh sessions <game-dir>                                       # list save sessions
rpgh compact-checkpoints <game-dir> [--apply]                 # deduplicate immutable state objects
rpgh certify  <game-dir> --session NAME [--family]            # freeze current strict coverage evidence
rpgh verify-certificate <game-dir> <certificate.json>         # validate evidence without session logs
rpgh coverage <game-dir> [--status pending|all]                # real-session story coverage / AI worklist
rpgh choices  <game-dir> [--status pending|all]                # executable choice-branch worklist
rpgh worklist <game-dir> [--session NAME]                      # unified prioritized AI development queue
rpgh project-status <game-dir> [--pretty]                     # compact worklist + current AI quality verdict
rpgh work     <game-dir> [--key KEY] [--new-session NAME]     # safely execute one structured work item
rpgh sweep    <game-dir> --session NAME --session-prefix RUN  # bounded resumable lineage exploration batch
rpgh sweep    <game-dir> --session NAME --session-prefix RUN --until-clean --limit 100 --max-generations 5 [--force-audit]
rpgh inspect-script <game-dir> <script-id> [--session NAME]   # authored structure + live hook transforms
rpgh inspect-session <game-dir> --session NAME               # read-only state/log/checkpoint diagnosis
rpgh inspect-report <game-dir> <report-id>                    # one finding with complete evidence
rpgh cover    <game-dir> --session AI [--key SCRIPT/CHOICE/OPTION] # execute one pending branch
rpgh reach    <game-dir> --from-session SAVE --session AI [--key SCRIPT/CHOICE] # find unseen choice
rpgh reach-script <game-dir> --script ID --from-session SAVE --session AI # complete uncovered story
rpgh transcript <game-dir> --session NAME [--tail 80]          # compact fork-aware player history
rpgh assets   <game-dir> list|prompts [--missing]              # asset manifest / prompt copy
rpgh studio   <game-dir>                                       # browser asset workbench
```

Every mode runs on the same engine and the same content. `step` and `play` produce
identical state files. `autoplay` is just `step` with a registered persona deciding
the input. `test` is `step` with assertions on the resulting trace. An AI agent
playing via the `rpg-harness-player` skill is just `step` with the LLM deciding the input.
`report` turns an observation made during that loop into a structured coding issue,
automatically pointing at the current script, save, log line, and latest input/output.
`reproduce` turns that issue evidence into a named CLI/TUI/Web session (and
prints its `/?session=...` path), making the coding issue directly executable.
For accepted-input Web feedback it opens the input-before state and prints the
captured `replayInput`; older/manual reports still open their incident state.
Structured autoplay and audit findings close only through their retained
verifiers; manual `resolve` remains available for ordinary human-authored
findings.
`choices` reads stable `choice.id` / `option.id` values from the same recoverable
session log and emits pending branches with an exact `fork --at` checkpoint plus
the `choose` input. This catches route gaps hidden by 100% script coverage.
`cover` consumes one of those work items end to end: it creates a new AI session
at the immutable checkpoint, verifies the edited game still presents the same
stable choice and option, selects by option id rather than stale array position,
then advances only until the containing script completes. Its result includes
the observed narration/dialogue response trace, so runtime hook transforms are
audited along with authored Markdown without spending tokens or changing state
in unrelated later scenes. A branch that emits `gameEnd` remains a genuine
completed ending rather than a local-stop result. Use `--source-session` to
constrain the worklist to one GUI/headless lineage and `--key` to select a
specific branch.
For a player-facing continuation, add `--player-session NAME`. `cover` keeps
the original autonomous session as complete proof that the target script still
finishes, then derives a second immutable checkpoint branch at the first
authored response after the selected option. Opening that session in Web starts
on the new dialogue/narration instead of dropping the player into the later Hub.
`worklist` is the project-level orchestration view: it merges open playtest
reports, unreadable session state/logs, story coverage gaps, executable choice
branches, and authored choice debt into one deterministic priority order. JSON
items classify their actionability as `executable`, `diagnostic`, or `authoring`,
retain the source coordinates, classify execution cost as inspection,
verification, checkpoint, search, or authoring, and expose a structured next operation such
as `reproduce`, `transcript`, `cover`, `reach`, `reach-script`, `inspect-script`,
`verify-autoplay`, `verify-audit`, or `edit`. Story gaps use the same bounded public-input search
and exact replay contract as choices instead of being mislabeled as generic
autoplay.
Placeholders such as
`<new-session>` remain explicit so an AI never silently overwrites player state.
`work` consumes that contract without asking the agent to translate camelCase
operation objects into CLI flags. With no key it selects the deterministic first
item. Read-only diagnoses execute immediately; `reproduce`, `verify-audit`,
`cover`, and `reach` require an explicit unused `--new-session`; authoring
operations return source,
beat, choice, and optional live-hook context without claiming an edit occurred.
If search exhausts the declared state space without reaching its target, `work`
returns `status: "failed"` but preserves the replay-verified closest state in
the requested isolated branch for GUI/Headless diagnosis. If only the node
budget is exhausted, it returns `status: "paused"` plus an executable
continuation rooted at that closest session instead of repeating the same
search from the original checkpoint.
Successful branch work is deliberately compact: it reports stable coordinates,
path counts/revision, search evidence, ending, and the GUI-compatible session,
without embedding the full save, every pending branch, or the raw replay path.
`sweep` executes a bounded snapshot of that same queue for one player lineage.
Within one product priority it closes inspection/verification and exact
checkpoint work before spending the shared budget on state-space search, so a
hard `reach-script` cannot starve dozens of one-step choice branches.
It preflights every generated branch before its first write, shares one total
search-node budget across the batch, and pauses normally when that budget is
spent. A paused search also exposes `resume.next`, an executable continuation
rooted at the materialized closest branch. The result carries the frozen
SHA-256 revision and exact next work key. After finishing that continuation,
resume the batch with both `--from-key` and `--snapshot-revision`; the frozen
revision prevents a changed queue from silently continuing at the wrong item.
Diagnostics and
checkpoint-backed branch coverage cost no search nodes, while unreachable
searches return their closest requirements as development evidence.
Sweep output is an orchestration envelope rather than a transcript: it omits
the snapshot's full remaining-key list and nested coverage response traces,
retaining the exact next key, revision, write boundary, causal result identity,
and GUI-compatible branch session where complete evidence remains available.
Use `inspect-session`, `transcript`, `choices`, or direct `reach` when those
detailed artifacts are actually needed.
With `--until-clean`, the item limit and total search-node limit become shared
budgets across several immutable generations. A search that reaches its own
node slice automatically resumes from the replay-verified closest branch, and
a completed generation freezes the newly exposed queue before continuing.
Paused searches rotate behind the other frozen items before receiving another
slice, so one difficult route cannot monopolize the lineage budget.
`--max-generations` (default 5) is a third hard bound. The convergence envelope
reports every generation revision, continuation attempt, isolated target,
aggregate budget, live remaining item, and (when paused inside a generation)
the exact frozen resume coordinate.
It stops rather than spinning when a queue revision repeats, when authoring
judgment is required, or when any declared budget is exhausted. A paused
deterministic search whose closest branch applied zero inputs is reported in
`safety.searchStalls` as `no-state-progress` instead of rerunning the identical
slice. The source player save is never written.
Before `--until-clean` returns clean, it runs the exact `game.yaml ai_audit`
acceptance matrix from every author-declared fresh-game seed. `--audit-seed`
is only the fallback for projects without `ai_audit.seeds`. A passing verdict becomes a
immutable content-addressed certificate under `.rpg-harness/evidence/quality/`, binding
the game behavior files, local Headless engine/parser/CLI implementation, Web
GUI/input bridge, audit policy, personas, budgets, and seed. Repeating the same clean convergence
reuses that certificate without creating another set of audit sessions; any
bound source edit changes the input revision and reruns the matrix.
Certificate issuance also executes the current React controls and records their
stable `next`, `choose`, `doActivity`, and `select` inputs, so a Headless-only
pass cannot certify a broken GUI dispatch surface.
`--force-audit` deliberately bypasses a matching certificate.
During local Web development the same compact project status is bridged into a
read-only HUD badge beside the shared-session label. Players can see pending
coding work or the current certified ending/path matrix while Headless agents
continue working; the badge polls a cached projection and never writes the
player save.
`inspect-script` executes the diagnostic operation emitted for uncovered scripts:
it returns the source file, indexed authored beats, requirements, stable choice
ids and AI intent. With `--session`, it also evaluates availability and reports
only the beats changed or skipped by `onBeatBefore` hooks, each on an isolated
state clone; it never advances or persists the inspected save.
`inspect-report` makes diagnostic findings without a reproduction checkpoint
directly consumable. `inspect-session` replaces unsafe generic "repair" advice:
it validates state JSON and log JSONL independently, verifies the latest usable
checkpoint, and suggests a recovery lane without modifying either surface.
Checkpoint state includes the engine PRNG cursor, so random combat, loot and
encounter results replay identically on Headless and GUI forks. Older saves get
a deterministic cursor derived from their checkpoint before their next draw.
`reach` consumes authored `reach-choice` work: it explores only public inputs
from a source checkpoint, stops on the stable target id, and replays the found
path into a named session usable by Web/TUI/Headless. It then compares the full
searched and replayed states, so an apparently successful but non-reproducible
route fails loudly instead of becoming misleading coverage evidence.
When `--from-at` is omitted, `reach` also inspects recoverable historical
choice checkpoints. It simulates each available authored consequence on an
isolated clone and prioritizes checkpoints whose effects satisfy the target
script gate, so a completed GUI branch can rewind directly to the decision
that unlocks a sibling ending. All attempts share the same `--max-nodes`
budget, and the resulting fork records the exact checkpoint that produced the
route.
Its `path` separates all public inputs from semantic decisions (`choose`,
`doActivity`, and `select`) and forced `next` advances, avoiding inflated
decision counts on narration-heavy or grinding routes.
On a bounded miss, `closest` reports the best path plus each satisfied/blocked
target requirement and persists that state in the requested GUI-compatible
session. Node-budget exhaustion is a normal pause with an executable
continuation from that session; a fully exhausted state space exits non-zero.
Add `--report-on-miss` to also turn the closest diagnosis into a reproducible
playtest issue.
`reach-script` applies the same contract to a whole authored script, including
scripts with no choices. A script may declare ordered
`ai.relatedActivityIds` breadcrumbs in frontmatter when its top-level condition
does not reveal how public gameplay can satisfy it. Breadcrumbs guide search
priority only: every activity must still be present and available in the live
Headless/GUI output, and the completed path must replay to an identical state.
Dynamic hub activities may expose an exact `requires` condition alongside the
human-facing `lockedReason`. Goal-directed search uses that shared contract to
prefer actions that measurably close a resource/stat gate and to avoid spending
an already-satisfied prerequisite merely because another requirement improves.
Static action YAML may also declare `ai_tags: [social, progression]`; dynamic
modules expose the same contract as `HubActivity.aiTags`. Tags describe semantic
intent rather than visual grouping: `category` may remain `social` for a gift
button forever, while a module can add `progression` only when that gift closes
the next relationship gate. Generic personas, project personas, GUI and
Headless therefore receive one state-aware public action contract without
depending on menu order or renderer text.
Both reach commands follow fork provenance through ancestor sessions, so an AI
starting from a terminal child branch can recover the exact earlier checkpoint
where another route was still playable without mutating any ancestor save.
`transcript` follows the exact fork lineage and reduces large save/log payloads to
the player-visible story, activities, choices, stable decisions and checkpoint
coordinates. An AI can therefore review what a GUI or Headless player actually
experienced without scraping JSONL or confusing later source edits with history.
Accepted Hub inputs persist an `activityDecision` beside the input/output pair:
the exact replay id plus its title, category, AI tags, recommendation, pacing
identity, linked public objectives, and the focused objective that owned the
decision. The compact transcript renders that
evidence on the selected line, so a tailed or forked history still says that an
opaque module action meant `nonlethal / mercy / memory` without retaining the
entire preceding menu or leaking its dispatch payload.
`assets` and `studio` are authoring-side tools — they help humans (or AI) fill in
visual art for the spec.yaml entries scripts reference.

## A game is a folder

```
my-game/
├── game.yaml                  title
├── characters/
│   └── alice.md               name, default affection, description, portraits map
├── maps/                      optional — locations the player can be in
│   └── town.yaml              connections, actions, encounter tables
├── scripts/
│   ├── 001_meeting.md         台本 with frontmatter: id, title, requires, characters, bg
│   └── ...
├── assets/                    optional — portraits, backgrounds, CGs
│   ├── portraits/alice-smile/
│   │   ├── spec.yaml                       description, prompt, placeholder, sizing
│   │   ├── tui.txt?                        ASCII rendering for terminal (optional)
│   │   ├── tui.ans?                        ANSI-colored rendering (optional)
│   │   ├── source.quality.png?             high-res master (gitignored)
│   │   └── source.compressed.webp?         distribution copy (optional)
│   ├── backgrounds/sakura-path/spec.yaml
│   └── cgs/handshake/spec.yaml
└── tests/
    └── good-ending.yaml       fixture: state seed + inputs + assertions
```

No `package.json`. No `node_modules`. No build step. Author writes markdown.

## Script syntax

Every paragraph is one **beat**. Empty lines separate beats.

```markdown
---
id: 001_meeting
title: 樱花树下
characters: [alice]
---

四月的午后，校园的樱花树下。           ← narration (plain text)

@alice 嗨。你也喜欢看樱花吗？          ← dialogue (@speaker prefix)

? 你怎么回应？                          ← choice (? prompt)
- "嗯，很美。" -> +alice               ← inline effect: alice affection +1
- "只是路过。" -> -alice
- "我喜欢看你画。" -> +2alice           ← +N for larger deltas
- 离开 -> goto leave                    ← goto a label

她笑了。

:goto reply                             ← silent unconditional jump (no player choice)

:label reply

我们沿着同一条路继续走。

[end]                                    ← end script here (skip remaining beats)

# leave                                  ← label

你转身离开了。
```

Choices that should participate in durable branch coverage can stay concise:

```markdown
? 你怎么回应？ {id: first-reply}
- "嗯，很美。" {id: admire-blossoms, ai: social sincere} -> +alice
- "只是路过。" {id: passing-by, ai: reserved independent} -> -alice
```

The annotations are authoring metadata and never appear in GUI/TUI prose.
Use `:goto <label>` after option-specific replies to converge branches without
showing the player a fake choice. Both choice targets and silent goto targets
are validated when the game loads.

For complex choices (requires, flags, multiple effects), use a YAML fenced block:

```markdown
​```yaml
type: choice
prompt: 你怎么选？
options:
  - text: 答应碧河
    effects:
      flags: { route: bea }
    goto: pick_bea
  - text: 跟薄樱走
    requires:
      affection: { character: alice, min: 2 }
    effects:
      flags: { route: alice }
    goto: pick_alice
​```
```

Scripts can also drive visual assets — background, portrait per slot, full-screen CG:

```markdown
---
id: 002_under_sakura
title: 樱花树下
characters: [alice]
bg: assets/backgrounds/sakura-path        ← scene's backdrop (set on entry)
defaultPortraits:                          ← list form: slots auto-assigned
  - { characterId: alice, emotion: smile } ← 1 → center; 2 → left/right;
  - { characterId: bob, emotion: default } ← 3 → left/center/right; 4+ → pos-N
---

@alice smile 嗨，又见面了。                ← inline emotion: swaps the slot
                                          ← alice already occupies (or center)

:cg assets/cgs/handshake                   ← full-screen CG takes over
@alice 别说什么了。
:hide-cg                                   ← back to bg + portrait

[end]
```

Backgrounds, portraits, CGs, and character sheets are **visual assets** — each lives in `assets/<kind>/<id>/` with a `spec.yaml` describing what it depicts plus optional pre-rendered files. Sheets (`assets/sheets/`) are descriptive: master design sheets (one image: views + expressions + detail callouts), turnarounds, and expression grids that anchor a character's identity for generation; no script renders them on stage, but the web frontend's 設定集 (art book, in the play HUD) shows them to players grouped per character — the same canon the art pipeline reads. Query a character's full pack with `rpgh assets list <game-dir> --character <id>` or the studio's character filter chips. References that resolve to nothing (a `:cg` path with no spec, a `defaultPortraits` emotion missing from the character's map) are surfaced everywhere: the loader warns on stderr, `rpgh assets list` prints a `MISSING` section, and the studio gallery pins red ghost cards. The convention is two-tier: `source.quality.png` is the author's high-res master (gitignored, kept local) and `source.compressed.{webp,png,jpg,jpeg}` is the slimmed distribution copy that travels with the repo so cloners get a working visual experience out of the box. ASCII art `tui.txt` and color `tui.ans` are what the TUI actually renders; missing renderings degrade to the spec's placeholder text, which is also what AI players see in the headless JSON event stream. See the [rpg-harness-author skill](.claude/skills/rpg-harness-author/SKILL.md) for the full asset spec format.

## Headless step API

This is what makes `autoplay`, `test`, and the AI-player skill possible:

```
step :: (Game, GameState, Input) → (GameState, Output)
```

Pure function. Stateless. Persistable. So:

```bash
# Session "claude" plays one step at a time
rpgh step ./my-game --session claude --input '{"type":"select","scriptId":"001_meeting"}'
rpgh step ./my-game --session claude --input '{"type":"next"}'
rpgh step ./my-game --session claude --input '{"type":"choose","choiceId":"route","optionId":"friends"}'
```

Stable `choiceId` / `optionId` input is preferred for AI and automation because
it survives option reordering. Human frontends may continue to submit the
presentation-local `{"type":"choose","index":2}` form for legacy choices.

State persists to `<game-dir>/.rpg-harness/sessions/<name>/state.json` between calls.
Each `step` appends `(input, output, checkpoint)` to `log.jsonl`. Fork any exact
post-step state without overwriting either session:

By default, `peek` and `step` return a bounded decision envelope with `session`,
`webPath`, a content revision for the resulting state, the current public
output, and `inputResult` after a step. Hub outputs retain the same stats,
objectives, available opportunity groups, executable inputs, and selection
guidance rendered by GUI/TUI clients, while omitting the duplicated raw activity
table and private save body. Use `--full` only for lossless state/hub diagnosis;
ordinary AI play should follow the compact public contract.

Every `step` response also carries an `inputResult`. `accepted:true` confirms
the input was routed. A rejected input returns the same current Output plus a
stable reason code (`unexpected-input`, `stale-choice`, `option-locked`,
`script-not-available`, `activity-not-present`, …), a human-readable message,
and that unchanged screen's expected input ids. A successful transition instead
reports the expectations of the newly returned Output, so an AI can execute the
next protocol directly without reconciling stale Hub ids against narration.
Rejections do not advance gameplay; AI clients should correct the input instead
of retrying it blindly.

```bash
rpgh fork ./my-game --from claude --to investigate-choice --at 42
# Or jump straight back to a captured playtest issue:
rpgh reproduce ./my-game pt-20260812123627-deadbeef --to fix-ending-stage
```

Legacy log entries created before checkpoints cannot be reconstructed exactly
when game logic used RNG; `fork --at` rejects those entries instead of guessing.

## Test injection

```yaml
# tests/seeded-alice-good.yaml
name: 注入 alice 高好感，验证 good ending 可达
state:
  baseline:
    characters:
      alice: { affection: 5, custom: {} }
    flags: { route: alice }
    completedScripts: [001_meeting_alice, 002_meeting_bea, 003_invitation, 004a_alice_route]
inputs:
  - { type: select, scriptId: "005a_alice_good" }
  - { type: next }
  # ...
assertions:
  - kind: state
    path: baseline.completedScripts
    includes: 005a_alice_good
  - kind: output
    type: gameEnd
    present: true
```

You don't have to play through 001–004 to test 005a. Seed the state, run the loop,
assert the outcome. Same idea Auto-Quant uses for strategy backtesting, applied
here to gameplay regression.

## Built-in personas (no API key)

```bash
rpgh autoplay ./examples/sengoku-raid --persona extractor -v   # always extract / flee / sell
rpgh autoplay ./examples/sengoku-raid --persona delver    -v   # always attack / push deepest
rpgh autoplay ./examples/sengoku-raid --persona objective --session ai-run
rpgh autoplay ./examples/sengoku-raid --persona objective \
  --from-session player-main --session ai-objective-audit --report-on-stop
rpgh audit ./examples/sengoku-raid --from-session player-main \
  --session-prefix ai-matrix --max-steps 500
rpgh audit ./examples/sengoku-raid \
  --session-prefix ai-fresh-matrix --seed 17 --max-steps 500
rpgh probe-choice ./examples/sengoku-raid --session player-main --at 42 --pretty
rpgh cover ./examples/sengoku-raid --source-session player-main \
  --session ai-cover-branch --key SCRIPT/CHOICE/OPTION
```

`objective` follows only renderer-neutral `HubSnapshot.objectives` links and can
persist every move into a GUI-compatible named session. Every objective declares
its authored `scope` (`main`, `side`, or `mastery`) and whether it is `terminal`;
clients never infer either meaning from array order or ids such as `ending_*`.
A Hub objective may additionally set `focus: true` when a temporary side
concern must own immediate player and agent attention without being relabelled
as the main quest. At most one active objective may be focused. A focused
objective, otherwise an active main objective, becomes the shared GUI/TUI/Headless
guidance candidate before ordinary authored recommendations. One link is a safe
primary action; several links remain an explicit decision for the player or
agent. The engine validates this contract at the output boundary and rejects
missing semantics, duplicate ids, or links to activities absent from the same
hub snapshot.

`audit` does not require a sacrificial player save. When `--from-session` is
omitted it materializes a seeded `<session-prefix>-source` new game, then forks
every persona lane from that immutable GUI-readable state. The returned seed
and source revision reproduce both the engine RNG and persona decisions; pass
`--from-session` only when the matrix should begin at an actual player/GUI
checkpoint.

Generic personas —
`greedy`, `charmer`, `rude`, `random`, `hunter` — also ship
for any game (always-first / always-last / always-second / uniform-random /
training-aware). They're useful for fuzz-testing path coverage. For LLM-driven
personas use the [`rpg-harness-player` skill](.claude/skills/rpg-harness-player/SKILL.md).

Every standalone `autoplay` result identifies both the registered `persona` and
its public uint32 `seed`. On a fresh session that one seed initializes the game
world (including author module RNG) and the runner-owned persona stream, so
repeating the command with the returned seed and another fresh session produces
the same semantic decision path and terminal state. On a resumed session the
persisted world RNG remains authoritative while the seed resumes persona
sampling; budget continuations return the exact next seed automatically.

For an autonomous development lane, combine `--from-session`, `--session`, and
`--report-on-stop`. The source GUI/player save is locked and checkpoint-forked
before the first AI input; the target must not already exist. A normal game end
returns the ending without filing noise. Any `quit`, detected `stalled` loop, `max-steps`, input
exhaustion, or engine error freezes both the pre-run replay state and the AI
branch's exact final incident state into the same structured playtest-report
format used by `report`/`reproduce`, and the
JSON response includes the branch's `webPath` plus report evidence for the next
coding agent. `verify-autoplay` reconstructs the pre-run checkpoint and repeats
the original persona, seed, and decision budget; a patch that only makes the
poisoned final save terminate cannot close the issue. `max-steps` is an exact AI-decision budget: the summary reports
those decisions separately from visible `steps`, including the initial output.
Autoplay also compares exact engine-state/public-output fingerprints and stops
after three identical cycles (up to 20 visible outputs per cycle). Its summary
and playtest report carry the shortest repeated input/output cycle as structured
`stall` evidence, turning persona oscillation and gameplay deadlocks into a
reproducible coding issue before the whole decision budget is burned.
If the public behavior repeats while counters or other state still change, the
run is not stopped early; a `max-steps` summary instead carries a
`behaviorCycle` candidate plus the changing state paths. That distinction keeps
legitimate grinding observable while exposing counters that mask an otherwise
stuck policy.
Every autoplay summary also contains a `progress` delta derived from newly
completed scripts, public objective requirement changes, and in-flight script
movement. A clean `max-steps` stop is scheduler state rather than a coding
issue: persisted runs return a machine-executable `continuation` with the same
session and the next persona RNG state. Errors, exact stalls, silent generator
returns, and masked behavior cycles still freeze causal evidence and enter the
worklist.
The full persisted autoplay result includes exact
`choiceCoverage.pendingBranches` checkpoints for forensic callers.
The CLI keeps its default JSON bounded even for very long runs: it returns the
decision-path and final-state revisions, the coverage totals, and an executable
`worklist` follow-up instead of embedding every decision, the full save, every
branch checkpoint, or unbounded progress/report evidence. A filed incident is
returned as an `inspect-report` operation. Pass `--full` when that complete
forensic payload is actually needed; the `runAutoplay` library API continues to
return it directly.
`audit` productizes the multi-persona development lane. It preflights the source
and every target name before writing anything, captures the protected player
checkpoint once, then forks that frozen snapshot into `${prefix}-${persona}`
sessions and runs each through the same
autoplay/report contract. Its compact matrix summarizes endings, strict stalls,
masked behavior cycles, resumable budget continuations, rejected inputs,
reports, and GUI-ready Web paths without embedding five full save states.
The player can keep advancing the source session while the sequential matrix
runs: every lane reports the same audit-time `source.stateRevision` and cannot
drift onto a later GUI/TUI state.
Games may turn that matrix into a project-owned acceptance gate in `game.yaml`:

```yaml
ai_audit:
  personas: [objective, greedy, charmer, rude, extractor, delver, completionist]
  fuzz_personas: [random]
  seeds: [1, 17, 2718, 65535]
  min_unique_endings: 2
  min_unique_decision_paths: 3
  max_activity_repetitions: 27
  max_activity_repetitions_by_kind: { move: 22, attack: 30 }
  required_activity_tags: [cautious, economic, aggressive]
  required_scripts: [deep_route_coda]
```

Projects may declare the acceptance `personas`, seeded `fuzz_personas`, and
independent fresh-world `seeds` beside their thresholds. `sweep --until-clean`
runs both matrices once per declared seed. Strategy personas own diversity,
coverage, and pacing thresholds; fuzz personas instead prove bounded terminal
reachability with no engine errors, rejected inputs, or open reports, so
intentional random wandering cannot dilute gameplay-quality budgets. One failed
lane blocks the v4 project certificate and creates replayable audit work. With no
`--personas` override, `audit` runs that project-owned matrix; an explicit
diagnostic subset remains runnable but is `not-evaluated` against the project
gate, so an impossible subset cannot create false quality debt. Thresholds may
not exceed the declared matrix size. `max_activity_repetitions` is the default
semantic pacing budget for one activity kind in one lane; exact
`max_activity_repetitions_by_kind` entries override it. This lets a game budget
multi-round combat separately from route-level movement without weakening the
default applied to search, travel, or future activity kinds. Dynamic activities
may also publish a stable `pacingInstanceId`: multiple accepted rounds against
one encounter remain visible as raw action intensity, while the repetition gate
counts that encounter once. Without an instance id, every dispatch remains a
distinct pacing event. The gate is evaluated only when every lane
reaches a terminal ending. Passing matrices stay silent. A completed matrix
below either threshold, missing a required activity tag, or never completing a
required script creates one
major gameplay report at a frozen copy of the audit source, including every
lane's GUI path, ending, semantic path revision, executed activity tags, and
choice divergences. The
report immediately appears as executable `verify-audit` work in `rpgh worklist`,
and `rpgh audit` exits non-zero, so route collapse becomes a coding issue and CI
signal instead of disposable console output. Audit reports retain their persona
set, seed, decision budget, policy, frozen source revision, and original matrix.
Running their `work` item with a fresh `--new-session` prefix reconstructs the
immutable source, preflights and reruns every lane against the live game, and
closes the issue only when both the current quality gate and the original
finding's requirements pass, so lowering or removing a requirement cannot erase
existing quality debt. A failed recheck stays open and leaves every new lane
GUI-readable; a passing recheck records its
policy, ending/path counts, lane sessions, and revisions as resolution evidence.
If a project later replaces its acceptance persona set, an older issue continues
to verify against its retained original lanes and requirements; the replacement
matrix is judged by a fresh project audit.
Older reports without deterministic replay parameters keep the ordinary
`reproduce` workflow.
`required_activity_tags` closes a different class of false positive: a matrix
whose dialogue choices and endings differ while every persona skips a critical
gameplay surface. The audit counts a tag only when an accepted `doActivity`
selects an activity carrying that author-owned `aiTags` value. Missing tags join
the same replayable quality report and remain part of its verification floor,
so deleting the requirement cannot silently close existing debt.
`required_scripts` is the authored-event counterpart. It requires at least one
lane, starting from the frozen audit source, to newly complete each named script.
Merely declaring a script, covering it in an isolated fixture, or inheriting it
as already completed at the source checkpoint does not satisfy the gate. This
lets a project make a deep quest, alliance scene, or optional boss resolution a
replayable autonomous acceptance condition rather than an informal promise.
Each lane also receives a content-addressed semantic decision-path revision
derived from stable choice identities, selected scripts, and activity ids plus
the selected activities' author-owned semantic tags.
The matrix classifies identical paths, different paths converging on one ending,
different endings, and incomplete sweeps separately; stable choice divergences
name the exact option selected by each persona. Ending convergence therefore no
longer hides meaningful route variation from the next coding agent.
Completed lanes remain individually replayable if the command is interrupted;
rerun with a fresh prefix after inspecting them. Add `random` explicitly with
`--personas ...random --seed N` so the matrix remains reproducible.
Generic policies are built into the runner. A game module can additionally
register project-aware policies through `Module.aiPersonas`; autoplay, audit,
and historical choice probes all resolve the same registry. This is where an
agent may safely understand private mechanics such as a raid module's visited
map without coupling the generic CLI to one game's state schema. Acceptance
personas are validated at game load, and module policies cannot shadow built-ins.
For authoring a single reached choice, `probe-choice` is the zero-write policy
lane: it restores the named content-addressed checkpoint in memory, evaluates
the current game scripts, and reports the stable option plus the exact reason
for each deterministic persona (`semantic-tags`, `ai-priority`, positional
fallback, or the owning module). It does not advance the source, fork sessions, or create budget
reports. Comparing the same `session@entry` before and after an edit makes
semantic intent review cheap while still exposing live script migration through
the source and evaluated state revisions. Random is intentionally excluded
because a sample is not evidence of authored intent.
`cover` is the execution half of that contract: it consumes an available branch
without requiring an agent to manually translate evidence into `fork` and
`step` commands, and fails closed if live authoring removed, locked, or replaced
the targeted stable option. Every covered branch now persists the same stable
choice coordinates and source target as an AI handoff, so GUI and Headless agree
on why that isolated save exists.
`work` adds a development handoff to every playable isolated branch it materializes:
the stable work key, priority, intent, operation, source fork, and whether the
target was reached, only a closest state was found, the issue was reproduced,
or the work was already covered are persisted beside
`fork.json`. The readiness value records the materialization result rather than
pretending to track later player inputs. The local Web GUI projects that metadata into its HUD, so a player
opening the returned `webPath` can see why the AI prepared this exact scene
without reading terminal output or letting the agent advance the player save.
AI provenance and live control are separate projections: the HUD begins as
**AI premiere**, then the first accepted Web/TUI input changes it to **player
play · AI source**. The immutable fork intent remains available for diagnosis,
but no longer implies that later raids or scenes are still being driven by AI.
This lifecycle is derived from the transaction-locked shared log, so reloads
and both frontends agree without mutating `fork.json`.
When the handoff names a stable choice, the bridge derives the player's selected
option and display text from the locked session log. The HUD updates in place,
while `log.jsonl` remains the single evidence source that also removes that
option from the player's structured worklist family.
Choice selection is also narrative history, not disposable menu state. Both Web
and TUI add the presented prompt plus the committed answer to their shared
backlog. A player-premiere fork carries the authoritative prompt/text captured
at its proof checkpoint and marks it as an **AI selection**, so opening the
branch after the choice still explains the character's first response. The Web
quality certificate executes and requires this projection before it can turn
green.
The local shared-session HUD also exposes **AIへフィードバック**. A player can
classify a narrative, gameplay, engine, UI, or tooling concern without leaving
the scene. The bridge routes the form through the same public `rpgh report`
contract used by Headless: the coding issue freezes the live save, log
coordinate, last input/output, visuals, current script, and a content-addressed
reproduction checkpoint, then appears immediately in `rpgh worklist`. Static
browser builds omit the control because they have no local development bridge.
Feedback source routing follows live ownership rather than stale provenance:
the active engine script's authoring source wins; a Hub/combat/runtime report
uses its frozen checkpoint without inventing a file target; and the original AI
handoff target is only a fallback before the player has accepted control. This
keeps a later balance report from being routed back into the premiere script
that originally created the save.
Hub actions use the same renderer-neutral semantic vocabulary as authored
choices. Games can distinguish combat styles such as `nonlethal`, `restraint`,
`mercy`, and `memory` without teaching a persona module-private action ids.
Project quality policies may require those tags; certification then proves a
fresh-world lane actually executed the authored play style, not merely that a
tag was present on an unvisited button.
Web submissions carry a structured player-feedback origin, so the same HUD can
poll the session's issue history without mixing in autonomous audit findings.
Players see whether AI is still working, resolved the concern, or explicitly
superseded it, together with the AI's recorded resolution. New Web feedback
freezes the current project-input revision; it cannot be closed by prose alone.
`rpgh verify-feedback` requires a changed revision, no unrelated pending work,
and a matching project quality certificate, then the GUI shows the before/after
revision and certificate as player-visible repair proof.
At a shared-session ending, Web also projects the current lineage's recoverable
choice work instead of reducing the save to a dead **The End** screen. It shows
the pending branch count and next authored option; one click invokes the public
`cover` workflow. The AI completes an isolated proof branch, then Web deep-links
to a player premiere fork paused on the option's first new authored response.
The player watches and advances the scene rather than arriving after it; the
completed save and its log stay byte-for-byte unchanged, while `--family`
coverage observes the proof branch and removes the option from the parent's
remaining queue.
Choice authors may set numeric `aiPriority` in fenced YAML; `objective` prefers
the highest available value while GUI/TUI presentation remains unchanged.
Concise Markdown options may declare space-separated open semantic tags with
`{id: ..., ai: tag1 tag2}`. Fenced-YAML options use `ai_tags`, such as
`[social, loyal]` or `[independent]`. These tags pass through the engine to
Headless clients without appearing in human shells. Built-in `charmer` and
`rude` personas use recognized intent tags before their legacy positional
fallbacks, and emit stable choice/option ids whenever the author supplied them,
so rearranging buttons no longer silently changes persona behavior. Unknown
tags remain available to LLM players and future game-specific policies.
Meaningful branch coverage uses a stable choice `id` and stable option `id`s;
the validator rejects duplicates and partial identities so work items survive
copy edits and option reordering. Concise Markdown accepts `{id: ...}` on the
`?` prompt and `{id: ..., ai: ...}` on each `-` option; fenced YAML accepts
ordinary `id` fields.
`rpgh choices` merges this authored inventory with runtime logs, separately
reporting choices that need ids, stable choices that have never been reached,
stable options missing explicit semantic intent, and reached options that still
need an exact checkpoint fork. Every option in a semantically complete branch
has at least one `aiTag`; authors use `neutral` when the lack of stronger intent
is deliberate, so omission remains actionable instead of ambiguous. Once every
executable option has a stable, replayed decision, it also compares each
option's complete narrative response trace up to the next interactive output.
If distinct options produce the same trace, the authoring worklist asks an AI
to review the convergence instead of declaring it a bug: shared staging is
fine, while an unanswered question or ignored vow can now become an explicit,
evidence-backed coding task.

## Architecture in one paragraph

`Engine` is a pure state machine. State is namespaced (`{ baseline: { ... } }`)
so future modules (combat, training, etc.) can each own a slice. The engine
yields `Output` events through an `AsyncGenerator` and accepts `Input` decisions.
The same generator is wrapped as `step()` for headless, `runLoop()` for batch
(tests + autoplay), and `play()` for the ink TUI. Same engine, different I/O bindings.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the long version,
[`docs/CLAUDE.md`](docs/CLAUDE.md) if you're an AI co-authoring on this codebase,
and [`.claude/skills/rpg-harness-player/SKILL.md`](.claude/skills/rpg-harness-player/SKILL.md)
if you're an AI playing the games.

## Status

Pre-alpha. Works end-to-end. Hub-mode TUI with multi-save and live hot-reload,
markdown content authoring, headless step API, fixture testing, built-in autoplay
personas, AI player + author skills, a scaffold command (`rpgh init`), and a
static **web frontend** (engine bundled in-tab, games baked at build time, saves
in localStorage — same engine + same screen-model reducer as the TUI; see
`packages/web/`) are all landed. Combat/training modules and a plugin registry
are next.

## License

MIT.
