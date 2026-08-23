import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  buildProjectResourceGraph,
  type Game,
  type ProjectResourceKind,
  type ProjectResourceNode,
} from "@rpg-harness/engine";

export const CREATABLE_RESOURCE_KINDS = [
  "map",
  "character",
  "item",
  "weapon",
  "skill",
  "enemy",
  "action",
  "script",
] as const satisfies readonly ProjectResourceKind[];

export type CreatableResourceKind = typeof CREATABLE_RESOURCE_KINDS[number];

export interface ResourceCreateOptions {
  mapLayout?: {
    width: number;
    height: number;
    tileset?: string;
  };
}

const RESOURCE_FILES: Record<CreatableResourceKind, { directory: string; extension: string }> = {
  map: { directory: "maps", extension: ".yaml" },
  character: { directory: "characters", extension: ".md" },
  item: { directory: "items", extension: ".md" },
  weapon: { directory: "weapons", extension: ".md" },
  skill: { directory: "skills", extension: ".md" },
  enemy: { directory: "enemies", extension: ".md" },
  action: { directory: "actions", extension: ".yaml" },
  script: { directory: "scripts", extension: ".md" },
};

export class ResourceCreateError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export async function createProjectResource(
  gameDir: string,
  kind: CreatableResourceKind,
  id: string,
  label: string,
  reload: () => Promise<Game>,
  options: ResourceCreateOptions = {},
): Promise<{ path: string; source: string; game: Game; resource: ProjectResourceNode }> {
  assertCreatableResourceInput(kind, id, label);
  assertResourceCreateOptions(kind, options);
  const file = RESOURCE_FILES[kind];
  const relative = path.posix.join(file.directory, `${id}${file.extension}`);
  const absolute = path.join(gameDir, file.directory, `${id}${file.extension}`);
  const source = projectResourceTemplate(kind, id, label.trim(), options);
  await mkdir(path.dirname(absolute), { recursive: true });
  try {
    await writeFile(absolute, source, { encoding: "utf-8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ResourceCreateError(`${relative} already exists`, 409);
    }
    throw error;
  }

  try {
    const game = await reload();
    const resource = buildProjectResourceGraph(game).resources.find(
      (candidate) => candidate.kind === kind && candidate.id === id,
    );
    if (!resource) throw new Error(`created resource did not load: ${kind}:${id}`);
    return { path: relative, source: await readFile(absolute, "utf-8"), game, resource };
  } catch (error) {
    await unlink(absolute).catch(() => {});
    throw error;
  }
}

export function projectResourceTemplate(
  kind: CreatableResourceKind,
  id: string,
  label: string,
  options: ResourceCreateOptions = {},
): string {
  if (kind === "map") {
    const mapLayout = options.mapLayout;
    return stringifyYaml({
      id,
      name: label,
      description: "",
      ...(mapLayout ? {
        layout: {
          width: mapLayout.width,
          height: mapLayout.height,
          tile_width: 32,
          tile_height: 32,
          player_start: [Math.floor(mapLayout.width / 2), Math.floor(mapLayout.height / 2)],
          ...(mapLayout.tileset ? { tileset: mapLayout.tileset } : {}),
          layers: [
            { id: "ground", kind: "tile", z: 0, visible: true },
            { id: "collision", kind: "collision", z: 5, visible: true },
            { id: "objects", kind: "object", z: 10, visible: true },
          ],
          regions: [],
        },
      } : {}),
    });
  }
  if (kind === "action") {
    return stringifyYaml({
      id,
      title: label,
      cost: 1,
      requires: { switch: { name: "__studio_draft__", eq: true } },
    });
  }
  const meta: Record<string, unknown> = kind === "script"
    ? {
        id,
        title: label,
        characters: [],
        requires: { switch: { name: "__studio_draft__", eq: true } },
        coverage: { ignore: true, reason: "Studio draft; author before enabling" },
      }
    : kind === "enemy"
      ? { id, name: label, hp: 1 }
      : kind === "weapon"
        ? { id, name: label, basePower: 1 }
        : kind === "item"
          ? { id, name: label, kind: "consumable", stack: true }
          : { id, name: label };
  const body = kind === "script" ? "[end]\n" : "";
  return `---\n${stringifyYaml(meta)}---\n\n${body}`;
}

export function assertResourceCreateOptions(kind: CreatableResourceKind, options: ResourceCreateOptions): void {
  if (!options.mapLayout) return;
  if (kind !== "map") throw new ResourceCreateError("mapLayout is only valid when creating a map");
  const { width, height, tileset } = options.mapLayout;
  if (!Number.isInteger(width) || width < 2 || width > 200 || !Number.isInteger(height) || height < 2 || height > 200) {
    throw new ResourceCreateError("mapLayout width and height must be integers from 2 to 200");
  }
  if (tileset !== undefined && (typeof tileset !== "string" || !tileset.startsWith("assets/tilesets/"))) {
    throw new ResourceCreateError("mapLayout tileset must be an assets/tilesets path");
  }
}

export function assertCreatableResourceInput(
  kind: string,
  id: string,
  label: string,
): asserts kind is CreatableResourceKind {
  if (!(CREATABLE_RESOURCE_KINDS as readonly string[]).includes(kind)) {
    throw new ResourceCreateError(`unsupported resource kind: ${kind}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id)) {
    throw new ResourceCreateError("id must be 1-80 stable ASCII letters, numbers, dashes, or underscores");
  }
  if (!label.trim() || label.trim().length > 160) {
    throw new ResourceCreateError("label must be 1-160 characters");
  }
}
