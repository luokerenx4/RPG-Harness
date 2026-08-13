import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Game } from "@rpg-harness/engine";
import { StageView } from "../src/WebPlayScreen";

describe("Web terminal handoff", () => {
  test("shows the authored title and stable ending id from Headless gameEnd", () => {
    const game = {
      scripts: [{ id: "ending_oni_self", title: "鬼の器" }],
    } as unknown as Game;

    const html = renderToStaticMarkup(
      <StageView
        stage={{ kind: "ended", endingId: "ending_oni_self" }}
        game={game}
        onInput={() => {}}
      />,
    );

    expect(html).toContain("鬼の器");
    expect(html).toContain("ending_oni_self");
  });

  test("keeps legacy gameEnd output renderable without an ending id", () => {
    const html = renderToStaticMarkup(
      <StageView
        stage={{ kind: "ended" }}
        game={{ scripts: [] } as unknown as Game}
        onInput={() => {}}
      />,
    );

    expect(html).toContain("― 終 ―");
    expect(html).not.toContain("ended-ending-id");
  });
});
