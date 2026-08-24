import { describe, expect, test } from "bun:test";
import { makeAction, makeCharacter, makeCtx, makeGame } from "../test-utils";
import { collectMapActivities } from "./buildMapHub";
import { collectMapAvailableResources } from "./collectMapResources";
import { dispatchActivity } from "./dispatchActivity";

async function drain<T>(gen: AsyncGenerator<any, T, any>): Promise<T> {
  let result = await gen.next();
  while (!result.done) result = await gen.next(undefined);
  return result.value;
}

describe("collectMapAvailableResources", () => {
  test("projects stacked placements without requiring a visual avatar", () => {
    const game = makeGame({
      characters: [makeCharacter("kagari")],
      scripts: [
        { id: "talk", title: "Talk", beats: [] },
        { id: "cg", title: "CG", beats: [] },
      ],
      actions: [makeAction("inspect", { title: "Inspect", exposure: "placed" })],
      maps: [{
        id: "shrine",
        name: "Shrine",
        description: "",
        placements: [
          {
            id: "kagari",
            at: { x: 4, y: 7 },
            z: 0,
            footprint: { width: 1, height: 1 },
            collision: "block",
            visible: true,
            resource: { kind: "character", id: "kagari" },
            events: [
              {
                id: "talk",
                trigger: "interact",
                order: 10,
                run: { kind: "script", id: "talk" },
              },
              {
                id: "inspect",
                trigger: "interact",
                order: 20,
                run: { kind: "action", id: "inspect" },
              },
            ],
          },
          {
            id: "hidden_cg",
            at: { x: 4, y: 7 },
            z: 1,
            footprint: { width: 1, height: 1 },
            collision: "none",
            visible: false,
            resource: { kind: "script", id: "cg" },
            events: [{ id: "play", trigger: "autorun", order: 0 }],
          },
        ],
      }],
    });
    const ctx = makeCtx(game);
    ctx.state.baseline.currentMapId = "shrine";

    const resources = collectMapAvailableResources(ctx);
    expect(resources).toHaveLength(5); // two placed resources + three events
    expect(resources.map((resource) => resource.key)).toContain(
      "map:shrine/placement:kagari/event:talk",
    );
    expect(resources.filter((resource) => resource.at?.x === 4)).toHaveLength(5);
    expect(collectMapActivities(ctx).map((activity) => activity.id)).toEqual([
      "map:shrine/placement:kagari/event:talk",
      "map:shrine/placement:kagari/event:inspect",
    ]);
  });

  test("combines placement and event conditions into the semantic option", () => {
    const game = makeGame({
      characters: [makeCharacter("hero")],
      scripts: [{ id: "secret", title: "Secret", beats: [] }],
      switches: [
        { id: "map_ready", initial: true },
        { id: "door_open", initial: false },
      ],
      maps: [{
        id: "room",
        name: "Room",
        description: "",
        placements: [{
          id: "door",
          at: { x: 0, y: 0 },
          z: 0,
          footprint: { width: 1, height: 1 },
          collision: "block",
          visible: true,
          requires: { switch: { name: "map_ready", eq: true } },
          events: [{
            id: "open",
            trigger: "interact",
            order: 0,
            lockedHint: "The door is closed",
            requires: { switch: { name: "door_open", eq: true } },
            run: { kind: "script", id: "secret" },
          }],
        }],
      }],
    });
    const ctx = makeCtx(game);
    ctx.state.baseline.currentMapId = "room";
    const event = collectMapAvailableResources(ctx).find((resource) => resource.eventId === "open");
    expect(event).toMatchObject({
      available: false,
      lockedReason: "The door is closed",
      requires: { all: expect.any(Array) },
    });
  });

  test("keeps placement facing out of interact, player-touch, and Headless semantics", () => {
    const facings = [undefined, "north", "east", "south", "west"] as const;
    const projections = facings.map((facing) => {
      const game = makeGame({
        characters: [makeCharacter("hero")],
        scripts: [
          { id: "talk", title: "Talk", beats: [] },
          { id: "leave", title: "Leave", beats: [] },
        ],
        maps: [{
          id: "room",
          name: "Room",
          description: "",
          layout: {
            width: 3,
            height: 3,
            tileWidth: 32,
            tileHeight: 32,
            playerStart: { x: 0, y: 1 },
            layers: [],
            regions: [],
          },
          placements: [{
            id: "guide",
            at: { x: 1, y: 1 },
            z: 0,
            ...(facing ? { facing } : {}),
            footprint: { width: 1, height: 1 },
            collision: "trigger",
            visible: true,
            resource: { kind: "character", id: "hero" },
            events: [{
              id: "talk",
              trigger: "interact",
              order: 0,
              run: { kind: "script", id: "talk" },
            }, {
              id: "leave",
              trigger: "player_touch",
              order: 1,
              run: { kind: "script", id: "leave" },
            }],
          }],
        }],
      });
      const ctx = makeCtx(game);
      ctx.state.baseline.currentMapId = "room";
      return {
        resources: collectMapAvailableResources(ctx),
        activities: collectMapActivities(ctx),
      };
    });

    expect(projections[0]!.resources.filter(({ trigger }) => trigger).map(({ trigger }) => trigger)).toEqual([
      "interact",
      "player_touch",
    ]);
    expect(projections[0]!.activities.map(({ id }) => id)).toEqual([
      "map:room/placement:guide/event:talk",
      "map:room/placement:guide/event:leave",
    ]);
    for (const projection of projections.slice(1)) {
      expect(projection.resources).toEqual(projections[0]!.resources);
      expect(projection.activities).toEqual(projections[0]!.activities);
    }
  });
});

describe("placement-backed activity dispatch", () => {
  test("runs referenced actions and scripts through the existing engine paths", async () => {
    const game = makeGame({
      characters: [makeCharacter("hero")],
      scripts: [{ id: "talk", title: "Talk", beats: [] }],
      actions: [makeAction("inspect", {
        exposure: "placed",
        narrations: ["inspected"],
      })],
      maps: [{
        id: "room",
        name: "Room",
        description: "",
        placements: [{
          id: "object",
          at: { x: 0, y: 0 },
          z: 0,
          footprint: { width: 1, height: 1 },
          collision: "none",
          visible: true,
          events: [
            {
              id: "inspect",
              trigger: "interact",
              order: 0,
              run: { kind: "action", id: "inspect" },
            },
            {
              id: "talk",
              trigger: "interact",
              order: 1,
              run: { kind: "script", id: "talk" },
            },
          ],
        }],
      }],
    });
    const ctx = makeCtx(game, { rng: () => 0 });
    ctx.state.baseline.currentMapId = "room";
    ctx.state.runtime.lastHubActivities = collectMapActivities(ctx);

    await drain(dispatchActivity(ctx, "map:room/placement:object/event:inspect"));
    expect(ctx.state.runtime.pendingNarrations).toEqual(["inspected"]);

    await drain(dispatchActivity(ctx, "map:room/placement:object/event:talk"));
    expect(ctx.state.baseline.currentScriptId).toBe("talk");
  });
});
