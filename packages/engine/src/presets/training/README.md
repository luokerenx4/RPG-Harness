# training preset

Day/slot/stats/hub game loop — the minimal reference is
`examples/eject-test`. Same script-runner foundation as the vn preset, plus:

- **calendar**: slots advance after every action (via `onActionComplete`
  hook the bundled `trainingPreset` Module registers), days roll over,
  per-day decay applies to a configured stat
- **hub**: between scripts the player sees an activity menu (scripts +
  actions, filtered by day/night slot AND by the player's current map —
  see "Maps" in `docs/ARCHITECTURE.md`). When `state.baseline.currentMapId`
  is set, the hub builder additionally surfaces `move:<target>` activities
  for each connection from the current map, and filters `game.actions[]`
  through their optional `whenIn:` map-id list.
- **end conditions**: checked at the top of every loop iteration when
  no script is in progress; the first match runs its optional `goto` ending
  script and then emits a stable terminal `gameEnd` identity

## Files

| file | role |
|---|---|
| `run.ts` | the main loop generator (`trainingRun`) — the file an AI copies on `--eject` |
| `module.ts` | the `trainingPreset` Module — hooks (`onActionComplete`, `onHubBuild`), `actionHandlers.sleep`, calendar advance |
| `hub.ts` | `buildHubSnapshot` helper used by `onHubBuild` |
| `sleepHandler.ts` | the `sleep` action handler — restores physical-family stats |

## Use

A game declares it via `game.yaml`:

```yaml
title: My Training Game
training:
  slotsPerDay: 3
  slotNames: [morning, afternoon, night]
  startDay: 1
  maxDay: 14
  ...
```

When `game.training` is set, the engine auto-resolves the training
preset's run function and includes the `trainingPreset` Module.

To eject and customize the loop:

```bash
rpgh init my-game --preset training --eject
# → copies run.ts (+ module.ts / hub.ts / sleepHandler.ts) into
#   my-game/preset/, with imports rewritten to @rpg-harness/engine.
#   my-game/game.yaml sets `preset: ./preset/run.ts`.
```

After ejecting you own the loop — engine API changes won't automatically
flow in. See the eject section in the top-level README for details.
