import { describe, expect, test } from "bun:test";
import {
  buildMapHubSnapshot,
  collectMapActivities,
} from "./buildMapHub";
import { makeCtx, makeGame, makeCharacter, makeAction } from "../test-utils";
import { enterMap } from "./enterMap";
import type { Game, MapDef } from "../types";

function gameWith(maps: MapDef[], extra: Partial<Game> = {}): Game {
  return makeGame({
    characters: [makeCharacter("alice")],
    maps,
    ...extra,
  });
}

describe("buildMapHubSnapshot", () => {
  test("emits move activities for every connection", () => {
    const game = gameWith([
      {
        id: "city",
        name: "城下",
        description: "",
        connections: [
          { dir: "東", target: "swamp" },
          { dir: "北", target: "mountain" },
        ],
      },
      { id: "swamp", name: "黒沼", description: "" },
      { id: "mountain", name: "宝峰山", description: "" },
    ]);
    const ctx = makeCtx(game);
    enterMap(ctx.state, game, "city");
    const out = buildMapHubSnapshot(ctx);
    expect(out.type).toBe("hubMenu");
    const ids =
      out.type === "hubMenu" ? out.snapshot.activities.map((a) => a.id) : [];
    expect(ids).toEqual(["move:swamp", "move:mountain"]);
    if (out.type === "hubMenu") {
      const first = out.snapshot.activities[0]!;
      expect(first.kind).toBe("action");
      expect(first.actionKind).toBe("moveToMap");
      expect(first.payload).toEqual({
        to: "swamp",
        routeKey: "map:city/legacy-connection:0",
      });
      expect(first.title).toContain("黒沼");
    }
  });

  test("surfaces map-level actions for the current map only", () => {
    const game = gameWith([
      {
        id: "hospital",
        name: "病院",
        description: "",
        actions: [makeAction("work_hospital", { title: "病院でバイト" })],
      },
      {
        id: "cafe",
        name: "ネカフェ",
        description: "",
        actions: [
          makeAction("work_cafe", { title: "ネカフェでバイト" }),
          makeAction("infiltrate_cafe", { title: "ネカフェに潜入" }),
        ],
      },
    ]);
    const ctx = makeCtx(game);
    enterMap(ctx.state, game, "cafe");
    const ids = collectMapActivities(ctx).map((a) => a.id);
    expect(ids).toEqual(["action:work_cafe", "action:infiltrate_cafe"]);
    expect(ids).not.toContain("action:work_hospital");
  });

  test("Action.whenIn filters game.actions to matching map", () => {
    const game = gameWith(
      [
        { id: "a", name: "a", description: "" },
        { id: "b", name: "b", description: "" },
      ],
      {
        actions: [
          makeAction("only_a", { title: "A限定", whenIn: ["a"] }),
          makeAction("only_b", { title: "B限定", whenIn: ["b"] }),
          makeAction("ambient", { title: "どこでも" }),
        ],
      },
    );
    const ctx = makeCtx(game);
    enterMap(ctx.state, game, "a");
    const idsOnA = collectMapActivities(ctx).map((a) => a.id);
    expect(idsOnA).toContain("action:only_a");
    expect(idsOnA).toContain("action:ambient");
    expect(idsOnA).not.toContain("action:only_b");
    enterMap(ctx.state, game, "b");
    const idsOnB = collectMapActivities(ctx).map((a) => a.id);
    expect(idsOnB).toContain("action:only_b");
    expect(idsOnB).toContain("action:ambient");
    expect(idsOnB).not.toContain("action:only_a");
  });

  test("with no currentMapId, only ambient (whenIn-less) actions surface", () => {
    const game = gameWith(
      [{ id: "x", name: "x", description: "" }],
      {
        actions: [
          makeAction("scoped", { whenIn: ["x"] }),
          makeAction("ambient"),
        ],
      },
    );
    const ctx = makeCtx(game);
    const ids = collectMapActivities(ctx).map((a) => a.id);
    expect(ids).toEqual(["action:ambient"]);
  });

  test("preserves author-owned AI intent on static actions", () => {
    const game = gameWith([], {
      actions: [makeAction("comfort", { aiTags: ["social", "story"] })],
    });
    expect(collectMapActivities(makeCtx(game))[0]).toMatchObject({
      id: "action:comfort",
      aiTags: ["social", "story"],
    });
  });

  test("locked connection surfaces with lockedReason", () => {
    const game = gameWith(
      [
        {
          id: "gate",
          name: "Gate",
          description: "",
          connections: [
            {
              dir: "奥",
              target: "inner",
              requires: { switch: { name: "key_held", eq: true } },
              lockedHint: "鍵がない",
            },
          ],
        },
        { id: "inner", name: "Inner", description: "" },
      ],
      {
        switches: [{ id: "key_held", initial: false }],
      },
    );
    const ctx = makeCtx(game);
    enterMap(ctx.state, game, "gate");
    const act = collectMapActivities(ctx)[0]!;
    expect(act.id).toBe("move:inner");
    expect(act.available).toBe(false);
    expect(act.lockedReason).toBe("鍵がない");
  });

  test("keeps the exact machine gate while deriving a player-facing reason", () => {
    const requires = { switch: { name: "key_held", eq: true } } as const;
    const game = gameWith(
      [{
        id: "gate",
        name: "Gate",
        description: "",
        connections: [{ dir: "奥", target: "inner", requires }],
      }, {
        id: "inner",
        name: "Inner",
        description: "",
      }],
      { switches: [{ id: "key_held", initial: false, label: "門の鍵を入手" }] },
    );
    const ctx = makeCtx(game);
    enterMap(ctx.state, game, "gate");
    expect(collectMapActivities(ctx)[0]).toMatchObject({
      available: false,
      requires,
      lockedReason: "門の鍵を入手",
    });
  });
});
