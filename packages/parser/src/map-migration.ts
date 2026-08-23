import { parseDocument } from "yaml";
import { parseMap } from "./map";

export interface MapV2MigrationResult {
  content: string;
  changed: boolean;
  migratedConnections: number;
  migratedOnEnter: boolean;
}

export function migrateMapToPlacements(
  content: string,
  source?: string,
): MapV2MigrationResult {
  const map = parseMap(content, source);
  const connections = map.connections ?? [];
  if (connections.length === 0 && map.onEnter === undefined) {
    return {
      content,
      changed: false,
      migratedConnections: 0,
      migratedOnEnter: false,
    };
  }

  const doc = parseDocument(content);
  if (doc.errors.length > 0) {
    throw new Error(
      `${source ?? map.id}: existing YAML has parse errors — ${doc.errors[0]!.message}`,
    );
  }
  const root = doc.toJS() as Record<string, unknown>;
  const existing = Array.isArray(root.placements) ? root.placements : [];
  const usedIds = new Set(
    existing.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const id = (entry as Record<string, unknown>).id;
      return typeof id === "string" ? [id] : [];
    }),
  );

  const placements: Array<Record<string, unknown>> = connections.map((connection, index) => {
    const id = uniquePlacementId(`exit_${stableSegment(connection.target)}`, usedIds);
    usedIds.add(id);
    return {
      id,
      at: [0, 0],
      resource: { kind: "map", id: connection.target },
      collision: "trigger",
      events: [{
        id: "move",
        trigger: "manual",
        label: connection.dir,
        ...(connection.requires ? { requires: connection.requires } : {}),
        ...(connection.lockedHint ? { locked_hint: connection.lockedHint } : {}),
        order: index,
      }],
    };
  });
  if (map.onEnter) {
    const id = uniquePlacementId("on_enter", usedIds);
    usedIds.add(id);
    placements.push({
      id,
      at: [0, 0],
      resource: { kind: "script", id: map.onEnter },
      collision: "none",
      visible: false,
      events: [{ id: "run", trigger: "map_enter", order: -100 }],
    });
  }

  doc.set("placements", [...existing, ...placements]);
  doc.delete("connections");
  doc.delete("on_enter");
  return {
    content: doc.toString(),
    changed: true,
    migratedConnections: connections.length,
    migratedOnEnter: map.onEnter !== undefined,
  };
}

function stableSegment(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "map";
}

function uniquePlacementId(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}
