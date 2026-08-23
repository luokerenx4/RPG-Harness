import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MapDef, MapPlacementDef } from "@rpg-harness/engine";
import {
  ReciprocalRouteDialog,
  ReciprocalRouteDiscardConfirmation,
  buildReciprocalRouteSubmitPayload,
  clampReciprocalRoutePoint,
  createReciprocalRouteDialogDraft,
  isReciprocalRouteFocusable,
  mapWithPendingRoutePlacement,
  reciprocalRouteArrivalSummary,
  reciprocalRouteCloseDecision,
  reciprocalRouteDraftsEqual,
  reciprocalRouteFocusDestination,
  reciprocalRouteFocusRestoreIndex,
  reciprocalRouteFocusRestoreTarget,
  preventReciprocalRouteDraftUnload,
  retargetReciprocalForwardArrival,
  suggestReciprocalRoutePlacementId,
  validateReciprocalRouteDraft,
} from "./ReciprocalRouteDialog";

function placement(id: string, x = 0, y = 0): MapPlacementDef {
  return {
    id,
    at: { x, y },
    z: 0,
    footprint: { width: 1, height: 1 },
    collision: "trigger",
    visible: true,
    events: [],
  };
}

const sourceMap: MapDef = {
  id: "source-map",
  name: "Source Hall",
  description: "Source map.",
  layout: {
    width: 8,
    height: 6,
    tileWidth: 32,
    tileHeight: 32,
    playerStart: { x: 1, y: 2 },
    layers: [],
    regions: [],
  },
  placements: [placement("route_to_target-map", 2, 2), placement("source-marker", 4, 1)],
};

const targetMap: MapDef = {
  id: "target-map",
  name: "Target Court",
  description: "Destination map.",
  layout: {
    width: 5,
    height: 4,
    tileWidth: 32,
    tileHeight: 32,
    playerStart: { x: 3, y: 1 },
    layers: [],
    regions: [],
  },
  placements: [placement("route_to_source-map", 1, 1), placement("target-marker", 2, 3)],
};

const nodeMap: MapDef = {
  id: "dream-node",
  name: "Dream Node",
  description: "Folded destination.",
  placements: [placement("memory", 0, 0)],
};

describe("Studio reciprocal route dialog", () => {
  test("builds two collision-free pending route placements with counterpart arrivals", () => {
    const draft = createReciprocalRouteDialogDraft(
      sourceMap,
      [sourceMap, targetMap],
      { x: 99, y: -3 },
      targetMap.id,
    );

    expect(draft.targetMapId).toBe("target-map");
    expect(draft.forward).toMatchObject({
      placementId: "route_to_target-map_2",
      at: { x: 7, y: 0 },
      eventId: "transfer",
      label: "Travel to Target Court",
      trigger: "interact",
      arrival: { placementId: "route_to_source-map_2" },
    });
    expect(draft.reverse).toMatchObject({
      placementId: "route_to_source-map_2",
      at: { x: 3, y: 1 },
      eventId: "transfer",
      label: "Return to Source Hall",
      trigger: "interact",
      arrival: { placementId: "route_to_target-map_2" },
    });
    expect(validateReciprocalRouteDraft(sourceMap, [sourceMap, targetMap], draft)).toEqual([]);
  });

  test("keeps node placement origins canonical and suggestions deterministic", () => {
    expect(clampReciprocalRoutePoint(nodeMap, { x: 12, y: -8 })).toEqual({ x: 0, y: 0 });
    expect(clampReciprocalRoutePoint(targetMap, { x: 7.8, y: -2 })).toEqual({ x: 4, y: 0 });
    expect(suggestReciprocalRoutePlacementId("snow field", ["route_to_snow_field", "route_to_snow_field_2"]))
      .toBe("route_to_snow_field_3");

    const draft = createReciprocalRouteDialogDraft(sourceMap, [sourceMap, nodeMap], undefined, nodeMap.id);
    expect(draft.reverse.at).toEqual({ x: 0, y: 0 });
    expect(validateReciprocalRouteDraft(sourceMap, [sourceMap, nodeMap], draft)).toEqual([]);
  });

  test("builds an endpoint-neutral forward and reverse payload without optional map-start fields", () => {
    const draft = createReciprocalRouteDialogDraft(sourceMap, [sourceMap, targetMap]);
    draft.forward.placementId = " exact forward id ";
    draft.forward.eventId = "forward-event";
    draft.forward.label = "Forward label";
    draft.forward.arrival = undefined;
    draft.reverse.placementId = "exact-return-id";
    draft.reverse.eventId = "return-event";
    draft.reverse.label = "Return label";
    draft.reverse.arrival = { at: { x: 6, y: 5 } };

    expect(validateReciprocalRouteDraft(sourceMap, [sourceMap, targetMap], draft)).toEqual([]);
    const payload = buildReciprocalRouteSubmitPayload(sourceMap, draft);
    expect(payload).toEqual({
      forward: {
        sourceMapId: "source-map",
        targetMapId: "target-map",
        placementId: " exact forward id ",
        at: { x: 1, y: 2 },
        eventId: "forward-event",
        label: "Forward label",
        trigger: "interact",
      },
      reverse: {
        sourceMapId: "target-map",
        targetMapId: "source-map",
        placementId: "exact-return-id",
        at: { x: 3, y: 1 },
        eventId: "return-event",
        label: "Return label",
        trigger: "interact",
        arrival: { at: { x: 6, y: 5 } },
      },
    });
    expect(payload.forward).not.toHaveProperty("arrival");
  });

  test("rejects self routes, missing second maps, collisions, and invalid arrivals", () => {
    const draft = createReciprocalRouteDialogDraft(sourceMap, [sourceMap, targetMap]);
    const collision = structuredClone(draft);
    collision.forward.placementId = "source-marker";
    collision.reverse.placementId = "target-marker";
    collision.forward.eventId = " ";
    collision.reverse.arrival = {};
    const collisionIssues = validateReciprocalRouteDraft(sourceMap, [sourceMap, targetMap], collision);
    expect(collisionIssues.map((issue) => issue.field)).toEqual(expect.arrayContaining([
      "forward.placementId",
      "forward.eventId",
      "reverse.placementId",
      "reverse.arrival",
    ]));

    const selfRoute = { ...draft, targetMapId: sourceMap.id };
    expect(validateReciprocalRouteDraft(sourceMap, [sourceMap, targetMap], selfRoute)[0]?.message)
      .toContain("two different maps");

    const singleMap = createReciprocalRouteDialogDraft(sourceMap, [sourceMap]);
    expect(singleMap.targetMapId).toBe("");
    expect(validateReciprocalRouteDraft(sourceMap, [sourceMap], singleMap)[0]?.message)
      .toContain("needs a second map");

    const nodeDraft = createReciprocalRouteDialogDraft(sourceMap, [sourceMap, nodeMap], undefined, nodeMap.id);
    nodeDraft.forward.arrival = { at: { x: 1, y: 1 } };
    expect(validateReciprocalRouteDraft(sourceMap, [sourceMap, nodeMap], nodeDraft))
      .toContainEqual(expect.objectContaining({ field: "forward.arrival" }));
  });

  test("injects a pending counterpart only into an arrival projection", () => {
    const draft = createReciprocalRouteDialogDraft(sourceMap, [sourceMap, targetMap]);
    const before = structuredClone(targetMap);
    const projected = mapWithPendingRoutePlacement(targetMap, draft.reverse, sourceMap.id);

    expect(projected).not.toBe(targetMap);
    expect(projected.placements?.at(-1)).toMatchObject({
      id: draft.reverse.placementId,
      at: draft.reverse.at,
      collision: "trigger",
      resource: { kind: "map", id: sourceMap.id },
      events: [],
    });
    expect(targetMap).toEqual(before);
    expect(reciprocalRouteArrivalSummary({ placementId: draft.reverse.placementId }))
      .toBe(`placement:${draft.reverse.placementId}`);
    expect(reciprocalRouteArrivalSummary(undefined)).toBe("map start");
  });

  test("retargets only the untouched pending-counterpart arrival", () => {
    expect(retargetReciprocalForwardArrival(
      { placementId: "old-return-door" },
      "old-return-door",
      "new-return-door",
    )).toEqual({ placementId: "new-return-door" });
    expect(retargetReciprocalForwardArrival(
      undefined,
      "old-return-door",
      "new-return-door",
    )).toBeUndefined();
    expect(retargetReciprocalForwardArrival(
      { at: { x: 4, y: 2 } },
      "old-return-door",
      "new-return-door",
    )).toEqual({ at: { x: 4, y: 2 } });
    expect(retargetReciprocalForwardArrival(
      { placementId: "authored-anchor" },
      "old-return-door",
      "new-return-door",
    )).toEqual({ placementId: "authored-anchor" });
  });

  test("compares the baseline and current draft by authored route semantics", () => {
    const baseline = createReciprocalRouteDialogDraft(sourceMap, [sourceMap, targetMap]);
    const draft = structuredClone(baseline);

    expect(reciprocalRouteDraftsEqual(baseline, draft)).toBe(true);
    draft.forward.label = "A different player label";
    expect(reciprocalRouteDraftsEqual(baseline, draft)).toBe(false);
    draft.forward.label = baseline.forward.label;
    expect(reciprocalRouteDraftsEqual(baseline, draft)).toBe(true);

    draft.reverse.at = { ...baseline.reverse.at, x: baseline.reverse.at.x + 1 };
    expect(reciprocalRouteDraftsEqual(baseline, draft)).toBe(false);
    draft.reverse.at = { ...baseline.reverse.at };
    draft.forward.arrival = undefined;
    expect(reciprocalRouteDraftsEqual(baseline, draft)).toBe(false);
  });

  test("routes clean, dirty, and submitting close requests explicitly", () => {
    expect(reciprocalRouteCloseDecision(false, false)).toBe("close");
    expect(reciprocalRouteCloseDecision(true, false)).toBe("confirm");
    expect(reciprocalRouteCloseDecision(false, true)).toBe("blocked");
    expect(reciprocalRouteCloseDecision(true, true)).toBe("blocked");
  });

  test("guards a dirty route draft from browser unload", () => {
    let prevented = false;
    const event = {
      returnValue: "unchanged",
      preventDefault() {
        prevented = true;
      },
    } as unknown as BeforeUnloadEvent;

    preventReciprocalRouteDraftUnload(event);

    expect(prevented).toBe(true);
    expect(event.returnValue).toBe("");
  });

  test("restores the equivalent focus position after the confirmation view unmounts", () => {
    const before = [{ id: "close" }, { id: "label" }, { id: "cancel" }];
    const index = reciprocalRouteFocusRestoreIndex(before, before[1]!);
    const after = [{ id: "close-new" }, { id: "label-new" }, { id: "cancel-new" }];

    expect(index).toBe(1);
    expect(reciprocalRouteFocusRestoreTarget(after, index)).toBe(after[1]);
    expect(reciprocalRouteFocusRestoreTarget(after, 99)).toBe(after[0]);
  });

  test("keeps Tab inside the dialog when fieldset-disabled controls are not focusable", () => {
    const enabled = focusCandidate(false, false);
    const fieldsetDisabled = focusCandidate(true, false);
    const ariaHidden = focusCandidate(false, true);

    expect(isReciprocalRouteFocusable(enabled)).toBe(true);
    expect(isReciprocalRouteFocusable(fieldsetDisabled)).toBe(false);
    expect(isReciprocalRouteFocusable(ariaHidden)).toBe(false);
    expect(fieldsetDisabled.seenSelectors).toContain(":disabled");

    expect(reciprocalRouteFocusDestination(0, -1, true, false)).toBe("dialog");
    expect(reciprocalRouteFocusDestination(0, -1, true, true)).toBe("dialog");
    expect(reciprocalRouteFocusDestination(3, -1, true, false)).toBe("first");
    expect(reciprocalRouteFocusDestination(3, -1, true, true)).toBe("last");
    expect(reciprocalRouteFocusDestination(3, 0, false, true)).toBe("last");
    expect(reciprocalRouteFocusDestination(3, 2, false, false)).toBe("first");
    expect(reciprocalRouteFocusDestination(3, 1, false, false)).toBeNull();
  });

  test("renders linked doors as two explicit directed routes with unique arrival groups", () => {
    const html = renderToStaticMarkup(<ReciprocalRouteDialog
      sourceMap={sourceMap}
      maps={[sourceMap, targetMap, nodeMap]}
      initialTargetMapId={targetMap.id}
      onSubmit={() => {}}
      onClose={() => {}}
    />);

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Create reciprocal route");
    expect(html).toContain("two independent directed routes");
    expect(html).toContain("Forward route");
    expect(html).toContain("Return route");
    expect(html).toContain("map:source-map → map:target-map");
    expect(html).toContain("map:target-map → map:source-map");
    expect(html).toContain("PENDING COUNTERPART");
    expect(html).toContain("route_to_source-map_2");
    expect(html).toContain("route_to_target-map_2");
    expect(html).toContain("VALIDATION READY");
    expect(html).toContain("Create reciprocal route");
    expect(html).not.toContain('<option value="source-map"');
    expect(html).toContain("-forward-arrival-mode");
    expect(html).toContain("-reverse-arrival-mode");
  });

  test("renders a clear discard confirmation without nesting modal semantics", () => {
    const html = renderToStaticMarkup(<ReciprocalRouteDiscardConfirmation
      domId="discard-test"
      submitting={false}
      onKeepEditing={() => {}}
      onDiscard={() => {}}
    />);

    expect(html).toContain("Discard reciprocal route draft?");
    expect(html).toContain("No map source has been changed yet.");
    expect(html).toContain("Keep editing");
    expect(html).toContain("Discard route draft");
    expect(html).not.toContain("aria-modal");
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('role="alertdialog"');

    const submittingHtml = renderToStaticMarkup(<ReciprocalRouteDiscardConfirmation
      domId="discard-blocked-test"
      submitting
      onKeepEditing={() => {}}
      onDiscard={() => {}}
    />);
    expect(submittingHtml.match(/disabled=""/g)).toHaveLength(2);
  });

  test("renders a blocked single-map state and controlled submission error", () => {
    const emptyHtml = renderToStaticMarkup(<ReciprocalRouteDialog
      sourceMap={sourceMap}
      maps={[sourceMap]}
      onSubmit={() => {}}
      onClose={() => {}}
    />);
    expect(emptyHtml).toContain("Needs a second map");
    expect(emptyHtml).toContain("Linked doors need a second map");
    expect(emptyHtml).toContain("This project needs a second map");
    expect(emptyHtml).toContain('class="primary" disabled=""');

    const errorHtml = renderToStaticMarkup(<ReciprocalRouteDialog
      sourceMap={sourceMap}
      maps={[sourceMap, targetMap]}
      submitting
      submitError="revision changed"
      onSubmit={() => {}}
      onClose={() => {}}
    />);
    expect(errorHtml).toContain('aria-busy="true"');
    expect(errorHtml).toContain('class="reciprocal-route-body" disabled=""');
    expect(errorHtml).toContain('class="reciprocal-route-submit-error" role="alert"');
    expect(errorHtml).toContain("revision changed");
    expect(errorHtml).toContain("Creating…");
  });

  test("ships scoped focus, narrow-screen, fixed-error, and reduced-motion styles", async () => {
    const css = await Bun.file(new URL("./ReciprocalRouteDialog.css", import.meta.url)).text();

    expect(css).toContain(".reciprocal-route-layer");
    expect(css).toContain("z-index: 7200");
    expect(css).toContain(".reciprocal-route-direction-fields input:focus-visible");
    expect(css).toContain(".reciprocal-route-submit-error");
    expect(css).toContain(".reciprocal-route-dialog.confirming");
    expect(css).toContain(".reciprocal-route-confirm-body");
    expect(css).toContain(".reciprocal-route-footer.confirm-actions");
    expect(css).toContain(".reciprocal-route-footer button.danger");
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toContain("grid-template-columns: minmax(0,1fr)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  test("wires every dialog close gesture through the same dirty-draft request", async () => {
    const source = await Bun.file(new URL("./ReciprocalRouteDialog.tsx", import.meta.url)).text();

    expect(source.match(/onClick=\{requestClose\}/g)?.length).toBe(3);
    expect(source).toContain('role={confirmClose ? "alertdialog" : "dialog"}');
    expect(source).toContain('if (confirmClose) return;');
    expect(source).toContain('if (confirmClose) cancelClose();');
    expect(source).toContain('else requestClose();');
    expect(source).toContain('onDiscard={onClose}');
    expect(source).toContain('window.addEventListener("beforeunload", preventReciprocalRouteDraftUnload)');
  });

  test("wires the map toolbar through draft protection and a preview-bound commit", async () => {
    const projectSource = await Bun.file(new URL("./pages/Project.tsx", import.meta.url)).text();
    const overview = projectSource.slice(
      projectSource.indexOf("function MapOverview("),
      projectSource.indexOf("export function MapPropertiesDialog("),
    );

    expect(overview).toContain("⇄ Linked doors…");
    expect(overview).toContain('aria-haspopup="dialog"');
    expect(overview).toContain("setReciprocalRouteGuardOpen(true);");
    expect(overview).toContain('destination="Linked Doors"');
    expect(projectSource.match(/document[.]querySelector\('\[aria-modal="true"\]'\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(overview).toContain("if (reciprocalRouteSubmitLockRef.current) return;");
    expect(overview.indexOf("reciprocalRouteSubmitLockRef.current = true;")).toBeLessThan(
      overview.indexOf("await previewReciprocalMapRoutes(payload)"),
    );
    const preview = overview.indexOf("await previewReciprocalMapRoutes(payload)");
    const commit = overview.indexOf("await saveReciprocalMapRoutes({", preview);
    expect(preview).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(preview);
    expect(overview.slice(commit, commit + 180)).toContain("expectedRevision: preview.revision");
  });
});

function focusCandidate(disabled: boolean, hidden: boolean) {
  const seenSelectors: string[] = [];
  return {
    seenSelectors,
    matches(selector: string) {
      seenSelectors.push(selector);
      return selector === ":disabled" && disabled;
    },
    closest(selector: string) {
      seenSelectors.push(selector);
      return selector === '[aria-hidden="true"]' && hidden ? {} : null;
    },
  };
}
