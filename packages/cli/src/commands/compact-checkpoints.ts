import {
  compactSessionCheckpoints,
  type SessionCheckpointCompactionSummary,
} from "@rpg-harness/session-store";

export interface CompactCheckpointsArgs {
  gameDir: string;
  apply: boolean;
  pretty: boolean;
}

export async function compactCheckpointsCommand(
  args: CompactCheckpointsArgs,
): Promise<void> {
  const summary = await compactSessionCheckpoints(args.gameDir, {
    apply: args.apply,
  });
  process.stdout.write(
    args.pretty
      ? `${JSON.stringify(summary, null, 2)}\n`
      : formatCheckpointCompaction(summary),
  );
}

export function formatCheckpointCompaction(
  summary: SessionCheckpointCompactionSummary,
): string {
  if (summary.legacyFiles === 0) {
    return "Checkpoint object store is compact; no legacy files found.\n";
  }
  const action = summary.mode === "apply" ? "Compacted" : "Would compact";
  const tail = summary.mode === "dry-run"
    ? " Run again with --apply to migrate verified objects and remove legacy copies."
    : " All legacy copies were removed after their global objects were verified.";
  return [
    `${action} ${summary.legacyFiles} legacy checkpoint files (${formatBytes(summary.legacyBytes)})`,
    `into ${summary.uniqueRevisions} project objects; ${formatBytes(summary.reclaimableBytes)} reclaimable.`,
    tail.trimStart(),
  ].join(" ") + "\n";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}
