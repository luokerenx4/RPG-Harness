import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  MapArrivalDef,
  MapDef,
  MapEventTrigger,
  MapPlacementDef,
  MapPoint,
} from "@rpg-harness/engine";
import { RouteArrivalEditor } from "./RouteArrivalEditor";
import "./ReciprocalRouteDialog.css";

export interface DirectedRoutePlacementDraft {
  sourceMapId: string;
  targetMapId: string;
  placementId: string;
  at: MapPoint;
  eventId: string;
  label: string;
  trigger: MapEventTrigger;
  arrival?: MapArrivalDef;
}

export interface ReciprocalRouteSubmitPayload {
  forward: DirectedRoutePlacementDraft;
  reverse: DirectedRoutePlacementDraft;
}

export interface ReciprocalRouteDirectionFields {
  placementId: string;
  at: MapPoint;
  eventId: string;
  label: string;
  trigger: MapEventTrigger;
  arrival?: MapArrivalDef;
}

export interface ReciprocalRouteDialogDraft {
  targetMapId: string;
  forward: ReciprocalRouteDirectionFields;
  reverse: ReciprocalRouteDirectionFields;
}

export interface ReciprocalRouteValidationIssue {
  field: string;
  message: string;
}

export interface ReciprocalRouteDialogProps {
  /** Fixed source context for this atomic linked-door draft. */
  sourceMap: MapDef;
  /** Authoritative map catalog. sourceMap wins when its id is also present here. */
  maps: readonly MapDef[];
  /** Selected source canvas cell; node maps always normalize this to 0,0. */
  initialSourceAt?: MapPoint;
  initialTargetMapId?: string;
  submitting?: boolean;
  submitError?: string | null;
  onSubmit: (payload: ReciprocalRouteSubmitPayload) => void;
  onClose: () => void;
}

export const RECIPROCAL_ROUTE_TRIGGERS: ReadonlyArray<{
  value: MapEventTrigger;
  label: string;
}> = [
  { value: "interact", label: "Action Button" },
  { value: "player_touch", label: "Player Touch" },
  { value: "event_touch", label: "Event Touch" },
  { value: "manual", label: "Explicit Call" },
];

/** Clamp placement origins to a spatial map, or fold a node map to 0,0. */
export function clampReciprocalRoutePoint(
  map: Pick<MapDef, "layout">,
  point: MapPoint,
): MapPoint {
  if (!map.layout) return { x: 0, y: 0 };
  return {
    x: clampInteger(point.x, 0, Math.max(0, map.layout.width - 1)),
    y: clampInteger(point.y, 0, Math.max(0, map.layout.height - 1)),
  };
}

/** Generate a readable stable id without overwriting an authored placement. */
export function suggestReciprocalRoutePlacementId(
  targetMapId: string,
  usedIds: readonly string[],
): string {
  const segment = targetMapId
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "map";
  const base = `route_to_${segment}`;
  const used = new Set(usedIds);
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

export function createReciprocalRouteDialogDraft(
  sourceMap: MapDef,
  maps: readonly MapDef[],
  initialSourceAt?: MapPoint,
  initialTargetMapId?: string,
): ReciprocalRouteDialogDraft {
  const catalog = reciprocalRouteMapCatalog(sourceMap, maps);
  const targetMap = catalog.find((map) => map.id === initialTargetMapId && map.id !== sourceMap.id)
    ?? catalog.find((map) => map.id !== sourceMap.id);
  const targetForDefaults = targetMap ?? sourceMap;
  const forwardPlacementId = suggestReciprocalRoutePlacementId(
    targetMap?.id ?? "target",
    (sourceMap.placements ?? []).map((placement) => placement.id),
  );
  const reverseUsedIds = (targetMap?.placements ?? []).map((placement) => placement.id);
  const reversePlacementId = suggestReciprocalRoutePlacementId(
    sourceMap.id,
    reverseUsedIds,
  );
  return {
    targetMapId: targetMap?.id ?? "",
    forward: {
      placementId: forwardPlacementId,
      at: clampReciprocalRoutePoint(
        sourceMap,
        initialSourceAt ?? sourceMap.layout?.playerStart ?? { x: 0, y: 0 },
      ),
      eventId: "transfer",
      label: targetMap ? `Travel to ${targetMap.name}` : "Travel to target map",
      trigger: "interact",
      arrival: { placementId: reversePlacementId },
    },
    reverse: {
      placementId: reversePlacementId,
      at: clampReciprocalRoutePoint(
        targetForDefaults,
        targetForDefaults.layout?.playerStart ?? { x: 0, y: 0 },
      ),
      eventId: "transfer",
      label: `Return to ${sourceMap.name}`,
      trigger: "interact",
      arrival: { placementId: forwardPlacementId },
    },
  };
}

/** Add a pending route placement only to the arrival editor's local projection. */
export function mapWithPendingRoutePlacement(
  map: MapDef,
  pending: ReciprocalRouteDirectionFields,
  targetMapId: string,
): MapDef {
  if (pending.placementId.length === 0) return map;
  const placement: MapPlacementDef = {
    id: pending.placementId,
    at: clampReciprocalRoutePoint(map, pending.at),
    resource: { kind: "map", id: targetMapId },
    z: 0,
    footprint: { width: 1, height: 1 },
    collision: "trigger",
    visible: true,
    events: [],
  };
  return {
    ...map,
    placements: [
      ...(map.placements ?? []).filter((candidate) => candidate.id !== placement.id),
      placement,
    ],
  };
}

export function validateReciprocalRouteDraft(
  sourceMap: MapDef,
  maps: readonly MapDef[],
  draft: ReciprocalRouteDialogDraft,
): ReciprocalRouteValidationIssue[] {
  const issues: ReciprocalRouteValidationIssue[] = [];
  const targetMap = reciprocalRouteMapCatalog(sourceMap, maps)
    .find((map) => map.id === draft.targetMapId);
  if (draft.targetMapId === sourceMap.id) {
    return [{ field: "targetMapId", message: "A reciprocal route requires two different maps." }];
  }
  if (!targetMap) {
    const hasSecondMap = reciprocalRouteMapCatalog(sourceMap, maps)
      .some((map) => map.id !== sourceMap.id);
    return [{
      field: "targetMapId",
      message: hasSecondMap
        ? "Choose a destination map that still exists in the project."
        : "This project needs a second map before linked doors can be created.",
    }];
  }

  validateStableId("forward.placementId", "Forward placement ID", draft.forward.placementId, issues);
  validateStableId("forward.eventId", "Forward event ID", draft.forward.eventId, issues);
  validateLabel("forward.label", "Forward player label", draft.forward.label, issues);
  validateStableId("reverse.placementId", "Return placement ID", draft.reverse.placementId, issues);
  validateStableId("reverse.eventId", "Return event ID", draft.reverse.eventId, issues);
  validateLabel("reverse.label", "Return player label", draft.reverse.label, issues);

  if ((sourceMap.placements ?? []).some((placement) => placement.id === draft.forward.placementId)) {
    issues.push({
      field: "forward.placementId",
      message: `Placement ID ${quoted(draft.forward.placementId)} already exists in map:${sourceMap.id}.`,
    });
  }
  if ((targetMap.placements ?? []).some((placement) => placement.id === draft.reverse.placementId)) {
    issues.push({
      field: "reverse.placementId",
      message: `Placement ID ${quoted(draft.reverse.placementId)} already exists in map:${targetMap.id}.`,
    });
  }
  if (
    sourceMap.id === targetMap.id &&
    draft.forward.placementId.length > 0 &&
    draft.forward.placementId === draft.reverse.placementId
  ) {
    issues.push({
      field: "reverse.placementId",
      message: "Forward and return placements on the same map need different stable IDs.",
    });
  }

  validatePlacementPoint("forward.at", "Forward placement", sourceMap, draft.forward.at, issues);
  validatePlacementPoint("reverse.at", "Return placement", targetMap, draft.reverse.at, issues);

  const forwardArrivalMap = mapWithPendingRoutePlacement(
    targetMap,
    draft.reverse,
    sourceMap.id,
  );
  const reverseArrivalMap = mapWithPendingRoutePlacement(
    sourceMap,
    draft.forward,
    targetMap.id,
  );
  validateArrival("forward.arrival", "Forward arrival", forwardArrivalMap, draft.forward.arrival, issues);
  validateArrival("reverse.arrival", "Return arrival", reverseArrivalMap, draft.reverse.arrival, issues);
  return issues;
}

export function buildReciprocalRouteSubmitPayload(
  sourceMap: Pick<MapDef, "id">,
  draft: ReciprocalRouteDialogDraft,
): ReciprocalRouteSubmitPayload {
  return {
    forward: buildDirectedRoute(
      sourceMap.id,
      draft.targetMapId,
      draft.forward,
    ),
    reverse: buildDirectedRoute(
      draft.targetMapId,
      sourceMap.id,
      draft.reverse,
    ),
  };
}

export function reciprocalRouteArrivalSummary(arrival?: MapArrivalDef): string {
  if (arrival?.placementId) return `placement:${arrival.placementId}`;
  if (arrival?.at) return `${arrival.at.x},${arrival.at.y}`;
  return "map start";
}

/** Retarget only the default counterpart anchor; preserve explicit author choices. */
export function retargetReciprocalForwardArrival(
  arrival: MapArrivalDef | undefined,
  previousCounterpartId: string,
  nextCounterpartId: string,
): MapArrivalDef | undefined {
  if (arrival?.placementId === previousCounterpartId) {
    return { placementId: nextCounterpartId };
  }
  return arrival;
}

/** Compare only the authored route semantics, independent of object identity. */
export function reciprocalRouteDraftsEqual(
  left: ReciprocalRouteDialogDraft,
  right: ReciprocalRouteDialogDraft,
): boolean {
  return left.targetMapId === right.targetMapId &&
    reciprocalRouteDirectionsEqual(left.forward, right.forward) &&
    reciprocalRouteDirectionsEqual(left.reverse, right.reverse);
}

export type ReciprocalRouteCloseDecision = "close" | "confirm" | "blocked";

/** Submitting is never dismissible; only a semantically changed draft confirms. */
export function reciprocalRouteCloseDecision(
  dirty: boolean,
  submitting: boolean,
): ReciprocalRouteCloseDecision {
  if (submitting) return "blocked";
  return dirty ? "confirm" : "close";
}

export interface ReciprocalRouteFocusableCandidate {
  matches: (selector: string) => boolean;
  closest: (selector: string) => unknown;
}

/** `:disabled` includes controls disabled through an ancestor fieldset. */
export function isReciprocalRouteFocusable(
  element: ReciprocalRouteFocusableCandidate,
): boolean {
  return !element.matches(":disabled") && element.closest('[aria-hidden="true"]') === null;
}

export type ReciprocalRouteFocusDestination = "dialog" | "first" | "last" | null;

/** Resolve focus wrapping without depending on a browser DOM in tests. */
export function reciprocalRouteFocusDestination(
  focusableCount: number,
  activeIndex: number,
  activeIsDialog: boolean,
  shiftKey: boolean,
): ReciprocalRouteFocusDestination {
  if (focusableCount === 0) return "dialog";
  if (activeIsDialog || activeIndex < 0) return shiftKey ? "last" : "first";
  if (shiftKey && activeIndex === 0) return "last";
  if (!shiftKey && activeIndex === focusableCount - 1) return "first";
  return null;
}

export function reciprocalRouteFocusRestoreIndex<T>(
  focusable: readonly T[],
  active: T | null,
): number {
  return Math.max(0, active === null ? -1 : focusable.indexOf(active));
}

export function reciprocalRouteFocusRestoreTarget<T>(
  focusable: readonly T[],
  index: number,
): T | undefined {
  return focusable[index] ?? focusable[0];
}

export function preventReciprocalRouteDraftUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = "";
}

export function ReciprocalRouteDiscardConfirmation({
  domId,
  submitting,
  keepEditingRef,
  onKeepEditing,
  onDiscard,
}: {
  domId: string;
  submitting: boolean;
  keepEditingRef?: React.Ref<HTMLButtonElement>;
  onKeepEditing: () => void;
  onDiscard: () => void;
}) {
  return (
    <>
      <header className="reciprocal-route-header danger">
        <div>
          <span>UNSAVED LINKED DOORS</span>
          <strong id={`${domId}-title`}>Discard reciprocal route draft?</strong>
          <small id={`${domId}-description`}>No map source has been changed yet.</small>
        </div>
      </header>
      <div className="reciprocal-route-confirm-body">
        <i aria-hidden="true">!</i>
        <strong>Leave the linked-door editor?</strong>
        <p>Your destination, stable IDs, labels, triggers, coordinates, and arrival anchors will be lost.</p>
      </div>
      <footer className="reciprocal-route-footer confirm-actions">
        <button ref={keepEditingRef} type="button" disabled={submitting} onClick={onKeepEditing}>Keep editing <kbd>Esc</kbd></button>
        <button type="button" className="danger" disabled={submitting} onClick={onDiscard}>Discard route draft</button>
      </footer>
    </>
  );
}

export function ReciprocalRouteDialog({
  sourceMap,
  maps,
  initialSourceAt,
  initialTargetMapId,
  submitting = false,
  submitError = null,
  onSubmit,
  onClose,
}: ReciprocalRouteDialogProps) {
  const catalog = useMemo(
    () => reciprocalRouteMapCatalog(sourceMap, maps),
    [sourceMap, maps],
  );
  const targetMaps = useMemo(
    () => catalog.filter((map) => map.id !== sourceMap.id),
    [catalog, sourceMap.id],
  );
  const [baselineDraft] = useState(() => createReciprocalRouteDialogDraft(
    sourceMap,
    maps,
    initialSourceAt,
    initialTargetMapId,
  ));
  const [draft, setDraft] = useState(baselineDraft);
  const [confirmClose, setConfirmClose] = useState(false);
  const automaticRef = useRef({
    forwardPlacementId: true,
    reversePlacementId: true,
    forwardLabel: true,
    reverseLabel: true,
  });
  const dialogRef = useRef<HTMLElement>(null);
  const targetSelectRef = useRef<HTMLSelectElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const closeReturnFocusIndexRef = useRef(0);
  const rawId = useId();
  const domId = `reciprocal-route-${rawId.replace(/:/g, "")}`;
  const targetMap = catalog.find((map) => map.id === draft.targetMapId);
  const issues = validateReciprocalRouteDraft(sourceMap, maps, draft);
  const issueFields = new Set(issues.map((issue) => issue.field));
  const forwardArrivalMap = targetMap
    ? mapWithPendingRoutePlacement(targetMap, draft.reverse, sourceMap.id)
    : sourceMap;
  const reverseArrivalMap = mapWithPendingRoutePlacement(
    sourceMap,
    draft.forward,
    targetMap?.id ?? draft.targetMapId,
  );
  const canSubmit = Boolean(targetMap && issues.length === 0 && !submitting);
  const dirty = !reciprocalRouteDraftsEqual(baselineDraft, draft);

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    if (targetSelectRef.current && !targetSelectRef.current.disabled) targetSelectRef.current.focus();
    else dialogRef.current?.focus();
    return () => returnFocusRef.current?.focus();
  }, []);

  useEffect(() => {
    if (submitting) dialogRef.current?.focus();
  }, [submitting]);

  useEffect(() => {
    if (!confirmClose) return;
    requestAnimationFrame(() => keepEditingRef.current?.focus());
  }, [confirmClose]);

  useEffect(() => {
    if (!dirty) return;
    window.addEventListener("beforeunload", preventReciprocalRouteDraftUnload);
    return () => window.removeEventListener("beforeunload", preventReciprocalRouteDraftUnload);
  }, [dirty]);

  const chooseTargetMap = (targetMapId: string) => {
    const nextTarget = catalog.find((map) => map.id === targetMapId);
    if (!nextTarget) return;
    setDraft((current) => {
      const forwardPlacementId = automaticRef.current.forwardPlacementId
        ? suggestReciprocalRoutePlacementId(
          nextTarget.id,
          (sourceMap.placements ?? []).map((placement) => placement.id),
        )
        : current.forward.placementId;
      const reverseUsedIds = (nextTarget.placements ?? []).map((placement) => placement.id);
      if (nextTarget.id === sourceMap.id) reverseUsedIds.push(forwardPlacementId);
      const reversePlacementId = automaticRef.current.reversePlacementId
        ? suggestReciprocalRoutePlacementId(sourceMap.id, reverseUsedIds)
        : current.reverse.placementId;
      const forwardArrival = retargetReciprocalForwardArrival(
        current.forward.arrival,
        current.reverse.placementId,
        reversePlacementId,
      );
      const reverseArrival = current.reverse.arrival?.placementId === current.forward.placementId
        ? { placementId: forwardPlacementId }
        : current.reverse.arrival;
      return {
        targetMapId,
        forward: {
          ...current.forward,
          placementId: forwardPlacementId,
          label: automaticRef.current.forwardLabel
            ? `Travel to ${nextTarget.name}`
            : current.forward.label,
          arrival: forwardArrival,
        },
        reverse: {
          ...current.reverse,
          placementId: reversePlacementId,
          at: clampReciprocalRoutePoint(
            nextTarget,
            nextTarget.layout?.playerStart ?? { x: 0, y: 0 },
          ),
          label: automaticRef.current.reverseLabel
            ? `Return to ${sourceMap.name}`
            : current.reverse.label,
          arrival: reverseArrival,
        },
      };
    });
  };

  const changePlacementId = (direction: "forward" | "reverse", placementId: string) => {
    automaticRef.current[direction === "forward" ? "forwardPlacementId" : "reversePlacementId"] = false;
    setDraft((current) => {
      const previousId = current[direction].placementId;
      const next = {
        ...current,
        [direction]: { ...current[direction], placementId },
      };
      if (direction === "forward" && current.reverse.arrival?.placementId === previousId) {
        next.reverse = { ...next.reverse, arrival: { placementId } };
      }
      if (direction === "reverse" && current.forward.arrival?.placementId === previousId) {
        next.forward = { ...next.forward, arrival: { placementId } };
      }
      return next;
    });
  };

  const patchDirection = (
    direction: "forward" | "reverse",
    patch: Partial<ReciprocalRouteDirectionFields>,
  ) => setDraft((current) => ({
    ...current,
    [direction]: { ...current[direction], ...patch },
  }));

  const submit = () => {
    if (!canSubmit) return;
    onSubmit(buildReciprocalRouteSubmitPayload(sourceMap, draft));
  };

  const restoreCloseFocus = () => {
    requestAnimationFrame(() => {
      if (!dialogRef.current) return;
      reciprocalRouteFocusRestoreTarget(
        reciprocalRouteFocusableElements(dialogRef.current),
        closeReturnFocusIndexRef.current,
      )?.focus();
    });
  };

  const requestClose = () => {
    const decision = reciprocalRouteCloseDecision(dirty, submitting);
    if (decision === "blocked") return;
    if (decision === "close") {
      onClose();
      return;
    }
    if (confirmClose) return;
    const focusable = dialogRef.current
      ? reciprocalRouteFocusableElements(dialogRef.current)
      : [];
    closeReturnFocusIndexRef.current = reciprocalRouteFocusRestoreIndex(
      focusable,
      document.activeElement instanceof HTMLElement ? document.activeElement : null,
    );
    setConfirmClose(true);
  };

  const cancelClose = () => {
    setConfirmClose(false);
    restoreCloseFocus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!confirmClose && (event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      submit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (submitting) return;
      if (confirmClose) cancelClose();
      else requestClose();
      return;
    }
    if (event.key === "Tab" && dialogRef.current) {
      trapReciprocalRouteFocus(event, dialogRef.current);
    }
  };

  return (
    <div className="reciprocal-route-layer" role="presentation">
      <button
        type="button"
        className="reciprocal-route-backdrop"
        aria-hidden="true"
        tabIndex={-1}
        disabled={submitting}
        onClick={requestClose}
      />
      <section
        ref={dialogRef}
        tabIndex={-1}
        className={`reciprocal-route-dialog${confirmClose ? " confirming" : ""}`}
        role={confirmClose ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-busy={submitting}
        aria-labelledby={`${domId}-title`}
        aria-describedby={`${domId}-description`}
        onKeyDown={handleKeyDown}
      >
        {confirmClose ? (
          <ReciprocalRouteDiscardConfirmation
            domId={domId}
            submitting={submitting}
            keepEditingRef={keepEditingRef}
            onKeepEditing={cancelClose}
            onDiscard={onClose}
          />
        ) : (
          <>
        <header className="reciprocal-route-header">
          <div>
            <span>WORLD ROUTES · LINKED DOORS</span>
            <strong id={`${domId}-title`}>Create reciprocal route</strong>
            <small id={`${domId}-description`}>Atomically create two route placements and two directed transfer events.</small>
          </div>
          <button type="button" aria-label="Close reciprocal route dialog" disabled={submitting} onClick={requestClose}>×</button>
        </header>

        <fieldset className="reciprocal-route-body" disabled={submitting}>
          <section className="reciprocal-route-context" aria-label="Route map context">
            <div>
              <span>SOURCE MAP</span>
              <strong>{sourceMap.name}</strong>
              <code>map:{sourceMap.id}</code>
            </div>
            <i aria-hidden="true">⇄</i>
            <label>
              <span>Target map</span>
              <select
                ref={targetSelectRef}
                value={draft.targetMapId}
                disabled={targetMaps.length === 0 || submitting}
                aria-invalid={issueFields.has("targetMapId")}
                onChange={(event) => chooseTargetMap(event.currentTarget.value)}
              >
                {targetMaps.length === 0 && <option value="">Needs a second map</option>}
                {targetMaps.map((map) => <option value={map.id} key={map.id}>{map.name} · map:{map.id}</option>)}
              </select>
              <small>{targetMap
                ? targetMap.layout
                  ? `${targetMap.layout.width}×${targetMap.layout.height} spatial map`
                  : "Folded node map"
                : "Create another map to enable reciprocal routes"}</small>
            </label>
          </section>

          {!targetMap && (
            <section className="reciprocal-route-no-target" role="status">
              <span aria-hidden="true">＋</span>
              <div><strong>Linked doors need a second map</strong><p>The source map cannot target itself. Add another map, then reopen this reciprocal route dialog.</p></div>
            </section>
          )}

          <section className="reciprocal-route-runtime-note" aria-label="Runtime route semantics">
            <span aria-hidden="true">↔</span>
            <div><strong>Linked authoring, directed runtime</strong><p>This transaction creates two independent directed routes: forward and return. Runtime traversal never implies a bidirectional edge.</p></div>
            <b>2 ROUTES</b>
          </section>

          {targetMap && (
            <div className="reciprocal-route-directions">
              <RouteDirectionEditor
                domId={`${domId}-forward`}
                direction="forward"
                ordinal="01"
                title="Forward route"
                sourceMap={sourceMap}
                targetMap={targetMap}
                arrivalMap={forwardArrivalMap}
                pendingCounterpartId={draft.reverse.placementId}
                value={draft.forward}
                issueFields={issueFields}
                onPlacementIdChange={(value) => changePlacementId("forward", value)}
                onChange={(patch) => patchDirection("forward", patch)}
                onLabelTouched={() => { automaticRef.current.forwardLabel = false; }}
              />

              <div className="reciprocal-route-link" aria-hidden="true"><span>ATOMIC PAIR</span><i>⇅</i><small>two writes · one intent</small></div>

              <RouteDirectionEditor
                domId={`${domId}-reverse`}
                direction="reverse"
                ordinal="02"
                title="Return route"
                sourceMap={targetMap}
                targetMap={sourceMap}
                arrivalMap={reverseArrivalMap}
                pendingCounterpartId={draft.forward.placementId}
                value={draft.reverse}
                issueFields={issueFields}
                onPlacementIdChange={(value) => changePlacementId("reverse", value)}
                onChange={(patch) => patchDirection("reverse", patch)}
                onLabelTouched={() => { automaticRef.current.reverseLabel = false; }}
              />
            </div>
          )}

          <section className={`reciprocal-route-validation${issues.length === 0 ? " ready" : " invalid"}`} aria-live="polite">
            <header><span>{issues.length === 0 ? "VALIDATION READY" : "DRAFT NEEDS ATTENTION"}</span><strong>Atomic route summary</strong></header>
            {targetMap && (
              <div className="reciprocal-route-summary-grid">
                <RouteSummary direction="FORWARD" sourceMapId={sourceMap.id} targetMapId={targetMap.id} value={draft.forward} />
                <RouteSummary direction="RETURN" sourceMapId={targetMap.id} targetMapId={sourceMap.id} value={draft.reverse} />
              </div>
            )}
            {issues.length > 0 ? (
              <ul>{issues.map((issue, index) => <li key={`${issue.field}-${index}`}>{issue.message}</li>)}</ul>
            ) : (
              <p><strong>Ready to create both directed routes.</strong> Stable IDs and arrivals remain explicit in the submit payload.</p>
            )}
          </section>
        </fieldset>

        {submitError && <div className="reciprocal-route-submit-error" role="alert"><strong>Reciprocal route failed</strong><span>{submitError}</span></div>}

        <footer className="reciprocal-route-footer">
          <span><i />{submitting ? "CREATING LINKED DOORS" : issues.length === 0 ? "VALIDATED RECIPROCAL DRAFT" : `${issues.length} VALIDATION ISSUE${issues.length === 1 ? "" : "S"}`}</span>
          <div>
            <button type="button" disabled={submitting} onClick={requestClose}>Cancel <kbd>Esc</kbd></button>
            <button type="button" className="primary" disabled={!canSubmit} onClick={submit}>{submitting ? "Creating…" : <>Create reciprocal route <kbd>⌘↵</kbd></>}</button>
          </div>
        </footer>
          </>
        )}
      </section>
    </div>
  );
}

function RouteDirectionEditor({
  domId,
  direction,
  ordinal,
  title,
  sourceMap,
  targetMap,
  arrivalMap,
  pendingCounterpartId,
  value,
  issueFields,
  onPlacementIdChange,
  onChange,
  onLabelTouched,
}: {
  domId: string;
  direction: "forward" | "reverse";
  ordinal: string;
  title: string;
  sourceMap: MapDef;
  targetMap: MapDef;
  arrivalMap: MapDef;
  pendingCounterpartId: string;
  value: ReciprocalRouteDirectionFields;
  issueFields: ReadonlySet<string>;
  onPlacementIdChange: (value: string) => void;
  onChange: (patch: Partial<ReciprocalRouteDirectionFields>) => void;
  onLabelTouched: () => void;
}) {
  const field = (name: string) => `${direction}.${name}`;
  return (
    <section className={`reciprocal-route-direction ${direction}`} aria-labelledby={`${domId}-title`}>
      <header>
        <span>{ordinal}</span>
        <div><small>DIRECTED ROUTE</small><strong id={`${domId}-title`}>{title}</strong><code>map:{sourceMap.id} → map:{targetMap.id}</code></div>
        <i aria-hidden="true">→</i>
      </header>
      <div className="reciprocal-route-direction-fields">
        <label>
          <span>Placement stable ID</span>
          <input
            value={value.placementId}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={issueFields.has(field("placementId"))}
            onChange={(event) => onPlacementIdChange(event.currentTarget.value)}
          />
          <small>New placement in map:{sourceMap.id}</small>
        </label>
        <label>
          <span>Event stable ID</span>
          <input
            value={value.eventId}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={issueFields.has(field("eventId"))}
            onChange={(event) => onChange({ eventId: event.currentTarget.value })}
          />
          <small>Event inside the new placement</small>
        </label>
        <label>
          <span>Player label</span>
          <input
            value={value.label}
            aria-invalid={issueFields.has(field("label"))}
            onChange={(event) => {
              onLabelTouched();
              onChange({ label: event.currentTarget.value });
            }}
          />
          <small>Shown when this route is available</small>
        </label>
        <label>
          <span>Trigger</span>
          <select value={value.trigger} onChange={(event) => onChange({ trigger: event.currentTarget.value as MapEventTrigger })}>
            {RECIPROCAL_ROUTE_TRIGGERS.map((trigger) => <option value={trigger.value} key={trigger.value}>{trigger.label} · {trigger.value}</option>)}
          </select>
          <small>Runtime activation rule</small>
        </label>
      </div>

      <RoutePlacementPointEditor
        map={sourceMap}
        value={value.at}
        invalid={issueFields.has(field("at"))}
        onChange={(at) => onChange({ at })}
      />

      <div className="reciprocal-route-arrival-shell">
        <div className="reciprocal-route-pending-anchor"><span>PENDING COUNTERPART</span><code>placement:{pendingCounterpartId || "(enter a stable ID)"}</code><small>Available as an arrival anchor because both placements are created atomically.</small></div>
        <RouteArrivalEditor
          targetMap={arrivalMap}
          value={value.arrival}
          groupName={`${domId}-arrival-mode`}
          onChange={(arrival) => onChange({ arrival })}
        />
      </div>
    </section>
  );
}

function RoutePlacementPointEditor({
  map,
  value,
  invalid,
  onChange,
}: {
  map: MapDef;
  value: MapPoint;
  invalid: boolean;
  onChange: (value: MapPoint) => void;
}) {
  if (!map.layout) {
    return (
      <section className="reciprocal-route-node-point" aria-label={`Placement origin in node map ${map.name}`}>
        <span aria-hidden="true">◇</span><div><strong>Folded node origin</strong><code>0,0</code><p>Node maps ignore two-dimensional placement coordinates. This route placement is authored at the canonical folded slot.</p></div>
      </section>
    );
  }
  const update = (axis: "x" | "y", next: number) => onChange(clampReciprocalRoutePoint(map, {
    ...value,
    [axis]: Number.isFinite(next) ? next : value[axis],
  }));
  return (
    <fieldset className="reciprocal-route-point-fields" aria-invalid={invalid}>
      <legend>New placement coordinate</legend>
      <p>Choose where the route object is placed in <code>map:{map.id}</code>.</p>
      <label><span>X</span><input type="number" min={0} max={Math.max(0, map.layout.width - 1)} step={1} value={value.x} onChange={(event) => update("x", event.currentTarget.valueAsNumber)} /><small>0–{Math.max(0, map.layout.width - 1)}</small></label>
      <label><span>Y</span><input type="number" min={0} max={Math.max(0, map.layout.height - 1)} step={1} value={value.y} onChange={(event) => update("y", event.currentTarget.valueAsNumber)} /><small>0–{Math.max(0, map.layout.height - 1)}</small></label>
    </fieldset>
  );
}

function RouteSummary({
  direction,
  sourceMapId,
  targetMapId,
  value,
}: {
  direction: string;
  sourceMapId: string;
  targetMapId: string;
  value: ReciprocalRouteDirectionFields;
}) {
  return (
    <article>
      <span>{direction}</span>
      <strong><code>map:{sourceMapId}</code><i aria-hidden="true">→</i><code>map:{targetMapId}</code></strong>
      <dl>
        <div><dt>Placement</dt><dd><code>{value.placementId || "—"}</code> at {value.at.x},{value.at.y}</dd></div>
        <div><dt>Event</dt><dd><code>{value.eventId || "—"}</code> · {value.trigger}</dd></div>
        <div><dt>Arrival</dt><dd>{reciprocalRouteArrivalSummary(value.arrival)}</dd></div>
      </dl>
    </article>
  );
}

function reciprocalRouteDirectionsEqual(
  left: ReciprocalRouteDirectionFields,
  right: ReciprocalRouteDirectionFields,
): boolean {
  return left.placementId === right.placementId &&
    left.at.x === right.at.x &&
    left.at.y === right.at.y &&
    left.eventId === right.eventId &&
    left.label === right.label &&
    left.trigger === right.trigger &&
    reciprocalRouteArrivalsEqual(left.arrival, right.arrival);
}

function reciprocalRouteArrivalsEqual(
  left: MapArrivalDef | undefined,
  right: MapArrivalDef | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.placementId !== right.placementId) return false;
  if (left.at === undefined || right.at === undefined) return left.at === right.at;
  return left.at.x === right.at.x && left.at.y === right.at.y;
}

function reciprocalRouteMapCatalog(sourceMap: MapDef, maps: readonly MapDef[]): MapDef[] {
  const catalog: MapDef[] = [];
  const seen = new Set<string>();
  for (const map of maps) {
    if (seen.has(map.id)) continue;
    seen.add(map.id);
    catalog.push(map.id === sourceMap.id ? sourceMap : map);
  }
  if (!seen.has(sourceMap.id)) catalog.unshift(sourceMap);
  return catalog;
}

function buildDirectedRoute(
  sourceMapId: string,
  targetMapId: string,
  value: ReciprocalRouteDirectionFields,
): DirectedRoutePlacementDraft {
  return {
    sourceMapId,
    targetMapId,
    placementId: value.placementId,
    at: { ...value.at },
    eventId: value.eventId,
    label: value.label,
    trigger: value.trigger,
    ...(value.arrival ? { arrival: cloneArrival(value.arrival) } : {}),
  };
}

function cloneArrival(arrival: MapArrivalDef): MapArrivalDef {
  if (arrival.placementId) return { placementId: arrival.placementId };
  if (arrival.at) return { at: { ...arrival.at } };
  return {};
}

function validateStableId(
  field: string,
  label: string,
  value: string,
  issues: ReciprocalRouteValidationIssue[],
) {
  if (value.trim().length === 0) issues.push({ field, message: `${label} must not be empty.` });
}

function validateLabel(
  field: string,
  label: string,
  value: string,
  issues: ReciprocalRouteValidationIssue[],
) {
  if (value.trim().length === 0) issues.push({ field, message: `${label} must not be empty.` });
}

function validatePlacementPoint(
  field: string,
  label: string,
  map: MapDef,
  point: MapPoint,
  issues: ReciprocalRouteValidationIssue[],
) {
  const expected = clampReciprocalRoutePoint(map, point);
  if (expected.x !== point.x || expected.y !== point.y) {
    issues.push({ field, message: `${label} coordinate must be inside map:${map.id}.` });
  }
}

function validateArrival(
  field: string,
  label: string,
  targetMap: MapDef,
  arrival: MapArrivalDef | undefined,
  issues: ReciprocalRouteValidationIssue[],
) {
  if (arrival === undefined) return;
  const placementId = arrival.placementId;
  const hasPlacement = placementId !== undefined;
  const hasCoordinate = arrival.at !== undefined;
  if (hasPlacement === hasCoordinate) {
    issues.push({ field, message: `${label} must use exactly one placement or coordinate; use Map start for neither.` });
    return;
  }
  if (placementId !== undefined && !(targetMap.placements ?? []).some((placement) => placement.id === placementId)) {
    issues.push({ field, message: `${label} placement ${quoted(placementId)} does not exist in map:${targetMap.id}.` });
  }
  if (arrival.at) {
    if (!targetMap.layout) {
      issues.push({ field, message: `${label} cannot use coordinates on node map:${targetMap.id}.` });
    } else {
      const expected = clampReciprocalRoutePoint(targetMap, arrival.at);
      if (expected.x !== arrival.at.x || expected.y !== arrival.at.y) {
        issues.push({ field, message: `${label} coordinate must be inside map:${targetMap.id}.` });
      }
    }
  }
}

function trapReciprocalRouteFocus(
  event: React.KeyboardEvent<HTMLElement>,
  dialog: HTMLElement,
) {
  const focusable = reciprocalRouteFocusableElements(dialog);
  const activeElement = document.activeElement;
  const destination = reciprocalRouteFocusDestination(
    focusable.length,
    focusable.indexOf(activeElement as HTMLElement),
    activeElement === dialog,
    event.shiftKey,
  );
  if (destination === null) return;
  event.preventDefault();
  if (destination === "dialog") {
    dialog.focus();
  } else if (destination === "first") {
    focusable[0]!.focus();
  } else {
    focusable.at(-1)!.focus();
  }
}

function reciprocalRouteFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(
    'button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )).filter(isReciprocalRouteFocusable);
}

function clampInteger(value: number, min: number, max: number): number {
  const normalized = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.max(min, Math.min(max, normalized));
}

function quoted(value: string): string {
  return JSON.stringify(value);
}
