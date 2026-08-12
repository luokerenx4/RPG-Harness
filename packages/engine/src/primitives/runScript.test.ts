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
  test("silent goto converges a branch without yielding a fake choice", async () => {
    const beats: Beat[] = [
      { type: "narration", text: "branch reply" },
      { type: "goto", target: "shared" },
      { type: "narration", text: "must skip" },
      { type: "label", name: "shared" },
      { type: "narration", text: "shared continuation" },
      { type: "endScript" },
    ];
    const ctx = makeCtx(makeGame({ scripts: [makeScript("s1", { beats })] }));
    ctx.state.baseline.currentScriptId = "s1";
    const { outputs, finished } = await drive(runScript(ctx, ctx.scriptMap.get("s1")!), [
      { type: "next" },
      { type: "next" },
    ]);
    expect(finished).toBe(true);
    expect(outputs.map((output) => output.type === "narration" ? output.text : output.type)).toEqual([
      "branch reply",
      "shared continuation",
    ]);
  });

  test("silent goto fails loudly when its label is missing", async () => {
    const beats: Beat[] = [{ type: "goto", target: "missing" }];
    const ctx = makeCtx(makeGame({ scripts: [makeScript("s1", { beats })] }));
    ctx.state.baseline.currentScriptId = "s1";
    await expect(runScript(ctx, ctx.scriptMap.get("s1")!).next()).rejects.toThrow(
      /goto target not found.*missing/,
    );
  });

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
        id: "route-finale",
        prompt: "answer",
        options: [
          {
            id: "stay",
            text: "stay",
            aiPriority: 20,
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
      scriptId: "s1",
      choiceId: "route-finale",
      options: [
        {
          id: "stay",
          text: "stay",
          available: true,
          aiPriority: 20,
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

  test("keeps the machine gate while presenting an authored human lock hint", async () => {
    const requirement = { switch: { name: "befriended_kagari" } } as const;
    const beats: Beat[] = [
      {
        type: "choice",
        options: [
          {
            text: "meet Kagari",
            requires: requirement,
            lockedHint: "篝と共に戦場を生き延びていない。",
          },
        ],
      },
      { type: "endScript" },
    ];
    const ctx = makeCtx(
      makeGame({
        characters: [makeCharacter("a")],
        switches: [
          { id: "befriended_kagari", initial: false },
        ],
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
          text: "meet Kagari",
          available: false,
          lockedReason: "篝と共に戦場を生き延びていない。",
          requires: requirement,
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

  test("relocates a choice after adding lock hints and replays inserted visual setup", async () => {
    const oldGame = makeGame({
      switches: [{ id: "met_a", initial: false }],
      scripts: [
        makeScript("s1", {
          beats: [
            { type: "showCg", assetPath: "assets/cgs/rite" },
            { type: "narration", text: "the rite ends" },
            {
              type: "choice",
              prompt: "Where now?",
              options: [
                {
                  text: "Find A",
                  requires: { switch: { name: "met_a" } },
                  goto: "a",
                },
                { text: "Walk alone", goto: "alone" },
              ],
            },
            { type: "label", name: "a" },
            { type: "endScript" },
            { type: "label", name: "alone" },
            { type: "endScript" },
          ],
        }),
      ],
    });
    const oldCtx = makeCtx(oldGame);
    oldCtx.state.baseline.currentScriptId = "s1";
    const oldRun = runScript(oldCtx, oldGame.scripts[0]!);
    await oldRun.next();
    expect((await oldRun.next({ type: "next" })).value).toMatchObject({
      type: "choice",
      visualState: { cg: "assets/cgs/rite" },
    });

    const editedGame = makeGame({
      switches: [{ id: "met_a", initial: false }],
      scripts: [
        makeScript("s1", {
          beats: [
            { type: "showCg", assetPath: "assets/cgs/rite" },
            { type: "narration", text: "the rite ends" },
            { type: "hideCg" },
            {
              type: "choice",
              prompt: "Where now?",
              options: [
                {
                  text: "Find A",
                  requires: { switch: { name: "met_a" } },
                  lockedHint: "You have not survived a journey together.",
                  goto: "a",
                },
                { text: "Walk alone", goto: "alone" },
              ],
            },
            { type: "label", name: "a" },
            { type: "endScript" },
            { type: "label", name: "alone" },
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
      type: "choice",
      options: [
        {
          text: "Find A",
          available: false,
          lockedReason: "You have not survived a journey together.",
        },
        { text: "Walk alone", available: true },
      ],
      visualState: { cg: null },
    });
    expect(editedCtx.state.baseline.beatIndex).toBe(3);
  });

  test("stable choice id relocates an old checkpoint after branch targets are authored", async () => {
    const oldGame = makeGame({
      scripts: [makeScript("s1", { beats: [
        {
          type: "choice",
          id: "reply",
          prompt: "Reply?",
          options: [
            { id: "yes", text: "Yes" },
            { id: "no", text: "No" },
          ],
        },
        { type: "narration", text: "old shared reply" },
        { type: "endScript" },
      ] })],
    });
    const oldCtx = makeCtx(oldGame);
    oldCtx.state.baseline.currentScriptId = "s1";
    expect((await runScript(oldCtx, oldGame.scripts[0]!).next()).value).toMatchObject({
      type: "choice",
      choiceId: "reply",
    });
    // Simulate a save created before ScriptCursor.choiceId was introduced;
    // its serialized beat anchor still contains the stable authored id.
    delete oldCtx.state.baseline.scriptCursor?.choiceId;

    const editedGame = makeGame({
      scripts: [makeScript("s1", { beats: [
        {
          type: "choice",
          id: "reply",
          prompt: "A better prompt?",
          options: [
            { id: "yes", text: "Absolutely", goto: "yes_reply" },
            { id: "no", text: "Never", goto: "no_reply" },
          ],
        },
        { type: "label", name: "yes_reply" },
        { type: "narration", text: "yes branch" },
        { type: "endScript" },
        { type: "label", name: "no_reply" },
        { type: "narration", text: "no branch" },
        { type: "endScript" },
      ] })],
    });
    const editedCtx = makeCtx(editedGame, { state: oldCtx.state });
    const resumed = await runScript(editedCtx, editedGame.scripts[0]!).next();
    expect(resumed.value).toMatchObject({
      type: "choice",
      choiceId: "reply",
      prompt: "A better prompt?",
    });
  });

  test("stable option id preserves the selected branch across option copy edits", async () => {
    const oldGame = makeGame({
      scripts: [makeScript("s1", { beats: [
        {
          type: "choice",
          id: "reply",
          prompt: "Reply?",
          options: [{ id: "silent", text: "Stay silent", goto: "silent" }],
        },
        { type: "label", name: "silent" },
        { type: "narration", text: "old branch line" },
        { type: "endScript" },
      ] })],
    });
    const oldCtx = makeCtx(oldGame);
    oldCtx.state.baseline.currentScriptId = "s1";
    const oldRun = runScript(oldCtx, oldGame.scripts[0]!);
    await oldRun.next();
    expect((await oldRun.next({ type: "choose", index: 0 })).value).toMatchObject({
      text: "old branch line",
    });
    expect(oldCtx.state.baseline.scriptCursor?.choice).toMatchObject({
      choiceId: "reply",
      optionId: "silent",
    });

    const editedGame = makeGame({
      scripts: [makeScript("s1", { beats: [
        {
          type: "choice",
          id: "reply",
          prompt: "New prompt?",
          options: [{ id: "silent", text: "Say nothing", goto: "silent_new" }],
        },
        { type: "label", name: "silent_new" },
        { type: "narration", text: "new branch line" },
        { type: "endScript" },
      ] })],
    });
    const editedCtx = makeCtx(editedGame, { state: oldCtx.state });
    expect((await runScript(editedCtx, editedGame.scripts[0]!).next()).value).toMatchObject({
      type: "narration",
      text: "new branch line",
    });
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

  test("resumes an old save when a legacy choice gains stable ids", async () => {
    const oldGame = makeGame({
      scripts: [makeScript("s1", { beats: [
        { type: "narration", text: "before" },
        {
          type: "choice",
          prompt: "Choose",
          options: [{ text: "Alpha" }, { text: "Beta" }],
        },
        { type: "endScript" },
      ] })],
    });
    const oldCtx = makeCtx(oldGame);
    oldCtx.state.baseline.currentScriptId = "s1";
    const runner = runScript(oldCtx, oldGame.scripts[0]!);
    await runner.next();
    await runner.next({ type: "next" });

    const editedGame = makeGame({
      scripts: [makeScript("s1", { beats: [
        { type: "narration", text: "before" },
        {
          type: "choice",
          id: "stable-choice",
          prompt: "Choose",
          options: [
            { id: "alpha", text: "Alpha", lockedHint: "New human hint" },
            { id: "beta", text: "Beta" },
          ],
        },
        { type: "endScript" },
      ] })],
    });
    const editedCtx = makeCtx(editedGame, { state: oldCtx.state });
    const resumed = await runScript(editedCtx, editedGame.scripts[0]!).next();

    expect(resumed.value).toMatchObject({
      type: "choice",
      choiceId: "stable-choice",
      options: [{ id: "alpha" }, { id: "beta" }],
    });
    expect(editedCtx.state.baseline.scriptCursor?.choiceId).toBe("stable-choice");
  });

  test("resumes an unresolved legacy choice when stable response branches are authored", async () => {
    const oldGame = makeGame({
      scripts: [makeScript("s1", { beats: [
        {
          type: "choice",
          prompt: "How do you sleep?",
          options: [
            { text: "Avoid dreams", effects: { variables: { trust: 1 } } },
            { text: "Do not sleep", effects: { variables: { trust: 2 } } },
          ],
        },
        { type: "dialogue", speaker: "a", text: "old shared response" },
        { type: "endScript" },
      ] })],
      characters: [makeCharacter("a")],
      variables: [{ id: "trust", type: "number", initial: 0 }],
    });
    const oldCtx = makeCtx(oldGame);
    oldCtx.state.baseline.currentScriptId = "s1";
    expect((await runScript(oldCtx, oldGame.scripts[0]!).next()).value).toMatchObject({
      type: "choice",
      prompt: "How do you sleep?",
    });

    const editedGame = makeGame({
      scripts: [makeScript("s1", { beats: [
        {
          type: "choice",
          id: "sleep",
          prompt: "How do you sleep?",
          options: [
            {
              id: "dreamless",
              text: "Avoid dreams",
              effects: { variables: { trust: 1 } },
              goto: "dreamless",
            },
            {
              id: "awake",
              text: "Do not sleep",
              effects: { variables: { trust: 2 } },
              goto: "awake",
            },
          ],
        },
        { type: "label", name: "dreamless" },
        { type: "dialogue", speaker: "a", text: "Then dream less." },
        { type: "endScript" },
        { type: "label", name: "awake" },
        { type: "dialogue", speaker: "a", text: "Then sleep tonight." },
        { type: "endScript" },
      ] })],
      characters: [makeCharacter("a")],
      variables: [{ id: "trust", type: "number", initial: 0 }],
    });
    const editedCtx = makeCtx(editedGame, { state: oldCtx.state });
    const resumed = await runScript(editedCtx, editedGame.scripts[0]!).next();

    expect(resumed.value).toMatchObject({
      type: "choice",
      choiceId: "sleep",
      options: [{ id: "dreamless" }, { id: "awake" }],
    });
    expect(editedCtx.state.baseline.scriptCursor?.choiceId).toBe("sleep");
  });

  test("rejects legacy branch authoring when an unresolved option effect also changes", async () => {
    const oldGame = makeGame({
      scripts: [makeScript("s1", { beats: [{
        type: "choice",
        prompt: "Choose",
        options: [
          { text: "Alpha", effects: { variables: { trust: 1 } } },
          { text: "Beta" },
        ],
      }, { type: "endScript" }] })],
      variables: [{ id: "trust", type: "number", initial: 0 }],
    });
    const oldCtx = makeCtx(oldGame);
    oldCtx.state.baseline.currentScriptId = "s1";
    await runScript(oldCtx, oldGame.scripts[0]!).next();

    const editedGame = makeGame({
      scripts: [makeScript("s1", { beats: [{
        type: "choice",
        id: "stable",
        prompt: "Choose",
        options: [
          { id: "alpha", text: "Alpha", effects: { variables: { trust: 9 } }, goto: "done" },
          { id: "beta", text: "Beta", goto: "done" },
        ],
      }, { type: "label", name: "done" }, { type: "endScript" }] })],
      variables: [{ id: "trust", type: "number", initial: 0 }],
    });
    const editedCtx = makeCtx(editedGame, { state: oldCtx.state });
    expect(runScript(editedCtx, editedGame.scripts[0]!).next()).rejects.toThrow(
      "script migration required",
    );
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
