import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  createInitialState,
  enterMap,
  peek,
  step,
  type Game,
} from "@rpg-harness/engine";
import { validateGame } from "@rpg-harness/parser";
import { createServer } from "vite";

describe("Web topology entry runtime", () => {
  test("the real Vite game loader and module consume a transferred chain entry", async () => {
    const server = await createServer({
      root: path.resolve(import.meta.dir, ".."),
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "silent",
    });
    try {
      const loadedModule = await server.ssrLoadModule("/src/loadGame.ts") as {
        loadWebGame: (gameId: string) => { game: Game };
      };
      const loaded = loadedModule.loadWebGame("sengoku-raid").game;
      const transferred: Game = {
        ...loaded,
        maps: loaded.maps?.map((map) => {
          if (map.id === "sumida_river_bridge_foot") {
            const next = { ...map };
            delete next.isEntry;
            return next;
          }
          return map.id === "sumida_river_ferry_landing"
            ? { ...map, isEntry: true }
            : map;
        }),
      };
      validateGame(transferred);

      const state = createInitialState(transferred, { seed: 0 });
      state.baseline.scripts["000_intro"] = {
        completed: true,
        selfSwitches: { A: false, B: false, C: false, D: false },
      };
      state.baseline.completionOrder = ["000_intro"];
      enterMap(state, transferred, "edo_castle");

      const before = await peek(transferred, state);
      expect(before.output?.type).toBe("hubMenu");
      if (before.output?.type !== "hubMenu") throw new Error("expected sengoku hub menu");
      expect(before.output.snapshot.activities.find(
        (activity) => activity.id === "depart:sumida_river",
      )).toMatchObject({
        id: "depart:sumida_river",
        actionKind: "depart",
        payload: {
          chain: "sumida_river",
          mapId: "sumida_river_ferry_landing",
        },
      });

      const after = await step(transferred, before.state, {
        type: "doActivity",
        id: "depart:sumida_river",
      });
      expect(after.inputResult?.accepted).toBe(true);
      expect(after.state.baseline.currentMapId).toBe("sumida_river_ferry_landing");
      expect(after.state.baseline.visuals.bg).toBe("assets/backgrounds/sumida-ferry");
    } finally {
      await server.close();
    }
  }, 60_000);
});
