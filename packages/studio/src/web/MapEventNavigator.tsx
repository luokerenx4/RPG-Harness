import React, {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  MapDef,
  ProjectResourceNode,
} from "@rpg-harness/engine";
import {
  buildMapEventNavigatorIndex,
  MAP_EVENT_NAVIGATOR_RESULT_LIMIT,
  searchMapEventNavigatorIndex,
  type MapEventNavigatorLocator,
  type MapEventNavigatorProblem,
  type MapEventNavigatorRow,
} from "./MapEventNavigatorModel";
import "./MapEventNavigator.css";

export interface MapEventNavigatorProps {
  draft: MapDef;
  resources: readonly ProjectResourceNode[];
  diagnosticCounts?: ReadonlyMap<string, number>;
  saving?: boolean;
  triggerRef?: React.RefObject<HTMLElement>;
  onActivate: (
    locator: MapEventNavigatorLocator,
    precision: "exact" | "placement-only",
  ) => {
    ok: boolean;
    message?: string;
  };
  onClose: () => void;
}

export type MapEventNavigatorKeyIntent =
  | { kind: "none" }
  | { kind: "move"; index: number }
  | { kind: "activate" }
  | { kind: "close" };

export type MapEventNavigatorRowActivation =
  | {
    ok: true;
    locator: MapEventNavigatorLocator;
    precision: "exact" | "placement-only";
  }
  | { ok: false; message: string };

export function MapEventNavigator({
  draft,
  resources,
  diagnosticCounts,
  saving = false,
  triggerRef,
  onActivate,
  onClose,
}: MapEventNavigatorProps) {
  const reactId = useId();
  const domId = `map-event-navigator-${reactId.replace(/:/g, "")}`;
  const dialogRef = useRef<HTMLElement | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const restoreOnUnmountRef = useRef(true);
  const focusLifecycleRef = useRef(0);
  const composingRef = useRef(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [requestedActiveIndex, setRequestedActiveIndex] = useState(0);
  const [activationError, setActivationError] = useState<string | null>(null);

  const index = useMemo(
    () => buildMapEventNavigatorIndex(draft, resources, diagnosticCounts),
    [diagnosticCounts, draft, resources],
  );
  const result = useMemo(
    () => searchMapEventNavigatorIndex(
      index,
      deferredQuery,
      MAP_EVENT_NAVIGATOR_RESULT_LIMIT,
    ),
    [deferredQuery, index],
  );
  const rows = result.rows;
  const activeIndex = rows.length === 0
    ? -1
    : Math.min(Math.max(0, requestedActiveIndex), rows.length - 1);
  const activeRow = activeIndex >= 0 ? rows[activeIndex] : undefined;
  const searchPending = query !== deferredQuery;

  useEffect(() => {
    focusLifecycleRef.current += 1;
    const activeElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    if (
      activeElement &&
      activeElement !== document.body &&
      !dialogRef.current?.contains(activeElement)
    ) {
      restoreFocusRef.current = activeElement;
    } else if (!restoreFocusRef.current) {
      restoreFocusRef.current = triggerRef?.current ?? null;
    }
    searchRef.current?.focus();
    return () => {
      if (!restoreOnUnmountRef.current) return;
      const lifecycle = ++focusLifecycleRef.current;
      const captured = restoreFocusRef.current;
      const target = captured?.isConnected ? captured : triggerRef?.current;
      if (target) requestAnimationFrame(() => {
        // React StrictMode immediately re-runs mount effects in development.
        // A newer setup invalidates the simulated cleanup's focus restore.
        if (focusLifecycleRef.current === lifecycle) target.focus();
      });
    };
  }, [triggerRef]);

  useEffect(() => {
    setRequestedActiveIndex(0);
  }, [deferredQuery, index]);

  useEffect(() => {
    if (activeIndex < 0) return;
    const options = resultsRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
    options?.[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  useEffect(() => {
    if (saving) dialogRef.current?.focus();
    else searchRef.current?.focus();
  }, [saving]);

  const requestClose = () => {
    if (saving) return;
    onClose();
  };

  const activateRow = (row: MapEventNavigatorRow | undefined) => {
    // Deferred results deliberately stay visible while the new query catches
    // up, but they must never navigate as if they matched the current input.
    if (!row || !canActivateMapEventNavigatorResult(saving, searchPending)) return;
    setActivationError(null);
    const activation = mapEventNavigatorRowActivation(row);
    if (!activation.ok) {
      setActivationError(activation.message);
      return;
    }
    try {
      const response = onActivate(activation.locator, activation.precision);
      if (!response.ok) {
        setActivationError(response.message ?? "The current draft could not open that event safely.");
        return;
      }
      // The integration focuses the selected placement/event. Do not steal
      // focus back to the toolbar trigger after a successful activation.
      restoreOnUnmountRef.current = false;
      onClose();
    } catch (cause) {
      setActivationError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const composing = composingRef.current
      || event.nativeEvent.isComposing
      || event.keyCode === 229;
    const intent = mapEventNavigatorKeyIntent(
      event.key,
      activeIndex,
      rows.length,
      composing,
    );
    if (intent.kind === "none") return;
    event.preventDefault();
    event.stopPropagation();
    if (intent.kind === "move") {
      setRequestedActiveIndex(intent.index);
      setActivationError(null);
    } else if (intent.kind === "activate") {
      activateRow(activeRow);
    } else {
      requestClose();
    }
  };

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    if (isMapEventNavigatorCommandShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key.toLowerCase() === "f" && !saving) {
        searchRef.current?.focus();
        searchRef.current?.select();
      }
      return;
    }
    const composing = composingRef.current
      || event.nativeEvent.isComposing
      || event.keyCode === 229;
    if (event.key === "Escape" && !composing) {
      event.preventDefault();
      event.stopPropagation();
      requestClose();
      return;
    }
    if (event.key === "Tab" && dialogRef.current) {
      trapMapEventNavigatorFocus(event, dialogRef.current);
    }
  };

  return (
    <div className="map-event-navigator-layer" role="presentation">
      <button
        type="button"
        className="map-event-navigator-backdrop"
        aria-hidden="true"
        tabIndex={-1}
        disabled={saving}
        onClick={requestClose}
      />
      <section
        ref={dialogRef}
        className="map-event-navigator-dialog"
        role="dialog"
        aria-modal="true"
        aria-busy={saving || searchPending}
        aria-labelledby={`${domId}-title`}
        aria-describedby={`${domId}-description`}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="map-event-navigator-header">
          <div>
            <span>MAP EVENT DATABASE</span>
            <strong id={`${domId}-title`}>Event Navigator</strong>
            <small id={`${domId}-description`}>
              Search placements and RPG event pages in the current unsaved map draft.
            </small>
          </div>
          <dl aria-label="Draft event totals">
            <div><dt>OBJECTS</dt><dd>{index.placementCount}</dd></div>
            <div><dt>PAGES</dt><dd>{index.eventCount}</dd></div>
          </dl>
          <button
            type="button"
            aria-label="Close Event Navigator"
            disabled={saving}
            onClick={requestClose}
          >×</button>
        </header>

        <div className="map-event-navigator-search">
          <label htmlFor={`${domId}-query`}>Search the current map draft</label>
          <div>
            <span aria-hidden="true">⌕</span>
            <input
              ref={searchRef}
              id={`${domId}-query`}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={`${domId}-results`}
              aria-activedescendant={activeIndex >= 0
                ? mapEventNavigatorOptionId(domId, activeIndex)
                : undefined}
              aria-describedby={`${domId}-result-status`}
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
              value={query}
              placeholder="Event label, ID, trigger, target, coordinate…"
              onChange={(event) => {
                setQuery(event.target.value);
                setRequestedActiveIndex(0);
                setActivationError(null);
              }}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; }}
              onKeyDown={handleSearchKeyDown}
            />
            {query && <button
              type="button"
              aria-label="Clear event search"
              disabled={saving}
              onClick={() => {
                setQuery("");
                setRequestedActiveIndex(0);
                setActivationError(null);
                searchRef.current?.focus();
              }}
            >×</button>}
          </div>
          <div
            id={`${domId}-result-status`}
            className="map-event-navigator-result-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <span>{searchPending ? "SEARCHING DRAFT…" : `${result.total} MATCH${result.total === 1 ? "" : "ES"}`}</span>
            <small>{result.truncated
              ? `Showing the first ${rows.length} of ${result.total}`
              : `${rows.length} visible · ${MAP_EVENT_NAVIGATOR_RESULT_LIMIT} row safety limit`}</small>
          </div>
        </div>

        <div className="map-event-navigator-body">
          {activationError && (
            <div className="map-event-navigator-error" role="alert">
              <strong>Could not open this event</strong>
              <span>{activationError}</span>
            </div>
          )}
          <div
            ref={resultsRef}
            id={`${domId}-results`}
            className="map-event-navigator-results"
            role="listbox"
            aria-label="Map placements and event pages"
          >
            {rows.map((row, rowIndex) => {
              const selected = rowIndex === activeIndex;
              const activation = mapEventNavigatorRowActivation(row);
              return (
                <button
                  type="button"
                  role="option"
                  id={mapEventNavigatorOptionId(domId, rowIndex)}
                  key={row.key}
                  className={`map-event-navigator-row kind-${row.kind}${selected ? " selected" : ""}${activation.ok ? ` ${activation.precision}` : " disabled"}`}
                  aria-selected={selected}
                  aria-disabled={!activation.ok || saving || searchPending}
                  tabIndex={-1}
                  disabled={saving || searchPending}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setRequestedActiveIndex(rowIndex)}
                  onClick={() => activateRow(row)}
                >
                  <span className={`map-event-navigator-kind kind-${row.kind}`} aria-hidden="true">
                    {row.kind === "event" ? "◆" : "◇"}
                  </span>
                  <span className="map-event-navigator-row-copy">
                    <span>
                      <b>{row.kind === "event" ? row.placementLabel : "PLACEMENT"}</b>
                      <strong>{row.label}</strong>
                    </span>
                    <code>{row.canonicalPath ?? mapEventNavigatorUnstablePath(row)}</code>
                    <small>
                      <span>⌖ {row.at.x},{row.at.y}</span>
                      <span>{row.layer ? `LAYER · ${row.layer}` : "DEFAULT LAYER"}</span>
                      {row.trigger && <span>TRIGGER · {row.trigger}</span>}
                    </small>
                  </span>
                  <span className="map-event-navigator-target">
                    <small>{row.targetKey ? "TARGET" : row.kind === "event" ? "NO TARGET" : "OBJECT"}</small>
                    <strong>{row.targetLabel ?? row.targetKey ?? (row.placementId || "Unnamed placement")}</strong>
                    {row.targetKey && <code>{row.targetKey}</code>}
                  </span>
                  {row.diagnosticCount > 0 && (
                    <span className="map-event-navigator-diagnostics" title={`${row.diagnosticCount} spatial diagnostics`}>
                      ! {row.diagnosticCount}
                    </span>
                  )}
                  <span className="map-event-navigator-destination">
                    <strong>{mapEventNavigatorDestinationLabel(row)}</strong>
                    <small>{activation.ok
                      ? activation.precision === "exact" ? "Enter · exact focus" : "Enter · repair page ID"
                      : activation.message}</small>
                  </span>
                </button>
              );
            })}
            {rows.length === 0 && (
              <div className="map-event-navigator-empty">
                <span aria-hidden="true">◇</span>
                <strong>{index.rows.length === 0 ? "No map events authored" : "No events match this search"}</strong>
                <small>{index.rows.length === 0
                  ? "Create an object or event page on the map, then reopen this navigator."
                  : "Try an event ID, trigger, target resource, layer, or coordinate."}</small>
              </div>
            )}
          </div>
        </div>

        <footer className="map-event-navigator-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close</span>
          <small>{saving ? "SAVING MAP DRAFT…" : "READ-ONLY INDEX · CURRENT UNSAVED DRAFT"}</small>
        </footer>
      </section>
    </div>
  );
}

export function mapEventNavigatorKeyIntent(
  key: string,
  currentIndex: number,
  rowCount: number,
  composing = false,
): MapEventNavigatorKeyIntent {
  if (composing) return { kind: "none" };
  if (key === "Escape") return { kind: "close" };
  if (key === "Enter") return rowCount > 0 ? { kind: "activate" } : { kind: "none" };
  if (rowCount <= 0) return { kind: "none" };
  if (key === "Home") return { kind: "move", index: 0 };
  if (key === "End") return { kind: "move", index: rowCount - 1 };
  if (key === "ArrowDown") {
    return {
      kind: "move",
      index: currentIndex < 0 || currentIndex >= rowCount - 1 ? 0 : currentIndex + 1,
    };
  }
  if (key === "ArrowUp") {
    return {
      kind: "move",
      index: currentIndex <= 0 ? rowCount - 1 : currentIndex - 1,
    };
  }
  return { kind: "none" };
}

export function mapEventNavigatorRowActivation(
  row: Pick<MapEventNavigatorRow, "destination">,
): MapEventNavigatorRowActivation {
  if (row.destination.mode === "disabled") {
    return { ok: false, message: mapEventNavigatorProblemMessage(row.destination.problem) };
  }
  return {
    ok: true,
    locator: row.destination.locator,
    precision: row.destination.mode,
  };
}

export function mapEventNavigatorProblemMessage(problem: MapEventNavigatorProblem): string {
  const messages: Record<MapEventNavigatorProblem, string> = {
    "placement-id-empty": "This placement has no stable ID. Give it a unique ID before navigating to it.",
    "placement-id-duplicate": "This placement ID is duplicated. Rename the duplicate before navigating safely.",
    "event-id-empty": "This event page has no stable ID. The navigator can open its placement for repair.",
    "event-id-duplicate": "This event page ID is duplicated. The navigator can open its placement for repair.",
  };
  return messages[problem];
}

export function isMapEventNavigatorCommandShortcut(
  event: Pick<React.KeyboardEvent, "ctrlKey" | "metaKey" | "key">,
): boolean {
  return (event.metaKey || event.ctrlKey)
    && ["s", "z", "y", "f"].includes(event.key.toLowerCase());
}

export function canActivateMapEventNavigatorResult(
  saving: boolean,
  searchPending: boolean,
): boolean {
  return !saving && !searchPending;
}

function mapEventNavigatorDestinationLabel(row: MapEventNavigatorRow): string {
  if (row.destination.mode === "disabled") return "REPAIR ID";
  if (row.destination.mode === "placement-only") return "OPEN OBJECT";
  return row.destination.locator.kind === "event" ? "OPEN PAGE" : "OPEN OBJECT";
}

function mapEventNavigatorUnstablePath(row: MapEventNavigatorRow): string {
  const placementId = row.placementId || "<missing-id>";
  if (row.kind === "event") return `placement:${placementId}/event:${row.eventId || "<missing-id>"}`;
  return `placement:${placementId}`;
}

function mapEventNavigatorOptionId(domId: string, index: number): string {
  return `${domId}-option-${index}`;
}

function trapMapEventNavigatorFocus(
  event: React.KeyboardEvent<HTMLElement>,
  dialog: HTMLElement,
) {
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.closest('[aria-hidden="true"]'));
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
