# ADR 0001: Map v2 and Project Studio

- Status: Accepted
- Date: 2026-08-23
- Scope: engine, parser, CLI loader, Web/TUI/Headless projections, Studio, game content

## Context

RPG-Harness currently models a map as a flat event container. A map owns a
background, map-scoped actions, an entry script, encounter/loot tables,
character spawn rules, and directed connections to other maps. Runtime location
is only `baseline.currentMapId`. This is sufficient for era-style hub play, but
it cannot author a character, event, exit, enemy, item, or other resource at a
real position without inventing game-specific `custom`/metadata fields.

The limitation is in the resource model, not in Headless play. Headless does not
need to operate a visual avatar. It can continue treating the current map as one
semantic node and choosing among the resources and operations currently
available there. Human renderers may additionally project the same map through
a two-dimensional surface.

Studio currently exposes visual assets and their rendering specifications. The
rest of the project database is only visible as unrelated files, so authors
cannot see the whole game, follow references, place resources on maps, or compare
human and Headless projections in one place.

## Decision

### 1. A map is a spatially-capable resource container

`MapDef` remains the canonical unit of location and the value selected by
`baseline.currentMapId`. It gains two optional, engine-owned structures:

- `layout`: grid dimensions, tile dimensions, tileset, ordered layers, collision
  data, and named regions;
- `placements`: stable instances of project resources at map coordinates.

Two-dimensional data belongs to the map resource. It is not renderer metadata.
A map may omit `layout` and `placements`; this is the compact form for an
era-style node. Spatial capability is universal, but spatial authoring is not
mandatory.

### 2. Placement is the common composition primitive

A placement has a stable map-local ID, position, optional layer/z/facing/
footprint/collision, one optional resource reference, and zero or more event
bindings. Resource references are namespaced pairs such as
`character:kagari`, `enemy:oni`, `script:shrine_intro`, or `map:castle_gate`.

Event bindings have their own stable ID, trigger, optional condition and locked
hint, and an optional resource to run. Omitting `run` activates the placement's
resource. Multiple placements may occupy one tile, and a placement may expose
multiple bindings. This deliberately supports RPG Maker-style event maps where
many invisible or autorun resources share one coordinate while the human player
only sees CG or dialogue.

`facing` is an authored presentation orientation for a static placement. It may
select a renderer cue or a future directional sprite frame, but it does not
rotate generic bitmaps and must not change footprint, collision, event range,
trigger eligibility, or the resources and operations exposed to Headless. A
future player-facing interaction cone requires a separate runtime player
orientation contract rather than reinterpreting placement `facing`.

`custom` remains available for game-specific attributes, but coordinates,
layers, collision, regions, resource identity, trigger type, ordering, and
conditions are formal fields and must not be encoded there.

### 3. Route target and spatial arrival are separate contracts

Every map transfer is a directed route. Its target identity remains an ordinary
map resource reference: an event's explicit `run`, or the containing
placement's `resource` when `run` is omitted. A route may additionally own one
spatial `arrival`, but arrival data never replaces or changes that resource
identity.

```yaml
# Stable anchor in the destination map.
resource: { kind: map, id: edo_castle }
events:
  - id: return
    trigger: player_touch
    arrival: { placement: south_gate_entry }

# Exact cell in a spatial destination selected by event.run.
events:
  - id: descend
    trigger: interact
    run: { kind: map, id: cellar }
    arrival: { at: [4, 7] }
```

The placement form resolves the named placement's `at` in the target map. The
coordinate form requires a target `layout` and must be within its bounds. A
layout-less node map may use a placement anchor, but cannot use an exact
coordinate anchor. If `arrival` is omitted, entry uses the target's
`player_start`, or `[0,0]` when no start is authored.

Headless consumes the same semantic route and resulting `currentMapId` while
ignoring its spatial coordinate. Human spatial renderers consume the persisted
cursor. Runtime never synthesizes the reverse edge; an authored A → B route is
independent from any B → A route.

Studio can offer "create return route" as an authoring convenience, provided it
materializes two ordinary directed placement events. Both sides remain explicit
and may choose different IDs, coordinates, labels, triggers, and arrivals. The
cross-map save is one preview-bound transaction: both authoritative sources are
locked, checked, written, reloaded, and validated together, and any failed side
rolls the whole operation back. No `bidirectional` field or implicit reverse
edge is added to the engine schema.

### 4. Surfaces are projections, not alternate game databases

The engine will expose one query for the current map's available semantic
resources/operations. Every surface consumes that result:

- Headless emits stable semantic IDs, resource references, requirements, and
  accepted inputs;
- Hub renders them as cards/buttons;
- TUI renders them as text;
- a 2D Web surface uses placement coordinates, layers, and collision to render
  and maps player gestures back to the same semantic operations.

Renderer-local state may contain camera position, animation progress, hover, or
selection. Authoritative switches, inventory, event completion, map identity,
and action results remain engine state. A renderer must not implement a second
copy of event eligibility or effects.

Player coordinates live in persisted runtime state only while a spatial shell
uses them. `moveMap` is renderer input and does not appear in the Headless
semantic option list; entering a spatial map initializes `player_start` (or
`[0,0]`). Collision and player-touch resolution are engine primitives, so
position-dependent outcomes are checkpointed and replayable rather than DOM
state.

### 5. Resource Registry is shared infrastructure

The engine/loader will provide a uniform registry over characters, items,
weapons, skills, enemies, maps, scripts, actions, visual assets, and modules.
Canonical keys use `<kind>:<id>`. Placement and Studio reference validation use
this registry rather than maintaining per-surface lookup rules.

Map-local identities are canonicalized as
`map:<map-id>/placement:<placement-id>` and
`map:<map-id>/placement:<placement-id>/event:<event-id>` for diagnostics,
replays, coding issues, and Studio deep links.

### 6. Project Studio is the authoring shell

Studio becomes the primary project editor rather than an asset-only gallery. It
will provide:

- a project tree for all standard resources, modules, and tests/issues;
- schema-driven detail editors with raw YAML/Markdown access and safe round-trip
  writes to the game folder;
- forward references, backlinks, missing references, and orphan diagnostics;
- a map canvas for layers, regions, collision, resource placement, stacking,
  event conditions, triggers, and ordering;
- Hub, 2D, TUI, and Headless previews backed by shared runtime queries;
- stable resource/event coordinates for AI findings, reproduction, editing, and
  verification.

The game folder remains the source of truth. Studio must not introduce an opaque
project database or duplicate parser/runtime rules in frontend code.

## Initial schema

```yaml
id: shrine_night
name: 夜之社
description: 月下的古社。
bg: assets/backgrounds/shrine-night

layout:
  width: 40
  height: 30
  tile_width: 32
  tile_height: 32
  player_start: [20, 28]
  tileset: assets/tilesets/shrine
  layers:
    - id: ground
      kind: tile
      z: 0
      tiles: []
    - id: actors
      kind: object
      z: 10
  regions:
    - { id: altar, x: 17, y: 7, width: 4, height: 3 }

placements:
  - id: kagari
    at: [18, 8]
    layer: actors
    facing: south
    footprint: [1, 1]
    collision: block
    resource: { kind: character, id: kagari }
    events:
      - id: talk
        trigger: interact
        label: 与篝交谈
        run: { kind: script, id: shrine_kagari }

  - id: return_gate
    at: [20, 29]
    resource: { kind: map, id: edo_castle }
    events:
      - id: leave
        trigger: player_touch
        label: 返回江户城
        arrival: { placement: south_gate_entry }

  - id: cellar_stairs
    at: [12, 8]
    events:
      - id: descend
        trigger: interact
        label: 前往地窖
        run: { kind: map, id: shrine_cellar }
        arrival: { at: [4, 7] }
```

The schema intentionally permits event-only maps, invisible placements, empty
tile layers, and arbitrarily many placements on one coordinate.

## Migration

Migration is staged but directional; the final content model will not keep two
equally authoritative map systems.

1. Add and validate `layout`/`placements` while existing fields continue to run.
2. Add the Resource Registry and the shared available-map-resource query.
3. Convert `connections` to `map` placements with event bindings, map-scoped
   inline `actions` to referenced action resources, `on_enter` to an autorun
   script placement, and character spawn rules to character placements/events.
4. Migrate existing games and fixtures, then remove the legacy authoring fields
   after all bundled content and tools consume placements.
5. Keep runtime input identity stable where possible (`move:<target>`,
   `action:<id>`); schema migration must not silently invalidate Headless saves
   or issue evidence without an explicit save migration.

Encounter and loot tables remain map-level probabilistic resources until their
placement semantics are specified. They must ultimately use the same stable
resource references and validation registry.

## Validation invariants

- map, layer, region, placement, and placement-event IDs are unique in scope;
- dimensions, coordinates, and footprints are finite non-negative/positive
  integers as appropriate;
- spatial placements and regions fit inside the declared layout;
- referenced layers and project resources exist;
- route arrival declares exactly one of a target placement or exact coordinate;
- target placements exist in the route's target map, and exact coordinates
  require and fit inside the target layout;
- tile matrices, when authored inline, match map width and height;
- event requirements use the common Condition DSL;
- renderer code cannot create authoritative resources unavailable to Headless;
- every user-visible or AI-visible operation has a stable semantic identity.

## Delivery slices

1. Types, parser, validator, Resource Registry, query contract, tests, and
   documentation.
2. Existing-game migration and unchanged Hub/Headless acceptance.
3. Minimal playable 2D Web renderer using the shared contract.
4. Project Studio tree, resource details, references/backlinks, and validation.
5. Studio map canvas, stack/event editing, multi-surface preview, and AI issue
   loop.

Each slice must keep the repository runnable and prove behavior with real game
fixtures rather than schema-only tests.

## Consequences

The map becomes a richer database resource and can support traditional JRPG,
action, event-only, VN/CG, and era-style games without inventing parallel world
models. The cost is a larger engine-owned schema, save migration once player
coordinates become authoritative, and a Studio backend that must preserve
human-authored files safely. Those costs are accepted because spatial placement
and unified project authoring are foundational extension points rather than
game-specific metadata.
