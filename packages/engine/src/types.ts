export type FlagValue = number | string | boolean;
// Variable storage: declared in game.yaml's `variables:` block. Each
// variable has a declared type (string | number) and an initial value.
// Unlike the old anonymous `flags` hash, references in conditions /
// effects are validated against the declared set at parse time.
export type VariableValue = number | string;
// Switch storage: declared in game.yaml's `switches:` block. Always
// boolean. Effectively a typed subset of the old flag hash for the
// common "did this happen" / "is this unlocked" case.

export interface SwitchDef {
  id: string;
  initial: boolean;
  description?: string;
}

export interface VariableDef {
  id: string;
  type: "string" | "number";
  initial: VariableValue;
  description?: string;
}

export interface CharacterState {
  // Per-character numeric stats. Author declares these in the character
  // markdown frontmatter (`stats: { affection: { initial: 0 } }`); the
  // engine pre-populates from those initials. `affection` is the
  // dominant case — inline-effect syntax `+alice` desugars to
  // `characterStats: { alice: { affection: 1 } }` — but games can
  // declare any number of stats (trust, friendship, anger, ...).
  stats: Record<string, number>;
  // Free-form custom slot. Engine doesn't interpret. Reserved for
  // game-specific per-character state that doesn't fit the stats
  // schema.
  custom: Record<string, FlagValue>;
}

// Per-script state. Mirrors RPGMaker's "event self-switches + completed
// flag". `completed` flips to true when the engine finishes running the
// script (any of [end] beat / endScript / fall-off-last-beat). The
// four self-switches A/B/C/D are author-controllable: they let a script
// remember per-instance state ("did I show this beat once" / "branch X
// already taken") without polluting the global variables namespace.
export interface ScriptState {
  completed: boolean;
  selfSwitches: { A: boolean; B: boolean; C: boolean; D: boolean };
}

export function makeScriptState(): ScriptState {
  return {
    completed: false,
    selfSwitches: { A: false, B: false, C: false, D: false },
  };
}

export interface BaselineState {
  characters: Record<string, CharacterState>;
  switches: Record<string, boolean>;
  variables: Record<string, VariableValue>;
  // Per-script completed flag + A/B/C/D self-switches. Lazy: missing
  // ids read as default ScriptState (completed=false, all switches
  // false). Engine creates/updates entries via mutateState; the
  // run-loop sets completed=true automatically when a script ends.
  scripts: Record<string, ScriptState>;
  // Ordered audit log of script ids in the order they completed. Used
  // for telemetry (last-script-run / "what ending was reached" in
  // autoplay output / session selector) — game logic should consult
  // baseline.scripts[id].completed instead.
  completionOrder: string[];
  currentScriptId: string | null;
  beatIndex: number;
  // Engine-owned standard inventory schema. Counts keyed by item id.
  // Invariant: keys with count <= 0 are deleted by applyDelta, so a
  // present key always means count >= 1. Empty record for games that
  // declare no items.
  inventory: Record<string, number>;
  // Id of the map the player is currently in, or null when the game has
  // not (yet) entered any map. Updated by the `enterMap` primitive (and
  // the built-in `moveToMap` action handler). When non-null, the hub
  // builder filters actions/connections by this id and modules can read
  // it to answer "where am I?" without inventing a private slot.
  currentMapId: string | null;
  // Engine-owned runtime weapon instances. Keyed by weapon id; engine
  // initializes each declared WeaponDef with power = basePower at
  // game start. Mutations go through StateDelta.weapons.
  weapons: Record<string, WeaponState>;
  // Id of the currently equipped weapon, or null. Engine auto-equips
  // the only declared weapon at init; multi-weapon games equip via
  // the equipWeapon primitive.
  equippedWeaponId: string | null;
  // Skills the player has learned. Empty for games that declare no
  // skills/ directory or for new sessions.
  knownSkills: string[];
  // Current bg / per-slot portraits / cg. Mutated by setBg / setPortrait
  // / clearVisuals / showCg / hideCg beats. Lazy-initialized to
  // emptyVisualState() so old saves without this field still load.
  visuals: VisualState;
}

export interface TrainingState {
  day: number;
  slot: number;
  stats: Record<string, number>;
  statMax: Record<string, number>;
}

// Transient run-loop state. Lives outside any specific preset because
// any preset's main loop may need to queue narrations across step()
// boundaries. (Previously this was on TrainingState, which made it
// unreachable for non-training presets.)
export interface RuntimeState {
  pendingNarrations: string[];
  // Trigger ids whose `when` condition is currently satisfied. Used by
  // checkTriggers to detect rising-edge transitions (was false, now
  // true) and only fire then — not every time the condition is
  // satisfied. Falling edges (was true, now false) re-arm the trigger.
  activeTriggers: string[];
  // Trigger ids that have fired at least once (only tracked for
  // triggers declared with `once: true`). Prevents re-firing even on
  // future rising edges.
  firedTriggers: string[];
  // Script ids whose `onScriptStart` has already fired for the current
  // entry. Pushed by fireOnScriptStart, cleared by fireOnScriptComplete.
  //
  // Why this exists: `step`-style callers (CLI peek/step,
  // session-replay) create a fresh Engine + run loop on each invocation
  // and re-enter the active script's runScript every step. Without
  // dedup, onScriptStart would fire on every step — surprising for any
  // module hook that has side effects (queueing narrations, flipping
  // switches, etc.). The docstring on Module.onScriptStart promises
  // "fires just before the first beat of a script yields" — singular,
  // not per-resumption. This field enforces that.
  firedScriptStarts: string[];
  // Snapshot of the most recent hubMenu Output's activities. The run
  // loop populates this whenever it yields a hubMenu; when the user
  // submits an Input.doActivity, the engine resolves the chosen id by
  // looking it up here to recover the activity's actionKind + payload.
  // This is what lets onHubBuild emit fully-dynamic activities (per-zone
  // move actions, per-character bond gifts, etc.) without each module
  // implementing its own prefix-string router.
  lastHubActivities: HubActivity[];
  // Per-action title markers. Hub builders prepend the marker string to
  // an activity's title when it appears here. Modules populate / clear
  // this map to signal "this option has new content today" — the
  // canonical use case is a galgame where a trigger arms a story beat
  // bound to a specific action, and the hub should highlight it so the
  // player knows where the next bit of plot lives. Keyed by the activity
  // id (e.g. `action:study`, `move:lab`). Optional; absent = no marker.
  hubMarkers?: Record<string, string>;
}

export interface ComposedState {
  baseline: BaselineState;
  runtime: RuntimeState;
  training?: TrainingState;
  [namespace: string]: unknown;
}

export interface CharacterDef {
  id: string;
  name: string;
  // Declared per-character stats. Each entry's `initial` seeds the
  // engine's CharacterState.stats at game start. `affection` is the
  // canonical example but games can register any name.
  stats?: Record<string, CharacterStatDef>;
  // emotion-name → asset path (e.g.
  // { default: "assets/portraits/kagari-normal",
  //   smile:   "assets/portraits/kagari-smile" }). Script syntax
  // `@kagari smile` resolves "smile" against this map at runtime. The
  // declaration uses full asset paths (Option A in the asset design)
  // — explicit at the source, terse at the reference site.
  portraits?: Record<string, string>;
  // Emotion key the engine falls back to when `@<character>` has no
  // emotion token. Defaults to "default" when omitted.
  defaultPortrait?: string;
  // Game-specific frontmatter the engine doesn't interpret. Anything
  // the parser found in <character>.md that isn't a known field lands
  // here verbatim, so game modules can read e.g. character.custom.gift_preference
  // without each parser growing a per-game vocabulary.
  custom?: Record<string, unknown>;
}

export interface CharacterStatDef {
  initial: number;
  min?: number;
  max?: number;
  description?: string;
}

// Engine-level standard item resource. Defined here (not in any
// gameplay module) so any module can assume this schema exists and
// use giveItem/consumeItem/hasItem primitives without reinventing.
// Gameplay modules that need item-shaped data outside this schema
// should namespace their own state slice under state[moduleId].
export interface ItemDef {
  id: string;
  name: string;
  // Markdown body of the .md file — for hub UI / inspection / AI
  // authoring context. Engine doesn't read it.
  description: string;
  kind: "consumable" | "key" | "gift";
  // Applied when the player uses this item via a kind: "useItem"
  // action. The engine's bundled useItem handler merges this with a
  // `-1` inventory delta for the item itself.
  effects?: StateDelta;
  // Default true. false marks unique key items — the bundled
  // giveItem primitive refuses to push count above 1 for non-stack
  // items so authors don't need to guard against double-pickup.
  stack?: boolean;
  // Game-specific frontmatter — sell_value, rarity, weight, etc.
  // Engine doesn't interpret it; game modules read via item.custom.<key>.
  custom?: Record<string, unknown>;
}

// Engine-level standard enemy resource. Combat modules read these to
// drive narration + base stats; specific damage formulas and HP
// scaling stay with the combat module (different games scale
// differently). Narrations support `{name}` and `{hp}` template
// substitution.
export interface EnemyDef {
  id: string;
  name: string;
  // Markdown body — flavor text for hub UI / inspection.
  description: string;
  // Base HP. Combat module may apply scaling (e.g. day-multiplier)
  // on top of this; engine doesn't.
  hp: number;
  // Optional misc stats — combat module decides how to use them
  // (attack power, defense, etc.). Empty for purely HP-driven enemies.
  stats?: Record<string, number>;
  narrations?: {
    // {hp}, {name} substituted at fire time.
    intro?: string;
    victory?: string;
    escape?: string;
  };
  // Game-specific frontmatter — tier tags, loot table refs, AI hints,
  // etc. Engine doesn't interpret it; combat modules read via
  // enemy.custom.<key>.
  custom?: Record<string, unknown>;
}

// Engine-level standard weapon resource. Engine owns the static
// definition (basePower, kind, properties); runtime instance state
// lives in state.baseline.weapons[id] (so authors can grow a weapon's
// power across the game). Combat modules pick the equipped weapon
// from state.baseline.equippedWeaponId and read its runtime power via
// the getWeaponPower primitive.
export interface WeaponDef {
  id: string;
  name: string;
  description: string;
  // Starting power. state.baseline.weapons[id].power = basePower at
  // game init; subsequent mutations (e.g. night_study, hunt wins) add
  // to that.
  basePower: number;
  // Optional. Combat modules may dispatch differently on weapon kind
  // (e.g. melee vs spell-focus). Engine doesn't interpret it.
  kind?: string;
  // Open-ended properties for combat-module-specific use (crit bonus,
  // affinity, durability, etc.). Engine just stores them.
  properties?: Record<string, number>;
  // Game-specific frontmatter — rarity, lore tags, etc. Engine doesn't
  // interpret it; modules read via weapon.custom.<key>.
  custom?: Record<string, unknown>;
}

// Runtime state per weapon. Engine initializes each weapon's `power`
// to its WeaponDef.basePower; gameplay modules / action effects can
// mutate it via StateDelta.weapons.
export interface WeaponState {
  power: number;
}

// Engine-level standard skill resource. Skills are learnable abilities
// — distinct from actions in that they're owned by the player
// (state.baseline.knownSkills) and gated by knowledge rather than
// stat thresholds. The engine ships a default useSkill action
// handler in the baseline module that validates ownership, applies
// cost (in stats) and effects.
export interface SkillDef {
  id: string;
  name: string;
  description: string;
  // Stat cost to use the skill (e.g. { intellect: -3 }). Optional —
  // skills can be free.
  cost?: StateDelta;
  // What happens when the skill is used (applied alongside cost in
  // one combined delta).
  effects?: StateDelta;
  // Optional gate on usability (e.g. `stat: { name: mental, min: 5 }`)
  // — checked by the useSkill handler in addition to the knowledge
  // check.
  requires?: Condition;
  // Game-specific frontmatter — passive marker, school tag, etc.
  // Engine doesn't interpret it; modules read via skill.custom.<key>.
  custom?: Record<string, unknown>;
}

// Engine-level standard map resource. A map is a *container for events*
// — actions, scripts, encounter tables, connections to other maps — that
// scopes "what the player can do right now" to "where they currently are."
// This is the RPGMaker map model: enter a map, the hub shows that map's
// actions/connections; move to another map, the hub re-scopes.
//
// Movement happens map-to-map (via `connections`). There is no coordinate
// axis inside a map; "where I am" is just `state.baseline.currentMapId`.
// Maps that conceptually belong to the same expedition / scene group
// share a `chain` string — engine doesn't interpret it; modules read it
// for sorting, gating, or "depart on raid → enter the chain's entry map".
//
// Maps are loaded from `maps/*.yaml`.
export interface MapDef {
  id: string;
  name: string;
  description: string;
  // Coarse author-declared progression hint. Modules can read this to
  // gate map availability (e.g. only show difficulty<=2 maps until the
  // player has completed an early raid). Engine doesn't enforce.
  difficulty?: number;
  // Background asset path. When the player enters this map via
  // `enterMap`, the engine syncs `state.baseline.visuals.bg` to this
  // value, so the snapshot's visualState tracks where the player
  // physically is rather than freezing at whatever the last script
  // `:setBg` directive set.
  bg?: string;
  // Actions available while the player is on this map. Surfaced by
  // `buildMapHubSnapshot` (or any caller iterating map.actions) and
  // dispatchable via the standard `action:<id>` activity path. Each
  // action's `requires` still gates availability normally.
  actions?: Action[];
  // Outgoing edges to other maps. `dir` is a player-facing label
  // ("北 / 城へ戻る"); `target` is another map's `id`. The engine's
  // built-in `moveToMap` handler dispatches a transition to the target.
  connections?: MapConnection[];
  // Script id to launch when the player enters this map. Engine sets
  // baseline.currentScriptId = this; the normal run loop picks it up
  // next iteration.
  onEnter?: string;
  // Marks an "exit" location — modules driving an extraction/expedition
  // loop typically surface a "leave / extract" action only when
  // `isExtract` is true on the current map.
  isExtract?: boolean;
  // Encounter table — weighted draw the consuming module can roll on
  // map entry. enemyId values are validated against game.enemies.
  encounterTable?: { enemyId: string | null; weight: number }[];
  // Loot table — weighted draw. itemId values are validated against
  // game.items.
  lootTable?: { itemId: string | null; min: number; max: number; weight: number }[];
  // Per-character spawn rules. RPGMaker analogue: map events with
  // chance + self-switch. Engine doesn't roll; modules do.
  characterSpawns?: CharacterSpawnRule[];
  // Logical grouping label. Maps that belong to the same expedition or
  // scene group share a `chain` string. Engine doesn't interpret it;
  // modules can read it (e.g. "all kuro_swamp maps") for sorting,
  // gating, or "depart on raid → enter the chain's entry map".
  chain?: string;
  // Game-specific frontmatter — lore tags, music cues, etc. Engine
  // doesn't interpret it; modules read via mapDef.custom.<key>.
  custom?: Record<string, unknown>;
}

// Edge between two maps. Surfaced as a hub activity that dispatches the
// built-in `moveToMap` handler (`payload.to = target`).
export interface MapConnection {
  // Player-facing label ("北", "城へ戻る", "Up the stairs").
  dir: string;
  // Target map id. Validated against game.maps at parse time.
  target: string;
  // Optional gate. When present and false, the engine surfaces the
  // connection as a locked entry (with `lockedHint` as the reason) so
  // the player can see where they could go.
  requires?: Condition;
  lockedHint?: string;
}

export interface CharacterSpawnRule {
  // Which character spawns. Must reference game.characters[].id.
  characterId: string;
  // Probability per spawn check, 0..1. Module rolls; engine doesn't.
  chance: number;
  // Script to launch when the spawn triggers. Must reference
  // game.scripts[].id.
  encounterScriptId: string;
}

// Visual asset registry. An asset is a directory under
// <gameDir>/assets/{portraits,backgrounds,cgs,sheets}/<slug>/ containing a
// spec.yaml plus any number of pre-rendered files (source.quality.png /
// source.compressed.{webp,png,jpg,jpeg}, tui.txt, tui.ans, web.webp).
// The engine never decodes images; it
// only carries the spec + paths to those files so each frontend can
// pick the best rendering it can display. Missing renderings degrade
// to the spec's `placeholder` text — that text is also what AI/
// headless consumers see, making it the self-describing ground truth
// against which a misselected asset can be detected.
//
// portrait / bg / cg are stage assets — scripts put them on screen.
// `sheet` is a descriptive asset: character design references
// (turnarounds, expression sheets) that no script directive renders;
// they exist for authors and generators — the identity source that
// portraits and CGs are derived from.
export type AssetKind = "portrait" | "bg" | "cg" | "sheet";

export interface AssetSpec {
  // Logical id = the asset directory's forward-slash relative path
  // from the game dir, e.g. "assets/portraits/kagari-smile". Scripts
  // reference assets by this exact string.
  path: string;
  kind: AssetKind;
  description: string;
  prompt: string;
  // Required short, display-facing text. Shown by TUI placeholder
  // mode and by every headless consumer (peek/step JSON, autoplay
  // stderr). Authors phrase it as a one-line "what this depicts"
  // including the most semantic facts (character, mood, scene) so
  // AI can detect a slot/spec mismatch without seeing the image.
  placeholder: string;
  // Optional pointer to another asset path used as a style anchor by
  // the generation pipeline. Engine doesn't read it.
  styleRef?: string;
  refs?: AssetRefs;
  sizeHint?: AssetSize;
  tags?: string[];
  // Authoring-side render preferences. The studio writes here after a
  // successful chafa render so the "winning combo" persists across
  // page reloads — find a good {symbols, dither, colors, cols, rows}
  // tuple once, the form pre-fills with it next time.
  //
  // Engine doesn't read this. It's authoring metadata, like `prompt`
  // or `style_ref` — useful for tooling, ignored at runtime.
  tuiRender?: TuiRenderPrefs;
  // Pre-rendered files discovered alongside spec.yaml in this asset's
  // directory. Engine populates absolute paths but never opens the
  // files itself — frontends do that.
  renderings: AssetRenderings;
  // Forward-compat passthrough for unknown spec.yaml keys.
  custom?: Record<string, unknown>;
}

export interface TuiRenderPrefs {
  // All optional — only the fields the author actually committed to
  // serialize. Studio's render-form hydrates from whatever's present.
  // Whitelist values are duplicated from studio/server/render.ts; keep
  // the two in sync (parser can't import from studio because engine
  // mustn't depend on studio).
  symbols?: string;
  dither?: string;
  colors?: string;
  cols?: number;
  rows?: number;
}

export interface AssetRefs {
  characters?: string[];
  emotion?: string;
  [k: string]: unknown;
}

export interface AssetSize {
  tui?: { cols: number; rows: number };
  web?: { aspect: string };
}

export interface AssetRenderings {
  // tui.ans — ANSI-colored text rendering; TUI prefers this over txt.
  // Constraint authoring side: must contain only SGR (color) escapes,
  // no cursor-move. Engine never validates this; misuse manifests as
  // visual glitches in the TUI.
  tuiAns?: string;
  // tui.txt — plain text rendering (ASCII art). TUI fallback when
  // tui.ans is absent.
  tuiTxt?: string;
  // Source image — three slots for one tier convention:
  //   source.quality.png        — author's high-res master (gitignored,
  //                                stays local; used by author-side
  //                                tooling like chafa re-render)
  //   source.compressed.{webp,png,jpg,jpeg}
  //                              — slimmed distribution copy that ships
  //                                with the repo; first-launch visual
  //                                fallback for cloners
  // Loader populates the two tier-specific slots independently with
  // whichever file(s) it finds, then sets `source` to the "best pick"
  // (sourceQuality if present, else sourceCompressed) for callers that
  // just want "give me an image, any image" — chafa render and the
  // existing renderings.source consumers fall into that category.
  // The future web renderer + studio's tier-aware preview consume
  // `sourceQuality` and `sourceCompressed` directly so they can show
  // both side by side and let the author compare compression loss.
  // Not consumed by the TUI (which uses tui.*).
  source?: string;
  sourceQuality?: string;
  sourceCompressed?: string;
  // web.webp / web.png — frontend-specific. Not currently consumed by
  // any built-in frontend; reserved for a future web renderer.
  web?: string;
}

// Current visual stack. `bg` is a single backdrop. `portraits` is a
// per-slot map (initial slot set = { "center" }; left/right and others
// reserved for future expansion). `cg` overlays the stage when
// non-null — galgame convention: a CG takes over the visible area.
// All values are asset paths (the AssetSpec.path key); resolve via
// PresetContext.assetMap.
export interface VisualState {
  bg: string | null;
  portraits: Record<string, string | null>;
  cg: string | null;
}

export function emptyVisualState(): VisualState {
  return { bg: null, portraits: {}, cg: null };
}

export interface StatDef {
  id: string;
  name: string;
  min: number;
  max: number;
  start: number;
  thresholds?: StatThreshold[];
}

export interface StatThreshold {
  min: number;
  label: string;
  color?: "green" | "yellow" | "red" | "cyan" | "magenta" | "white";
}

export interface TrainingConfig {
  slotsPerDay: number;
  slotNames: string[];
  startDay: number;
  maxDay: number;
  stats: StatDef[];
  decayPerDay: number;
  decayStatId: string;
  sleepActionId: string;
  huntActionId: string;
  endConditions: EndConditionSpec[];
}

export type EndConditionSpec = {
  goto?: string;
  reason: string;
  when: Condition;
};

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { scriptCompleted: string }
  // affection is the canonical character stat — `{ affection: { character,
  // min/max/eq } }` is sugar for `{ characterStat: { character, name:
  // "affection", ... } }`. Both shapes evaluate identically; kept here so
  // hand-written TS / hand-written YAML can use the short form.
  | { affection: { character: string; min?: number; max?: number; eq?: number } }
  | {
      characterStat: {
        character: string;
        name: string;
        min?: number;
        max?: number;
        eq?: number;
      };
    }
  | { switch: { name: string; eq?: boolean } }
  | {
      variable: {
        name: string;
        eq?: VariableValue;
        min?: number;
        max?: number;
      };
    }
  | { stat: { name: string; min?: number; max?: number; eq?: number } }
  | { inventory: { itemId: string; min?: number; max?: number; eq?: number } }
  | {
      weaponPower: {
        weaponId: string;
        min?: number;
        max?: number;
        eq?: number;
      };
    }
  | { knowsSkill: string }
  | { day: { min?: number; max?: number; eq?: number } }
  | { slot: { min?: number; max?: number; eq?: number } }
  | {
      selfSwitch: {
        scriptId: string;
        name: "A" | "B" | "C" | "D";
        eq?: boolean;
      };
    };

export interface StateDelta {
  // Per-character numeric stat deltas. Keyed by characterId → statName →
  // signed delta. Additive (applyDelta sums). Inline-effect syntax like
  // `+alice` desugars to `characterStats: { alice: { affection: 1 } }`.
  characterStats?: Record<string, Record<string, number>>;
  // Boolean switches. Last-write-wins (applyDelta overwrites the bit).
  switches?: Record<string, boolean>;
  // Typed variables. Numeric variables are additive (set { variables:
  // { gold: 5 } } adds 5); string variables are last-write-wins.
  variables?: Record<string, VariableValue>;
  stats?: Record<string, number>;
  statMax?: Record<string, number>;
  // Signed inventory deltas keyed by item id. applyDelta sums into
  // state.baseline.inventory and prunes any key whose result is <= 0,
  // preserving the "present key ⇔ count >= 1" invariant. Negative
  // deltas going below zero clamp to zero (key removed) rather than
  // throwing — the engine is forgiving here; handlers like consumeItem
  // do their own pre-validation for "loud" failures.
  inventory?: Record<string, number>;
  // Weapon runtime field deltas: { yaodao: { power: +2 } } adds 2 to
  // state.baseline.weapons.yaodao.power. applyDelta clamps to >= 0
  // but does not delete weapons whose power hits 0 (weapons persist
  // even at 0 power, unlike inventory items at 0 count).
  weapons?: Record<string, Partial<WeaponState>>;
  // Skill knowledge deltas. `learn: ["x"]` adds to knownSkills if not
  // already present; `forget: ["x"]` removes. Order is learn-then-forget
  // within one applyDelta call.
  skills?: { learn?: string[]; forget?: string[] };
  // Per-script self-switch flips. Keyed by scriptId. The engine
  // auto-creates the ScriptState if missing. Authors typically use
  // these for "did this branch run before" without registering a
  // global switch. Example: `selfSwitches: { my_quest: { A: true } }`.
  selfSwitches?: Record<string, Partial<ScriptState["selfSwitches"]>>;
}

export type Beat =
  | { type: "narration"; text: string }
  | {
      type: "dialogue";
      speaker: string;
      text: string;
      // Inline `@speaker emotion text` syntax: the second whitespace
      // token (when lowercase-leading) is parsed as a *candidate*
      // emotion. The engine resolves it against the character's
      // portraits map at runtime — if the key exists, the engine
      // swaps the slot the speaker already occupies (any slot whose
      // current path is one of their portrait paths), falling back to
      // "center" when they're not on stage; if not, the engine
      // prepends `candidateEmotion + " "` back onto `text` and
      // yields. This keeps the parser free of cross-file character
      // lookups.
      candidateEmotion?: string;
    }
  | {
      type: "choice";
      prompt?: string;
      options: ChoiceOption[];
      // Renderer hint. Identifies a TUI presenter (e.g. "list", "grid").
      // The engine never interprets it — pure pass-through to the
      // Output. Authors declare it via `? prompt {view: name}` in
      // markdown or the `view` field in JSON.
      view?: string;
    }
  | { type: "effects"; effects: StateDelta }
  | { type: "clear" }
  | { type: "label"; name: string }
  | { type: "endScript" }
  // Silent visual-state beats. None of these yield an Output by
  // themselves; they mutate state.baseline.visuals and the next
  // narration/dialogue/choice carries the updated VisualState. Parser
  // produces them from frontmatter (`bg:`, `defaultPortraits:`),
  // `:bg/:cg/:portrait/:clear-visuals/:hide-cg` directive lines, and
  // inline `@speaker emotion text` syntax.
  | { type: "setBg"; assetPath: string | null }
  | {
      type: "setPortrait";
      slot: string;
      // Either provide an explicit path (from `:portrait` directive)
      // OR a (characterId, emotion) pair (from `@speaker emotion`
      // inline) and let the engine resolve via the character's
      // portraits map. Engine prefers the explicit path when both
      // are present.
      assetPath?: string | null;
      characterId?: string;
      emotion?: string;
    }
  | { type: "clearVisuals" }
  | { type: "showCg"; assetPath: string }
  | { type: "hideCg" };

export interface ChoiceOption {
  text: string;
  requires?: Condition;
  effects?: StateDelta;
  goto?: string;
}

export interface Script {
  id: string;
  title: string;
  requires?: Condition;
  characters?: string[];
  beats: Beat[];
  // Calendar cost in slots when this script completes. Default 1: a
  // played script counts as a "1-slot action" for training-mode
  // calendar advance. Set to 0 for intros / cutscenes / trigger-launched
  // event scripts that shouldn't eat a player's decision window. The
  // training preset reads this via the synthetic Action it constructs at
  // script-complete.
  cost?: number;
}

export interface Action {
  id: string;
  title: string;
  description?: string;
  category?: string;
  cost: number;
  slot?: "any" | "day" | "night";
  requires?: Condition;
  effects?: StateDelta;
  // Dispatch kind. Resolved against the loaded modules' actionHandlers
  // at engine init. Bare form (`combat`) dispatches when exactly one
  // module provides that kind; qualified form (`spectral-combat:combat`)
  // is unambiguous. If absent, the engine applies action.effects
  // directly (no handler).
  kind?: string;
  // Required when kind === "useItem": id of the item this action
  // consumes. Resolved against ctx.itemMap by the bundled useItem
  // handler in baseline module.
  itemId?: string;
  // Optional: id of the enemy fought by this action. Used by combat
  // modules (game-provided) — engine does NOT dispatch on this field
  // directly. Resolved against ctx.enemyMap by combat handlers.
  enemyId?: string;
  // Required when kind === "useSkill": id of the skill this action
  // invokes. Resolved against ctx.skillMap by the bundled useSkill
  // handler in baseline module.
  skillId?: string;
  // Optional: id of a map referenced by this action. Used by modules
  // that drive a multi-map exploration loop (sengoku-raid's "depart"
  // action). Validated against game.maps[] at parse time; resolved at
  // dispatch time via ctx.mapMap.
  mapId?: string;
  // Optional: restrict this action's visibility to a set of maps.
  // When set, hub builders that scope by location (buildMapHubSnapshot
  // and equivalents) hide the action unless `state.baseline.currentMapId`
  // is one of these ids. Omitted = visible regardless of current map
  // (the existing global-action behavior). Each entry must reference a
  // declared map at parse time.
  whenIn?: string[];
  // Free-form per-action payload. Module handlers read whatever keys
  // they expect (e.g. raid:move reads `zoneId`, raid:bond reads
  // `characterId`). Used primarily by dynamically-constructed
  // HubActivities (see HubActivity.payload) but also valid on
  // statically-declared actions when a generic handler can be
  // parameterized via YAML.
  payload?: Record<string, unknown>;
  // Optional flavor narration(s) emitted when the action runs. For
  // kindless actions (those without a `kind` dispatched to a handler),
  // the engine picks one entry at random per invocation and queues it
  // into runtime.pendingNarrations alongside applying `effects`. Allows
  // YAML authors to attach simple per-action flavor without writing a
  // module handler. Actions with handlers should emit narrations via
  // their handler's ActionResult instead.
  narrations?: string[];
}

// Where a state mutation came from. Passed to onStateMutated so
// subscriber modules can filter cheaply without writing diff logic.
export type StateMutationSource =
  | "beat" // a script beat's effects: clause
  | "choice" // a chosen choice's effects
  | "action" // an action handler's returned deltas
  | "decay" // training preset's per-day decay
  | "endcondition" // an end-condition-triggered mutation
  | "trigger" // a reactive trigger's do() ActionResult deltas
  | "item" // giveItem / consumeItem / useItem-handler-produced
  | "weapon" // weapon power / properties mutation
  | "skill" // learnSkill / forgetSkill / useSkill-handler-produced
  | "external"; // anything else (manual game scripts, hot-reload, etc.)

// Reactive trigger. Modules declare a list of these; the engine
// evaluates each one's `when` after every state mutation and fires
// `do` on rising-edge transitions (was false → now true). This is the
// RPGMaker "parallel process + conditional branch" idiom condensed
// into a declarative shape: "when this state condition becomes true,
// run this small piece of code."
//
// `do` returns an ActionResult — same shape as an action handler. Its
// deltas, narrations, and customLog apply through the engine's normal
// channels. Trigger-fired mutations are tagged source="trigger" on the
// onStateMutated hook and do NOT recursively trigger other triggers
// within the same wave (to avoid infinite loops). Authors who need
// cascades chain via flags observed by another trigger.
export interface Trigger {
  // Stable identifier, unique within the module. Used to track
  // active / fired state across step() boundaries.
  id: string;
  // Reuse the existing Condition AST (alice.affection >= 5, day >= 8,
  // etc.). evaluateCondition() is exported from @rpg-harness/engine.
  when: Condition;
  // Returns an ActionResult to apply atomically when the trigger fires.
  // Receives the full PresetContext (state + game + rng + modules).
  do: TriggerHandler;
  // If true, fires at most once per game session. Future rising edges
  // are ignored. Useful for milestone events ("alice affection first
  // hits 5"). Default false: re-arms on falling edges.
  once?: boolean;
}

export type TriggerHandler = (ctx: PresetContext) => ActionResult;

export interface Module {
  id: string;
  version?: string;
  initialize?(game: Game): unknown;

  // Map of action.kind → handler. When the engine dispatches an Action
  // whose `kind` matches one of the keys, this handler is invoked.
  // Handlers MUST resolve atomically (see ActionHandler doc below).
  // Actions can reference these kinds either bare (`kind: combat`) when
  // exactly one loaded module provides them, or qualified
  // (`kind: spectral-combat:combat`) when multiple modules share a kind
  // name. The engine builds both lookup keys at construction.
  actionHandlers?: Record<string, ActionHandler>;

  // Optional self-documenting list of kinds this module provides. When
  // present, the engine checks at construction that this set matches
  // the actionHandlers keys exactly — a redundancy guard against
  // typos like `actionHandlers: { coombat: ... }` slipping through. If
  // omitted, the engine infers provides from actionHandlers keys.
  provides?: string[];

  // Reactive triggers. The engine evaluates each Trigger's `when`
  // after every state mutation; fires `do` on rising-edge transitions.
  // See Trigger doc for semantics.
  triggers?: Trigger[];

  // ============ LIFECYCLE HOOKS ============
  // All hooks fire SYNC. To emit narrations, push into
  // state.runtime.pendingNarrations — the run loop drains them on
  // subsequent steps. Do NOT yield Output from hooks (they're not
  // generators).
  //
  // Compose rules per hook (labelled in JSDoc, enforced by fireHook
  // dispatcher):
  //   - observer: every module called, returns ignored
  //   - first-wins: every module called (so downstream observers see
  //     the event), but only the first non-undefined return is used
  //   - reducer: chain transforms (prev return fed into next)

  /** observer: fires once at engine.run() entry, before any other work. */
  onSessionStart?(ctx: PresetContext): void;

  /** first-wins: return a different scriptId to redirect the selection. */
  onScriptSelect?(ctx: PresetContext, scriptId: string): string | void;

  /** observer: fires just before the first beat of a script yields. */
  onScriptStart?(ctx: PresetContext, scriptId: string): void;

  /**
   * reducer: pre-process the beat about to run. Return value:
   *   - `undefined` (or no return): use the original beat as-is
   *   - `{ replace: Beat }`: substitute the beat
   *   - `{ skip: true }`: don't yield this beat at all; advance beatIndex
   *   - `Beat` (bare): same as `{ replace: <beat> }` for ergonomic
   *     in-place edits like `{ ...beat, text: "..." }`
   */
  onBeatBefore?(
    ctx: PresetContext,
    scriptId: string,
    beatIdx: number,
    beat: Beat,
  ): Beat | { replace: Beat } | { skip: true } | void;

  /** observer: fires after each beat's input is processed (incl. skipped). */
  onBeatAfter?(
    ctx: PresetContext,
    scriptId: string,
    beatIdx: number,
    beat: Beat,
  ): void;

  /** reducer: chain transforms over the rendered options array. */
  onChoicePresented?(
    ctx: PresetContext,
    scriptId: string,
    beatIdx: number,
    options: RenderedChoice[],
  ): RenderedChoice[] | void;

  /** observer: fires after the player's choose input is processed. */
  onChoiceResolved?(
    ctx: PresetContext,
    scriptId: string,
    beatIdx: number,
    choiceIdx: number,
  ): void;

  /** observer: fires when runScript jumps into a label. */
  onLabelEnter?(
    ctx: PresetContext,
    scriptId: string,
    labelName: string,
  ): void;

  /** observer: fires after a script reaches [end] or its last beat. */
  onScriptComplete?(ctx: PresetContext, scriptId: string): void;

  /**
   * first-wins: pre-process or cancel an action dispatch. Return value:
   *   - `Action`: dispatch the returned action instead of the original
   *   - `"cancel"`: skip the dispatch entirely (action body doesn't run)
   *   - `undefined`: pass through unchanged
   */
  onActionDispatch?(
    ctx: PresetContext,
    action: Action,
  ): Action | "cancel" | void;

  /**
   * observer: fires after an action body and applyActionResult complete.
   * `result` is undefined when the engine treats a script completion as
   * a "1-slot action" for calendar bookkeeping. Replaces the
   * advanceAfterAction hook from PR #2.
   */
  onActionComplete?(
    ctx: PresetContext,
    action: Action,
    result: ActionResult | undefined,
  ): void;

  /**
   * observer: fires after every applyDelta-style mutation. `source`
   * lets subscribers filter without diffing state. High-volume — keep
   * implementations cheap.
   */
  onStateMutated?(
    ctx: PresetContext,
    delta: StateDelta,
    source: StateMutationSource,
  ): void;

  /**
   * first-wins: provide a hub Output for the current state. Used by
   * presets that have a hub (e.g. training). Replaces the
   * buildHubOutput hook from PR #2.
   */
  onHubBuild?(ctx: PresetContext): Output | undefined;

  /** observer: fires when an end-condition first matches and triggers. */
  onEndConditionFire?(
    ctx: PresetContext,
    ec: EndConditionSpec,
  ): void;

  /** observer: fires when one narration is shifted off the queue. */
  onNarrationDrain?(ctx: PresetContext, text: string): void;
}

// ActionHandler invariant: must resolve ATOMICALLY. The handler computes
// the entire outcome of the action (rolls, branches, state mutations,
// narration text) and returns it as a single ActionResult. The engine
// then applies deltas and enqueues narrations. The handler MUST NOT
// yield through multiple steps via persisted in-memory state — that
// pattern broke combat-in-step mode before this refactor. If your
// action needs multi-step narrative pacing, push the lines into
// `narrations` and the engine's main loop will drain them one per step.
export type ActionHandler = (ctx: ActionContext) => ActionResult;

export interface ActionContext {
  state: ComposedState;
  action: Action;
  game: Game;
  // Inject randomness here so handlers can be tested deterministically.
  rng: () => number;
}

export interface ActionResult {
  // Narration lines shown one-at-a-time, in order, on subsequent steps.
  narrations?: string[];
  // Aggregated state changes; the engine calls applyDelta(state, deltas).
  deltas?: StateDelta;
  // Optional opaque payload appended to a module-owned log array at
  // state[moduleId].log[]. Useful for combat logs, debug traces, etc.
  customLog?: { moduleId: string; entry: unknown };
}

export interface Game {
  title: string;
  characters: CharacterDef[];
  scripts: Script[];
  // Declared switches (boolean) — engine pre-populates baseline.switches
  // from `initial`. References in conditions / effects are validated
  // against this declared set at parse time.
  switches?: SwitchDef[];
  // Declared variables (string | number) — engine pre-populates
  // baseline.variables from `initial`.
  variables?: VariableDef[];
  actions?: Action[];
  // Engine-level item registry — see ItemDef. Empty / absent for games
  // that declare no items/ directory.
  items?: ItemDef[];
  // Engine-level enemy registry — see EnemyDef. Empty / absent for
  // games that declare no enemies/ directory.
  enemies?: EnemyDef[];
  // Engine-level weapon registry — see WeaponDef. Empty / absent for
  // games that declare no weapons/ directory.
  weapons?: WeaponDef[];
  // Engine-level skill registry — see SkillDef. Empty / absent for
  // games that declare no skills/ directory.
  skills?: SkillDef[];
  // Engine-level map registry — see MapDef. Empty / absent for games
  // that declare no maps/ directory.
  maps?: MapDef[];
  // Visual asset registry — see AssetSpec. Empty / absent for games
  // that declare no assets/ directory. Scripts reference entries by
  // their `path` (a forward-slash relative path from game dir).
  assets?: AssetSpec[];
  training?: TrainingConfig;
  modules?: Module[];
  // Preset selector. Either a built-in name ("vn" / "training") or a
  // relative path the loader resolved via dynamic import. When set as
  // a path, the loader fills `runFn` directly.
  preset?: string;
  // Resolved RunFunction (set by CLI loader after a path-based preset
  // is imported). Engine prefers this over the built-in lookup.
  runFn?: RunFunction;
}

export interface ScriptInfo {
  id: string;
  title: string;
}

export interface RenderedChoice {
  text: string;
  available: boolean;
  lockedReason?: string;
}

export interface HubActivity {
  id: string;
  // High-level activity type. "script" dispatches via
  // baseline.currentScriptId; "action" dispatches via the action
  // handler registry (either a preregistered Action in game.actions
  // OR — when actionKind is set — a synthetic Action with that kind
  // + payload). This is the dispatch-protocol layer; actionKind is
  // the handler-resolution layer.
  kind: "script" | "action";
  title: string;
  description?: string;
  category?: string;
  cost: number;
  effectsHint?: string;
  available: boolean;
  lockedReason?: string;
  // Module-supplied action handler kind for dynamic activities that
  // don't have a preregistered Action in game.actions. The engine
  // synthesizes an Action { id, title, kind: actionKind, payload, ...}
  // and routes it through the standard dispatchActivity path. Only
  // meaningful when kind === "action".
  actionKind?: string;
  // Free-form params passed to the handler (via Action.payload). Used
  // when the same actionKind is dispatched with different per-activity
  // parameters (e.g. `raid:move` with a `zoneId` payload).
  payload?: Record<string, unknown>;
}

export interface StatSnapshot {
  id: string;
  name: string;
  value: number;
  min: number;
  max: number;
  thresholds?: StatThreshold[];
}

export interface HubSnapshot {
  day: number;
  maxDay: number;
  slot: number;
  slotName: string;
  slotsPerDay: number;
  stats: StatSnapshot[];
  affections: Array<{ id: string; name: string; value: number }>;
  activities: HubActivity[];
}

export type Output =
  | {
      type: "narration";
      text: string;
      visualState?: VisualState;
      // Number of narrations remaining in the pending queue, INCLUDING
      // the one being yielded right now. 1 means "this is the last
      // one"; 5 means "this one plus four more queued". Lets AI players
      // and UI renderers know to keep advancing with `next` rather
      // than submitting other input — drainNarrations re-yields the
      // same narration on non-next input, which used to be a silent
      // footgun. Absent on engines built before this field landed.
      pendingCount?: number;
    }
  | {
      type: "dialogue";
      speakerId: string;
      speakerName: string;
      text: string;
      visualState?: VisualState;
    }
  | {
      type: "choice";
      prompt?: string;
      options: RenderedChoice[];
      // Passthrough of ChoiceBeat.view — see Beat definition above.
      view?: string;
      visualState?: VisualState;
    }
  | {
      type: "scriptComplete";
      completedId: string | null;
      nextAvailable: ScriptInfo[];
      visualState?: VisualState;
    }
  | { type: "hubMenu"; snapshot: HubSnapshot; visualState?: VisualState }
  | { type: "gameEnd"; reason?: string; visualState?: VisualState }
  | { type: "clear"; visualState?: VisualState };

export type Input =
  | { type: "next" }
  | { type: "choose"; index: number }
  | { type: "select"; scriptId: string }
  | { type: "doActivity"; id: string }
  | { type: "quit" };

export const END_LABEL = "$end";

// Context object threaded through preset run functions and primitives.
// Engine constructs this once per run; primitives accept it as their
// sole non-input argument so they can be tested in isolation without
// instantiating an Engine.
export interface PresetContext {
  state: ComposedState;
  game: Game;
  modules: Module[];
  // Aggregated action handler registry (action.kind → handler), built
  // once from all modules' actionHandlers. Duplicate kinds error at
  // construction time.
  actionHandlerRegistry: Record<string, ActionHandler>;
  // Aggregated trigger list (all modules.triggers concatenated in
  // declaration order). Trigger ids must be unique across all modules.
  triggerRegistry: Trigger[];
  // Precomputed lookup maps; cheap convenience, not authoritative.
  scriptMap: Map<string, Script>;
  actionMap: Map<string, Action>;
  itemMap: Map<string, ItemDef>;
  enemyMap: Map<string, EnemyDef>;
  weaponMap: Map<string, WeaponDef>;
  skillMap: Map<string, SkillDef>;
  mapMap: Map<string, MapDef>;
  // AssetSpec.path → AssetSpec. Used by the engine to resolve
  // `setPortrait` emotion → path lookups and by headless presenters
  // to attach placeholder text alongside asset paths.
  assetMap: Map<string, AssetSpec>;
  characterNameMap: Map<string, string>;
  // Injected RNG. Defaults to Math.random; tests can override for
  // deterministic combat / choice outcomes.
  rng: () => number;
}

// A preset's main loop. Engine.run() resolves which one to call based
// on game.preset (or auto-detection from game.training presence).
export type RunFunction = (
  ctx: PresetContext,
) => AsyncGenerator<Output, void, Input>;
