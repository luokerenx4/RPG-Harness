import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parsePatchBody, specYamlPath, updateSpec } from "./spec-write";

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
