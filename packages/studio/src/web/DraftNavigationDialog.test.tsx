import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DraftNavigationDialog } from "./DraftNavigationDialog";

describe("Studio draft navigation guard", () => {
  test("offers save, discard, and stay decisions with named context", () => {
    const html = renderToStaticMarkup(<DraftNavigationDialog
      guard={{ label: "Map · 潰れた社", save: async () => true, discard: () => {} }}
      destination="Asset Library"
      saving={false}
      onStay={() => {}}
      onSave={() => {}}
      onDiscard={() => {}}
    />);
    expect(html).toContain("Save before leaving?");
    expect(html).toContain("Map · 潰れた社");
    expect(html).toContain("Asset Library");
    expect(html).toContain("Save &amp; leave");
    expect(html).toContain("Discard &amp; leave");
    expect(html).toContain("Keep editing");
    expect(html).toContain('class="draft-navigation-dialog"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("⌘S");
  });

  test("stays above map editing dialogs while owning the keyboard decision", async () => {
    const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
    expect(css).toContain(".draft-navigation-layer { position: fixed; z-index: 7400;");
    expect(css).toContain(".map-properties-layer { position: fixed; z-index: 7000;");
  });
});
