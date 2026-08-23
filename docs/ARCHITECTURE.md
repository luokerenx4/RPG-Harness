# Architecture

RPG-Harness is a "headless RPGMaker" — a small engine that runs games defined as folders of markdown + YAML. The engine yields semantic events; a frontend renders them. The same game folder runs in a terminal, in a browser, and inside a headless test harness.

## The three layers

```
┌──────────────────────────────────────────────────────────┐
│  Engine  (@rpg-harness/engine)                                │
│  ─ Owns standard resource schemas (characters, items,     │
│    enemies, weapons, skills) and standard state slots.    │
│  ─ Owns primitives: runScript, dispatchActivity,          │
│    mutateState, checkTriggers, fireOn*, give/consumeItem, │
│    equipWeapon, learnSkill, …                             │
│  ─ Defines the Condition DSL, StateDelta, the Module      │
│    interface (action handlers + 15 lifecycle hooks +      │
│    reactive triggers), and the PresetContext that         │
│    threads through everything.                            │
│  ─ Does NOT decide what a "day" is, what a "battle" is,   │
│    what the hub looks like, or what an ending is.         │
└────────────────────────┬─────────────────────────────────┘
                         │ Output / Input via AsyncGenerator
┌────────────────────────┴─────────────────────────────────┐
│  Preset  (@rpg-harness/engine/presets OR ./preset/run.ts)     │
│  ─ Owns the main loop. Composes engine primitives into a  │
│    genre-shaped play flow.                                │
│  ─ Two are bundled: `vn` (visual-novel, linear scripts)   │
│    and `training` (calendar + hub + actions + endings).   │
│  ─ A game can pick a bundled preset by name OR ship its   │
│    own run.ts (the "ejected" form).                       │
└────────────────────────┬─────────────────────────────────┘
                         │ consumes engine APIs
┌────────────────────────┴─────────────────────────────────┐
│  Game folder                                              │
│  ─ Pure content + optional gameplay modules.              │
│  ─ Standard resources go in standard directories          │
│    (characters/ items/ enemies/ weapons/ skills/          │
│    scripts/ actions/). Engine parses and types them.      │
│  ─ Custom mechanics ship as modules (action handlers +    │
│    hooks + triggers + their own state namespace).         │
└──────────────────────────────────────────────────────────┘
```

Same engine + same game folder + different frontend → same game, different shell.
Same engine + different game folder + same frontend → different game, same shell.

## Engine main loop

The engine is exposed as an `AsyncGenerator<Output, void, Input>`. The preset's `run.ts` is the loop body; `Engine.run()` is a one-liner that yields from it.

```ts
const engine = new Engine(game);
const loop = engine.run();
let input: Input = { type: "next" };
while (true) {
  const { value: output, done } = await loop.next(input);
  if (done) break;
  await frontend.render(output);
  input = await frontend.read(output);
}
```

The engine doesn't know whether the output ends up in a terminal, a browser, or a JSON stream. That is the frontend's job.

Choice inputs have two compatible forms. Human renderers may submit the current
presentation index (`{ type: "choose", index: 1 }`). Automation should submit
the authored identity (`{ type: "choose", choiceId: "route", optionId:
"friends" }`), which the engine resolves against the currently yielded choice.
A stale choice id, missing option id, locked option, or payload that mixes both
forms fails closed and re-yields the same choice.

The stateless `step()` wrapper classifies every submitted input against the
current public Output before delivering it to the generator. Its
`StepResult.inputResult` is the machine-readable acceptance contract used by
Headless clients and persisted CLI logs. Rejections preserve the normalized
peek state and return the same Output. Presets and core dispatchers repeat
authorization-sensitive checks (script requirements, current hub membership,
map-connection gates) so direct `Engine.run()` consumers cannot bypass them.
The Web shell applies the same classifier before advancing its long-lived
generator, persists accepted and rejected `inputResult` values through the
shared-session bridge, and displays rejection messages without replacing the
current stage. Its choice stage preserves stable identity so authored
`choiceId` / `optionId` values reach the same decision log used by Headless.

## Frontends

A frontend is whatever consumes the `Output` stream and produces `Input`. Two ship today, and they share more than the engine:

- **`@rpg-harness/frontend-core`** owns the renderer-agnostic middle: a pure reducer (`applyOutput` / `applyUiAction`) that projects the `Output` stream into a stable `ScreenModel` — exactly one current stage (what the player looks at now) plus a capped backlog and the persistent visual stack. Neither React nor ink nor the DOM appears here; it depends only on engine types.
- **`@rpg-harness/cli`** renders that ScreenModel with ink, reads the keyboard, loads games from the filesystem, and saves sessions to disk.
- **`@rpg-harness/web`** renders the *same* ScreenModel with React DOM, reads clicks, and — because the engine is a pure no-Node state machine — bundles the engine into the page itself (the way a web console emulator bundles its core into JS). Games are baked at build time via `import.meta.glob` (`loadGame.ts` is the browser twin of the CLI's fs loader); saves go to localStorage. The result is a static site: one `vite build`, deploy anywhere, no backend.

So the axes are orthogonal: **engine** (one, shared) × **renderer** (ink | DOM, both over `frontend-core`) × **game-delivery seam** (fs loader | build-time bake). Same game folder + different renderer → same game, different shell. See `packages/web/README.md` for the web specifics.

## Two play modes

Both modes go through the same engine, but they wrap it differently:

| Mode      | Where                              | Generator lifetime           | Use                           |
| --------- | ---------------------------------- | ---------------------------- | ----------------------------- |
| `runLoop` | `rpgh play`, fixtures, autoplay | One engine, many `.next()`s  | Interactive / scripted replay |
| `step`    | AI playtester, batch evaluators    | Fresh engine per call        | Stateless query: state in, output(s) + state out |

`step` mode is why **ActionHandlers must resolve atomically** (see "Invariants" below) — if a handler yielded mid-resolution, the second call would create a fresh generator and lose the in-flight state.

Autoplay opts into `runLoop`'s exact stall detector. It fingerprints the full
composed engine state together with the public `Output` after each visible
step, finds the shortest repeated suffix, and stops after three repetitions.
The detector is caller-controlled and off for fixtures/ordinary `runLoop`
consumers. A `stalled` result includes the cycle's inputs and compact outputs,
which `--report-on-stop` persists as coding-issue evidence.
At a decision-budget stop, the same bounded suffix window is also checked with
state excluded from the behavioral fingerprint. If inputs and outputs repeat
while state differs, the result keeps `reason: max-steps` but attaches a
`behaviorCycle` and the changed state paths. This separates true fixed-point
deadlocks from pseudo-progress such as a turn counter increasing during a map
oscillation.

`rpgh audit` is a CLI orchestration layer over this contract, not another game
runner. It validates a source checkpoint and all `${prefix}-${persona}` target
sessions up front, captures the source state once under its session lock, then
creates every branch from that in-memory content-addressed snapshot before
calling persisted `runAutoplay` lanes sequentially. Each
lane retains ordinary fork provenance, checkpoints, reports, transcript, and
Web query path; the command returns only a compact cross-lane matrix. This keeps
the audit start point stable even if the player/GUI branch advances concurrently,
while making regression sweeps executable by a later coding agent without
bespoke shell loops.
The compact matrix does not equate an ending with a route. `runAutoplay`
content-addresses the accepted semantic inputs (`choose` by authored identity,
`select` by script id, and `doActivity` by activity id plus its `aiTags`), while
`audit` reports unique path and ending counts, executed activity-tag coverage,
distinct semantic pacing events, raw accepted activity totals, and
persona-grouped stable-choice divergences. Activities can share a stable
`pacingInstanceId` when several actions belong to one encounter or transaction;
an omitted id deliberately counts every dispatch as a separate pacing event.
A project may require critical
activity tags and newly completed script ids in `ai_audit`, turning skipped
gameplay surfaces or unreachable deep authored events into replayable
quality-gate work instead of trusting path hashes as an indirect proxy.
This lets autonomous development distinguish intentional narrative convergence
from a policy matrix that never made meaningfully different decisions.
Project certification also runs author-declared `fuzz_personas` as a separate
seeded survival matrix. Those lanes must reach authored terminal outputs within
the shared segmented budget without errors or rejected inputs, but do not
participate in strategy diversity or repetition scoring. Their exact seed,
decision count, path revision, GUI session, and ending remain certificate
evidence, so stochastic exploration is reproducible rather than anecdotal.
Playable branches created by the structured `work` executor also persist a small
development handoff next to their fork provenance. It names the stable work
item, priority, intent, source coordinate, operation, and readiness state; the
Web bridge exposes it read-only and the GUI renders it in the HUD. This closes
the human/agent handoff: Headless can prepare an exact coding-issue scene while
the player understands why that isolated save exists before making the next
choice.
Stable choice coordinates in that handoff also let the bridge project a live
outcome from the session log after the player answers. The fork metadata stays
immutable, the GUI shows the selected authored option, and Headless coverage
consumes the same decision record—there is no parallel “completed” flag to
drift away from replay evidence.
Player-authored feedback uses the same issue boundary in the opposite direction.
The development Web shell posts a small classification and comment to the local
bridge; the bridge invokes the public Headless `report` command for the active
session. Report capture owns the session transaction, so GUI feedback cannot mix
a later save with an earlier log event. No separate browser feedback database is
introduced: `issues.jsonl` plus its content-addressed checkpoint is the durable,
reproducible input consumed by the AI worklist.
The final `sweep --until-clean` acceptance is also persisted as a project
quality certificate. Its input revision covers authored behavior plus the
Headless engine, parser, session-store, CLI evaluator, Web GUI/input bridge,
and exact matrix inputs.
Issuance also executes the current React controls for narration, stable choices,
hub activities, and script selection. Their renderer-neutral `Input` evidence is
content-addressed inside the certificate; a Headless-only pass cannot mint green
status when the GUI dispatch contract is broken.
It also records the Bun/Node/platform/architecture execution identity in the
input digest, so a local certificate is never silently promoted across unlike
runtimes.
Consequently an unchanged clean loop is cheap and creates no new lane sessions,
while either a game, Headless evaluator, or GUI evaluator edit invalidates the verdict instead of
silently inheriting green status. The certificate is a local derived artifact;
`--force-audit` provides an explicit full rerun when environmental validation is
more important than reuse.
`rpgh project-status` is the compact projection consumed by CI, agents, and the
local Web HUD: global work counts, next priority, and the current certificate
identity. The dev session bridge invokes that CLI boundary and invalidates its
cache from authored/runtime/evidence file events, so GUI and Headless share the
development loop without duplicating orchestration rules or polling the entire
session archive continuously.
Hub objectives carry explicit author intent rather than naming conventions:
`scope` is `main`, `side`, or `mastery`, and `terminal` says whether taking the
linked activity may conclude the run. `Engine.run()` validates objective ids,
requirements, enum values, and same-snapshot activity links before any renderer
or agent sees the output. `frontend-core` then derives one shared guidance model
for Web, TUI, and Headless clients: one author-declared active `focus` objective
takes precedence, followed by an executable active main objective and authored
recommendations, without collapsing multiple valid
links into an arbitrary automatic choice. Built-in and module personas consume
the same fields, so objective ordering and `ending_*`-style ids are not policy.

Choice options may expose open `aiTags` alongside gates, consequences, and the
numeric objective priority. The engine treats this vocabulary as data rather
than policy: human renderers need not display it, generic personas can recognize
a small tag subset, and LLM or game-specific agents can consume the rest. When
stable choice identities are available, built-in personas submit those ids
instead of presentation indexes, keeping authored intent invariant under UI
reordering.
Authors can keep ordinary branches concise with
`- Label {id: stable-option, ai: social loyal}`; complex fenced YAML choices
express the same contract as `ai_tags: [social, loyal]`. Both forms share the
same stable-tag validation and produce identical engine output.
The authored-choice inventory reports semantic coverage independently of
runtime branch coverage. A stable multi-option choice is `complete` only when
every stable option declares at least one tag (`neutral` is an explicit valid
intent); partial and wholly missing choices become source-located
`annotate-choice-intent` work items for the next development agent.
`rpgh probe-choice` closes the authoring feedback loop without creating another
runtime branch. It loads an immutable session checkpoint, runs the current game
to its next output in memory, and asks the same deterministic choice-policy
function used by autoplay to explain each persona's decision. Reporting both
the stored and evaluated state revisions makes hot script migration observable;
the source session tree remains byte-for-byte unchanged. Policy explanation and
execution therefore cannot drift into separate implementations.

## Standard resources (the database)

The shared Resource Registry indexes the game manifest, characters, items,
enemies, weapons, skills, maps, actions, scripts, visual assets, and modules with canonical
`<kind>:<id>` keys. Six of these are stateful gameplay resource schemas with a
dedicated `BaselineState` contract:

| Resource     | Def type      | Game directory  | Runtime state                                              | Condition operators           | Bundled action handler |
| ------------ | ------------- | --------------- | ---------------------------------------------------------- | ----------------------------- | ---------------------- |
| Character    | `CharacterDef` | `characters/`   | `baseline.characters[id] = { affection, custom }`          | `affection`                   | —                      |
| Item         | `ItemDef`     | `items/`        | `baseline.inventory[id] = count`  (key absent ⇔ 0)         | `inventory`                   | `kind: useItem`        |
| Enemy        | `EnemyDef`    | `enemies/`      | (read-only; modules consume)                               | —                             | (modules)              |
| Weapon       | `WeaponDef`   | `weapons/`      | `baseline.weapons[id] = { power }` + `equippedWeaponId`    | `weaponPower`                 | —                      |
| Skill        | `SkillDef`    | `skills/`       | `baseline.knownSkills: string[]` (deduped)                 | `knowsSkill`                  | `kind: useSkill`       |
| Map          | `MapDef`      | `maps/`         | `baseline.currentMapId` + optional `runtime.mapPosition` | (`Action.whenIn` map filter)  | `kind: moveToMap`      |

Invariants enforced by `applyDelta`:
- `inventory[id]` is deleted when it reaches ≤ 0 (no zero-count keys).
- `weapons[id].power` is clamped at 0 (no negative power).
- `knownSkills` is deduped on insert; absent ⇔ unlearned.

Resources are append-only at load time: the engine never mutates `ItemDef`/`EnemyDef`/`WeaponDef`/`SkillDef` objects. State mutations only ever touch `state.baseline.<slot>`.

Every Def also carries an optional `custom?: Record<string, unknown>` populated at parse time from any frontmatter key the parser doesn't recognize (via `extractCustom()` in `packages/parser/src/frontmatter.ts`). Game modules read game-specific metadata via `item.custom.sell_value` or `enemy.custom.attack_power`; the engine doesn't interpret it. This keeps the engine's `Def` shape minimal (only fields every game needs) while letting individual games attach arbitrary numbers, strings, and tags directly in the .md source-of-truth file instead of mirroring them in module-side lookup tables.

## Maps (the location and resource-container axis)

A map is a spatially-capable **container for resources and events**, scoped to
"where the player is right now." The engine owns
`state.baseline.currentMapId`; modules read that first-class location instead
of inventing private mode/location slots.

`layout` and `placements` are optional. Omitting `layout` produces the compact
era-style node projection, but it does not select another map system. Node-map
resources may all share logical coordinate `[0,0]`; a 2D author can instead
declare dimensions, layers, regions, collision, and real positions. Hub, TUI,
Headless, and 2D Web all consume the same placement events through
`collectMapAvailableResources(ctx)`.

```yaml
# maps/town.yaml — one spatial map resource
id: town
name: 街
description: 涩谷·西早稲田。
bg: assets/backgrounds/town
layout:
  width: 20
  height: 12
  tile_width: 32
  player_start: [2, 10]        # persisted Web grid cursor; Headless ignores it
  tile_height: 32
  tileset: assets/tilesets/town
  layers:
    - { id: ground, kind: tile, z: 0 }
    - { id: actors, kind: object, z: 10 }
  regions:
    - { id: station, x: 15, y: 8, width: 4, height: 3 }
placements:
  - id: school_gate
    at: [3, 1]
    layer: actors
    resource: { kind: map, id: lab }
    collision: trigger
    events:
      - { id: move, trigger: player_touch, label: 校园 }
  - id: alice
    at: [8, 5]
    layer: actors
    facing: south
    resource: { kind: character, id: alice }
    events:
      - { id: talk, trigger: interact, label: 話す, run: { kind: script, id: meet_alice } }
  - id: arrive_town
    at: [0, 0]
    visible: false
    resource: { kind: script, id: arrive_town }
    events:
      - { id: run, trigger: map_enter, order: -100 }
encounter_table:               # optional — modules roll on entry
  - { enemy: null, weight: 1 }
loot_table:                    # optional
  - { item: ryo, min: 8, max: 16, weight: 50 }
chain: shibuya                 # optional grouping (no engine semantics)
```

`layout` is renderer-neutral authoring data. `placements` may reference a map,
character, item, enemy, weapon, skill, action, script, asset, module, or custom
resource. Placement and event IDs are stable diagnostic/replay coordinates;
multiple placements may intentionally overlap.

### Directed routes and arrival

A map placement event whose effective resource is a map is one directed route.
The destination map identity remains the resource reference: `event.run` when
present, otherwise the containing placement's `resource`. `arrival` only
describes where the spatial cursor starts inside that target; it never supplies
or overrides the target map ID.

```yaml
placements:
  - id: castle_gate
    at: [3, 1]
    resource: { kind: map, id: castle }
    events:
      - id: enter
        trigger: player_touch
        arrival: { placement: south_gate_entry }

  - id: cellar_stairs
    at: [12, 8]
    events:
      - id: descend
        trigger: interact
        run: { kind: map, id: cellar }
        arrival: { at: [4, 7] }
```

`arrival: { placement: ... }` names a stable placement in the target map and
uses that placement's `at` coordinate. `arrival: { at: [x, y] }` names an exact
cell and therefore requires the target to declare a spatial `layout`; the cell
must fit inside it. A layout-less node map may use a placement anchor but not an
explicit coordinate anchor. Omitting `arrival` preserves the ordinary target
entry behavior: `layout.player_start`, falling back to `[0,0]`.

Headless observes the same route identity, gate, accepted input, and resulting
`currentMapId`, but does not simulate or choose by the arrival coordinate. The
coordinate exists for persisted spatial state and human renderers. Routes are
directed runtime edges: authoring A → B does not infer B → A.

Legacy `connections` and `on_enter` still parse during migration. `rpgh
migrate-maps <game-dir> --apply` converts edges and entry scripts to placements
at `[0,0]` without inventing a layout. New content should author placements
directly.

### How a map scopes every projection

Two hub-building paths exist; both honor `currentMapId`:

- **`collectMapAvailableResources(ctx)`** is the renderer-neutral source. It evaluates placement/event conditions, keeps stable resource/event keys, and emits semantic activities for map, action, and script bindings without simulating a visual avatar.
- **`buildMapHubSnapshot(ctx)` / `collectMapActivities(ctx)`** project that query into Hub activities; global actions remain filtered by `Action.whenIn`, while `exposure: placed` keeps an action out of the ambient list until a placement references it.
- **Training preset hub** — same filtering layered on top of slot / scripts. Games using `training:` config get map-scoping for free.

The Web 2D shell may additionally submit `moveMap`. `moveMapPlayer(ctx, dir)`
updates the persisted `runtime.mapPosition`, enforces layout bounds and blocking
footprints, and maps a `player_touch` collision back to the already-published
Hub activity. This renderer input is intentionally absent from Headless
`expected` semantic choices: an AI still operates the map as one node.

`map_enter` fires once per map visit. `autorun` fires once when its condition
becomes true during that visit. Both use the same deterministic activity
dispatcher and are never exposed as player buttons. `parallel` and namespaced
triggers are extension contracts for a preset/module-owned scheduler; core does
not invent an unbounded per-frame loop.

A game module that owns its own `onHubBuild` can call `collectMapActivities` and layer on game-specific entries (companion HP, depart-to-chain buttons, etc.).

### `enterMap` and `moveToMap`

Two engine-owned entrypoints for transitioning:

- **`enterMap(state, game, mapId, arrival?)`** — primitive any preset/module can
  call. It validates and resolves the complete destination before changing
  state, sets `currentMapId`, initializes the target's authoritative player
  position from the optional route arrival or `player_start`, and syncs
  `baseline.visuals.bg` to `map.bg` when present. Legacy `map.onEnter` remains
  transitional; new content uses a `map_enter` event placement.
- **`kind: "moveToMap"`** — bundled action handler in the baseline module. It
  resolves the exact authored route from `payload.to` plus its stable route key,
  rechecks the route gate, and passes that route's arrival to `enterMap`. This is
  what engine-synthesized map activities dispatch through.

Games with side-effects-on-move (raid turn count, companion passives, encounter rolls) provide their own action handler and observe via `onActionComplete` — the engine's `moveToMap` is the simple-game default, not a mandatory channel.

### Modules that want map context

Read `state.baseline.currentMapId` directly. Read the static `MapDef` via `ctx.mapMap.get(id)` or `game.maps?.find(...)`. Treat current-map as a normal observable axis the way you'd treat `day` / `slot` in training mode — including in trigger `when:` clauses (compose via `switch`/`variable` mirrors if you need to gate on it).

## Engine primitives

`packages/engine/src/primitives/` exposes the building blocks the preset loop and modules call. Each takes `PresetContext` and is side-effect-free except where named otherwise.

- `runScript(ctx, script)` — yield script beats, handle choice + effects, return on end.
- `drainNarrations(ctx)` — empty `runtime.pendingNarrations` as dialogue/narration outputs.
- `dispatchActivity(ctx, id)` — route a `doActivity` to a script or an action; action goes through registered handler.
- `applyActionResult(ctx, result)` — apply handler's `ActionResult` (deltas + narrations + scriptStart).
- `mutateState(ctx, delta, source)` — `applyDelta` + `fireOnStateMutated` + `checkTriggers`. The one true write path.
- `enterMap(state, game, mapId, arrival?)` — transition the player into a map,
  optionally resolving a target placement or exact spatial cell (writes
  `currentMapId`, syncs visuals, queues `onEnter` script).
- `collectMapAvailableResources(ctx)` — query the current map's placement resources and semantic operations.
- `moveMapPlayer(ctx, direction)` — update authoritative spatial position, enforce collision, and resolve player-touch to a semantic activity.
- `buildMapHubSnapshot(ctx)` / `collectMapActivities(ctx)` — project the shared query into Hub activities.
- `checkEndConditions(ctx)` — evaluate `game.training.endConditions` in order.
- `checkTriggers(ctx)` — rising-edge evaluation across all registered triggers.
- `fireOnXxx(ctx, ...)` — 15 hook dispatchers (see "Hooks").
- `giveItem` / `consumeItem` / `hasItem`.
- `equipWeapon` / `getWeaponPower` / `setWeaponPower`.
- `learnSkill` / `knowsSkill`.

The engine main loop is gone: `Engine.run()` just yields from `runFn(ctx)`, where `runFn` is the resolved preset run function.

## The Module interface

```ts
interface Module {
  id: string;
  version: string;
  initialize?(ctx): void;
  actionHandlers?: Record<string, ActionHandler>;
  triggers?: Trigger[];

  // 15 lifecycle hooks — see below.
  onSessionStart?(ctx): void;
  onScriptStart?(ctx, scriptId): void;
  onScriptComplete?(ctx, scriptId): void;
  onBeatEnter?(ctx, beat): BeatOverride | void;
  onChoicePresented?(ctx, choices): Choice[] | void;
  onChoiceResolved?(ctx, scriptId, beatIdx, choiceIdx, resolution): void;
  onActionDispatch?(ctx, action): "cancel" | void;
  onActionComplete?(ctx, action, result): void;
  onStateMutated?(ctx, delta, source): void;
  onHubBuild?(ctx): HubOutput | void;
  onTriggerFire?(ctx, trigger): void;
  onEndConditionFire?(ctx, end): void;
  onError?(ctx, err): void;
  onSave?(ctx): Record<string, unknown> | void;
  onLoad?(ctx, snapshot): void;
}
```

`onChoiceResolved` keeps `choiceIdx` for presentation-local and legacy module
logic, but `resolution.choiceId` / `resolution.optionId` are the durable
semantic keys. Any module that writes narrative memory or another persisted
consequence must prefer the stable ids: option order is authoring presentation
and may change during live AI edits without changing the player's intent.

### Compose strategies

Hooks compose differently depending on what they're for:

- **Notify-all** (most hooks): every module that defines the hook gets called. No return value.
- **First-wins** (`onHubBuild`, `onBeatEnter`, `onChoicePresented`): modules are polled in order; the first to return a non-`void` value wins, but the rest of the modules are still notified for observation purposes (e.g. analytics / debug modules can watch hub builds without claiming them).
- **Veto** (`onActionDispatch`): any module returning `"cancel"` short-circuits dispatch.

### ActionHandlers (the atomic invariant)

```ts
type ActionHandler = (ctx, action, payload?) => ActionResult;

interface ActionResult {
  deltas?: StateDelta;          // applied once, atomically
  narrations?: string[];        // pushed onto runtime.pendingNarrations
  scriptStart?: string;         // sets baseline.currentScriptId
}
```

Hard rule: **handlers do not yield**. They compute an `ActionResult` and return. The preset loop applies it via `applyActionResult` and drains narrations on subsequent steps. This is what lets `step` mode rebuild engines cheaply.

If a handler needs multi-step output (a combat with three lines of flavor text), it queues all the narrations at once into `result.narrations`. The main loop's `drainNarrations` releases them one per step.

## Reactive triggers

```ts
interface Trigger {
  id: string;
  when: Condition;
  do: (ctx) => TriggerEffect;
  once?: boolean;
}
```

Triggers are evaluated by `checkTriggers(ctx)`, which is called by `mutateState` after every state delta. They use **rising-edge detection**: a trigger fires when its `when` transitions false→true. `state.runtime.activeTriggers` records which triggers were true on the last check; `state.runtime.firedTriggers` records ones with `once: true` that already fired.

Cascade is bounded: `checkTriggers` runs until no new trigger fires in a pass (or hits a safety cap). A trigger's `do` returns `{ deltas?, narrations?, output? }`; deltas go through `mutateState` (which re-evaluates triggers — hence the cascade).

This is what lets games declare "when sword_power reaches 10, learn purify" without polling every frame.

## Condition DSL

Conditions are declarative trees, not embedded code — statically validatable, AI-author-friendly, never `eval`-ed.

```yaml
requires:
  all:
    - scriptCompleted: "001_meeting"
    - affection: { character: alice, min: 3 }
    - inventory: { itemId: talisman, min: 1 }
    - weaponPower: { weaponId: yaodao, gte: 10 }
    - knowsSkill: purify
    - stat: { name: spectral, lt: 50 }
```

Full grammar lives in `packages/engine/src/types.ts` (the `Condition` union) and `packages/engine/src/condition.ts` (the evaluator). Parser-side mirror in `packages/parser/src/condition.ts`.

Conditions have two projections. Headless outputs retain the exact `requires`
tree so an AI can plan and repair against stable ids. Player surfaces render a
separate `lockedReason`, derived from the same tree. Give switches, variables,
and character stats author-facing `label` metadata to keep that explanation in
the game's voice; resource names and script titles are resolved automatically:

```yaml
# game.yaml
switches:
  learnedChinkonho: { initial: false, label: 「鎮魂法」を習得 }

# characters/kagari.md frontmatter
stats:
  affection: { initial: 0, label: 親密度 }
```

An explicit `lockedHint` still takes precedence when a gate needs bespoke
wording. Labels and hints never replace the machine-readable condition.

Activity consequences follow the same split. `effectsHint` is compact machine
evidence for Headless candidates and AI persona scoring; it may contain stable
resource ids and is not player prose. Human shells render `description` plus
structured `forecast` metrics instead. Authors who need an extra visible line
should put it in `description`, never overload the AI hint.

Forecast `unit` values are likewise stable machine identifiers retained by
Headless clients. Player shells format shared semantic units centrally
(`percent`, `HP`, and inventory `item` gains); unknown ids stay hidden unless
the author supplies an explicit player-facing `unitLabel`.

Forecast density is also authored, not inferred by each renderer. Metrics with
`playerDisplay: detail` remain lossless in Headless output and captured coding
issues, while the shared Web/TUI projection omits them from the default action
row. Keep three or four decision-defining metrics primary and reserve derived
breakdowns, zero-value proc chances, and post-outcome diagnostics for detail.

## State model

State is plain JSON. No class instances, no functions, no `Date`s, no `Map`s. Survives `JSON.stringify` round-trip without loss.

```ts
interface GameState {
  baseline: {
    characters: Record<string, { stats: Record<string, number>; custom: Record<string, unknown> }>;
    switches: Record<string, boolean>;             // declared in game.yaml `switches:`
    variables: Record<string, string | number>;    // declared in game.yaml `variables:`
    scripts: Record<string, ScriptState>;          // { completed, selfSwitches: A/B/C/D }
    completionOrder: string[];                     // append-only audit log
    currentScriptId: string | null;
    beatIndex: number;
    inventory: Record<string, number>;             // key absent ⇔ count 0
    currentMapId: string | null;                   // where the player is
    weapons: Record<string, { power: number }>;
    equippedWeaponId: string | null;
    knownSkills: string[];
    visuals: { bg: string | null; portraits: Record<string, string | null>; cg: string | null };
  };
  training?: {
    day: number;
    slot: number;
    stats: Record<string, number>;
    statMax: Record<string, number>;
  };
  runtime: {
    pendingNarrations: string[];
    activeTriggers: string[];
    firedTriggers: string[];
    firedScriptStarts: string[];
    lastHubActivities: HubActivity[];
  };
  // Module-private namespaces, keyed by module id:
  [moduleId: string]: unknown;
}
```

Saves are a single JSON file. AI playtester branching = snapshot + replay from a state. `git diff` on saves works. Hot-reload preserves state.
Checkpoint bodies live in a project-level SHA-256 object store rather than
inside each session, so branch fan-out reuses identical states. Session logs
retain logical checkpoint references and fork provenance. A coverage
certificate is a second, smaller layer: it indexes only current-revision story
completion and stable option facts, with verified object witnesses. This lets
CI validate the current authored game after bulky exploratory sessions are
archived, while any content revision invalidates only the facts it changes.

The local Web dev server exposes a same-origin session bridge. Its default
`web` session is the same `.rpg-harness/sessions/web/state.json` and
`log.jsonl` consumed by `rpgh peek`, `step`, `report`, and `resolve`; GUI steps
carry `source: "web"`, semantic decisions, and `inputResult` in the log. The bridge uses a hash revision on every PUT,
so the GUI can live-reload when a CLI/TUI step changes the file. A browser that
writes inside the polling race window receives 409 instead of overwriting the
newer step. Production Web builds do not include this middleware and continue
to use localStorage.

## Preset layer

Two bundled presets:

- **vn** (`packages/engine/src/presets/vn/`) — linear visual novel: walk scripts, accept inputs, end.
- **training** (`packages/engine/src/presets/training/`) — calendar + day/slot + stats + hub + actions + scripts + end conditions. Minimal reference: `examples/eject-test`.

A game picks its preset in `game.yaml`:

```yaml
preset: training            # bundled by name
# or
preset: ./preset/run.ts     # ejected: ship your own run.ts
```

### Ejection

`rpgh init --preset training --eject` copies the bundled training preset (`run.ts`, `module.ts`, `hub.ts`, `sleepHandler.ts`, `index.ts`) into the game's `preset/` directory and rewrites imports to depend only on `@rpg-harness/engine`'s public surface. After ejection, authors can edit the loop without touching engine source.

`examples/eject-test` ships ejected — its `preset/run.ts` adds a daybreak narration at the start of each new day's morning slot. Pure cosmetic; demonstrates the surface is real.

## Game folder layout

```
my-game/
  game.yaml              # title, preset, modules, training config, endings
  characters/*.md
  items/*.md
  enemies/*.md
  weapons/*.md
  skills/*.md
  maps/*.yaml            # locations the player can be in (connections, actions, encounter tables)
  scripts/*.md           # one beat-list per file
  actions/*.yaml         # hub-bound activities (use `whenIn:` to scope to specific maps)
  modules/*.ts           # optional: custom mechanics
  preset/*.ts            # optional: ejected loop
  tests/*.yaml           # optional: headless fixtures
```

The loader (`packages/cli/src/loader.ts`) scans each directory, dispatches to the matching parser, and assembles a `Game` object that goes into `new Engine(game)`.

## Test fixtures

`*.yaml` fixtures under `tests/` declare seed state + input sequence + assertions. The fixture runner (`packages/cli/src/test.ts`) drives the engine in `runLoop` mode and asserts on final state slots / output stream.

```yaml
name: "..."
state:
  baseline: { ... }
  training: { ... }
inputs:
  - { type: doActivity, id: "action:hunt" }
  - { type: next }
assertions:
  - { kind: state, path: baseline.weapons.yaodao.power, gte: 25 }
  - { kind: output, type: gameEnd, present: true }
```

Used as regression tests (CI runs all of them on every PR) and as executable spec for what a feature does end-to-end.

## What the engine does NOT know

- What "good ending" or "bad ending" means semantically.
- What "spectral" or "physical" represents (any stat is a number with a max).
- What "battle" or "hunt" is — modules define those via action handlers.
- How to render anything — frontend's job.
- Where save files live — host's job.
- Whether the player is human or LLM — both look identical from inside the loop.
- What a map's encounter / loot tables mean (the engine stores them; modules roll on them).
- Whether the player should be allowed to depart on a raid right now (modules gate via `requires` / their own logic) — the engine knows only `currentMapId` and the connection graph.

Keeping the engine ignorant of all of this is what lets games swap mechanics without forking the engine.

## TypeScript

The contract is strict TS: no `any`, no `as` casts unless unavoidable. Every Claude Code user already has Bun, the user base is React-fluent, and "AI writes / human reviews" both want types.

## Why no comments in source

Code is short, names are explicit, types document intent. Comments document WHY only when the WHY would surprise a future reader. Everything else goes here in `docs/`.
