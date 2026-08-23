import { describe, expect, test } from "bun:test";
import type { ComposedState, Game } from "@rpg-harness/engine";
import { pickerSaveSummary } from "../src/pickerSaveSummary";

describe("RPG save slot summary", () => {
  test("projects stable state ids into player-facing location and activity labels", () => {
    const game = {
      maps: [{ id: "shrine", name: "潰れた社" }],
      scripts: [{ id: "memory", title: "失われた記憶" }],
    } as unknown as Game;
    const state = {
      baseline: {
        currentMapId: "shrine",
        currentScriptId: "memory",
        completionOrder: ["intro", "road"],
      },
    } as unknown as ComposedState;
    expect(pickerSaveSummary(game, state)).toEqual({
      location: "潰れた社",
      activity: "失われた記憶",
      records: 2,
    });
  });
});
