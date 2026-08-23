import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MapDef } from "@rpg-harness/engine";
import type { ProjectResponse } from "./api";
import {
  MapTopologyDialog,
  buildMapTopologyChains,
  buildMapTopologyIntent,
  mapTopologyCommitIntent,
  mapTopologyFocusRestoreIndex,
  mapTopologyFocusRestoreTarget,
  mapTopologyNeedsSourceReplacement,
  preventTopologyDraftUnload,
} from "./MapTopologyDialog";

function map(id: string, extra: Partial<MapDef> = {}): MapDef {
  return {
    id,
    name: extra.name ?? id,
    description: "",
    ...extra,
  };
}

const maps = [
  map("gate", { name: "Gate", chain: " raid ", isEntry: true }),
  map("depths", { name: "Depths", chain: " raid " }),
  map("plain", { name: "Plain", chain: "raid", isEntry: true }),
  map("spaces", { name: "Spaces", chain: "   ", isEntry: true }),
  map("town", { name: "Town" }),
];

const project = {
  graph: { resources: [], references: [], missing: [] },
  maps,
  switches: [],
  variables: [],
  assets: [],
} as unknown as ProjectResponse;

describe("Studio Map Topology dialog", () => {
  test("builds exact chain groups without trimming or merging authored values", () => {
    const chains = buildMapTopologyChains(maps);
    expect(chains.map((chain) => chain.chain)).toEqual(["   ", " raid ", "raid"]);
    expect(chains.find((chain) => chain.chain === " raid ")).toEqual({
      chain: " raid ",
      memberIds: ["gate", "depths"],
      entryIds: ["gate"],
    });
  });

  test("builds a CAS intent from the authoritative exact topology", () => {
    const intent = buildMapTopologyIntent(
      maps[0]!,
      maps,
      "   ",
      "keep-existing",
      "depths",
    );
    expect(intent).toEqual({
      expected: {
        chain: " raid ",
        isEntry: true,
        sourceEntryId: "gate",
        destinationEntryId: "spaces",
      },
      destination: {
        chain: "   ",
        entry: "keep-existing",
      },
      sourceReplacementEntryId: "depths",
    });
    expect(mapTopologyNeedsSourceReplacement(maps[0]!, maps, "   ")).toBe(true);
    expect(mapTopologyNeedsSourceReplacement(maps[1]!, maps, "   ")).toBe(false);
  });

  test("binds commit to the revision returned by the ready preview", () => {
    const intent = buildMapTopologyIntent(maps[1]!, maps, " raid ", "make-selected");
    expect(mapTopologyCommitIntent(intent, { revision: `sha256:${"a".repeat(64)}` })).toEqual({
      ...intent,
      expected: {
        ...intent.expected,
        revision: `sha256:${"a".repeat(64)}`,
      },
    });
  });

  test("guards a dirty topology draft from browser unload", () => {
    let prevented = false;
    const event = {
      returnValue: "unchanged",
      preventDefault() {
        prevented = true;
      },
    } as unknown as BeforeUnloadEvent;

    preventTopologyDraftUnload(event);

    expect(prevented).toBe(true);
    expect(event.returnValue).toBe("");
  });

  test("restores the equivalent focus position after confirmation remounts controls", () => {
    const before = [{ id: "close" }, { id: "chain" }, { id: "cancel" }];
    const index = mapTopologyFocusRestoreIndex(before, before[1]!);
    const after = [{ id: "close-new" }, { id: "chain-new" }, { id: "cancel-new" }];

    expect(index).toBe(1);
    expect(mapTopologyFocusRestoreTarget(after, index)).toBe(after[1]);
    expect(mapTopologyFocusRestoreTarget(after, 99)).toBe(after[0]);
  });

  test("renders stable map identity separately from the exact chain identity", () => {
    const html = renderToStaticMarkup(<MapTopologyDialog
      project={project}
      selectedMap={maps[1]!}
      chains={buildMapTopologyChains(maps)}
      onPreview={async () => ({
        revision: `sha256:${"a".repeat(64)}`,
        changedIds: [],
        assignments: [],
      })}
      onApply={async () => {}}
      onClose={() => {}}
    />);

    expect(html).toContain("Map Topology");
    expect(html).toContain("Stable map ID");
    expect(html).toContain("map:depths");
    expect(html).toContain("Current chain ID");
    expect(html).toContain("&quot; raid &quot;");
    expect(html).toContain("Chain IDs are exact authored strings and are never trimmed");
    expect(html).toContain("Standalone");
    expect(html).toContain("Existing chain");
    expect(html).toContain("New exact chain");
    expect(html).toContain("Apply topology");
  });

  test("ships focus, exact-value, and narrow-screen styles with the component", async () => {
    const css = await Bun.file(new URL("./MapTopologyDialog.css", import.meta.url)).text();
    expect(css).toContain(".map-topology-mode-grid > label:has(input:focus-visible)");
    expect(css).toContain("white-space: pre-wrap");
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toContain("grid-template-columns: minmax(0,1fr)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
