import path from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import { rankWebAssetImage } from "../src/assetImagePolicy";

const BAKED_CONTENT_FILE = /\.(?:md|ya?ml|ts)$/i;

// import.meta.glob tracks the files that existed when loadGame.ts was
// transformed. Vite HMR handles edits to those files, but a newly authored
// script/spec/rendering (or a deletion) changes the glob membership itself.
// Invalidate the registry module and reload the page so an AI can add assets
// during a live playtest without restarting the dev server.
export function gameContentReloadPlugin(examplesRoot: string): Plugin {
  const root = path.resolve(examplesRoot);
  const loadGameFile = path.resolve(import.meta.dirname, "../src/loadGame.ts");
  return {
    name: "rpg-harness-game-content-reload",
    apply: "serve",
    configureServer(server) {
      installGameContentReload(server, root, loadGameFile);
    },
  };
}

export function installGameContentReload(
  server: Pick<ViteDevServer, "watcher" | "moduleGraph" | "ws">,
  examplesRoot: string,
  loadGameFile: string,
): void {
  const root = path.resolve(examplesRoot);
  server.watcher.add(root);
  const reload = (file: string) => {
    if (!isBakedGameFile(file, root)) return;
    invalidateLoadGame(server, loadGameFile);
    server.ws.send({ type: "full-reload", path: "*" });
  };
  server.watcher.on("add", reload);
  server.watcher.on("unlink", reload);
}

export function isBakedGameFile(file: string, examplesRoot: string): boolean {
  const relative = path.relative(path.resolve(examplesRoot), path.resolve(file));
  const normalized = relative.split(path.sep).join("/");
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative) &&
    !relative.split(path.sep).some((segment) => segment.startsWith(".")) &&
    !/\.(?:test|spec)\.ts$/i.test(normalized) &&
    (BAKED_CONTENT_FILE.test(relative) || rankWebAssetImage(path.posix.basename(normalized)) > 0)
  );
}

function invalidateLoadGame(
  server: Pick<ViteDevServer, "moduleGraph">,
  loadGameFile: string,
): void {
  for (const module of server.moduleGraph.getModulesByFile(loadGameFile) ?? []) {
    server.moduleGraph.invalidateModule(module);
  }
}
