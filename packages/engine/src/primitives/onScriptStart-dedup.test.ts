import { describe, expect, test } from "bun:test";
import {
  makeCharacter,
  makeCtx,
  makeGame,
  makeScript,
  trackerModule,
} from "../test-utils";
import {
  fireOnScriptComplete,
  fireOnScriptStart,
} from "./hooks";

// onScriptStart dedup contract:
//
// - Multiple calls for the same scriptId fire the hook exactly once
//   (mirrors the Module.onScriptStart docstring: "fires just before
//   the first beat of a script yields", singular).
// - fireOnScriptComplete clears the dedup entry so a future re-entry
//   of the same script can fire onScriptStart again.
// - Different scriptIds are tracked independently.
//
// Why this exists: step-style CLI invocation (peek/step) creates a
// fresh Engine + runner per call and re-enters runScript every step.
// Without dedup, hooks with side effects (queueing narrations,
// flipping switches) fire on every step → can deadlock the run loop
// when the side effect interferes with input consumption.

describe("fireOnScriptStart — dedup contract", () => {
  test("repeat calls for same scriptId fire the hook once", () => {
    const tracker = trackerModule();
    const ctx = makeCtx(
      makeGame({
        characters: [makeCharacter("a")],
        scripts: [makeScript("letter_01"), makeScript("letter_02")],
        modules: [tracker.module],
      }),
    );

    fireOnScriptStart(ctx, "letter_01");
    fireOnScriptStart(ctx, "letter_01");
    fireOnScriptStart(ctx, "letter_01");

    const events = tracker.events.filter((e) => e.hook === "onScriptStart");
    expect(events).toHaveLength(1);
    expect(ctx.state.runtime.firedScriptStarts).toEqual(["letter_01"]);
  });

  test("different scriptIds fire independently", () => {
    const tracker = trackerModule();
    const ctx = makeCtx(
      makeGame({
        characters: [makeCharacter("a")],
        scripts: [makeScript("letter_01"), makeScript("letter_02")],
        modules: [tracker.module],
      }),
    );

    fireOnScriptStart(ctx, "letter_01");
    fireOnScriptStart(ctx, "letter_02");
    fireOnScriptStart(ctx, "letter_01");

    const events = tracker.events.filter((e) => e.hook === "onScriptStart");
    expect(events).toHaveLength(2);
    expect(events.map((e) => (e as { scriptId: string }).scriptId)).toEqual([
      "letter_01",
      "letter_02",
    ]);
  });

  test("fireOnScriptComplete clears the dedup entry → re-entry re-fires", () => {
    const tracker = trackerModule();
    const ctx = makeCtx(
      makeGame({
        characters: [makeCharacter("a")],
        scripts: [makeScript("letter_01")],
        modules: [tracker.module],
      }),
    );

    fireOnScriptStart(ctx, "letter_01");
    fireOnScriptComplete(ctx, "letter_01");
    fireOnScriptStart(ctx, "letter_01");

    const startEvents = tracker.events.filter(
      (e) => e.hook === "onScriptStart",
    );
    expect(startEvents).toHaveLength(2);
    expect(ctx.state.runtime.firedScriptStarts).toEqual(["letter_01"]);
  });

  test("hook that pushes pendingNarrations doesn't double-push", () => {
    // The motivating bug: a module's onScriptStart unshifts a header
    // into pendingNarrations. Without dedup, every step's re-entry
    // would push another header — queue grows unboundedly and consumes
    // the player's input meant for the script's first beat.
    let pushCount = 0;
    const ctx = makeCtx(
      makeGame({
        characters: [makeCharacter("a")],
        scripts: [makeScript("letter_01")],
        modules: [
          {
            id: "header-pusher",
            onScriptStart: (c, scriptId) => {
              if (scriptId.startsWith("letter_")) {
                c.state.runtime.pendingNarrations.unshift("HEADER");
                pushCount += 1;
              }
            },
          },
        ],
      }),
    );

    for (let i = 0; i < 5; i += 1) fireOnScriptStart(ctx, "letter_01");
    expect(pushCount).toBe(1);
    expect(
      ctx.state.runtime.pendingNarrations.filter((n) => n === "HEADER"),
    ).toHaveLength(1);
  });

  test("a reentrant hook cannot recursively fire the same script entry", () => {
    let calls = 0;
    const game = makeGame({
      modules: [{
        id: "reentrant",
        onScriptStart: (ctx, scriptId) => {
          calls += 1;
          fireOnScriptStart(ctx, scriptId);
        },
      }],
    });
    const ctx = makeCtx(game);

    fireOnScriptStart(ctx, "letter_01");

    expect(calls).toBe(1);
    expect(ctx.state.runtime.firedScriptStarts).toEqual(["letter_01"]);
  });
});
