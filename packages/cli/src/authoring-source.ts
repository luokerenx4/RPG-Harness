import path from "node:path";

/** Normalize parser/loader source locators to a portable game-root coordinate. */
export function normalizeAuthoringSource(
  gameDir: string,
  source: string,
): string {
  const normalizedGame = path.resolve(gameDir);
  const normalizedSource = path.resolve(source);
  const relative = path.relative(normalizedGame, normalizedSource);
  const insideGame = relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
  return (insideGame ? relative : source).split(path.sep).join(path.posix.sep);
}
