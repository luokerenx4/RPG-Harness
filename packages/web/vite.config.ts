import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { gameContentReloadPlugin } from "./dev/game-content-reload";
import { sessionBridgePlugin } from "./dev/session-bridge";

// The production Web shell stays static: the engine is bundled into the page,
// games are baked at build time, and saves fall back to localStorage. During
// local development, sessionBridgePlugin adds a same-origin filesystem bridge
// so GUI steps use the exact state.json/log.jsonl sessions as the CLI.
//
// The game folders live at <repo>/examples, two levels above this
// package, so the dev server must be allowed to read them for the
// ?raw / ?url glob imports. fs.allow opens the repo root.
const repoRoot = path.resolve(import.meta.dirname, "../..");
const examplesRoot = path.join(repoRoot, "examples");

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [
    react(),
    gameContentReloadPlugin(examplesRoot),
    sessionBridgePlugin(examplesRoot),
  ],
  server: {
    port: Number(process.env.WEB_PORT ?? 5174),
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
