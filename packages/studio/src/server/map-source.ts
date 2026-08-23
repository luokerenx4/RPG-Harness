import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseMap } from "@rpg-harness/parser";

export type MapSourceResolution =
  | { kind: "found"; path: string }
  | { kind: "missing" }
  | { kind: "ambiguous"; paths: string[] }
  | { kind: "invalid"; path: string; error: string }
  | { kind: "mismatched"; path: string; actualId: string };

/** Resolve source authority with enough detail for preview/commit parity. */
export async function resolveMapSource(
  gameDir: string,
  mapId: string,
): Promise<MapSourceResolution> {
  if (!mapId || mapId.includes("/") || mapId.includes("\\") || mapId === "." || mapId === "..") {
    return { kind: "missing" };
  }
  const mapsDir = path.resolve(gameDir, "maps");
  const candidates = ["yaml", "yml"]
    .map((extension) => path.resolve(mapsDir, `${mapId}.${extension}`))
    .filter((absolute) => path.dirname(absolute) === mapsDir);
  const existing: string[] = [];
  for (const absolute of candidates) {
    if (await stat(absolute).then((entry) => entry.isFile(), () => false)) existing.push(absolute);
  }
  if (existing.length === 0) return { kind: "missing" };
  if (existing.length > 1) return { kind: "ambiguous", paths: existing };
  const absolute = existing[0]!;
  try {
    const actualId = parseMap(await readFile(absolute, "utf-8"), absolute).id;
    return actualId === mapId
      ? { kind: "found", path: absolute }
      : { kind: "mismatched", path: absolute, actualId };
  } catch (error) {
    return {
      kind: "invalid",
      path: absolute,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Resolve one canonical top-level map source without trusting URL identity. */
export async function resolveMapSourceFile(
  gameDir: string,
  mapId: string,
): Promise<string | undefined> {
  const resolution = await resolveMapSource(gameDir, mapId);
  return resolution.kind === "found" ? resolution.path : undefined;
}
