import { readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { migrateMapToPlacements } from "@rpg-harness/parser";
import { loadGame } from "../loader";

interface Args {
  gameDir: string;
  apply: boolean;
  format: "table" | "json";
}

interface MigrationRow {
  file: string;
  connections: number;
  onEnter: boolean;
}

export async function migrateMapsCommand(args: Args): Promise<void> {
  const gameDir = path.resolve(args.gameDir);
  await loadGame(gameDir);
  const mapDir = path.join(gameDir, "maps");
  const names = (await readdir(mapDir))
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort();
  const pending: Array<MigrationRow & { abs: string; content: string }> = [];

  for (const name of names) {
    const abs = path.join(mapDir, name);
    const original = await readFile(abs, "utf-8");
    const result = migrateMapToPlacements(original, path.relative(gameDir, abs));
    if (!result.changed) continue;
    pending.push({
      file: path.relative(gameDir, abs),
      connections: result.migratedConnections,
      onEnter: result.migratedOnEnter,
      abs,
      content: result.content,
    });
  }

  if (args.apply) {
    for (const entry of pending) await atomicWrite(entry.abs, entry.content);
    await loadGame(gameDir);
  }

  const rows = pending.map(({ file, connections, onEnter }) => ({ file, connections, onEnter }));
  if (args.format === "json") {
    process.stdout.write(JSON.stringify({ applied: args.apply, maps: rows }, null, 2) + "\n");
    return;
  }

  if (rows.length === 0) {
    process.stdout.write("All maps already use placement-backed exits and entry events.\n");
    return;
  }
  for (const row of rows) {
    const details = [
      `${row.connections} exits`,
      ...(row.onEnter ? ["on_enter"] : []),
    ].join(", ");
    process.stdout.write(`${args.apply ? "migrated" : "would migrate"} ${row.file} (${details})\n`);
  }
  process.stdout.write(
    `\n${rows.length} map${rows.length === 1 ? "" : "s"}, ${rows.reduce((sum, row) => sum + row.connections, 0)} exits, ${rows.filter((row) => row.onEnter).length} entry events${args.apply ? " migrated" : " pending; rerun with --apply"}.\n`,
  );
}

async function atomicWrite(abs: string, content: string): Promise<void> {
  const temporary = abs + ".map-v2.tmp";
  await writeFile(temporary, content);
  await rename(temporary, abs).catch(async (error) => {
    await unlink(temporary).catch(() => {});
    throw error;
  });
}
