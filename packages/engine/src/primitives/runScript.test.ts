import { describe, expect, test } from "bun:test";
import {
  makeCharacter,
  makeCtx,
  makeGame,
  makeScript,
} from "../test-utils";
import type { Beat } from "../types";
import { runScript } from "./runScript";

async function drive<I, O>(
  gen: AsyncGenerator<O, boolean, I>,
  inputs: I[],
): Promise<{ outputs: O[]; finished: boolean | undefined }> {
  const outputs: O[] = [];
  let r = await gen.next();
  let i = 0;
  while (!r.done && i < inputs.length + 20) {
    outputs.push(r.value);
    const input = inputs[i] ?? (undefined as unknown as I);
    r = await gen.next(input);
    i++;
  }
  return { outputs, finished: r.done ? r.value : undefined };
}

describe("runScript — narration / dialogue input protocol", () => {
  test("narration advances only on `next`", async () => {
    const beats: Beat[] = [
      { type: "narration", text: "line one" },
      { type: "narration", text: "line two" },
      { type: "endScript" },
    ];
    const ctx = makeCtx(
      makeGame({
        characters: [makeCharacter("a")],
        scripts: [makeScript("s1", { beats })],
      }),
    );
    ctx.state.baseline.currentScriptId = "s1";
    const script = ctx.scriptMap.get("s1")!;
    // Send doActivity while narration is yielded — should re-yield
    // same narration. Then next to advance.
    const { outputs, finished } = await drive(runScript(ctx, script), [
      { type: "doActivity", id: "x" },
      { type: "next" },
      { type: "next" },
    ]);
    expect(finished).toBe(true);
    expect(outputs.map((o) => (o as { text: string }).text)).toEqual([
      "line one",
      "line one",
      "line two",
    ]);
  });

  test("dialogue advances only on `next`", async () => {
    const beats: Beat[] = [
      { type: "dialogue", speaker: "a", text: "hi" },
      { type: "endScript" },
    ];
    const ctx = makeCtx(
      makeGame({
        characters: [makeCharacter("a")],
        scripts: [makeScript("s1", { beats })],
      }),
    );
    ctx.state.baseline.currentScriptId = "s1";
    const script = ctx.scriptMap.get("s1")!;
    const { outputs, finished } = await drive(runScript(ctx, script), [
      { type: "choose", index: 0 },
      { type: "next" },
    ]);
    expect(finished).toBe(true);
    // First yield = dialogue. Second yield = same dialogue (choose was
    // ignored). Then next ends the script.
    expect(outputs).toHaveLength(2);
    expect(outputs[0]?.type).toBe("dialogue");
    expect(outputs[1]?.type).toBe("dialogue");
  });

  test("quit on narration still terminates", async () => {
    const beats: Beat[] = [
      { type: "narration", text: "one" },
      { type: "endScript" },
    ];
    const ctx = makeCtx(
      makeGame({
        characters: [makeCharacter("a")],
        scripts: [makeScript("s1", { beats })],
      }),
    );
    ctx.state.baseline.currentScriptId = "s1";
    const script = ctx.scriptMap.get("s1")!;
    const { finished } = await drive(runScript(ctx, script), [
      { type: "quit" },
    ]);
    expect(finished).toBe(false);
  });
});

describe("runScript — machine-readable choice consequences", () => {
  test("yields authored effects and branch targets without requiring source inspection", async () => {
    const beats: Beat[] = [
      {
        type: "choice",
        prompt: "answer",
        options: [
          {
            text: "stay",
            effects: { characterStats: { a: { affection: 2 } } },
            goto: "after",
          },
          { text: "leave", goto: "$end" },
        ],
      },
      { type: "label", name: "after" },
      { type: "endScript" },
    ];
    const ctx = makeCtx(
      makeGame({
        characters: [makeCharacter("a")],
        scripts: [makeScript("s1", { beats })],
      }),
    );
    ctx.state.baseline.currentScriptId = "s1";

    const { outputs } = await drive(runScript(ctx, ctx.scriptMap.get("s1")!), [
      { type: "quit" },
    ]);

    expect(outputs[0]).toMatchObject({
      type: "choice",
      options: [
        {
          text: "stay",
          available: true,
          consequence: {
            effects: { characterStats: { a: { affection: 2 } } },
            goto: "after",
          },
        },
        {
          text: "leave",
          available: true,
          consequence: { goto: "$end" },
        },
      ],
    });
  });
});

describe("runScript — inline emotion slot resolution", () => {
  const cast = () => [
    makeCharacter("a", {
      portraits: {
        default: "assets/portraits/a-default",
        smile: "assets/portraits/a-smile",
      },
    }),
    makeCharacter("b", {
      portraits: { default: "assets/portraits/b-default" },
    }),
  ];

  test("speaker seeded in a side slot swaps that slot, not center", async () => {
    const beats: Beat[] = [
      { type: "setPortrait", slot: "left", characterId: "a", emotion: "default" },
      { type: "setPortrait", slot: "right", characterId: "b", emotion: "default" },
      { type: "dialogue", speaker: "a", text: "hi", candidateEmotion: "smile" },
      { type: "endScript" },
    ];
    const ctx = makeCtx(
      makeGame({ characters: cast(), scripts: [makeScript("s1", { beats })] }),
    );
    ctx.state.baseline.currentScriptId = "s1";
    const script = ctx.scriptMap.get("s1")!;
    const { outputs } = await drive(runScript(ctx, script), [{ type: "next" }]);
    const dialogue = outputs[0] as { visualState: { portraits: unknown } };
    expect(dialogue.visualState.portraits).toEqual({
      left: "assets/portraits/a-smile",
      right: "assets/portraits/b-default",
    });
  });

  test("speaker not on stage falls back to center", async () => {
    const beats: Beat[] = [
      { type: "setPortrait", slot: "right", characterId: "b", emotion: "default" },
      { type: "dialogue", speaker: "a", text: "hi", candidateEmotion: "smile" },
      { type: "endScript" },
    ];
    const ctx = makeCtx(
      makeGame({ characters: cast(), scripts: [makeScript("s1", { beats })] }),
    );
    ctx.state.baseline.currentScriptId = "s1";
    const script = ctx.scriptMap.get("s1")!;
    const { outputs } = await drive(runScript(ctx, script), [{ type: "next" }]);
    const dialogue = outputs[0] as { visualState: { portraits: unknown } };
    expect(dialogue.visualState.portraits).toEqual({
      right: "assets/portraits/b-default",
      center: "assets/portraits/a-smile",
    });
  });
});

describe("runScript — stage teardown on script end", () => {
  test("portraits and cg clear when the script finishes; bg stays", async () => {
    const beats: Beat[] = [
      { type: "setBg", assetPath: "assets/backgrounds/inn" },
      { type: "setPortrait", slot: "center", characterId: "a", emotion: "default" },
      { type: "showCg", assetPath: "assets/cgs/x" },
      { type: "dialogue", speaker: "a", text: "hi" },
      { type: "endScript" },
    ];
    const ctx = makeCtx(
      makeGame({
        characters: [
          makeCharacter("a", {
            portraits: { default: "assets/portraits/a-default" },
          }),
        ],
        scripts: [makeScript("s1", { beats })],
      }),
    );
    ctx.state.baseline.currentScriptId = "s1";
    const script = ctx.scriptMap.get("s1")!;
    const { outputs, finished } = await drive(runScript(ctx, script), [
      { type: "next" },
    ]);
    expect(finished).toBe(true);
    // The dialogue rendered with the full stage…
    const dialogue = outputs[0] as {
      visualState: { portraits: unknown; cg: unknown };
    };
    expect(dialogue.visualState.portraits).toEqual({
      center: "assets/portraits/a-default",
    });
    expect(dialogue.visualState.cg).toBe("assets/cgs/x");
    // …and the finished script left only the bg behind.
    expect(ctx.state.baseline.visuals).toEqual({
      bg: "assets/backgrounds/inn",
      portraits: {},
      cg: null,
    });
  });

  test("quit does not tear down the stage (script resumes later)", async () => {
    const beats: Beat[] = [
      { type: "setPortrait", slot: "center", characterId: "a", emotion: "default" },
      { type: "dialogue", speaker: "a", text: "hi" },
      { type: "endScript" },
    ];
    const ctx = makeCtx(
      makeGame({
        characters: [
          makeCharacter("a", {
            portraits: { default: "assets/portraits/a-default" },
          }),
        ],
        scripts: [makeScript("s1", { beats })],
      }),
    );
    ctx.state.baseline.currentScriptId = "s1";
    const script = ctx.scriptMap.get("s1")!;
    const { finished } = await drive(runScript(ctx, script), [
      { type: "quit" },
    ]);
    expect(finished).toBe(false);
    expect(ctx.state.baseline.visuals.portraits).toEqual({
      center: "assets/portraits/a-default",
    });
  });
});

describe("runScript — semantic cursor migration after hot edits", () => {
  test("relocates the visible beat when earlier beats were inserted", async () => {
    const oldGame = makeGame({
      scripts: [
        makeScript("s1", {
          beats: [
            { type: "narration", text: "first" },
            { type: "narration", text: "current" },
            { type: "endScript" },
          ],
        }),
      ],
    });
    const oldCtx = makeCtx(oldGame);
    oldCtx.state.baseline.currentScriptId = "s1";
    const oldRun = runScript(oldCtx, oldGame.scripts[0]!);
    expect((await oldRun.next()).value).toMatchObject({ text: "first" });
    expect((await oldRun.next({ type: "next" })).value).toMatchObject({
      text: "current",
    });

    const editedGame = makeGame({
      scripts: [
        makeScript("s1", {
          beats: [
            { type: "narration", text: "first" },
            { type: "narration", text: "new earlier beat" },
            { type: "narration", text: "current" },
            { type: "endScript" },
          ],
        }),
      ],
    });
    const editedCtx = makeCtx(editedGame, { state: oldCtx.state });
    const resumed = await runScript(
      editedCtx,
      editedGame.scripts[0]!,
    ).next();
    expect(resumed.value).toMatchObject({ text: "current" });
    expect(editedCtx.state.baseline.beatIndex).toBe(2);
  });

  test("replays newly inserted visual setup before the relocated beat", async () => {
    const oldGame = makeGame({
      scripts: [
        makeScript("s1", {
          beats: [
            { type: "narration", text: "current" },
            { type: "endScript" },
          ],
        }),
      ],
    });
    const oldCtx = makeCtx(oldGame);
    oldCtx.state.baseline.currentScriptId = "s1";
    oldCtx.state.baseline.visuals.bg = "assets/backgrounds/old";
    await runScript(oldCtx, oldGame.scripts[0]!).next();

    const editedGame = makeGame({
      scripts: [
        makeScript("s1", {
          beats: [
            { type: "setBg", assetPath: "assets/backgrounds/new" },
            { type: "showCg", assetPath: "assets/cgs/new" },
            { type: "narration", text: "current" },
            { type: "endScript" },
          ],
        }),
      ],
    });
    const editedCtx = makeCtx(editedGame, { state: oldCtx.state });
    const resumed = await runScript(
      editedCtx,
      editedGame.scripts[0]!,
    ).next();

    expect(resumed.value).toMatchObject({
      type: "narration",
      text: "current",
      visualState: {
        bg: "assets/backgrounds/new",
        cg: "assets/cgs/new",
      },
    });
    expect(editedCtx.state.baseline.beatIndex).toBe(2);
  });

  test("replays an edited visual path even when the visible beat text is unchanged", async () => {
    const oldGame = makeGame({
      scripts: [
        makeScript("s1", {
          beats: [
            { type: "showCg", assetPath: "assets/cgs/old-road" },
            { type: "narration", text: "before" },
            {
              type: "choice",
              prompt: "Reply?",
              options: [{ text: "Stay silent" }],
            },
            { type: "dialogue", speaker: "a", text: "current" },
            { type: "endScript" },
          ],
        }),
      ],
      characters: [makeCharacter("a")],
    });
    const oldCtx = makeCtx(oldGame);
    oldCtx.state.baseline.currentScriptId = "s1";
    const oldRun = runScript(oldCtx, oldGame.scripts[0]!);
    await oldRun.next();
    await oldRun.next({ type: "next" });
    expect((await oldRun.next({ type: "choose", index: 0 })).value).toMatchObject({
      text: "current",
      visualState: { cg: "assets/cgs/old-road" },
    });

    const editedGame = makeGame({
      scripts: [
        makeScript("s1", {
          beats: [
            { type: "hideCg" },
            {
              type: "setPortrait",
              slot: "center",
              assetPath: "assets/portraits/a-default",
            },
            { type: "narration", text: "before" },
            {
              type: "choice",
              prompt: "Reply?",
              options: [{ text: "Stay silent" }],
            },
            { type: "dialogue", speaker: "a", text: "current" },
            { type: "endScript" },
          ],
        }),
      ],
      characters: [makeCharacter("a")],
    });
    const editedCtx = makeCtx(editedGame, { state: oldCtx.state });
    const resumed = await runScript(
      editedCtx,
      editedGame.scripts[0]!,
    ).next();

    expect(resumed.value).toMatchObject({
      type: "dialogue",
      text: "current",
      visualState: {
        cg: null,
        portraits: { center: "assets/portraits/a-default" },
      },
    });
    expect(editedCtx.state.baseline.beatIndex).toBe(4);
  });

  test("removes a deleted visual directive by replaying from the entry stage", async () => {
    const oldGame = makeGame({
      scripts: [
        makeScript("s1", {
          beats: [
            { type: "showCg", assetPath: "assets/cgs/to-be-deleted" },
            { type: "narration", text: "current" },
            { type: "endScript" },
          ],
        }),
      ],
    });
    const oldCtx = makeCtx(oldGame);
    oldCtx.state.baseline.currentScriptId = "s1";
    oldCtx.state.baseline.visuals.bg = "assets/backgrounds/entry";
    expect((await runScript(oldCtx, oldGame.scripts[0]!).next()).value).toMatchObject({
      visualState: { cg: "assets/cgs/to-be-deleted" },
    });

    const editedGame = makeGame({
      scripts: [
        makeScript("s1", {
          beats: [
            { type: "narration", text: "current" },
            { type: "endScript" },
          ],
        }),
      ],
    });
    const editedCtx = makeCtx(editedGame, { state: oldCtx.state });
    const resumed = await runScript(
      editedCtx,
      editedGame.scripts[0]!,
    ).next();

    expect(resumed.value).toMatchObject({
      text: "current",
      visualState: {
        bg: "assets/backgrounds/entry",
        cg: null,
        portraits: {},
      },
    });
  });

  test("uses the selected option to enter a newly authored response branch", async () => {
    const optionText = "Keep pace silently";
    const oldGame = makeGame({
      scripts: [
        makeScript("s1", {
          beats: [
            {
              type: "choice",
              prompt: "Reply?",
              options: [{ text: optionText }],
            },
            { type: "dialogue", speaker: "a", text: "old shared reply" },
            { type: "endScript" },
          ],
        }),
      ],
      characters: [makeCharacter("a")],
    });
    const oldCtx = makeCtx(oldGame);
    oldCtx.state.baseline.currentScriptId = "s1";
    const oldRun = runScript(oldCtx, oldGame.scripts[0]!);
    expect((await oldRun.next()).value).toMatchObject({ type: "choice" });
    expect((await oldRun.next({ type: "choose", index: 0 })).value).toMatchObject({
      text: "old shared reply",
    });

    const editedGame = makeGame({
      scripts: [
        makeScript("s1", {
          beats: [
            {
              type: "choice",
              prompt: "Reply?",
              options: [{ text: optionText, goto: "silent" }],
            },
            { type: "label", name: "spoken" },
            { type: "dialogue", speaker: "a", text: "spoken reply" },
            { type: "endScript" },
            { type: "label", name: "silent" },
            { type: "narration", text: "their footsteps align" },
            { type: "endScript" },
          ],
        }),
      ],
      characters: [makeCharacter("a")],
    });
    const editedCtx = makeCtx(editedGame, { state: oldCtx.state });
    const resumed = await runScript(
      editedCtx,
      editedGame.scripts[0]!,
    ).next();
    expect(resumed.value).toMatchObject({
      type: "narration",
      text: "their footsteps align",
    });
    expect(editedCtx.state.baseline.beatIndex).toBe(5);
  });

  test("choice intent wins when the old shared reply remains in another branch", async () => {
    const selectedText = "Try reading the tracks";
    const oldGame = makeGame({
      scripts: [
        makeScript("s1", {
          beats: [
            {
              type: "choice",
              prompt: "Reply?",
              options: [{ text: selectedText }, { text: "Admit defeat" }],
            },
            { type: "dialogue", speaker: "a", text: "old shared reply" },
            { type: "endScript" },
          ],
        }),
      ],
      characters: [makeCharacter("a")],
    });
    const oldCtx = makeCtx(oldGame);
    oldCtx.state.baseline.currentScriptId = "s1";
    const oldRun = runScript(oldCtx, oldGame.scripts[0]!);
    await oldRun.next();
    expect((await oldRun.next({ type: "choose", index: 0 })).value).toMatchObject({
      text: "old shared reply",
    });

    const editedGame = makeGame({
      scripts: [
        makeScript("s1", {
          beats: [
            {
              type: "choice",
              prompt: "Reply?",
              options: [
                { text: selectedText, goto: "learn" },
                { text: "Admit defeat", goto: "honest" },
              ],
            },
            { type: "label", name: "learn" },
            { type: "dialogue", speaker: "a", text: "active instruction" },
            { type: "endScript" },
            { type: "label", name: "honest" },
            { type: "dialogue", speaker: "a", text: "old shared reply" },
            { type: "endScript" },
          ],
        }),
      ],
      characters: [makeCharacter("a")],
    });
    const editedCtx = makeCtx(editedGame, { state: oldCtx.state });
    const resumed = await runScript(
      editedCtx,
      editedGame.scripts[0]!,
    ).next();

    expect(resumed.value).toMatchObject({
      type: "dialogue",
      text: "active instruction",
    });
    expect(editedCtx.state.baseline.beatIndex).toBe(2);
  });

  test("resumes an in-place edit to the currently visible narration", async () => {
    const oldGame = makeGame({
      scripts: [
        makeScript("s1", {
          beats: [
            { type: "narration", text: "state-inaccurate old prose" },
            { type: "narration", text: "next anchor" },
            { type: "endScript" },
          ],
        }),
      ],
    });
    const oldCtx = makeCtx(oldGame);
    oldCtx.state.baseline.currentScriptId = "s1";
    await runScript(oldCtx, oldGame.scripts[0]!).next();

    const editedGame = makeGame({
      scripts: [
        makeScript("s1", {
          beats: [
            { type: "narration", text: "state-aware corrected prose" },
            { type: "narration", text: "next anchor" },
            { type: "endScript" },
          ],
        }),
      ],
    });
    const editedCtx = makeCtx(editedGame, { state: oldCtx.state });
    const resumed = await runScript(editedCtx, editedGame.scripts[0]!).next();
    expect(resumed.value).toMatchObject({
      type: "narration",
      text: "state-aware corrected prose",
    });
    expect(editedCtx.state.baseline.beatIndex).toBe(0);
  });

  test("rejects same-type prose replacement when adjacent structure also changed", async () => {
    const oldGame = makeGame({
      scripts: [makeScript("s1", { beats: [
        { type: "narration", text: "old current" },
        { type: "narration", text: "old next" },
        { type: "endScript" },
      ] })],
    });
    const oldCtx = makeCtx(oldGame);
    oldCtx.state.baseline.currentScriptId = "s1";
    await runScript(oldCtx, oldGame.scripts[0]!).next();

    const rewrittenGame = makeGame({
      scripts: [makeScript("s1", { beats: [
        { type: "narration", text: "new current" },
        { type: "narration", text: "new next" },
        { type: "endScript" },
      ] })],
    });
    const rewrittenCtx = makeCtx(rewrittenGame, { state: oldCtx.state });
    expect(
      runScript(rewrittenCtx, rewrittenGame.scripts[0]!).next(),
    ).rejects.toThrow("script migration required");
  });

  test("fails explicitly when the changed current beat has a different structure", async () => {
    const oldGame = makeGame({
      scripts: [
        makeScript("s1", {
          beats: [
            { type: "narration", text: "old current beat" },
            { type: "endScript" },
          ],
        }),
      ],
    });
    const oldCtx = makeCtx(oldGame);
    oldCtx.state.baseline.currentScriptId = "s1";
    await runScript(oldCtx, oldGame.scripts[0]!).next();

    const editedGame = makeGame({
      scripts: [
        makeScript("s1", {
          beats: [
            { type: "dialogue", speaker: "a", text: "replacement with no anchor" },
            { type: "endScript" },
          ],
        }),
      ],
      characters: [makeCharacter("a")],
    });
    const editedCtx = makeCtx(editedGame, { state: oldCtx.state });
    expect(
      runScript(editedCtx, editedGame.scripts[0]!).next(),
    ).rejects.toThrow("script migration required");
  });
});
