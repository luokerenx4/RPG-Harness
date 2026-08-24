import { describe, expect, test } from "bun:test";
import { AssetParseError, parseAssetSpec } from "./asset";

describe("parseAssetSpec — minimal", () => {
  test("minimum required fields produce a valid spec", () => {
    const spec = parseAssetSpec(
      [
        "kind: portrait",
        'description: "a young swordswoman, half body"',
        'prompt: "anime style portrait of a young female swordswoman"',
        'placeholder: "[篝・微笑] 若き女剣士、淡く笑む"',
      ].join("\n"),
      "assets/portraits/kagari-smile",
    );
    expect(spec).toEqual({
      path: "assets/portraits/kagari-smile",
      kind: "portrait",
      description: "a young swordswoman, half body",
      prompt: "anime style portrait of a young female swordswoman",
      placeholder: "[篝・微笑] 若き女剣士、淡く笑む",
    });
  });

  test("path comes from the relPath argument verbatim", () => {
    const spec = parseAssetSpec(
      'kind: bg\ndescription: x\nprompt: y\nplaceholder: z\n',
      "assets/backgrounds/foo",
    );
    expect(spec.path).toBe("assets/backgrounds/foo");
  });
});

describe("parseAssetSpec — kind", () => {
  test("stage, authoring, and map asset kinds are accepted", () => {
    for (const kind of ["portrait", "bg", "cg", "sheet", "sprite", "tileset"] as const) {
      const spec = parseAssetSpec(
        `kind: ${kind}\ndescription: x\nprompt: y\nplaceholder: z\n`,
        `assets/x/y`,
      );
      expect(spec.kind).toBe(kind);
    }
  });

  test("unknown kind throws", () => {
    expect(() =>
      parseAssetSpec(
        "kind: animation\ndescription: x\nprompt: y\nplaceholder: z\n",
        "assets/x/y",
      ),
    ).toThrow(/kind.*portrait.*bg.*cg/);
  });

  test("missing kind throws", () => {
    expect(() =>
      parseAssetSpec("description: x\nprompt: y\nplaceholder: z\n", "x"),
    ).toThrow(AssetParseError);
  });
});

describe("parseAssetSpec — required fields", () => {
  test("missing description throws", () => {
    expect(() =>
      parseAssetSpec(
        "kind: portrait\nprompt: y\nplaceholder: z\n",
        "x",
      ),
    ).toThrow(/description/);
  });

  test("empty placeholder throws", () => {
    expect(() =>
      parseAssetSpec(
        'kind: portrait\ndescription: x\nprompt: y\nplaceholder: ""\n',
        "x",
      ),
    ).toThrow(/placeholder/);
  });
});

describe("parseAssetSpec — snake_case → camelCase", () => {
  test("style_ref → styleRef", () => {
    const spec = parseAssetSpec(
      [
        "kind: portrait",
        "description: x",
        "prompt: y",
        "placeholder: z",
        "style_ref: assets/portraits/kagari-normal",
      ].join("\n"),
      "assets/portraits/kagari-smile",
    );
    expect(spec.styleRef).toBe("assets/portraits/kagari-normal");
    expect((spec as Record<string, unknown>).style_ref).toBeUndefined();
  });

  test("tile_grid → tileGrid for tileset atlases", () => {
    const spec = parseAssetSpec(
      [
        "kind: tileset",
        "description: x",
        "prompt: y",
        "placeholder: z",
        "tile_grid: { columns: 4, rows: 3, first_id: 1 }",
      ].join("\n"),
      "assets/tilesets/shrine",
    );
    expect(spec.tileGrid).toEqual({ columns: 4, rows: 3, firstId: 1 });
    expect((spec as Record<string, unknown>).tile_grid).toBeUndefined();
    expect(() => parseAssetSpec(
      "kind: bg\ndescription: x\nprompt: y\nplaceholder: z\ntile_grid: { columns: 4, rows: 4 }",
      "assets/backgrounds/not-a-tileset",
    )).toThrow(/only valid.*tileset/);
  });

  test("sprite_grid declares a complete explicit directional atlas", () => {
    const spec = parseAssetSpec(
      [
        "kind: sprite",
        "description: Four-direction field sprite",
        "prompt: A compact character atlas",
        'placeholder: "[field sprite]"',
        "sprite_grid:",
        "  columns: 3",
        "  rows: 4",
        "  default_facing: south",
        "  frames: { north: 10, east: 7, south: 1, west: 4 }",
      ].join("\n"),
      "assets/sprites/hero-field",
    );

    expect(spec.spriteGrid).toEqual({
      columns: 3,
      rows: 4,
      defaultFacing: "south",
      frames: { north: 10, east: 7, south: 1, west: 4 },
    });
    expect(spec.custom).toBeUndefined();
  });

  test("keeps generic sprite assets backward-compatible", () => {
    const spec = parseAssetSpec(
      "kind: sprite\ndescription: Static field sprite\nprompt: One transparent image\nplaceholder: '[static sprite]'",
      "assets/sprites/static-field",
    );
    expect(spec.spriteGrid).toBeUndefined();
  });

  test("rejects sprite_grid on non-sprite assets", () => {
    expect(() => parseAssetSpec(
      [
        "kind: portrait",
        "description: Portrait",
        "prompt: Portrait atlas",
        'placeholder: "[portrait]"',
        "sprite_grid:",
        "  columns: 2",
        "  rows: 2",
        "  default_facing: south",
        "  frames: { north: 0, east: 1, south: 2, west: 3 }",
      ].join("\n"),
      "assets/portraits/hero",
    )).toThrow("`sprite_grid` is only valid for `kind: sprite`");
  });

  test("rejects incomplete, unknown, and out-of-range directional frames", () => {
    const source = (frames: string) => [
      "kind: sprite",
      "description: Directional sprite",
      "prompt: Directional atlas",
      'placeholder: "[sprite]"',
      "sprite_grid:",
      "  columns: 2",
      "  rows: 2",
      "  default_facing: south",
      `  frames: ${frames}`,
    ].join("\n");
    expect(() => parseAssetSpec(
      source("{ north: 0, east: 1, south: 2 }"),
      "missing",
    )).toThrow("`sprite_grid.frames.west` must be an integer between 0 and 3");
    expect(() => parseAssetSpec(
      source("{ north: 0, east: 1, south: 2, west: 3, northeast: 0 }"),
      "unknown",
    )).toThrow("`sprite_grid.frames` has unknown direction \"northeast\"");
    expect(() => parseAssetSpec(
      source("{ north: 0, east: 1, south: 4, west: 3 }"),
      "range",
    )).toThrow("`sprite_grid.frames.south` must be an integer between 0 and 3");
  });

  test("requires an explicit valid sprite_grid default_facing", () => {
    expect(() => parseAssetSpec(
      [
        "kind: sprite",
        "description: Directional sprite",
        "prompt: Directional atlas",
        'placeholder: "[sprite]"',
        "sprite_grid:",
        "  columns: 2",
        "  rows: 2",
        "  default_facing: diagonal",
        "  frames: { north: 0, east: 1, south: 2, west: 3 }",
      ].join("\n"),
      "assets/sprites/bad-default",
    )).toThrow("`sprite_grid.default_facing` must be one of north / east / south / west");
  });

  test("size_hint → sizeHint with cols/rows + aspect", () => {
    const spec = parseAssetSpec(
      [
        "kind: portrait",
        "description: x",
        "prompt: y",
        "placeholder: z",
        "size_hint:",
        "  tui: { cols: 30, rows: 20 }",
        '  web: { aspect: "3:4" }',
      ].join("\n"),
      "assets/portraits/k",
    );
    expect(spec.sizeHint).toEqual({
      tui: { cols: 30, rows: 20 },
      web: { aspect: "3:4" },
    });
  });
});

describe("parseAssetSpec — refs", () => {
  test("characters + emotion + extra ref keys preserved", () => {
    const spec = parseAssetSpec(
      [
        "kind: cg",
        "description: x",
        "prompt: y",
        "placeholder: z",
        "refs:",
        "  characters: [kagari, kasumi]",
        "  emotion: smile",
        "  location: 村外",
        "  time: 黄昏",
      ].join("\n"),
      "assets/cgs/first-encounter",
    );
    expect(spec.refs).toEqual({
      characters: ["kagari", "kasumi"],
      emotion: "smile",
      location: "村外",
      time: "黄昏",
    });
  });

  test("refs.characters must be string array", () => {
    expect(() =>
      parseAssetSpec(
        [
          "kind: portrait",
          "description: x",
          "prompt: y",
          "placeholder: z",
          "refs: { characters: [1, 2] }",
        ].join("\n"),
        "x",
      ),
    ).toThrow(/characters/);
  });
});

describe("parseAssetSpec — tags + custom", () => {
  test("tags array preserved", () => {
    const spec = parseAssetSpec(
      [
        "kind: bg",
        "description: x",
        "prompt: y",
        "placeholder: z",
        "tags: [chapter-1, night]",
      ].join("\n"),
      "x",
    );
    expect(spec.tags).toEqual(["chapter-1", "night"]);
  });

  test("unknown keys land in custom", () => {
    const spec = parseAssetSpec(
      [
        "kind: portrait",
        "description: x",
        "prompt: y",
        "placeholder: z",
        "license: CC-BY",
        "palette_ref: muted",
      ].join("\n"),
      "x",
    );
    expect(spec.custom).toEqual({
      license: "CC-BY",
      palette_ref: "muted",
    });
  });
});

describe("parseAssetSpec — error surface", () => {
  test("invalid YAML throws AssetParseError", () => {
    expect(() => parseAssetSpec("::: bad ::: yaml", "x")).toThrow(
      AssetParseError,
    );
  });

  test("non-object YAML rejected", () => {
    expect(() => parseAssetSpec("- just a list\n", "x")).toThrow(
      AssetParseError,
    );
  });
});

describe("parseAssetSpec — tui_render", () => {
  const base = [
    "kind: portrait",
    "description: x",
    "prompt: y",
    "placeholder: z",
  ].join("\n");

  test("full tui_render block parses into camelCase", () => {
    const spec = parseAssetSpec(
      `${base}\ntui_render:\n  symbols: sextant\n  dither: diffusion\n  colors: '256'\n  cols: 48\n  rows: 28\n`,
      "assets/portraits/k",
    );
    expect(spec.tuiRender).toEqual({
      symbols: "sextant",
      dither: "diffusion",
      colors: "256",
      cols: 48,
      rows: 28,
    });
  });

  test("partial tui_render only carries set fields", () => {
    const spec = parseAssetSpec(
      `${base}\ntui_render:\n  symbols: braille\n`,
      "assets/x/y",
    );
    expect(spec.tuiRender).toEqual({ symbols: "braille" });
  });

  test("colors accepted as unquoted integer in YAML", () => {
    const spec = parseAssetSpec(
      `${base}\ntui_render:\n  colors: 256\n`,
      "assets/x/y",
    );
    expect(spec.tuiRender?.colors).toBe("256");
  });

  test("invalid symbols throws", () => {
    expect(() =>
      parseAssetSpec(
        `${base}\ntui_render:\n  symbols: bogus\n`,
        "x",
      ),
    ).toThrow(/symbols/);
  });

  test("invalid dither throws", () => {
    expect(() =>
      parseAssetSpec(
        `${base}\ntui_render:\n  dither: weird\n`,
        "x",
      ),
    ).toThrow(/dither/);
  });

  test("invalid colors throws", () => {
    expect(() =>
      parseAssetSpec(
        `${base}\ntui_render:\n  colors: 'rainbow'\n`,
        "x",
      ),
    ).toThrow(/colors/);
  });

  test("out-of-range cols throws", () => {
    expect(() =>
      parseAssetSpec(
        `${base}\ntui_render:\n  cols: 9999\n`,
        "x",
      ),
    ).toThrow(/cols/);
  });

  test("tui_render missing keeps tuiRender undefined", () => {
    const spec = parseAssetSpec(base, "x");
    expect(spec.tuiRender).toBeUndefined();
  });

  test("tui_render not stashed in custom", () => {
    const spec = parseAssetSpec(
      `${base}\ntui_render:\n  symbols: quad\n`,
      "x",
    );
    expect(spec.custom).toBeUndefined();
  });
});
