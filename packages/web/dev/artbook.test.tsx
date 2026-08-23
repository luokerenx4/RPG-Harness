import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Game } from "@rpg-harness/engine";
import { ArtBook } from "../src/ArtBook";

describe("in-game setting archive", () => {
  test("renders character-indexed canon assets as an RPG archive", () => {
    const game = {
      characters: [{ id: "kagari", name: "篝", description: "槍を持つ妖刀使。" }],
      assets: [{
        path: "assets/sheets/kagari-master",
        kind: "sheet",
        description: "槍を持つ妖刀使。",
        placeholder: "篝・総合設定画",
        refs: { characters: ["kagari"] },
        tags: ["master"],
      }],
    } as unknown as Game;
    const html = renderToStaticMarkup(<ArtBook
      game={game}
      assetUrls={{ "assets/sheets/kagari-master": "/kagari.png" }}
      onClose={() => {}}
    />);
    expect(html).toContain("ARCHIVE · 1 RECORDS");
    expect(html).toContain("CHARACTER FILE · 01");
    expect(html).toContain("槍を持つ妖刀使。");
    expect(html).toContain("assets/sheets/kagari-master");
  });
});
