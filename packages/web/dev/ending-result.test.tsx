import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Game } from "@rpg-harness/engine";
import { StageView } from "../src/WebPlayScreen";

describe("RPG ending result", () => {
  test("presents the ending and the next AI branch as a saved result", () => {
    const game = {
      scripts: [{ id: "moon-end", title: "月下の帰還" }],
    } as unknown as Game;
    const html = renderToStaticMarkup(<StageView
      stage={{ kind: "ended", endingId: "moon-end", reason: "夜明けを迎えた。" }}
      game={game}
      currentMapId={null}
      assetUrls={{}}
      onInput={() => {}}
      exploration={{
        revision: "test",
        pendingOptions: 3,
        next: {
          key: "branch-1",
          scriptId: "moon-end",
          choiceId: "gate",
          optionId: "wait",
          optionText: "門前で夜明けを待つ",
        },
      }}
      onExplore={() => {}}
    />);
    expect(html).toContain("STORY RESULT");
    expect(html).toContain("CLEAR DATA · SAVED");
    expect(html).toContain("月下の帰還");
    expect(html).toContain("ENDING · moon-end");
    expect(html).toContain("AI BRANCH · 3 PATHS REMAIN");
    expect(html).toContain("門前で夜明けを待つ");
    expect(html).toContain("AI に別の分岐を探索させる");
  });
});
