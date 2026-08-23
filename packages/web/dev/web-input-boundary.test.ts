import { describe, expect, test } from "bun:test";
import type {
  ComposedState,
  Input,
  InputResult,
  MapDef,
  Output,
} from "@rpg-harness/engine";
import {
  normalizeSpatialMapCursor,
  resolveAcceptedSpatialMoveBlock,
  submitWebInput,
} from "../src/WebPlayScreen";

const accepted: InputResult = {
  accepted: true,
  code: "accepted",
  message: "Input accepted.",
  expected: [],
};

const field: MapDef = {
  id: "probe",
  name: "Probe",
  description: "",
  difficulty: 1,
  layout: {
    width: 5,
    height: 4,
    tileWidth: 32,
    tileHeight: 32,
    playerStart: { x: 2, y: 2 },
    layers: [],
    regions: [],
  },
};

function fieldState(
  mapId: string,
  position?: { x: number; y: number },
  positionMapId: string | null = position ? mapId : null,
): ComposedState {
  return {
    baseline: { currentMapId: mapId } as ComposedState["baseline"],
    runtime: {
      ...(position ? { mapPosition: position } : {}),
      mapPositionMapId: positionMapId,
    } as ComposedState["runtime"],
  };
}

describe("Web input boundary", () => {
  test("does not deliver rejected input to the live generator", async () => {
    const received: Input[] = [];
    const runner: AsyncGenerator<Output, void, Input> = (async function* () {
      const input: Input = yield { type: "narration", text: "Wait." };
      received.push(input);
      yield { type: "gameEnd" };
    })();
    await runner.next();

    const submitted = await submitWebInput(
      { type: "narration", text: "Wait." },
      { type: "doActivity", id: "rest" },
      runner,
    );

    expect(submitted).toMatchObject({
      inputResult: { accepted: false, code: "unexpected-input" },
    });
    expect(submitted.result).toBeUndefined();
    expect(received).toEqual([]);
  });

  test("delivers accepted stable choice identity unchanged", async () => {
    const received: Input[] = [];
    const runner: AsyncGenerator<Output, void, Input> = (async function* () {
      const input: Input = yield { type: "choice", choiceId: "route", options: [
        { id: "friends", text: "Friends", available: true },
      ] };
      received.push(input);
      yield { type: "gameEnd" };
    })();
    await runner.next();
    const output: Output = {
      type: "choice",
      choiceId: "route",
      options: [{ id: "friends", text: "Friends", available: true }],
    };

    const submitted = await submitWebInput(
      output,
      { type: "choose", choiceId: "route", optionId: "friends" },
      runner,
    );

    expect(submitted.inputResult.accepted).toBe(true);
    expect(submitted.inputResult.expected).toEqual([]);
    expect(submitted.result?.value).toEqual({ type: "gameEnd" });
    expect(received).toEqual([
      { type: "choose", choiceId: "route", optionId: "friends" },
    ]);
  });

  test("accepted Hub input reports expectations for the resulting narration", async () => {
    const runner: AsyncGenerator<Output, void, Input> = (async function* () {
      yield { type: "hubMenu", snapshot: {
        day: 1,
        maxDay: 1,
        slot: 0,
        slotName: "",
        slotsPerDay: 1,
        stats: [],
        affections: [],
        activities: [{ id: "memory", kind: "action", title: "Recall", cost: 0, available: true }],
      } };
      yield { type: "narration", text: "The memory returns." };
    })();
    const current = await runner.next();
    const submitted = await submitWebInput(
      current.value!,
      { type: "doActivity", id: "memory" },
      runner,
    );

    expect(submitted.result?.value).toMatchObject({ type: "narration" });
    expect(submitted.inputResult).toMatchObject({
      accepted: true,
      expected: [{ type: "next" }, { type: "quit" }],
    });
  });

  test("delivers an accepted map move exactly once", async () => {
    const received: Input[] = [];
    const hub: Output = { type: "hubMenu", snapshot: {
      day: 1,
      maxDay: 1,
      slot: 0,
      slotName: "",
      slotsPerDay: 1,
      stats: [],
      affections: [],
      activities: [],
    } };
    const runner: AsyncGenerator<Output, void, Input> = (async function* () {
      const input: Input = yield hub;
      received.push(input);
      yield hub;
    })();
    await runner.next();

    const submitted = await submitWebInput(
      hub,
      { type: "moveMap", direction: "east" },
      runner,
    );

    expect(submitted.inputResult.accepted).toBe(true);
    expect(received).toEqual([{ type: "moveMap", direction: "east" }]);
  });

  test("acknowledges only accepted moves that stay on the same normalized cell", () => {
    const maps = [field, {
      ...field,
      id: "other",
      name: "Other",
      layout: { ...field.layout!, playerStart: { x: 0, y: 0 } },
    }];
    const before = fieldState("probe", { x: 2, y: 2 });

    expect(resolveAcceptedSpatialMoveBlock(
      maps,
      { type: "moveMap", direction: "east" },
      accepted,
      before,
      fieldState("probe", { x: 2, y: 2 }),
    )).toBe("east");
    expect(resolveAcceptedSpatialMoveBlock(
      maps,
      { type: "moveMap", direction: "west" },
      accepted,
      before,
      fieldState("probe", { x: 1, y: 2 }),
    )).toBeUndefined();
    expect(resolveAcceptedSpatialMoveBlock(
      maps,
      { type: "moveMap", direction: "north" },
      accepted,
      before,
      fieldState("other", { x: 0, y: 0 }),
    )).toBeUndefined();
    expect(resolveAcceptedSpatialMoveBlock(
      maps,
      { type: "doActivity", id: "inspect" },
      accepted,
      before,
      fieldState("probe", { x: 2, y: 2 }),
    )).toBeUndefined();
    expect(resolveAcceptedSpatialMoveBlock(
      maps,
      { type: "moveMap", direction: "east" },
      { ...accepted, accepted: false, code: "unexpected-input" },
      before,
      fieldState("probe", { x: 2, y: 2 }),
    )).toBeUndefined();
  });

  test("normalizes a missing or unowned runtime cursor to authored playerStart", () => {
    const missing = fieldState("probe");
    const stale = fieldState("probe", { x: 4, y: 3 }, "other");
    const atStart = fieldState("probe", { x: 2, y: 2 });

    expect(normalizeSpatialMapCursor([field], missing)).toEqual({
      mapId: "probe",
      position: { x: 2, y: 2 },
    });
    expect(normalizeSpatialMapCursor([field], stale)).toEqual({
      mapId: "probe",
      position: { x: 2, y: 2 },
    });
    expect(resolveAcceptedSpatialMoveBlock(
      [field],
      { type: "moveMap", direction: "south" },
      accepted,
      missing,
      atStart,
    )).toBe("south");
  });
});
