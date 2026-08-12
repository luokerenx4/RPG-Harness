import { describe, expect, test } from "bun:test";
import { parseScript, ScriptParseError } from "./script";

// Helper: build a script source string with frontmatter + body without
// having to fight indentation in template literals.
function source(
  frontmatter: string,
  body: string,
): string {
  return `---\n${frontmatter}\n---\n\n${body}`;
}

describe("parseScript — frontmatter", () => {
  test("parses id + title", () => {
    const s = parseScript(source("id: 001_intro\ntitle: 樱花树下", ""));
    expect(s.id).toBe("001_intro");
    expect(s.title).toBe("樱花树下");
    expect(s.beats).toEqual([]);
  });

  test("throws on missing id", () => {
    expect(() =>
      parseScript(source("title: x", "")),
    ).toThrow(ScriptParseError);
  });

  test("throws on missing title", () => {
    expect(() =>
      parseScript(source("id: x", "")),
    ).toThrow(ScriptParseError);
  });

  test("parses characters list", () => {
    const s = parseScript(
      source("id: x\ntitle: t\ncharacters: [alice, bea]", ""),
    );
    expect(s.characters).toEqual(["alice", "bea"]);
  });

  test("characters must be array of strings", () => {
    expect(() =>
      parseScript(
        source("id: x\ntitle: t\ncharacters: [1, 2]", ""),
      ),
    ).toThrow(/characters/);
  });

  test("parses requires", () => {
    const s = parseScript(
      source(
        "id: x\ntitle: t\nrequires:\n  scriptCompleted: \"000_intro\"",
        "",
      ),
    );
    expect(s.requires).toEqual({ scriptCompleted: "000_intro" });
  });
});

describe("parseScript — beat splitting", () => {
  test("paragraphs separated by blank lines become individual beats", () => {
    const s = parseScript(
      source(
        "id: x\ntitle: t",
        "第一段narration。\n\n第二段narration。",
      ),
    );
    expect(s.beats).toHaveLength(2);
    expect(s.beats[0]).toEqual({ type: "narration", text: "第一段narration。" });
    expect(s.beats[1]).toEqual({
      type: "narration",
      text: "第二段narration。",
    });
  });

  test("multi-line narration in a single block", () => {
    const s = parseScript(
      source("id: x\ntitle: t", "第一行\n第二行"),
    );
    expect(s.beats).toHaveLength(1);
    expect(s.beats[0]).toEqual({
      type: "narration",
      text: "第一行\n第二行",
    });
  });

  test("@speaker prefix → dialogue beat", () => {
    const s = parseScript(
      source("id: x\ntitle: t", "@alice 嗨。你好吗？"),
    );
    expect(s.beats[0]).toEqual({
      type: "dialogue",
      speaker: "alice",
      text: "嗨。你好吗？",
    });
  });

  test("@speaker with continuation lines", () => {
    const s = parseScript(
      source("id: x\ntitle: t", "@alice 嗨。\n你好吗？"),
    );
    expect(s.beats[0]).toEqual({
      type: "dialogue",
      speaker: "alice",
      text: "嗨。\n你好吗？",
    });
  });

  test("[end] → endScript beat", () => {
    const s = parseScript(
      source("id: x\ntitle: t", "narration\n\n[end]\n\nafter"),
    );
    const types = s.beats.map((b) => b.type);
    expect(types).toEqual(["narration", "endScript", "narration"]);
  });

  test("# label → label beat", () => {
    const s = parseScript(
      source("id: x\ntitle: t", "# leave\n\n你转身离开。"),
    );
    expect(s.beats[0]).toEqual({ type: "label", name: "leave" });
    expect(s.beats[1]?.type).toBe("narration");
  });
});

describe("parseScript — choice (? prompt)", () => {
  test("basic choice with text-only options", () => {
    const s = parseScript(
      source(
        "id: x\ntitle: t",
        "? 你怎么回应？\n- 嗯，很美\n- 只是路过",
      ),
    );
    expect(s.beats[0]).toEqual({
      type: "choice",
      prompt: "你怎么回应？",
      options: [{ text: "嗯，很美" }, { text: "只是路过" }],
    });
  });

  test("inline effect: +alice", () => {
    const s = parseScript(
      source(
        "id: x\ntitle: t",
        "? prompt\n- 答应 -> +alice",
      ),
    );
    expect(s.beats[0]).toEqual({
      type: "choice",
      prompt: "prompt",
      options: [
        {
          text: "答应",
          effects: { characterStats: { alice: { affection: 1 } } },
        },
      ],
    });
  });

  test("inline magnitude: +2alice", () => {
    const s = parseScript(
      source(
        "id: x\ntitle: t",
        "? prompt\n- 强烈赞同 -> +2alice",
      ),
    );
    const beat = s.beats[0];
    expect(beat?.type).toBe("choice");
    if (!beat || beat.type !== "choice") throw new Error();
    expect(beat.options[0]?.effects).toEqual({
      characterStats: { alice: { affection: 2 } },
    });
  });

  test("goto target", () => {
    const s = parseScript(
      source(
        "id: x\ntitle: t",
        "? prompt\n- 离开 -> goto leave",
      ),
    );
    const beat = s.beats[0];
    if (!beat || beat.type !== "choice") throw new Error();
    expect(beat.options[0]).toEqual({
      text: "离开",
      goto: "leave",
    });
  });

  test("trailing {view: grid} annotation is parsed and stripped from prompt", () => {
    const s = parseScript(
      source(
        "id: x\ntitle: t",
        "? 你怎么做？ {view: grid}\n- 上\n- 下",
      ),
    );
    const beat = s.beats[0];
    if (!beat || beat.type !== "choice") throw new Error();
    expect(beat.prompt).toBe("你怎么做？");
    expect(beat.view).toBe("grid");
  });

  test("annotation works on a prompt-less ? line", () => {
    const s = parseScript(
      source(
        "id: x\ntitle: t",
        "? {view: grid}\n- a\n- b",
      ),
    );
    const beat = s.beats[0];
    if (!beat || beat.type !== "choice") throw new Error();
    expect(beat.prompt).toBeUndefined();
    expect(beat.view).toBe("grid");
  });

  test("unknown annotation key throws", () => {
    expect(() =>
      parseScript(
        source(
          "id: x\ntitle: t",
          "? prompt {wat: 1}\n- a",
        ),
      ),
    ).toThrow(/Unknown prompt annotation/);
  });

  test("empty view value throws", () => {
    expect(() =>
      parseScript(
        source("id: x\ntitle: t", "? prompt {view: }\n- a"),
      ),
    ).toThrow(/`view` is empty/);
  });

  test("non-option line in choice block throws", () => {
    expect(() =>
      parseScript(
        source(
          "id: x\ntitle: t",
          "? prompt\n- 第一项\nthis is not an option",
        ),
      ),
    ).toThrow(/non-option line/);
  });
});

describe("parseScript — fenced YAML choice", () => {
  test("requires + effects + goto", () => {
    const body = [
      "```yaml",
      "type: choice",
      "prompt: 你怎么选？",
      "options:",
      "  - text: 答应碧河",
      "    effects:",
      "      variables: { route: bea }",
      "    goto: pick_bea",
      "  - text: 跟薄樱走",
      "    requires:",
      "      affection: { character: alice, min: 2 }",
      "    effects:",
      "      variables: { route: alice }",
      "    goto: pick_alice",
      "```",
    ].join("\n");
    const s = parseScript(source("id: x\ntitle: t", body));
    expect(s.beats).toHaveLength(1);
    const beat = s.beats[0];
    if (!beat || beat.type !== "choice") throw new Error();
    expect(beat.prompt).toBe("你怎么选？");
    expect(beat.options).toHaveLength(2);
    expect(beat.options[1]?.requires).toEqual({
      affection: { character: "alice", min: 2 },
    });
    expect(beat.options[0]?.effects).toEqual({
      variables: { route: "bea" },
    });
    expect(beat.options[0]?.goto).toBe("pick_bea");
  });

  test("missing type in fence throws", () => {
    const body = "```yaml\noptions: []\n```";
    expect(() =>
      parseScript(source("id: x\ntitle: t", body)),
    ).toThrow(/must have a `type` field/);
  });

  test("unknown fence type throws", () => {
    const body = "```yaml\ntype: bogus\n```";
    expect(() =>
      parseScript(source("id: x\ntitle: t", body)),
    ).toThrow(/Unknown fenced beat type/);
  });

  test("effects fence stands alone", () => {
    const body = [
      "```yaml",
      "type: effects",
      "effects:",
      "  switches: { unlocked: true }",
      "  affection: { alice: 1 }",
      "```",
    ].join("\n");
    const s = parseScript(source("id: x\ntitle: t", body));
    expect(s.beats[0]).toEqual({
      type: "effects",
      effects: {
        switches: { unlocked: true },
        characterStats: { alice: { affection: 1 } },
      },
    });
  });

  test("clear fence", () => {
    const body = "```yaml\ntype: clear\n```";
    const s = parseScript(source("id: x\ntitle: t", body));
    expect(s.beats[0]).toEqual({ type: "clear" });
  });
});

describe("parseScript — visual frontmatter", () => {
  test("bg in frontmatter prepends a setBg beat", () => {
    const s = parseScript(
      source(
        "id: x\ntitle: t\nbg: assets/backgrounds/mura-yugata",
        "narration here",
      ),
    );
    expect(s.beats[0]).toEqual({
      type: "setBg",
      assetPath: "assets/backgrounds/mura-yugata",
    });
    expect(s.beats[1]).toEqual({ type: "narration", text: "narration here" });
  });

  test("defaultPortraits prepends setPortrait beats", () => {
    const s = parseScript(
      source(
        [
          "id: x",
          "title: t",
          "defaultPortraits:",
          "  center: { characterId: kagari, emotion: smile }",
        ].join("\n"),
        "@kagari hello",
      ),
    );
    expect(s.beats[0]).toEqual({
      type: "setPortrait",
      slot: "center",
      characterId: "kagari",
      emotion: "smile",
    });
  });

  test("bg + defaultPortraits both seed beats", () => {
    const s = parseScript(
      source(
        [
          "id: x",
          "title: t",
          "bg: assets/backgrounds/mura",
          "defaultPortraits:",
          "  center: { characterId: kagari, emotion: smile }",
        ].join("\n"),
        "",
      ),
    );
    expect(s.beats).toEqual([
      { type: "setBg", assetPath: "assets/backgrounds/mura" },
      {
        type: "setPortrait",
        slot: "center",
        characterId: "kagari",
        emotion: "smile",
      },
    ]);
  });

  test("empty bg throws", () => {
    expect(() =>
      parseScript(source("id: x\ntitle: t\nbg: ''", "")),
    ).toThrow(/bg/);
  });

  test("defaultPortraits list form: single entry lands in center", () => {
    const s = parseScript(
      source(
        [
          "id: x",
          "title: t",
          "defaultPortraits:",
          "  - { characterId: kagari, emotion: smile }",
        ].join("\n"),
        "",
      ),
    );
    expect(s.beats).toEqual([
      { type: "setPortrait", slot: "center", characterId: "kagari", emotion: "smile" },
    ]);
  });

  test("defaultPortraits list form: two entries auto-spread left/right", () => {
    const s = parseScript(
      source(
        [
          "id: x",
          "title: t",
          "defaultPortraits:",
          "  - { characterId: kagari, emotion: default }",
          "  - { characterId: kasumi, emotion: smile }",
        ].join("\n"),
        "",
      ),
    );
    expect(s.beats).toEqual([
      { type: "setPortrait", slot: "left", characterId: "kagari", emotion: "default" },
      { type: "setPortrait", slot: "right", characterId: "kasumi", emotion: "smile" },
    ]);
  });

  test("defaultPortraits list form: three entries fill left/center/right", () => {
    const s = parseScript(
      source(
        [
          "id: x",
          "title: t",
          "defaultPortraits:",
          "  - { characterId: kagari, emotion: default }",
          "  - { characterId: mio, emotion: default }",
          "  - { characterId: kasumi, emotion: default }",
        ].join("\n"),
        "",
      ),
    );
    expect(s.beats.map((b) => (b as { slot: string }).slot)).toEqual([
      "left",
      "center",
      "right",
    ]);
  });

  test("defaultPortraits list form: four+ entries use pos-N in order", () => {
    const s = parseScript(
      source(
        [
          "id: x",
          "title: t",
          "defaultPortraits:",
          "  - { characterId: a, emotion: default }",
          "  - { characterId: b, emotion: default }",
          "  - { characterId: c, emotion: default }",
          "  - { characterId: d, emotion: default }",
        ].join("\n"),
        "",
      ),
    );
    expect(s.beats.map((b) => (b as { slot: string }).slot)).toEqual([
      "pos-1",
      "pos-2",
      "pos-3",
      "pos-4",
    ]);
  });

  test("defaultPortraits list entry missing emotion throws", () => {
    expect(() =>
      parseScript(
        source(
          [
            "id: x",
            "title: t",
            "defaultPortraits:",
            "  - { characterId: kagari }",
          ].join("\n"),
          "",
        ),
      ),
    ).toThrow(/emotion/);
  });

  test("defaultPortraits missing characterId throws", () => {
    expect(() =>
      parseScript(
        source(
          [
            "id: x",
            "title: t",
            "defaultPortraits:",
            "  center: { emotion: smile }",
          ].join("\n"),
          "",
        ),
      ),
    ).toThrow(/characterId/);
  });
});

describe("parseScript — inline emotion", () => {
  test("@speaker emotion text → dialogue with candidateEmotion", () => {
    const s = parseScript(
      source("id: x\ntitle: t", "@kagari smile こんにちは"),
    );
    expect(s.beats).toHaveLength(1);
    expect(s.beats[0]).toEqual({
      type: "dialogue",
      speaker: "kagari",
      text: "こんにちは",
      candidateEmotion: "smile",
    });
  });

  test("@speaker text — second token always becomes candidateEmotion when it matches the ident shape", () => {
    // "hello" matches /^[a-z][\w-]*$/ so parser emits it as candidate;
    // engine decides at runtime whether to keep it as a portrait
    // selector or restore it to the dialogue text.
    const s = parseScript(source("id: x\ntitle: t", "@kagari hello"));
    expect(s.beats).toHaveLength(1);
    expect(s.beats[0]).toEqual({
      type: "dialogue",
      speaker: "kagari",
      text: "",
      candidateEmotion: "hello",
    });
  });

  test("uppercase or punctuated second token is NOT treated as candidate", () => {
    // "Hello" starts with capital → not an emotion candidate.
    const s = parseScript(source("id: x\ntitle: t", "@kagari Hello world"));
    expect(s.beats).toHaveLength(1);
    expect(s.beats[0]).toEqual({
      type: "dialogue",
      speaker: "kagari",
      text: "Hello world",
    });
  });

  test("hyphenated emotion accepted", () => {
    const s = parseScript(
      source("id: x\ntitle: t", "@kagari half-smile うん"),
    );
    expect((s.beats[0] as { candidateEmotion?: string }).candidateEmotion).toBe(
      "half-smile",
    );
  });

  test("dialogue starting with 「 — first token is the bracket, no emotion", () => {
    const s = parseScript(
      source("id: x\ntitle: t", "@kagari 「下がれ」"),
    );
    expect(s.beats).toHaveLength(1);
    expect(s.beats[0]).toEqual({
      type: "dialogue",
      speaker: "kagari",
      text: "「下がれ」",
    });
  });

  test("emotion + bracket text — candidate set, text is the bracketed body", () => {
    const s = parseScript(
      source("id: x\ntitle: t", "@kagari smile 「下がれ」"),
    );
    expect(s.beats).toHaveLength(1);
    expect(s.beats[0]).toEqual({
      type: "dialogue",
      speaker: "kagari",
      text: "「下がれ」",
      candidateEmotion: "smile",
    });
  });
});

describe("parseScript — visual directives", () => {
  test(":bg <path> → setBg beat", () => {
    const s = parseScript(
      source("id: x\ntitle: t", ":bg assets/backgrounds/forest"),
    );
    expect(s.beats[0]).toEqual({
      type: "setBg",
      assetPath: "assets/backgrounds/forest",
    });
  });

  test(":bg none → setBg null (explicit clear)", () => {
    const s = parseScript(source("id: x\ntitle: t", ":bg none"));
    expect(s.beats[0]).toEqual({ type: "setBg", assetPath: null });
  });

  test(":cg <path> → showCg", () => {
    const s = parseScript(
      source("id: x\ntitle: t", ":cg assets/cgs/first-encounter"),
    );
    expect(s.beats[0]).toEqual({
      type: "showCg",
      assetPath: "assets/cgs/first-encounter",
    });
  });

  test(":hide-cg → hideCg", () => {
    const s = parseScript(source("id: x\ntitle: t", ":hide-cg"));
    expect(s.beats[0]).toEqual({ type: "hideCg" });
  });

  test(":portrait <slot> <path> → explicit setPortrait", () => {
    const s = parseScript(
      source("id: x\ntitle: t", ":portrait left assets/portraits/k-smile"),
    );
    expect(s.beats[0]).toEqual({
      type: "setPortrait",
      slot: "left",
      assetPath: "assets/portraits/k-smile",
    });
  });

  test(":portrait <slot> (no path) clears the slot", () => {
    const s = parseScript(source("id: x\ntitle: t", ":portrait left"));
    expect(s.beats[0]).toEqual({
      type: "setPortrait",
      slot: "left",
      assetPath: null,
    });
  });

  test(":clear-visuals → clearVisuals", () => {
    const s = parseScript(source("id: x\ntitle: t", ":clear-visuals"));
    expect(s.beats[0]).toEqual({ type: "clearVisuals" });
  });

  test("multiple directives separated by blank lines produce separate beats", () => {
    const s = parseScript(
      source(
        "id: x\ntitle: t",
        ":bg assets/bg/a\n\n:portrait center assets/portraits/x\n\n:cg assets/cgs/c",
      ),
    );
    expect(s.beats).toEqual([
      { type: "setBg", assetPath: "assets/bg/a" },
      {
        type: "setPortrait",
        slot: "center",
        assetPath: "assets/portraits/x",
      },
      { type: "showCg", assetPath: "assets/cgs/c" },
    ]);
  });

  test("unknown directive throws", () => {
    expect(() =>
      parseScript(source("id: x\ntitle: t", ":unknownthing foo")),
    ).toThrow(/Unknown directive/);
  });

  test("multi-line directive block throws", () => {
    expect(() =>
      parseScript(
        source("id: x\ntitle: t", ":bg foo\n:cg bar"),
      ),
    ).toThrow(/single line/);
  });
});
