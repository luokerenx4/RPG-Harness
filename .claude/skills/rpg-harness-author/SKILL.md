---
name: rpg-harness-author
description: Author content for an RPG-Harness game — write or extend scripts (台本), add characters, design branching, add tests. Use this skill when you're inside an RPG-Harness game folder (one with game.yaml + characters/ + scripts/) and the user wants you to write story content, add a new scene, design an ending, balance affection numbers, or add a test fixture.
---

# rpg-harness-author

You're authoring a game on top of **RPG-Harness — a headless RPG Maker**. The engine in `packages/engine` owns the universal pieces: typed resources (characters / items / enemies / weapons / skills / scripts / actions), a Condition DSL, 15 lifecycle hooks, reactive triggers, and one write path (`mutateState`). **Everything game-specific is yours to write.** That means:

- Pure VN-shaped games: write only markdown + yaml. The engine's bundled `vn` and `training` presets cover the main loop.
- Anything more interesting (custom combat, hub mode switches, raid loops, reactive milestones, state machines): drop into `modules/*.ts`. Action handlers, triggers, hook implementations, and a private state namespace are all yours.
- Want to change the main loop itself (daybreak narrations, custom mode routing, novel hub patterns)? `rpgh init --eject` copies the preset's `run.ts` into the game folder; you own it from there.

What you **don't** touch is the engine itself — `packages/engine`, `packages/parser`, `packages/cli` are off-limits from inside a game folder. See `examples/sengoku-raid/modules/raid.ts` for the canonical shape of a "the game's logic lives here" module: ~20 action handlers, 13/15 hooks, composite triggers, its own state namespace.

## Where you are

You should be in a folder that has at minimum:
- `game.yaml` — manifest (title, preset, modules list, optional training config)
- `characters/` — one .md file per character
- `scripts/` — one .md file per 台本 (story segment)

And optionally:
- `items/` `enemies/` `weapons/` `skills/` — engine-typed resources (one .md per id)
- `maps/` — locations the player can be in (one .yaml per id). The engine tracks `state.baseline.currentMapId`; hub menus scope to it.
- `actions/` — yaml-defined hub activities (one .yaml per id). Use `whenIn: [<map_id>, ...]` to restrict an action to specific maps.
- `modules/` — `*.ts` modules implementing custom mechanics
- `preset/` — ejected main-loop source (`run.ts` + supporting files)
- `tests/` — fixture-based regression tests

If `game.yaml` / `characters/` / `scripts/` is missing entirely, the user is starting from scratch — suggest `rpgh init` to scaffold a template.

## The script (.md) format

Every script is a markdown file with frontmatter. The frontmatter declares metadata; the body is the actual story. Beats are separated by blank lines.

```markdown
---
id: 001_meeting          # unique within the game
title: 樱花树下           # human-readable
characters: [alice]      # which characters appear
requires:                # optional — when this script becomes available
  affection: { character: alice, min: 1 }
bg: assets/backgrounds/sakura-path     # optional — scene's backdrop
defaultPortraits:                       # optional — portraits set on entry.
  - { characterId: alice, emotion: smile }   # list form auto-assigns slots:
  - { characterId: bob, emotion: default }   # 1 → center; 2 → left, right;
                                        # 3 → left, center, right; 4+ → pos-1..pos-N
                                        # (map form `center: {characterId, emotion}`
                                        # also works when you need explicit slots)
---

narration line.          # plain text is narration

@alice 嗨。               # @<id> <text> is dialogue from character <id>

@alice smile 嗨，又见面了。  # optional emotion token resolves via
                            # alice.portraits.smile → swaps the slot alice
                            # already occupies (or center if she's not on stage)

? 你怎么回应？             # ? at start = choice block
- 打招呼 -> +alice         # inline: "<text> -> <effects>"
- 离开 -> -alice
- 转身 -> goto leave       # goto a label (or `goto $end` to end script here)

她笑了。

:cg assets/cgs/handshake   # full-screen CG overlay
@alice 别说什么了。
:hide-cg                    # back to bg + portraits

[end]                     # explicit end-of-script (skip remaining beats)

# leave                   # label (jump target)

你转身离开了。
```

### Beat types in detail

**Narration** — plain text, no prefix:
```
她合上素描本，但没收起来。
```

**Dialogue** — `@<character-id>` at start of paragraph:
```
@alice 我点了两杯咖啡。
```
The character must be defined in `characters/<id>.md`. The display name comes from the character file's `name` frontmatter field.

**Choice** — `?` at start, then `-` options. Inline effects after `->`:
```
? 你怎么说？
- "嗯，谢谢" -> +alice
- "不喝咖啡" -> -alice
- "你点什么我喝什么" -> +2alice
```

Inline effects support **only** affection deltas: `+alice` (= +1 to alice), `-bea` (= -1 to bea), `+2alice` (= +2 to alice). For anything more complex (flags, requires on options, goto), use a YAML fenced block (see below).

You can also add `goto <label>` after `|`:
```
- 走开 -> -alice | goto leave
- 留下 -> +alice
```

**Label** — `# <name>` on its own line. Used as a goto target:
```
# leave
```

Label names: ASCII letters/digits/underscore/hyphen. Cannot start with `$` (reserved).

**End-of-script** — `[end]` on its own line. Stops the script immediately. Use this to prevent fall-through into following label sections.

**Inline portrait emotion** — optional second token after `@<speaker>`:
```
@alice smile こんにちは。
```
Resolves `smile` against `alice.portraits.smile` (declared in `characters/alice.md`'s frontmatter `portraits:` map) and swaps the portrait slot alice already occupies (any slot currently showing one of her portrait paths — so multi-portrait scenes keep her in place), falling back to `center` when she isn't on stage. The lookup is **runtime, not parse-time**: if `smile` isn't in alice's portraits map, the engine treats `smile` as the first word of dialogue text — graceful fallback, no parse error.

Authors who don't want emotions in their game can ignore this entirely; `@alice こんにちは。` works unchanged.

**Visual directive lines** — `:` at start of a single-line block, no indentation:
```
:bg assets/backgrounds/town       # set background asset
:bg none                          # clear background
:cg assets/cgs/key-moment         # full-screen CG (covers bg + portraits)
:hide-cg                          # close the CG; bg/portraits return
:portrait center assets/portraits/alice-smile   # set named slot
:portrait left                    # empty path → clear slot
:clear-visuals                    # clear portraits + cg (keeps bg)
```

Slots are open-shape strings. `left` / `center` / `right` get canonical layout positions in the TUI; other names render in declaration order. The asset path must exist (the loader warns at load time on dangling references). All directives are silent — they mutate `state.baseline.visuals` but don't yield a beat. The next narration / dialogue / choice carries the new visuals to the renderer.

**Stage teardown is automatic**: when a script finishes (`[end]` or last beat), the engine clears portraits and any active CG; only the bg persists into the hub / next script. You never need a trailing `:clear-visuals` for end-of-scene cleanup — use it only for mid-script stage resets. A `quit` (player pausing out) does NOT tear down; the script resumes with its stage intact.

**YAML fenced choice** — when you need flags, requires on options, or multi-effect:

````markdown
```yaml
type: choice
prompt: 你要选哪条路？
options:
  - text: 跟 alice 走
    effects:
      flags: { route: alice }
      affection: { alice: 1 }
    goto: pick_alice
  - text: 跟 bea 走
    requires:
      affection: { character: bea, min: 2 }
    effects:
      flags: { route: bea }
    goto: pick_bea
```
````

## Frontmatter `requires` — the Condition DSL

When a script (or fenced choice option) has `requires`, it's only available when the condition is true. The grammar:

```yaml
# Atoms:
scriptCompleted: 001_meeting               # this script must be in completedScripts
affection: { character: alice, min: 2 }   # alice's affection >= 2
affection: { character: bea, max: 5 }     # bea <= 5
affection: { character: alice, eq: 0 }    # alice == 0
flag: { name: route, eq: alice }          # flags.route === "alice"
flag: { name: coins, min: 100 }           # flags.coins >= 100 (numeric flags only)
stat: { name: spectral, min: 80 }         # training-mode stat >= 80
inventory: { itemId: talisman, min: 1 }   # player holds >= 1 talisman
weaponPower: { weaponId: yaodao, min: 20 } # equipped/registered weapon's power >= 20
knowsSkill: purify                         # player has learned the skill
day: { min: 8 }                           # training calendar
slot: { eq: 2 }                           # training-mode slot index

# Combinators:
all: [<cond>, <cond>, ...]                # all must hold (AND)
any: [<cond>, <cond>, ...]                # any holds (OR)
not: <cond>                                # negation

# Example: both alice+bea high but no specific route picked yet
requires:
  all:
    - affection: { character: alice, min: 3 }
    - affection: { character: bea, min: 3 }
    - not:
        flag: { name: route, eq: alice }
```

## Character file format

```markdown
---
id: alice
name: 薄樱
defaultAffection: 0
portraits:                                  # optional — for visual assets
  default: assets/portraits/alice-normal
  smile:   assets/portraits/alice-smile
  angry:   assets/portraits/alice-angry
defaultPortrait: default                    # optional, defaults to "default"
---

短描述。用于作者参考，引擎不读。
```

The `id` must match what scripts use in `@<id>` dialogue beats.

The `portraits` map binds emotion names (used in scripts as `@alice smile`) to asset paths. Paths are full — repeating `assets/portraits/` per entry is intentional, so an AI reader sees the source-of-truth path at the declaration site rather than tracing through a config indirection. See the Visual assets section below for the directory shape on the other end.

**Appearance canon** — if the character will have portraits or appear in CGs, give the body an `## 外見` (appearance) section that locks the visual design: hair (color + shape — distinct silhouettes per cast member), eyes (shape + color), build, outfit + palette, signature item, expression baseline. Every portrait/CG `spec.yaml` prompt must derive from this section, never invent its own description — and asset specs should note the back-reference (`外見の正は characters/<id>.md`). Write the cast's definitions **contrastively** (different palettes, silhouettes, props) so characters stay distinguishable at a glance; the cheapest source of contrast axes is usually the characters' names. See the Character art pipeline below for generation order.

## Item file format — `items/<id>.md`

Optional directory. Items are engine-level resources; once declared,
the player can carry them in `state.baseline.inventory` and you can
gate scripts/actions on them via `requires: { inventory: ... }`.

```markdown
---
id: talisman
name: 镇魂札
kind: consumable        # consumable | key | gift
stack: true             # optional; default true. false = unique key item
effects:                # optional; applied when player uses the item
  stats: { spectral: -10 }
---

Markdown body becomes the item's description (for hub UI / AI context).
```

To let the player **acquire** an item, put `inventory: { talisman: 1 }`
in any action's or beat's `effects`:

```yaml
# actions/find_talisman.yaml
id: find_talisman
title: 翻一张札
effects:
  inventory: { talisman: 1 }
```

To let the player **use** an item, declare an action with
`kind: useItem` and `itemId: <id>`. The engine's bundled handler
consumes one of the item AND applies the item's `effects` atomically:

```yaml
# actions/use_talisman.yaml
id: use_talisman
title: 撕一张镇魂札
kind: useItem
itemId: talisman
requires:
  inventory: { itemId: talisman, min: 1 }   # only show when player has one
```

The engine deletes the inventory key when its count hits zero — you
don't need to clean up explicitly. Counts never go below zero.

**Custom metadata**: any frontmatter key not listed above (e.g.
`sell_value`, `rarity`, `weight`) is preserved under `item.custom`.
Game modules read `item.custom.sell_value` etc. directly from the
engine's item registry. Use this for game-specific numbers; the
engine doesn't interpret it.

## Enemy file format — `enemies/<id>.md`

Optional directory. Enemies are engine-level data; combat modules
(e.g. spectral-combat) read enemy stats + narrations and apply their
own damage formulas.

```markdown
---
id: youkai
name: 妖怪
hp: 6                   # base HP. Combat module may scale (e.g. +day×k).
stats:                  # optional; combat module decides how to use
  attack: 2
narrations:             # optional; templates with {hp} {name} {damage}
  intro: 一团扭曲的影子爬出——HP {hp} 的{name}。
  victory: {name} 化为光点散去。
  escape: {name} 逃了。
---

Markdown body becomes the enemy's description (for hub UI / AI authoring).
```

Actions that fight an enemy declare it via `enemyId`:

```yaml
# actions/hunt.yaml
id: hunt
kind: combat
enemyId: youkai
requires:
  stat: { name: mental, min: 2 }
```

The engine **does not dispatch on `enemyId` itself** — it just makes
the enemy data available via `game.enemies` to whatever combat handler
the game registers. Combat modules are responsible for picking up the
enemy and using its fields.

**Custom metadata**: any frontmatter key not listed above (e.g.
`attack_power`, `tier`, `weakness`) is preserved under `enemy.custom`.
Combat modules read `enemy.custom.attack_power` directly. Use this
for game-specific combat parameters that aren't engine-universal
(`hp` is universal; how hard the enemy hits back isn't).

## Weapon file format — `weapons/<id>.md`

Optional directory. Weapons are engine-level resources with a static
definition + a runtime mirror in `state.baseline.weapons[id]`. Engine
auto-equips the only declared weapon at init (single-weapon games);
multi-weapon games equip via the `equipWeapon` primitive.

```markdown
---
id: yaodao
name: 妖刀
basePower: 3         # state.baseline.weapons.yaodao.power starts here
kind: melee          # optional; combat modules may dispatch on this
properties:          # optional; open-ended fields combat modules use
  crit_scaling: 0.7
---

Markdown body becomes the weapon's description.
```

To **grow a weapon's power** during play, put `weapons` in any
action's or beat's `effects`:

```yaml
# actions/night_study.yaml — train the sword by study
effects:
  weapons: { yaodao: { power: 2 } }
  stats: { mental: -2 }
```

To **gate a script/action** on weapon power, use the `weaponPower`
condition variant:

```yaml
requires:
  weaponPower: { weaponId: yaodao, min: 20 }
```

Combat modules read the equipped weapon's current power via the
`getEquippedWeaponPower(ctx)` primitive (or
`state.baseline.weapons[state.baseline.equippedWeaponId].power` from
inside an ActionHandler).

**Custom metadata**: any frontmatter key not listed above is
preserved under `weapon.custom`. Use this for game-specific affinity
tags, lore IDs, rarity etc.

## Skill file format — `skills/<id>.md`

Optional directory. Skills are learnable abilities — distinct from
actions in that they're owned (in `state.baseline.knownSkills`) and
gated by knowledge, not by stat thresholds. Engine ships a bundled
`useSkill` action handler.

```markdown
---
id: purify
name: 净化术式
cost:
  stats: { intellect: -3 }      # what the skill consumes
effects:
  stats: { spectral: -15, mental: -1 }   # what it does
requires:
  stat: { name: intellect, min: 5 }      # gate on usability (in addition to ownership)
---

Markdown body becomes the skill's description.
```

To **teach** the player a skill, put `skills: { learn: [...] }` in
any action's or beat's `effects`, OR — more interesting — declare a
reactive trigger in a game module that watches state and grants the
skill on milestones:

```ts
// modules/combat.ts
triggers: [
  {
    id: "learn_purify",
    when: { weaponPower: { weaponId: "yaodao", min: 10 } },
    once: true,
    do: () => ({ deltas: { skills: { learn: ["purify"] } } }),
  },
]
```

To **use** a skill, declare an action with `kind: useSkill` and
`skillId: <id>`. The engine's bundled handler validates ownership +
applies cost + effects in one combined atomic delta:

```yaml
# actions/use_purify.yaml
id: use_purify
title: 发动净化术式
kind: useSkill
skillId: purify
requires:
  all:
    - knowsSkill: purify
    - stat: { name: intellect, min: 3 }
```

**Custom metadata**: any frontmatter key not listed above is preserved
under `skill.custom`. Combat / spirit modules read game-specific tags
(school, element, passive marker) via `skill.custom.<key>`.

## Visual assets — `assets/<kind>/<id>/`

Optional. Once declared, scripts can reference portraits, backgrounds, and CG (cut-scene illustrations) by path; the TUI renders them as a galgame-style stage, and the headless JSON output carries semantic descriptions so AI players can also "see" the scene.

**The asset is a directory, not a file.** Every asset has a `spec.yaml` (always present — the source of truth) plus zero or more pre-rendered files (`source.quality.png` / `source.compressed.{webp,png,jpg,jpeg}` / `tui.txt` / `tui.ans` / `web.*`). The engine never decodes images; renderings are produced by external tools (chafa, Midjourney, Stable Diffusion, hand-drawn ASCII, etc.) and committed alongside the spec. Missing renderings degrade to the spec's `placeholder` text — that text is also what AI players see in their JSON event stream, which is what makes the system work when nobody's drawn the art yet.

### Directory layout

```
assets/
  portraits/
    alice-smile/
      spec.yaml                  # always required
      source.quality.png?        # author's high-res master (gitignored)
      source.compressed.webp?    # distribution copy (tracked; cwebp / pngquant output)
      tui.txt?                   # plain ASCII for TUI (optional)
      tui.ans?                   # ANSI-colored for TUI (optional; preferred over txt)
      web.webp?                  # future web frontend (optional)
    alice-angry/
      spec.yaml
  backgrounds/
    sakura-path/
      spec.yaml
      ...
  cgs/
    handshake/
      spec.yaml
      ...
```

Four kinds: **portrait** (right/left/center character on a backdrop), **bg** (full-stage backdrop), **cg** (full-screen takeover for cinematic moments), and **sheet** — a *descriptive* asset (character turnarounds, expression sheets) under `assets/sheets/<slug>/`. Sheets never appear on the game stage (no script directive renders them); they exist for authors and image generators as the identity source that portraits and CGs derive from, and are browsable in the studio gallery like everything else.

**Check for ghost references** — a script can `:cg`/`:bg`/`:portrait` a path (or `defaultPortraits` an emotion) that nothing backs. Players hit these as placeholder text mid-scene. Both surfaces report them: `rpgh assets list <game-dir>` prints a `MISSING` section (also in `--format json` under `dangling`), and the studio gallery pins red ghost cards with every referencing site. Run the scan after writing scripts that mention new assets — the reference and its spec.yaml should land in the same commit.

### `spec.yaml` fields

```yaml
kind: portrait                              # portrait | bg | cg — required
description: |                              # required — what this depicts
  Alice, half-body, school uniform under sakura, soft smile.
prompt: |                                   # required — generator-facing
  Anime-style half-body portrait of Alice (twin-tails, school uniform),
  standing under a cherry blossom tree, soft smile, painterly palette.
placeholder: "[薄樱・微笑] 桜の下、淡く笑む"   # required — short, AI-visible
style_ref: ../alice-normal                  # optional — points to another spec
                                            # for style consistency reference
refs:                                       # optional — what the asset depicts.
  characters: [alice]                       # for CGs this is a generation contract:
  emotion: smile                            # attach each character's anchor portrait
                                            # as a reference image (see pipeline below)
size_hint:                                  # optional — playback / web sizing
  tui:  { cols: 28, rows: 16 }
  web:  { aspect: "3:4" }
tags: [main-cast, chapter-1]                # optional — for filtering / search
tui_render:                                 # optional — authoring metadata
  symbols: sextant                          # studio writes this after a
  dither: diffusion                         # successful chafa render; on
  colors: "256"                             # next open, the form pre-fills
  cols: 40                                  # so the winning combo persists
  rows: 24
```

`placeholder` is the most important field: it's what every consumer that can't or won't render the actual image sees. AI authors should write it as a full one-line description (character, emotion, posture, scene) so AI players reading the JSON stream can react to the scene as if they'd seen it.

`prompt` is consumed by image generators. Write it the way you'd write to Midjourney / SD / Claude — full sentences, style guidance, palette hints. Authors who want a different prompt format for their generator can edit the field freely; the engine doesn't validate it beyond non-empty.

`tui_render` is **authoring metadata only** — the engine doesn't read it. The studio (browser workbench, see below) writes this after a successful chafa render so the next-time author opens the page, the render-options form is pre-filled with the combo that worked.

### Character art pipeline — generation order matters

Character art generated in the wrong order produces casts that look alike across characters yet inconsistent within one character. The contract, from simple to composite:

1. **Lock the text first.** The character's `## 外見` section (see Character file format) is the only source of appearance truth. No sheet, portrait, or CG prompt invents looks ad hoc.
2. **Master design sheet.** Generate ONE comprehensive `sheet` asset per character (`assets/sheets/<id>-master/`) — full-body front/back, head studies, expression busts, and equipment detail callouts all on a single image. Compose the prompt from [templates/character-master-sheet.md](templates/character-master-sheet.md) (the template is the source; the spec's prompt is its build artifact — record `custom: { template: ... }`). One image forces one coherent interpretation; separate batches drift. A human approves the master (this is the casting decision). The same template works for enemies/creatures — swap expressions for threat poses.
3. **Split sheets & portraits.** Finer sheets (turnaround `<id>-turnaround/`, expression grid `<id>-expressions/`) and every in-game portrait are generated image-to-image FROM the master (declare `style_ref: ../<id>-master` in their specs), never from text alone. Register portraits in the character's `portraits:` map.
4. **CGs last.** A CG's `refs.characters` list is a real contract: attach each listed character's **master sheet — exactly one reference image per character**. The information density belongs INSIDE the reference (a master already carries multiple views, expressions, and detail close-ups in one image), not in a stack of separate reference images — generators reconcile a multi-image stack poorly, and a single-view reference (a lone portrait) invites pose-pasting. The prompt describes the scene; the references carry the identity. **Spell out the split in the generation instruction**: references pin identity ONLY (face features, apparent age, hair color/style, eye color, outfit, palette) — pose, camera angle, facial expression, framing, and lighting must come from the scene description, never copied from the reference. An instruction like "match the reference closely" produces portrait-paste CGs where the character stands in her portrait pose under portrait lighting in every scene.

Portrait image format: 3:4, **transparent background** (real alpha — verify, don't trust the RGBA flag), half-body, bottom edge may bleed/fade (the web frontend anchors portraits flush to the stage bottom and the dialogue box covers the waist cut). Keep `source.quality.png` as the local master and commit a slimmed `source.compressed.webp` (cwebp output, roughly ≤300KB).

### Render priority in the TUI

The TUI's `selectRendering` picks the best file the terminal can display:

1. `tui.ans` (truecolor / 256-color terminal only) → richest
2. `tui.txt` (any terminal) → plain
3. `placeholder` text → fallback when no rendering files exist

`NO_COLOR=1`, `TERM=dumb`, or `FORCE_COLOR=0` force a skip past `.ans` straight to `.txt`. Headless flows (`rpgh autoplay`, `peek`, `step` JSON) always see `placeholder` regardless of files present — they don't need image bytes, just semantic descriptions.

### The studio workflow (browser, optional)

`rpgh studio <game-dir>` boots a local web workbench at `http://localhost:5173` for visual asset management. v3 capabilities:

- **Gallery** — grid of all asset specs, filter by kind / missing-rendering, color-coded badges
- **Detail page** — view spec, copy prompt to clipboard, upload PNG to `source.quality.png` slot, render `source.quality.png → tui.txt`/`tui.ans` via chafa with options (symbols / dither / colors / size), preview the rendered output (ANSI colors render correctly in browser)
- **Inline spec edit** — placeholder / description / prompt / tags / refs / size_hint editable; saves go through the YAML Document API so author-formatted comments and key ordering survive the round-trip
- **Persisted render prefs** — last successful render's options auto-write to `spec.tui_render`; on page reload the form pre-fills

chafa is a system dependency (`brew install chafa` on macOS); studio detects whether it's installed and disables the render button with an install hint when it isn't. Authors who don't want chafa can hand-author `tui.txt` directly or commit only `placeholder` (the TUI will render that in a dim placeholder box).

### Workflow when AI authors a new game

The "AI generates game, human fills in art" flow is the canonical one:

1. AI writes `spec.yaml` for every visual asset the game needs — including detailed `placeholder` and `prompt` fields. **No image files needed yet** — the game is fully playable in placeholder mode.
2. AI references those assets from scripts (`bg:` frontmatter, `:cg ...` directives, character `portraits` map + `@speaker emotion` syntax).
3. Headless / AI playthroughs work end-to-end. The JSON event stream carries `placeholder` text wherever there'd be an image.
4. **Later**, a human (or another AI step) runs `rpgh assets list <game-dir> --missing` to see what art is needed, then `rpgh assets prompts <game-dir> <asset-path>` to copy the prompt into an image generator, drops the resulting PNG into `<asset-dir>/source.quality.png`, generates a distribution copy at `<asset-dir>/source.compressed.webp` (see below), and runs the chafa render in studio. The TUI hot-reloads the new rendering on next beat.

This separation means AI doesn't have to generate images itself, and humans don't have to write spec.yaml by hand. The two halves of the workflow are decoupled — they share `spec.yaml` as the contract.

### The source-image two-tier convention

PNGs from modern image generators are 2–3 MB each. Shipping the masters in git would bloat any non-trivial game to tens of MB; not shipping anything at all leaves cloners staring at placeholder text on first launch. The convention solves both:

| File | Tier | In git? | Purpose |
|---|---|---|---|
| `source.quality.png` | author master | **no** (gitignored) | high-res original from the generator; stays on author's machine + private backup branch; chafa re-renders from here |
| `source.compressed.{webp,png,jpg,jpeg}` | distribution | **yes** | slimmed copy that travels with the repo; first-launch visual fallback; future web frontend's input |

**Loader behavior** (`packages/cli/src/loader.ts`): prefers `source.quality.png` if present, falls back to `source.compressed.*` (webp > png > jpg > jpeg), falls back to undefined (TUI keeps working via `tui.*`). The engine never cares which tier won; downstream tools (chafa, future web renderer) just consume whatever path the loader hands them.

**After you generate `source.quality.png`, also produce a distribution copy.** Engine doesn't hard-bind any specific compressor — use whatever you have:

```bash
# WebP (best size, ~70% smaller than PNG; cwebp from libwebp)
cwebp -q 80 source.quality.png -o source.compressed.webp

# PNG (lossy palette reduction, ~70% smaller, stays PNG; pngquant)
pngquant --quality=65-85 --output source.compressed.png source.quality.png

# PNG (lossless, ~20-40% smaller; oxipng / optipng)
oxipng -o 4 source.quality.png --out source.compressed.png
```

Target size for `source.compressed.*` is ~300–500 KB per CG, ~50–150 KB per portrait. Commit the compressed file; `source.quality.png` is gitignored at `examples/**/*.quality.png` by default (extend to your game folder if your game lives outside `examples/`).

If you skip the compression step entirely, the repo just won't have a distribution copy — cloners see placeholder text, the TUI still renders from `tui.*`. Graceful degradation all the way down.

## Map file format — `maps/*.yaml`

Optional directory. A map is a **container for events** — actions,
encounter tables, connections to other maps — scoped to "where the
player is right now." This is the RPGMaker map model: enter a map, the
hub shows that map's actions/connections; move to another map, the
hub re-scopes. The engine tracks the player's current location at
`state.baseline.currentMapId` as a first-class state slot.

Maps are flat — there is no coordinate axis or zone hierarchy inside
a map. Movement happens map-to-map via `connections`. The graph between
maps is the world's geometry.

```yaml
# maps/town.yaml
id: town                        # unique within the game
name: 街
description: 涩谷·西早稲田。咖啡店、便利店、车站。
bg: assets/backgrounds/town     # optional — synced to visuals.bg on entry
difficulty: 1                   # optional, defaults to 1
chain: shibuya                  # optional grouping label
on_enter: arrive_town           # optional — script id launched on entry

# Edges to other maps. Surfaced as "move:<target>" activities the
# engine synthesizes with kind: moveToMap.
connections:
  - { dir: 校园, target: lab }
  - { dir: 回家, target: cyber }
  - { dir: 奥, target: backroom, requires: { switch: { name: key_held, eq: true } }, locked_hint: 鍵がない }

# Optional inline map-scoped actions. Same shape as actions/*.yaml.
actions:
  - id: work_town
    title: 街でバイト
    cost: 1
    effects:
      stats: { funds: 12, stamina: -1 }

# Optional encounter table — modules roll on map entry.
# enemy ids validated against game.enemies. null = "no encounter this draw".
encounter_table:
  - { enemy: oni_lesser, weight: 70 }
  - { enemy: null,       weight: 30 }

# Optional loot table — modules roll on map entry.
# item ids validated against game.items.
loot_table:
  - { item: ryo, min: 8, max: 16, weight: 50 }
  - { item: null, min: 0, max: 0, weight: 50 }

# Optional character spawn rules. Modules consume — engine doesn't roll.
character_spawns:
  - { character: asahi, chance: 0.3, encounter_script: meet_asahi }

# Optional: marks this map as an "exit" location (raid extract, scene break).
# Modules surface a leave/extract action when isExtract is true.
is_extract: false
```

### Connections (the world's geometry)

Each connection declares a one-way edge `dir → target`. The engine
synthesizes a hub activity `move:<target>` with `kind: moveToMap` for
each connection from the current map. Players see "→ <target.name>（<dir>）"
in the menu. The bundled `moveToMap` handler calls `enterMap`, which:

1. Sets `state.baseline.currentMapId` to the target.
2. Syncs `state.baseline.visuals.bg` to `<target>.bg` when set.
3. Queues `<target>.on_enter` script (if any) into `currentScriptId`.

If your game needs side effects on movement (turn count, companion
passives, encounter rolls, narration variants), don't replace the
engine handler — observe `onActionComplete` for `action.kind === "moveToMap"`
in a module and layer behavior on top. The engine handler is the
default channel.

Locked connections render with `lockedHint` as the reason. The player
sees where they could go but can't dispatch the move until `requires` is true.

### Entry maps and `onSessionStart`

`state.baseline.currentMapId` starts as `null` on a fresh session.
**Set the starting map in your game module's `onSessionStart`**:

```ts
onSessionStart: (ctx) => {
  if (ctx.state.baseline.currentMapId === null) {
    ctx.state.baseline.currentMapId = "town";
  }
}
```

Or use `enterMap(ctx.state, ctx.game, "town")` if you also want the
map's `bg` and `on_enter` script to fire.

### Scoping actions to maps — `Action.whenIn`

Any action (in `actions/*.yaml` OR inline in a map's `actions:` block
OR in a module's action handler registry) can declare `whenIn: [<map_id>, ...]`
to limit which maps it appears on. Omitted = visible everywhere (the
"ambient" pattern, e.g. an `end_year` action that works regardless of
where the player is).

```yaml
# actions/study.yaml — only available when in lab
id: study
title: 上课 / 听讲座
cost: 1
whenIn: [lab]                  # array of map ids
effects:
  stats: { engineering: 5, neuroscience: 2, stamina: -1 }
```

This is the cleanest way to express "I can only study when I'm in the
lab" — don't manually gate via a `currentMapId` switch / variable.

### Chains (optional grouping)

A `chain: <id>` label on a map marks "this set of maps belongs to the
same expedition or scene group." Engine doesn't interpret it. Modules
read it for sorting / gating / "depart on raid → enter the chain's
entry map" UI patterns. sengoku-raid uses `chain: "kuro_swamp"` (etc.)
to group flat raid maps under a player-facing "go raid kuro_swamp"
button that internally enters the chain's entry map.

### Map vs. script vs. action — when to pick which

- **Map**: a stable location. The player's "where am I?" answer for
  more than one turn. Has actions scoped to it, possibly an `on_enter`
  intro script.
- **Script**: linear or branching narrative. The player's "what's
  happening to me right now?" answer. Doesn't have a hub during itself.
- **Action**: a single one-shot operation from a hub. Either applies
  effects directly or dispatches into a module handler that mutates
  state.

Rule of thumb: if the player should be able to do **multiple different
things from the same context** (study OR research OR call a friend
from the lab), that context is a *map*. If they pass through and the
context ends, it's a *script*.

## Action file format — `actions/*.yaml`

Actions are hub-bound activities — anything that's not a script the player can pick when the engine yields a hub menu. Three flavors:

**Engine-bundled `kind`** — the engine ships handlers for these:

```yaml
# actions/use_talisman.yaml
id: use_talisman
title: 撕一张镇魂札
kind: useItem
itemId: talisman                              # required for useItem
requires:
  inventory: { itemId: talisman, min: 1 }
```

`kind: useSkill` works the same with `skillId`. `kind: combat` declares an `enemyId` but **does not** dispatch on its own — a combat module has to register a handler for `kind: combat` (or for a more specific kind like `kind: raid`) and consume the action.

**Effects-only action** — no `kind`, just `effects` + (optionally) `narrations`. The engine's bundled dispatcher applies the delta:

```yaml
# actions/study.yaml
id: study
title: 复习古文
effects:
  stats: { intellect: 1, mental: -2 }
narrations:
  - 灯下读到深夜。
requires:
  slot: { eq: 2 }                             # only at night, training mode
```

**Module-defined `kind`** — anything else. The action's `kind` is the dispatch key into your module's `actionHandlers`:

```yaml
# actions/depart.yaml
id: depart_kuro_swamp
title: 出征 · 黒沼地
kind: depart                                  # raid module registers this
mapId: kuro_swamp_edge                        # engine-validated map ref (see below)
requires:
  stat: { name: hp, min: 1 }
```

All actions share a frontmatter envelope: `id` (required, unique), `title` (display), `requires` (Condition DSL — same grammar as scripts), `effects` (StateDelta, optional), `narrations` (string[], optional). Any other field is passed through to the dispatcher / handler verbatim.

**Engine-validated fields** on `Action`:
- `mapId: <id>` — when set, the parser validates the id against `game.maps[]` at load time. Module handlers can pull the map from `ctx.game.maps?.find(...)` or `ctx.mapMap.get(...)`.
- `whenIn: [<id>, ...]` — array of map ids. The hub builder filters out the action when `state.baseline.currentMapId` isn't one of them. Omitted = ambient (visible on any map).
- `kind: "moveToMap"` with `payload: { to: <map_id> }` — bundled engine handler. Calls `enterMap` and transitions the player. Used by the synthesized activities the engine emits for each `MapDef.connections[]`.

## Script ID conventions (suggested, not enforced)

Numeric prefix groups related scripts:
- `001_*` — opening
- `00X_*` — main flow
- `004a_*`, `004b_*` — branch routes (a/b for parallel)
- `005a_good`, `005b_bad` — endings

Script availability is determined by `requires`, not by name. Names are for humans.

## Test fixtures — `tests/*.yaml`

For regression: assert that certain inputs lead to certain state.

```yaml
name: 选好感选项三次应该解锁 002
description: ...
state:                       # optional partial state to seed
  baseline:
    characters:
      alice: { affection: 3 }
inputs:
  - { type: select, scriptId: "001_meeting" }
  - { type: next }
  - { type: choose, index: 2 }
assertions:
  - { kind: reason, eq: completed }   # or inputs-exhausted / quit / max-steps
  - { kind: state, path: baseline.completedScripts, includes: 001_meeting }
  - { kind: state, path: baseline.characters.alice.affection, eq: 5 }
  - { kind: output, type: gameEnd, present: true }
```

After writing or changing scripts, run `rpgh test .` to check fixtures still pass.

## When you need custom mechanics — `modules/*.ts`

If the request fits in markdown — new scene, new branch, balance affection, swap dialogue, gate a script behind a flag, add an item or skill — stay in markdown.

If the request needs **new behavior** the engine doesn't already do — custom combat math, hub mode switches, a raid loop, reactive milestones, hidden state, per-character passives, "when X reaches Y do Z" without polling — write a module under `modules/<name>.ts`. The engine exposes the surface for exactly this; that's what "headless RPG Maker" means.

A module default-exports a `Module` with whichever of these slots are relevant:

- `id` / `version` — required.
- `actionHandlers: Record<string, ActionHandler>` — pick action `kind` strings; handle them atomically. An `ActionHandler` returns an `ActionResult` (`{ deltas?, narrations?, scriptStart? }`) — it does **not** yield. Multi-step output goes through `narrations: string[]`, drained one per step by the main loop.
- `triggers: Trigger[]` — declarative reactive milestones (`{ when: Condition, do, once? }`). Rising-edge: fires when `when` transitions false→true. Cheap, scales to many.
- 15 lifecycle hooks — `onSessionStart`, `onScriptStart`, `onScriptComplete`, `onBeatEnter`, `onChoicePresented`, `onChoiceSelected`, `onActionDispatch`, `onActionComplete`, `onStateMutated`, `onHubBuild`, `onTriggerFire`, `onEndConditionFire`, `onError`, `onSave`, `onLoad`. Three compose strategies depending on the hook: notify-all (every module observes), first-wins (`onHubBuild`, `onBeatEnter`, `onChoicePresented` — first non-void wins), veto (`onActionDispatch` — return `"cancel"` to short-circuit).
- Private state namespace at `state[module.id]` — your module's data. Plain JSON only (no functions, no class instances, no `Date`s, no `Map`s). Engine state slots (`baseline.*`, `training.*`) you read freely; you write them only through primitives (`giveItem` / `mutateState` / `equipWeapon` / `learnSkill` / …).

The canonical reference is `examples/sengoku-raid/modules/raid.ts`: ~20 action handlers, 13/15 hooks exercised, composite triggers with `once: true`, its own state namespace (`state["sengoku-raid"]`), no engine modifications. Read it before writing your own module — it's the template.

After the module is written, declare it in `game.yaml`:

```yaml
modules:
  - ./modules/raid.ts
```

For the special case of customizing the **main loop itself** (e.g. add a daybreak narration at the start of each new day, route activities across multiple modes), eject the preset: `rpgh init <dir> --preset training --eject`. That copies `run.ts` + supporting files into `<dir>/preset/` and rewrites imports to `@rpg-harness/engine`'s public surface. After ejection, you own the loop; engine updates don't flow in automatically.

## How to make changes

1. **Understand the existing flow first.** Read `game.yaml`, all `characters/*.md`, all `scripts/*.md`. Note which scripts gate which (via `requires`). Build a mental map of the routes and endings.
2. **Identify what's being asked.** Is it: add a new branch? Polish dialogue? Balance affection thresholds? Add a new character?
3. **Make the change in the smallest viable scope.** One new script is better than three. Edit existing text in-place when polishing.
4. **Test.** Run `rpgh autoplay . --persona greedy` and `--persona charmer` and `--persona rude`. Each should still reach a defined ending. Then `rpgh test .` to verify fixtures.
5. **If a fixture is now wrong** (the design changed legitimately), update the fixture rather than the design — and tell the user what changed.

## Where to make changes

- **DO** edit `scripts/`, `characters/`, `items/`, `enemies/`, `weapons/`, `skills/`, `actions/`, `maps/`, `assets/`, `tests/`, `game.yaml` — that's content.
- **DO** edit `modules/*.ts` (and `preset/*.ts`, if ejected) when the game needs mechanics the engine doesn't already provide. New action `kind`s, new triggers, new private state, custom hub builds — they belong in a module, not in engine.
- **DON'T** edit `packages/engine`, `packages/parser`, `packages/cli` source — that's the engine itself, off-limits from inside a game folder.
- **DON'T** touch `.rpg-harness/sessions/` — those are the player's saves.
- **DON'T** change a character's `id` once scripts reference it. Add a new character if you need a new name.
- **DON'T** invent new engine-level Beat types, `Condition` operators, `StateDelta` slots, `Output` / `Input` variants, or `Module` hooks — those need engine PRs. You CAN add new action `kind`s, new triggers, and new module-private state freely inside your own `modules/*.ts`.

## Stylistic guidance

- Keep narration short and concrete. The player advances one beat at a time — long paragraphs feel like walls.
- Don't repeat what a character just said in narration. Dialogue carries voice; narration carries scene.
- 3 choice options is usually right. 2 feels coercive. 5+ feels like a survey.
- An ending script should be SHORT (3-6 beats). The drama is in the run-up; the ending lands the feeling.
- A "bad" ending isn't punishment — it's a different note. Even "bad" endings should give the player something to feel.

## Common pitfalls

- **Fall-through past `[end]` is forgotten** — if a script has a `# leave` section but no `[end]` before it, the main path will run into the leave content. Use `[end]`.
- **Label names with special chars** — only `[a-zA-Z_][\w-]*` works. `$end` is the reserved goto-to-end-of-script target.
- **Inline effects with flags** — inline only supports affection. For flags use YAML fence.
- **Forgetting to add `scriptCompleted` to ending requires** — if you have `004 → 005`, ending 005 should also require 004 completed, otherwise random play can skip ahead.
- **`@speaker emotion` collides with first word of dialogue** — if the second token happens to look like an emotion (`@alice ok let's go`) the parser tags it as a candidate emotion. The engine resolves at runtime: if `ok` isn't in `alice.portraits`, the token is restored to the dialogue text — graceful fallback. Authors who want to be safe can rephrase (`@alice 「ok let's go」`) or just not worry; the emotion-form is opt-in by character's `portraits` map.
- **Forgetting the `assets/` prefix in asset paths** — script `bg: backgrounds/foo` won't resolve. The full path is `bg: assets/backgrounds/foo`. Same for `:cg` and `:portrait` directives, and character `portraits:` map values.
- **Editing `tui_render` by hand and getting whitelist errors** — `colors: 256` must be quoted as `"256"` (YAML reads bare `256` as int; the studio writes it quoted, the parser accepts both, but unquoted on hand-edits is fine too — the parser normalizes to string). `symbols` / `dither` values are checked against the chafa whitelist (sextant / quad / braille / ordered / diffusion / etc.) at parse time.
