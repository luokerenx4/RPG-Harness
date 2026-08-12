import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  Action,
  AssetKind,
  AssetRenderings,
  AssetSpec,
  CharacterDef,
  EnemyDef,
  Game,
  ItemDef,
  MapDef,
  Module,
  RunFunction,
  Script,
  SkillDef,
  WeaponDef,
} from "@rpg-harness/engine";
import {
  buildGame,
  parseAction,
  parseAssetSpec,
  parseCharacter,
  parseEnemy,
  parseItem,
  parseManifest,
  parseMap,
  parseScript,
  parseSkill,
  parseWeapon,
} from "@rpg-harness/parser";

export async function loadGame(dir: string): Promise<Game> {
  const manifestPath = path.join(dir, "game.yaml");
  const manifest = parseManifest(await readFile(manifestPath, "utf-8"));

  const characters = await loadDir<CharacterDef>(
    path.join(dir, "characters"),
    [".md"],
    parseCharacter,
  );
  const scripts = await loadDir<Script>(
    path.join(dir, "scripts"),
    [".md"],
    (content, source) => parseScript(content, source),
  );
  scripts.sort((a, b) => a.id.localeCompare(b.id));

  const actions = await loadDir<Action>(
    path.join(dir, "actions"),
    [".yaml", ".yml"],
    (content, source) => parseAction(content, source),
  );
  actions.sort((a, b) => a.id.localeCompare(b.id));

  const items = await loadDir<ItemDef>(
    path.join(dir, "items"),
    [".md"],
    (content, source) => parseItem(content, source),
  );
  items.sort((a, b) => a.id.localeCompare(b.id));

  const enemies = await loadDir<EnemyDef>(
    path.join(dir, "enemies"),
    [".md"],
    (content, source) => parseEnemy(content, source),
  );
  enemies.sort((a, b) => a.id.localeCompare(b.id));

  const weapons = await loadDir<WeaponDef>(
    path.join(dir, "weapons"),
    [".md"],
    (content, source) => parseWeapon(content, source),
  );
  weapons.sort((a, b) => a.id.localeCompare(b.id));

  const skills = await loadDir<SkillDef>(
    path.join(dir, "skills"),
    [".md"],
    (content, source) => parseSkill(content, source),
  );
  skills.sort((a, b) => a.id.localeCompare(b.id));

  const maps = await loadDir<MapDef>(
    path.join(dir, "maps"),
    [".yaml", ".yml"],
    (content, source) => parseMap(content, source),
  );
  maps.sort((a, b) => a.id.localeCompare(b.id));

  const assets = await loadAssets(dir);
  assets.sort((a, b) => a.path.localeCompare(b.path));

  const modules = await loadModules(dir, manifest.modules ?? []);

  const game = buildGame(
    manifest,
    characters,
    scripts,
    actions,
    modules,
    items,
    enemies,
    weapons,
    skills,
    maps,
    assets,
  );

  warnDanglingAssetRefs(game, assets);

  // If game.yaml's preset: is a relative path (the ejected-preset case),
  // dynamic-import the file and attach its default-exported RunFunction
  // to game.runFn. Engine prefers game.runFn over the preset name.
  if (manifest.preset && isRelativePath(manifest.preset)) {
    const abs = path.resolve(dir, manifest.preset);
    const imported = (await import(abs)) as { default?: unknown };
    const fn = imported.default;
    if (typeof fn !== "function") {
      throw new Error(
        `Preset at ${manifest.preset} must default-export a RunFunction (got ${typeof fn})`,
      );
    }
    game.runFn = fn as RunFunction;
  }

  return game;
}

function isRelativePath(s: string): boolean {
  return s.startsWith("./") || s.startsWith("../");
}

async function loadModules(
  gameDir: string,
  paths: string[],
): Promise<Module[]> {
  const modules: Module[] = [];
  for (const rel of paths) {
    const abs = path.resolve(gameDir, rel);
    const imported = (await import(abs)) as { default?: unknown };
    const mod = imported.default;
    if (!mod || typeof mod !== "object" || typeof (mod as Module).id !== "string") {
      throw new Error(
        `Module at ${rel} must export a default Module with a string \`id\``,
      );
    }
    modules.push(mod as Module);
  }
  return modules;
}

async function loadDir<T>(
  dir: string,
  exts: string[],
  parse: (content: string, source: string) => T,
): Promise<T[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const files = entries
    .filter((e) => exts.some((ext) => e.endsWith(ext)))
    .map((e) => path.join(dir, e))
    .sort();
  return Promise.all(
    files.map(async (file) => {
      const content = await readFile(file, "utf-8");
      return parse(content, file);
    }),
  );
}

// Walk <gameDir>/assets/{portraits,backgrounds,cgs}/ and for each
// subdirectory that contains a spec.yaml, parse the spec and
// enumerate its rendering files (tui.txt/tui.ans/source.{quality,compressed}.*/web.*).
// Returns one AssetSpec per discovered directory; missing top-level
// kind subdirs (e.g. no cgs/ at all) are silently skipped — assets/
// itself absent is also fine.
//
// Path keys are forward-slash relative to gameDir so script-level
// references work cross-platform without normalization.
const ASSET_KIND_DIRS: ReadonlyArray<{ name: string; kind: AssetKind }> = [
  { name: "portraits", kind: "portrait" },
  { name: "backgrounds", kind: "bg" },
  { name: "cgs", kind: "cg" },
  { name: "sheets", kind: "sheet" },
];

async function loadAssets(gameDir: string): Promise<AssetSpec[]> {
  const assets: AssetSpec[] = [];
  for (const { name, kind } of ASSET_KIND_DIRS) {
    const root = path.join(gameDir, "assets", name);
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const entry of entries) {
      const assetDir = path.join(root, entry);
      const specPath = path.join(assetDir, "spec.yaml");
      let content: string;
      try {
        content = await readFile(specPath, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      const relPath = path
        .relative(gameDir, assetDir)
        .split(path.sep)
        .join("/");
      const spec = parseAssetSpec(content, relPath);
      if (spec.kind !== kind) {
        process.stderr.write(
          `[assets] ${relPath}: declared kind="${spec.kind}" but lives under assets/${name}/ (expected kind="${kind}")\n`,
        );
      }
      const renderings = await discoverRenderings(assetDir);
      assets.push({ ...spec, renderings });
    }
  }
  return assets;
}

async function discoverRenderings(assetDir: string): Promise<AssetRenderings> {
  const out: AssetRenderings = {};
  const tryFile = async (rel: string) => {
    const abs = path.join(assetDir, rel);
    try {
      await stat(abs);
      return abs;
    } catch {
      return undefined;
    }
  };
  const ans = await tryFile("tui.ans");
  if (ans) out.tuiAns = ans;
  const txt = await tryFile("tui.txt");
  if (txt) out.tuiTxt = txt;
  // Source slot — two tiers under the same convention. The
  // `*.quality.*` file is the author's high-res master (gitignored
  // by default; lives on the author's machine and on their private
  // backup branch). The `*.compressed.*` file is the slimmed-down
  // distribution copy that travels with the repo so cloners get a
  // working out-of-the-box visual experience. Loader populates the
  // two tier slots independently so studio / a future web renderer
  // can show both side-by-side and compare; `out.source` is set to
  // the "best pick" (quality > compressed) for legacy consumers that
  // just want "give me an image, any image" (chafa render, etc.).
  // Both tiers fall back to undefined when absent — TUI still works
  // via tui.*; placeholder text covers the rest.
  // Compressed tier accepts multiple formats — PNG for masters
  // (lossless generator output) and any of webp/png/jpg for
  // compressed (mirror of the existing web.* slot's format flexibility).
  const quality = await tryFile("source.quality.png");
  if (quality) out.sourceQuality = quality;
  for (const ext of ["webp", "png", "jpg", "jpeg"]) {
    const c = await tryFile(`source.compressed.${ext}`);
    if (c) {
      out.sourceCompressed = c;
      break;
    }
  }
  out.source = out.sourceQuality ?? out.sourceCompressed;
  // Web slot accepts any of webp/png/jpg, in that priority. First match wins.
  for (const ext of ["webp", "png", "jpg", "jpeg"]) {
    const w = await tryFile(`web.${ext}`);
    if (w) {
      out.web = w;
      break;
    }
  }
  return out;
}

// A reference that doesn't resolve: either an asset path nobody
// created a spec.yaml for, or a defaultPortraits emotion missing from
// the character's portraits map. `referencedBy` lists every site that
// makes the reference, e.g. "script bond_kagari_03 :cg" or
// "character kagari portraits.smile".
export interface MissingAssetRef {
  assetPath: string;
  referencedBy: string[];
}
export interface MissingEmotionRef {
  characterId: string;
  emotion: string;
  referencedBy: string[];
}
export interface DanglingRefs {
  missingAssets: MissingAssetRef[];
  missingEmotions: MissingEmotionRef[];
}

// Scan every asset reference in the game — character portraits maps,
// script frontmatter-seeded beats, script body directives — and
// return the ones that don't resolve. Shared by the loader's stderr
// warnings, `rpgh assets list`'s MISSING section, and the studio's
// ghost cards.
export function collectDanglingRefs(
  game: Game,
  assets: AssetSpec[],
): DanglingRefs {
  const known = new Set(assets.map((a) => a.path));
  const missingAssets = new Map<string, string[]>();
  const missingEmotions = new Map<string, string[]>();
  const addAsset = (assetPath: string, site: string) => {
    if (known.has(assetPath)) return;
    const sites = missingAssets.get(assetPath) ?? [];
    sites.push(site);
    missingAssets.set(assetPath, sites);
  };

  const charById = new Map(game.characters.map((c) => [c.id, c]));
  for (const c of game.characters) {
    if (!c.portraits) continue;
    for (const [emotion, p] of Object.entries(c.portraits)) {
      addAsset(p, `character ${c.id} portraits.${emotion}`);
    }
  }
  for (const s of game.scripts) {
    for (const beat of s.beats) {
      if (beat.type === "setBg" && beat.assetPath !== null) {
        addAsset(beat.assetPath, `script ${s.id} :bg`);
      } else if (beat.type === "setPortrait") {
        if (beat.assetPath) {
          addAsset(beat.assetPath, `script ${s.id} :portrait ${beat.slot}`);
        } else if (beat.characterId && beat.emotion) {
          // defaultPortraits form: resolves through the character's
          // portraits map at runtime. Missing emotion → portrait
          // silently never appears; surface it here instead.
          const ch = charById.get(beat.characterId);
          if (!ch?.portraits?.[beat.emotion]) {
            const key = `${beat.characterId} ${beat.emotion}`;
            const sites = missingEmotions.get(key) ?? [];
            sites.push(`script ${s.id} defaultPortraits ${beat.slot}`);
            missingEmotions.set(key, sites);
          }
        }
      } else if (beat.type === "showCg") {
        addAsset(beat.assetPath, `script ${s.id} :cg`);
      }
    }
  }

  return {
    missingAssets: [...missingAssets.entries()].map(
      ([assetPath, referencedBy]) => ({ assetPath, referencedBy }),
    ),
    missingEmotions: [...missingEmotions.entries()].map(
      ([key, referencedBy]) => {
        const [characterId = "", emotion = ""] = key.split(" ");
        return { characterId, emotion, referencedBy };
      },
    ),
  };
}

// Emit a stderr warning for every dangling reference. Warn-only —
// broken refs fall back to placeholder mode at runtime; the warning
// just helps authors notice.
function warnDanglingAssetRefs(game: Game, assets: AssetSpec[]): void {
  const warn = (msg: string) => process.stderr.write(`[assets] ${msg}\n`);
  const { missingAssets, missingEmotions } = collectDanglingRefs(game, assets);
  for (const m of missingAssets) {
    for (const site of m.referencedBy) {
      warn(`${site} → "${m.assetPath}" not found`);
    }
  }
  for (const m of missingEmotions) {
    for (const site of m.referencedBy) {
      warn(
        `${site} → character ${m.characterId} has no portraits.${m.emotion}`,
      );
    }
  }
}
