import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { ViteDevServer } from "vite";
import {
  installGameContentReload,
  isBakedGameFile,
} from "./game-content-reload";

describe("Web game content reload", () => {
  const root = path.resolve("/repo/examples");

  test("recognizes files whose glob membership changes the bundled game", () => {
    for (const relative of [
      "sengoku/game.yaml",
      "sengoku/scripts/new-scene.md",
      "sengoku/modules/new-rule.ts",
      "sengoku/assets/backgrounds/new/spec.yml",
      "sengoku/assets/backgrounds/new/source.compressed.webp",
      "sengoku/assets/portraits/new/web.webp",
    ]) {
      expect(isBakedGameFile(path.join(root, relative), root)).toBe(true);
    }
  });

  test("ignores session writes, editor noise, and files outside examples", () => {
    for (const file of [
      path.join(root, "sengoku/.rpg-harness/sessions/web/state.json"),
      path.join(root, "sengoku/assets/backgrounds/new/tui.ans"),
      path.join(root, "sengoku/assets/portraits/new/source.quality.png"),
      path.join(root, "sengoku/modules/raid.personas.test.ts"),
      path.join(root, "sengoku/modules/raid.personas.spec.ts"),
      path.join(root, "sengoku/.DS_Store"),
      path.resolve("/repo/packages/web/src/App.tsx"),
    ]) {
      expect(isBakedGameFile(file, root)).toBe(false);
    }
  });

  test("new baked files invalidate the registry and request a full reload", () => {
    const callbacks = new Map<string, (file: string) => void>();
    const invalidated: unknown[] = [];
    const messages: unknown[] = [];
    const watched: string[] = [];
    const registryModule = { id: "loadGame" };
    const server = {
      watcher: {
        add: (file: string) => watched.push(file),
        on: (event: string, callback: (file: string) => void) => {
          callbacks.set(event, callback);
          return undefined;
        },
      },
      moduleGraph: {
        getModulesByFile: () => new Set([registryModule]),
        invalidateModule: (module: unknown) => invalidated.push(module),
      },
      ws: { send: (message: unknown) => messages.push(message) },
    } as unknown as Pick<ViteDevServer, "watcher" | "moduleGraph" | "ws">;

    installGameContentReload(server, root, "/repo/packages/web/src/loadGame.ts");
    callbacks.get("add")?.(
      path.join(root, "sengoku/assets/backgrounds/new/spec.yaml"),
    );

    expect(watched).toEqual([root]);
    expect(invalidated).toEqual([registryModule]);
    expect(messages).toEqual([{ type: "full-reload", path: "*" }]);
  });

  test("session writes do not reload the game", () => {
    const callbacks = new Map<string, (file: string) => void>();
    const messages: unknown[] = [];
    const server = {
      watcher: {
        add: () => undefined,
        on: (event: string, callback: (file: string) => void) => {
          callbacks.set(event, callback);
          return undefined;
        },
      },
      moduleGraph: {
        getModulesByFile: () => new Set(),
        invalidateModule: () => undefined,
      },
      ws: { send: (message: unknown) => messages.push(message) },
    } as unknown as Pick<ViteDevServer, "watcher" | "moduleGraph" | "ws">;

    installGameContentReload(server, root, "/repo/packages/web/src/loadGame.ts");
    callbacks.get("add")?.(
      path.join(root, "sengoku/.rpg-harness/sessions/web/state.json"),
    );

    expect(messages).toEqual([]);
  });
});
