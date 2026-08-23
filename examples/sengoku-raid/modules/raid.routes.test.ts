import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  buildPresetContext,
  createInitialState,
  dispatchActivity,
  enterMap,
  peek,
  step,
  type ComposedState,
  type Game,
  type HubActivity,
  type Input,
  type StepResult,
} from "@rpg-harness/engine";
import { loadGame } from "@rpg-harness/cli";

const GAME_DIR = path.resolve(import.meta.dir, "..");
const ENTRY_ID = "kuro_swamp_edge";
const TARGET_ID = "kuro_swamp_crossroads";
const ROUTE_KEY =
  "map:kuro_swamp_edge/placement:exit_kuro_swamp_crossroads/event:move";

describe("sengoku-raid map routes", () => {
  test("publishes stable route identity and consumes it through the real raid move handler", async () => {
    const game = await loadGame(GAME_DIR);
    const raidHub = await enterKuroSwampRaid(game);
    const move = findActivity(raidHub, `move:${TARGET_ID}`);

    expect(move).toMatchObject({
      id: `move:${TARGET_ID}`,
      sourceKey: ROUTE_KEY,
      actionKind: "move",
      payload: { mapId: TARGET_ID, routeKey: ROUTE_KEY },
      available: true,
    });

    const moved = await step(game, raidHub.state, {
      type: "doActivity",
      id: move.id,
    });

    expect(moved.inputResult?.accepted).toBe(true);
    expect(moved.state.baseline.currentMapId).toBe(TARGET_ID);
    expect(raidState(moved.state).raid).toMatchObject({
      turnsTaken: 1,
      visited: {
        [ENTRY_ID]: { visited: true },
        [TARGET_ID]: { visited: true },
      },
    });
  });

  test("keeps a locked route closed in both the public Hub and the raid handler", async () => {
    const game = await gameWithLockedKuroRoute();
    const raidHub = await enterKuroSwampRaid(game);
    const move = findActivity(raidHub, `move:${TARGET_ID}`);

    expect(move).toMatchObject({
      sourceKey: ROUTE_KEY,
      payload: { mapId: TARGET_ID, routeKey: ROUTE_KEY },
      available: false,
      lockedReason: "AUDIT LOCK",
    });

    const rejected = await step(game, raidHub.state, {
      type: "doActivity",
      id: move.id,
    });
    expect(rejected.inputResult).toMatchObject({
      accepted: false,
      code: "activity-locked",
    });
    expect(rejected.state.baseline.currentMapId).toBe(ENTRY_ID);

    // Bypass normal Hub input classification and omit the published gate from
    // the forged activity. The module handler must resolve the authored route
    // again and enforce its current condition rather than trusting the caller.
    const ctx = buildPresetContext(game, raidHub.state, () => 0);
    const forged: HubActivity = {
      id: "audit:forged-kuro-route",
      kind: "action",
      actionKind: "move",
      payload: { mapId: TARGET_ID, routeKey: ROUTE_KEY },
      title: "Forged route",
      category: "raid",
      cost: 0,
      available: true,
    };
    ctx.state.runtime.lastHubActivities = [forged];

    await drain(dispatchActivity(ctx, forged.id));

    expect(ctx.state.baseline.currentMapId).toBe(ENTRY_ID);
    expect(raidState(ctx.state).raid).toMatchObject({
      turnsTaken: 0,
      visited: {
        [ENTRY_ID]: { visited: true },
      },
    });
    expect(raidState(ctx.state).raid?.visited[TARGET_ID]).toBeUndefined();
    expect(ctx.state.runtime.pendingNarrations).toContain("AUDIT LOCK");
  });
});

async function gameWithLockedKuroRoute(): Promise<Game> {
  const loaded = await loadGame(GAME_DIR);
  const maps = (loaded.maps ?? []).map((map) =>
    map.id === ENTRY_ID ? structuredClone(map) : map
  );
  const entry = maps.find((map) => map.id === ENTRY_ID);
  const placement = entry?.placements?.find(
    (candidate) => candidate.id === "exit_kuro_swamp_crossroads",
  );
  const event = placement?.events.find((candidate) => candidate.id === "move");
  if (!event) throw new Error("real kuro swamp route fixture is missing");
  event.requires = { switch: { name: "audit_route_open", eq: true } };
  event.lockedHint = "AUDIT LOCK";

  const game: Game = {
    ...loaded,
    switches: [...(loaded.switches ?? []), { id: "audit_route_open", initial: false }],
    maps,
  };
  return game;
}

async function enterKuroSwampRaid(game: Game): Promise<StepResult> {
  const state = createInitialState(game, { seed: 0 });
  state.baseline.scripts["000_intro"] = {
    completed: true,
    selfSwitches: { A: false, B: false, C: false, D: false },
  };
  state.baseline.completionOrder = ["000_intro"];
  enterMap(state, game, "edo_castle");

  const hub = await peek(game, state);
  const departed = await step(game, hub.state, {
    type: "doActivity",
    id: "depart:kuro_swamp",
  });
  expect(departed.inputResult?.accepted).toBe(true);
  return advanceToHub(game, departed);
}

async function advanceToHub(game: Game, initial: StepResult): Promise<StepResult> {
  let current = initial;
  for (let index = 0; index < 20; index += 1) {
    if (current.output?.type === "hubMenu") return current;
    if (
      current.output?.type !== "narration" &&
      current.output?.type !== "dialogue" &&
      current.output?.type !== "clear"
    ) {
      throw new Error(`expected narration before raid Hub, received ${current.output?.type ?? "null"}`);
    }
    current = await step(game, current.state, { type: "next" });
  }
  throw new Error("real kuro swamp raid did not reach its Hub within 20 steps");
}

function findActivity(
  result: StepResult,
  id: string,
): Extract<NonNullable<StepResult["output"]>, { type: "hubMenu" }>["snapshot"]["activities"][number] {
  if (result.output?.type !== "hubMenu") throw new Error("expected raid Hub");
  const activity = result.output.snapshot.activities.find((candidate) => candidate.id === id);
  if (!activity) throw new Error(`activity not found: ${id}`);
  return activity;
}

function raidState(state: ComposedState): {
  raid?: {
    turnsTaken: number;
    visited: Record<string, { visited: boolean }>;
  };
} {
  return state["sengoku-raid"] as {
    raid?: {
      turnsTaken: number;
      visited: Record<string, { visited: boolean }>;
    };
  };
}

async function drain(
  generator: AsyncGenerator<unknown, unknown, Input>,
): Promise<void> {
  let result = await generator.next();
  while (!result.done) result = await generator.next({ type: "next" });
}
