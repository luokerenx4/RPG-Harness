/** Runtime Web builds ship frontend/compressed tiers, never authoring masters. */
export function rankWebAssetImage(file: string): number {
  if (file.startsWith("web.")) return 2;
  if (file.startsWith("source.compressed.")) return 1;
  return 0;
}
