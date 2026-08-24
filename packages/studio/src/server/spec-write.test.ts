import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { editableSpecKindError, parsePatchBody, specYamlPath, updateSpec } from "./spec-write";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "rpgh-spec-test-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const SAMPLE_WITH_COMMENTS = `# Authored by hand — DO NOT regenerate.
kind: portrait
description: |
  Kagari, half-body. The studio shouldn't reformat this block.
prompt: "anime swordswoman, sengoku era"

# placeholder is the AI-visible label
placeholder: "[篝・微笑] 若き女剣士、淡く笑む"

size_hint:
  tui: { cols: 28, rows: 16 }
  # web aspect intentionally narrow
  web: { aspect: "3:4" }

tags:
  - main-cast
  - chapter-1
`;

describe("updateSpec", () => {
  test("round-trip of unchanged spec preserves bytes exactly", async () => {
    const p = path.join(tmp, "spec.yaml");
    await writeFile(p, SAMPLE_WITH_COMMENTS);
    await updateSpec(p, {});
    const after = await readFile(p, "utf-8");
    expect(after).toBe(SAMPLE_WITH_COMMENTS);
  });

  test("editing placeholder preserves surrounding comments", async () => {
    const p = path.join(tmp, "spec.yaml");
    await writeFile(p, SAMPLE_WITH_COMMENTS);
    await updateSpec(p, { placeholder: "[新] 別の説明" });
    const after = await readFile(p, "utf-8");
    expect(after).toContain("# Authored by hand");
    expect(after).toContain("# placeholder is the AI-visible label");
    expect(after).toContain("# web aspect intentionally narrow");
    expect(after).toContain("[新] 別の説明");
    expect(after).not.toContain("若き女剣士、淡く笑む");
  });

  test("adding tui_render block to a spec that didn't have one", async () => {
    const p = path.join(tmp, "spec.yaml");
    await writeFile(p, SAMPLE_WITH_COMMENTS);
    await updateSpec(p, {
      tuiRender: {
        symbols: "sextant",
        dither: "diffusion",
        colors: "256",
        cols: 48,
        rows: 28,
      },
    });
    const after = await readFile(p, "utf-8");
    expect(after).toContain("tui_render:");
    expect(after).toContain("symbols: sextant");
    expect(after).toContain("colors: \"256\"");
    expect(after).toContain("cols: 48");
    // Pre-existing comments and key order still present.
    expect(after).toContain("# Authored by hand");
    expect(after).toContain("kind: portrait");
  });

  test("partial tui_render update keeps existing sibling keys", async () => {
    const p = path.join(tmp, "spec.yaml");
    await writeFile(
      p,
      `kind: portrait
description: x
prompt: y
placeholder: z
tui_render:
  symbols: block
  dither: ordered
  colors: "256"
`,
    );
    await updateSpec(p, { tuiRender: { symbols: "sextant" } });
    const after = await readFile(p, "utf-8");
    expect(after).toContain("symbols: sextant");
    // dither and colors untouched
    expect(after).toContain("dither: ordered");
    expect(after).toContain('colors: "256"');
  });

  test("camelCase patch keys serialize as snake_case on disk", async () => {
    const p = path.join(tmp, "spec.yaml");
    await writeFile(p, "kind: portrait\ndescription: x\nprompt: y\nplaceholder: z\n");
    await updateSpec(p, {
      styleRef: "assets/portraits/k-normal",
      sizeHint: { tui: { cols: 40, rows: 24 } },
      tileGrid: { columns: 4, rows: 3, firstId: 1 },
      tuiRender: { symbols: "quad" },
    });
    const after = await readFile(p, "utf-8");
    expect(after).toContain("style_ref:");
    expect(after).toContain("size_hint:");
    expect(after).toContain("tile_grid:");
    expect(after).toContain("first_id: 1");
    expect(after).toContain("tui_render:");
    // The camelCase keys must NOT leak into the YAML.
    expect(after).not.toContain("styleRef");
    expect(after).not.toContain("sizeHint");
    expect(after).not.toContain("tileGrid");
    expect(after).not.toContain("tuiRender");
  });

  test("validates editable tileset atlas metadata", () => {
    expect(parsePatchBody({ tileGrid: { columns: 4, rows: 4, firstId: 1 } })).toEqual({
      fields: { tileGrid: { columns: 4, rows: 4, firstId: 1 } },
    });
    expect(parsePatchBody({ tileGrid: { columns: 0, rows: 4, firstId: 1 } })).toEqual({
      error: "tileGrid.columns must be a positive integer",
    });
    expect(parsePatchBody({ tileGrid: null })).toEqual({ fields: { tileGrid: null } });
  });

  test("serializes a complete directional sprite grid with snake-case YAML keys", async () => {
    const p = path.join(tmp, "spec.yaml");
    await writeFile(p, "kind: sprite\ndescription: x\nprompt: y\nplaceholder: z\n");
    await updateSpec(p, {
      spriteGrid: {
        columns: 3,
        rows: 4,
        defaultFacing: "south",
        frames: { north: 10, east: 7, south: 1, west: 4 },
      },
    });
    const after = await readFile(p, "utf-8");
    expect(after).toContain("sprite_grid:");
    expect(after).toContain("default_facing: south");
    expect(after).toContain("north: 10");
    expect(after).toContain("east: 7");
    expect(after).not.toContain("spriteGrid");
    expect(after).not.toContain("defaultFacing");
  });

  test("validates complete sprite frame maps while allowing aliases", () => {
    const aliased = {
      columns: 2,
      rows: 2,
      defaultFacing: "south",
      frames: { north: 0, east: 1, south: 1, west: 0 },
    } as const;
    expect(parsePatchBody({ spriteGrid: aliased })).toEqual({ fields: { spriteGrid: aliased } });
    expect(parsePatchBody({ spriteGrid: { ...aliased, frames: { north: 0, east: 1, south: 2 } } })).toEqual({
      error: "spriteGrid.frames.west must be an integer in 0..3",
    });
    expect(parsePatchBody({ spriteGrid: { ...aliased, frames: { ...aliased.frames, north: 4 } } })).toEqual({
      error: "spriteGrid.frames.north must be an integer in 0..3",
    });
    expect(parsePatchBody({ spriteGrid: { ...aliased, defaultFacing: "diagonal" } })).toEqual({
      error: "spriteGrid.defaultFacing must be north, east, south, or west",
    });
    expect(parsePatchBody({ spriteGrid: { ...aliased, frames: { ...aliased.frames, diagonal: 0 } } })).toEqual({
      error: "spriteGrid.frames.diagonal is not supported",
    });
    expect(parsePatchBody({ spriteGrid: { ...aliased, columns: Number.MAX_SAFE_INTEGER, rows: 2 } })).toEqual({
      error: "spriteGrid cell count must be a safe integer",
    });
    expect(parsePatchBody({ spriteGrid: null })).toEqual({ fields: { spriteGrid: null } });
  });

  test("restricts specialized atlas patches to their matching asset kinds", () => {
    const parsed = parsePatchBody({
      spriteGrid: {
        columns: 1,
        rows: 1,
        defaultFacing: "south",
        frames: { north: 0, east: 0, south: 0, west: 0 },
      },
    });
    if ("error" in parsed) throw new Error(parsed.error);
    expect(editableSpecKindError(parsed.fields, "sprite")).toBeUndefined();
    expect(editableSpecKindError(parsed.fields, "portrait")).toBe("spriteGrid is only editable for sprite assets");
    expect(editableSpecKindError({ tileGrid: null }, "sprite")).toBe("tileGrid is only editable for tileset assets");
  });

  test("setting a field to null removes it", async () => {
    const p = path.join(tmp, "spec.yaml");
    await writeFile(
      p,
      "kind: portrait\ndescription: x\nprompt: y\nplaceholder: z\nstyle_ref: ../other\n",
    );
    await updateSpec(p, { styleRef: null });
    const after = await readFile(p, "utf-8");
    expect(after).not.toContain("style_ref:");
  });

  test("removing a directional contract deletes the complete sprite_grid block", async () => {
    const p = path.join(tmp, "spec.yaml");
    await writeFile(p, `kind: sprite
description: x
prompt: y
placeholder: z
sprite_grid:
  columns: 1
  rows: 1
  default_facing: south
  frames: { north: 0, east: 0, south: 0, west: 0 }
`);
    await updateSpec(p, { spriteGrid: null });
    const after = await readFile(p, "utf-8");
    expect(after).not.toContain("sprite_grid:");
    expect(after).toContain("placeholder: z");
  });

  test("empty patch is a no-op (no disk write)", async () => {
    // No real way to verify "no disk write" without filesystem
    // observers, but at least the result must be byte-identical to
    // the input — the same guarantee callers care about.
    const p = path.join(tmp, "spec.yaml");
    const original = "kind: portrait\ndescription: x\nprompt: y\nplaceholder: z\n";
    await writeFile(p, original);
    await updateSpec(p, {});
    expect(await readFile(p, "utf-8")).toBe(original);
  });
});

describe("specYamlPath", () => {
  test("joins game dir + asset path + spec.yaml", () => {
    const p = specYamlPath("/games/sengoku", "assets/portraits/kagari-smile");
    expect(p).toBe(
      path.join(
        "/games/sengoku",
        "assets",
        "portraits",
        "kagari-smile",
        "spec.yaml",
      ),
    );
  });
});
