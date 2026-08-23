import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Game } from "@rpg-harness/engine";
import {
  planProjectResourceRename,
  renameProjectResource,
  transformResourceSource,
} from "./resource-rename";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function game(characterId: string): Game {
  return {
    title: "Refactor test",
    characters: [{ id: characterId, name: "Hero" }],
    scripts: [{
      id: "intro",
      title: "Intro",
      characters: [characterId],
      beats: [
        { type: "dialogue", speaker: characterId, text: "Ready." },
        { type: "choice", options: [{ text: "Trust", effects: { characterStats: { [characterId]: { affection: 1 } } } }] },
      ],
    }],
    maps: [{
      id: "town",
      name: "Town",
      description: "",
      placements: [{
        id: "hero",
        at: { x: 0, y: 0 },
        z: 0,
        footprint: { width: 1, height: 1 },
        collision: "none",
        visible: true,
        resource: { kind: "character", id: characterId },
        events: [],
      }],
    }],
    assets: [{
      path: "assets/portraits/hero",
      kind: "portrait",
      description: "Hero",
      prompt: "Hero",
      placeholder: "Hero portrait",
      refs: { characters: [characterId] },
      renderings: {},
    }],
  };
}

async function fixture(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "autogal-rename-"));
  created.push(directory);
  await Promise.all([
    mkdir(path.join(directory, "characters")),
    mkdir(path.join(directory, "scripts")),
    mkdir(path.join(directory, "maps")),
    mkdir(path.join(directory, "assets/portraits/hero"), { recursive: true }),
  ]);
  await writeFile(path.join(directory, "characters/hero.md"), "---\nid: hero\nname: Hero\n---\n\nA hero.\n");
  await writeFile(path.join(directory, "scripts/intro.md"), `---
id: intro
title: Intro
characters: [hero]
---

@hero Ready.

? Trust? {id: trust}
- Trust them -> +hero

\`\`\`yaml
type: effects
effects:
  characterStats:
    hero: { affection: 1 }
\`\`\`
`);
  await writeFile(path.join(directory, "maps/town.yaml"), `id: town
name: Town
description: ""
placements:
  - id: hero
    at: { x: 0, y: 0 }
    z: 0
    footprint: { width: 1, height: 1 }
    collision: none
    visible: true
    resource: { kind: character, id: hero }
    events: []
`);
  await writeFile(path.join(directory, "assets/portraits/hero/spec.yaml"), `kind: portrait
description: Hero
prompt: Hero
placeholder: Hero portrait
refs:
  characters: [hero]
`);
  return directory;
}

describe("Studio resource rename refactor", () => {
  test("rewrites structured frontmatter, fenced effects, dialogue, and inline effects", () => {
    const transformed = transformResourceSource("script", `---
id: intro
title: Intro
characters: [hero]
---

@hero Ready.

- Trust -> +2hero.affection

\`\`\`yaml
type: effects
effects: { characterStats: { hero: { affection: 1 } } }
\`\`\`
`, { kind: "character", id: "hero", newId: "guide" });
    expect(transformed.changes).toBe(4);
    expect(transformed.source).toContain("characters: [guide]");
    expect(transformed.source).toContain("@guide Ready.");
    expect(transformed.source).toContain("+2guide.affection");
    expect(transformed.source).toContain("guide:");
  });

  test("rewrites the legacy affection-map effect syntax retained by era projects", () => {
    const transformed = transformResourceSource("script", `---
id: intro
title: Intro
---

\`\`\`yaml
type: effects
effects:
  affection:
    hero: 1
\`\`\`
`, { kind: "character", id: "hero", newId: "guide" });
    expect(transformed.changes).toBe(1);
    expect(transformed.source).toContain("affection:\n    guide: 1");
  });

  test("previews and atomically renames a resource plus every proven backlink", async () => {
    const directory = await fixture();
    const plan = await planProjectResourceRename(directory, game("hero"), "character", "hero", "guide");
    expect(plan.blockers).toEqual([]);
    expect(plan.files.map((file) => file.key)).toEqual([
      "character:hero",
      "asset:assets/portraits/hero",
      "map:town",
      "script:intro",
    ]);
    expect(plan.files[0]).toMatchObject({
      path: "characters/hero.md",
      destinationPath: "characters/guide.md",
      changes: 1,
    });

    const result = await renameProjectResource(
      directory,
      game("hero"),
      "character",
      "hero",
      "guide",
      async () => game("guide"),
    );
    expect(result.resource.key).toBe("character:guide");
    expect(await readFile(path.join(directory, "characters/guide.md"), "utf-8")).toContain("id: guide");
    await expect(readFile(path.join(directory, "characters/hero.md"), "utf-8")).rejects.toThrow();
    expect(await readFile(path.join(directory, "scripts/intro.md"), "utf-8")).not.toContain("@hero");
    expect(await readFile(path.join(directory, "maps/town.yaml"), "utf-8")).toContain("id: guide");
    expect(await readFile(path.join(directory, "assets/portraits/hero/spec.yaml"), "utf-8"))
      .toContain("characters: [guide]");
  });

  test("restores every source and filename when authoritative reload fails", async () => {
    const directory = await fixture();
    const originalScript = await readFile(path.join(directory, "scripts/intro.md"), "utf-8");
    await expect(renameProjectResource(
      directory,
      game("hero"),
      "character",
      "hero",
      "guide",
      async () => { throw new Error("validation failed"); },
    )).rejects.toThrow("validation failed");
    expect(await readFile(path.join(directory, "characters/hero.md"), "utf-8")).toContain("id: hero");
    await expect(readFile(path.join(directory, "characters/guide.md"), "utf-8")).rejects.toThrow();
    expect(await readFile(path.join(directory, "scripts/intro.md"), "utf-8")).toBe(originalScript);
  });

  test("is byte-exact after a forward and reverse refactor", async () => {
    const directory = await fixture();
    const files = [
      "characters/hero.md",
      "scripts/intro.md",
      "maps/town.yaml",
      "assets/portraits/hero/spec.yaml",
    ];
    const originals = new Map(await Promise.all(files.map(async (file) => [
      file,
      await readFile(path.join(directory, file), "utf-8"),
    ] as const)));
    await renameProjectResource(directory, game("hero"), "character", "hero", "guide", async () => game("guide"));
    await renameProjectResource(directory, game("guide"), "character", "guide", "hero", async () => game("hero"));

    for (const file of files) {
      expect(await readFile(path.join(directory, file), "utf-8")).toBe(originals.get(file)!);
    }
  });

  test("blocks executable module references and external project artifacts", async () => {
    const directory = await fixture();
    const sourceGame = game("hero");
    sourceGame.modules = [{
      id: "rules",
      source: "modules/rules.ts",
      triggers: [{
        id: "hero-ready",
        when: { affection: { character: "hero", min: 1 } },
        do: () => ({}),
      }],
    }];
    const plan = await planProjectResourceRename(
      directory,
      sourceGame,
      "character",
      "hero",
      "guide",
      ["issue:session/ref"],
    );
    expect(plan.blockers).toEqual([
      expect.objectContaining({ key: "issue:session/ref" }),
      expect.objectContaining({ key: "module:rules" }),
    ]);
  });
});
