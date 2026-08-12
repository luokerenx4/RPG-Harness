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
