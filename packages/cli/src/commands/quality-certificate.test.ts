import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  qualityAuditInputRevision,
  runQualitySurfaceChecks,
  type QualityAuditInputs,
} from "./quality-certificate";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("project quality certificate input", () => {
  test("executes the current Web GUI contract before certification", async () => {
    expect(await runQualitySurfaceChecks()).toMatchObject([{
      schemaVersion: 11,
      id: "web-input-contract",
      status: "passed",
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      interactions: [
        { surface: "narration", input: { type: "next" } },
        { surface: "choice", input: { type: "choose", choiceId: "route", optionId: "friends" } },
        { surface: "hub-activity", input: { type: "doActivity", id: "invite:kasumi" } },
        { surface: "script-select", input: { type: "select", scriptId: "ending" } },
      ],
      projections: [{
        surface: "player-feedback-proof",
        text: "検証済みproject aaaaaaaaaa → bbbbbbbbbbcertificate cccccccccc",
      }, {
        surface: "objective-requirement",
        text: "○ Vow kept○ Pulse: Oni 0 / 6",
      }, {
        surface: "locked-condition",
        text: "🔒 Kagariの親密度 4 以上（現在 0）、先に「Moonlit promise」を完了",
      }, {
        surface: "machine-effect-hidden",
        text: "親密度 +1（50 両）",
      }, {
        surface: "forecast-unit-hidden",
        text: "両 +11",
      }, {
        surface: "forecast-detail-hidden",
        text: "ダメージ 14–21 HP",
      }, {
        surface: "terminal-ai-branch",
        text: "AI BRANCH · 3 PATHS次: Remember the others",
      }, {
        surface: "ai-choice-backlog",
        text: "What do you promise?AI 選択Stay until dawn",
      }, {
        surface: "branch-control-handoff",
        text: "AI 首映 · Explore Stay玩家游玩 · AI 来源: Explore Stay",
      }, {
        surface: "feedback-live-routing",
        text: "scripts/current.mdRouting: live checkpoint / current runtime",
      }],
    }]);
  });

  test("invalidates when the Web GUI evaluator changes", async () => {
    const workspaceRoot = await temporaryWorkspace();
    const gameDir = path.join(workspaceRoot, "examples", "game");
    const inputs: QualityAuditInputs = {
      personas: ["objective"],
      fuzzPersonas: [],
      policy: { personas: ["objective"], minUniqueEndings: 1 },
      maxSteps: 10,
      maxSegments: 2,
      seeds: [7],
    };
    const before = await qualityAuditInputRevision(
      gameDir,
      inputs,
      { workspaceRoot },
    );

    await writeFile(
      path.join(workspaceRoot, "packages/web/src/WebPlayScreen.tsx"),
      "export const dispatch = 'broken-gui-input';\n",
      "utf-8",
    );
    const afterUiEdit = await qualityAuditInputRevision(
      gameDir,
      inputs,
      { workspaceRoot },
    );

    await writeFile(
      path.join(workspaceRoot, "packages/web/dev/session-bridge.ts"),
      "export const bridge = 'changed-session-contract';\n",
      "utf-8",
    );
    const afterBridgeEdit = await qualityAuditInputRevision(
      gameDir,
      inputs,
      { workspaceRoot },
    );

    expect(afterUiEdit).not.toBe(before);
    expect(afterBridgeEdit).not.toBe(afterUiEdit);
  });
});

async function temporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "rpgh-quality-input-"));
  temporaryDirectories.push(root);
  const sourceFiles: Record<string, string> = {
    "examples/game/game.yaml": "title: Quality input test\n",
    "packages/cli/src/index.ts": "export {};\n",
    "packages/engine/src/index.ts": "export {};\n",
    "packages/frontend-core/src/index.ts": "export {};\n",
    "packages/parser/src/index.ts": "export {};\n",
    "packages/session-store/src/index.ts": "export {};\n",
    "packages/web/src/WebPlayScreen.tsx": "export const dispatch = 'stable';\n",
    "packages/web/dev/session-bridge.ts": "export const bridge = 'stable';\n",
    "packages/web/index.html": "<div id=\"root\"></div>\n",
    "packages/web/vite.config.ts": "export default {};\n",
  };
  for (const relative of [
    "bun.lock",
    "package.json",
    "tsconfig.base.json",
    "packages/cli/package.json",
    "packages/engine/package.json",
    "packages/frontend-core/package.json",
    "packages/parser/package.json",
    "packages/session-store/package.json",
    "packages/web/package.json",
  ]) sourceFiles[relative] = "{}\n";
  for (const [relative, content] of Object.entries(sourceFiles)) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf-8");
  }
  return root;
}
