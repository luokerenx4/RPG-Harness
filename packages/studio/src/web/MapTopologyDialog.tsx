import React, {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MapDef } from "@rpg-harness/engine";
import type {
  MapTopologyIntent as ApiMapTopologyIntent,
  MapTopologyPreviewResponse,
  MapTopologyUpdateResponse,
  ProjectResponse,
} from "./api";
import {
  compareMapCatalogChainKeys,
  mapCatalogChainLabelFromKey,
} from "./MapCatalog";
import "./MapTopologyDialog.css";

export type MapTopologyEntryMode = "keep-existing" | "make-selected";
export type MapTopologyMembershipMode = "standalone" | "existing" | "new";

export interface MapTopologyChain {
  /** Exact authored chain value. Leading, trailing, and all-whitespace values are significant. */
  chain: string;
  memberIds: readonly string[];
  entryIds: readonly string[];
}

export type MapTopologyIntent = ApiMapTopologyIntent;
export type MapTopologyPreview = MapTopologyPreviewResponse;
export type MapTopologyApplyResult = MapTopologyUpdateResponse;

export interface MapTopologyDialogProps {
  /** Authoritative project snapshot captured when the dialog opens. */
  project: ProjectResponse;
  selectedMap: MapDef;
  /** Exact authored chains, normally produced by buildMapTopologyChains(project.maps). */
  chains: readonly MapTopologyChain[];
  onPreview: (
    intent: MapTopologyIntent,
    signal: AbortSignal,
  ) => Promise<MapTopologyPreview>;
  /** The caller should install result.project before resolving. */
  onApply: (intent: MapTopologyIntent) => Promise<MapTopologyApplyResult | void>;
  onClose: () => void;
}

type TopologyMapSnapshot = Pick<MapDef, "id" | "name" | "chain" | "isEntry">;

interface DialogBaseline {
  maps: TopologyMapSnapshot[];
  selected: TopologyMapSnapshot;
  chains: MapTopologyChain[];
  sourceChain: string | null;
  sourceEntryId: string | null;
  initialMembership: MapTopologyMembershipMode;
  initialExistingChain: string;
  initialEntryMode: MapTopologyEntryMode;
}

type PreviewState =
  | { phase: "idle" }
  | { phase: "building"; intentKey: string }
  | { phase: "ready"; intentKey: string; value: MapTopologyPreview }
  | { phase: "error"; intentKey: string; error: string };

/** Build the exact, non-normalizing chain catalog expected by the dialog. */
export function buildMapTopologyChains(
  maps: readonly Pick<MapDef, "id" | "chain" | "isEntry">[],
): MapTopologyChain[] {
  const grouped = new Map<string, { memberIds: string[]; entryIds: string[] }>();
  for (const map of maps) {
    if (map.chain === undefined || map.chain.length === 0) continue;
    const group = grouped.get(map.chain) ?? { memberIds: [], entryIds: [] };
    group.memberIds.push(map.id);
    if (map.isEntry) group.entryIds.push(map.id);
    grouped.set(map.chain, group);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => compareMapCatalogChainKeys(left, right))
    .map(([chain, group]) => ({
      chain,
      memberIds: group.memberIds,
      entryIds: group.entryIds,
    }));
}

/** Build the server CAS intent without ever trimming an authored chain. */
export function buildMapTopologyIntent(
  selectedMap: Pick<MapDef, "id" | "chain" | "isEntry">,
  maps: readonly Pick<MapDef, "id" | "chain" | "isEntry">[],
  destinationChain: string | null,
  entry: MapTopologyEntryMode,
  sourceReplacementEntryId?: string,
): MapTopologyIntent {
  if (destinationChain !== null && destinationChain.length === 0) {
    throw new Error("destination chain must be non-empty or null");
  }
  const sourceChain = selectedMap.chain ?? null;
  const expected = {
    chain: sourceChain,
    isEntry: Boolean(selectedMap.isEntry),
    sourceEntryId: exactChainEntryId(maps, sourceChain),
    destinationEntryId: exactChainEntryId(maps, destinationChain),
  };
  return {
    expected,
    destination: { chain: destinationChain, entry },
    ...(sourceReplacementEntryId
      ? { sourceReplacementEntryId }
      : {}),
  };
}

export function mapTopologyNeedsSourceReplacement(
  selectedMap: Pick<MapDef, "id" | "chain" | "isEntry">,
  maps: readonly Pick<MapDef, "id" | "chain" | "isEntry">[],
  destinationChain: string | null,
): boolean {
  const sourceChain = selectedMap.chain ?? null;
  return sourceChain !== null &&
    sourceChain !== destinationChain &&
    Boolean(selectedMap.isEntry) &&
    maps.some((map) => map.id !== selectedMap.id && map.chain === sourceChain);
}

/** Bind Apply to the authoritative topology revision returned by Preview. */
export function mapTopologyCommitIntent(
  intent: MapTopologyIntent,
  preview: Pick<MapTopologyPreview, "revision">,
): MapTopologyIntent {
  return {
    ...intent,
    expected: {
      ...intent.expected,
      revision: preview.revision,
    },
  };
}

export function MapTopologyDialog({
  project,
  selectedMap,
  chains,
  onPreview,
  onApply,
  onClose,
}: MapTopologyDialogProps) {
  const baselineRef = useRef<DialogBaseline | null>(null);
  if (!baselineRef.current) {
    baselineRef.current = createDialogBaseline(project, selectedMap, chains);
  }
  const baseline = baselineRef.current;
  const [membership, setMembership] = useState<MapTopologyMembershipMode>(
    baseline.initialMembership,
  );
  const [existingChain, setExistingChain] = useState(baseline.initialExistingChain);
  const [newChain, setNewChain] = useState("");
  const [entryMode, setEntryMode] = useState<MapTopologyEntryMode>(
    baseline.initialEntryMode,
  );
  const [sourceReplacementEntryId, setSourceReplacementEntryId] = useState("");
  const [previewState, setPreviewState] = useState<PreviewState>({ phase: "idle" });
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const closeReturnFocusIndexRef = useRef(0);
  const previewRequestRef = useRef(0);
  const rawId = useId();
  const domId = `map-topology-${rawId.replace(/:/g, "")}`;

  const chainByExactValue = useMemo(
    () => new Map(baseline.chains.map((chain) => [chain.chain, chain])),
    [baseline.chains],
  );
  const mapById = useMemo(
    () => new Map(baseline.maps.map((map) => [map.id, map])),
    [baseline.maps],
  );
  const destinationChain = membership === "standalone"
    ? null
    : membership === "existing"
      ? existingChain || null
      : newChain || null;
  const destinationEntryIds = destinationChain === null
    ? []
    : baseline.maps
      .filter((map) => map.chain === destinationChain && map.isEntry)
      .map((map) => map.id);
  const destinationEntryId = destinationEntryIds.length === 1
    ? destinationEntryIds[0]!
    : null;
  const effectiveEntryMode: MapTopologyEntryMode = membership === "standalone"
    ? "keep-existing"
    : membership === "new"
      ? "make-selected"
      : entryMode;
  const sourceRemainingMaps = baseline.maps.filter((map) =>
    map.id !== baseline.selected.id && map.chain === baseline.sourceChain
  );
  const needsSourceReplacement = destinationChain !== null || membership === "standalone"
    ? mapTopologyNeedsSourceReplacement(
      baseline.selected,
      baseline.maps,
      destinationChain,
    )
    : false;
  const exactNewChainAlreadyExists = membership === "new" &&
    newChain.length > 0 &&
    chainByExactValue.has(newChain);
  const localError = topologyDraftError({
    membership,
    existingChain,
    newChain,
    exactNewChainAlreadyExists,
    destinationEntryIds,
    effectiveEntryMode,
    needsSourceReplacement,
    sourceReplacementEntryId,
  });
  const destinationReady = membership === "standalone" ||
    (membership === "existing" && existingChain.length > 0) ||
    (membership === "new" && newChain.length > 0 && !exactNewChainAlreadyExists);
  const finalSelectedEntry = destinationChain === null
    ? false
    : effectiveEntryMode === "make-selected"
      ? true
      : destinationEntryId === baseline.selected.id;
  const semanticDirty = destinationReady && (
    destinationChain !== baseline.sourceChain ||
    finalSelectedEntry !== Boolean(baseline.selected.isEntry)
  );
  const dirty = semanticDirty ||
    (!destinationReady && membership !== baseline.initialMembership) ||
    sourceReplacementEntryId.length > 0;

  const intent = useMemo(() => {
    if (localError || !destinationReady) return null;
    try {
      return buildMapTopologyIntent(
        baseline.selected,
        baseline.maps,
        destinationChain,
        effectiveEntryMode,
        needsSourceReplacement ? sourceReplacementEntryId : undefined,
      );
    } catch {
      return null;
    }
  }, [
    baseline.maps,
    baseline.selected,
    destinationChain,
    destinationReady,
    effectiveEntryMode,
    localError,
    needsSourceReplacement,
    sourceReplacementEntryId,
  ]);
  const intentKey = intent ? JSON.stringify(intent) : "";

  useEffect(() => {
    dialogRef.current
      ?.querySelector<HTMLInputElement>('input[name="map-topology-membership"]:checked')
      ?.focus();
  }, []);

  useEffect(() => {
    if (!confirmClose) return;
    keepEditingRef.current?.focus();
  }, [confirmClose]);

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => preventTopologyDraftUnload(event);
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  useEffect(() => {
    setApplyError(null);
    const requestId = ++previewRequestRef.current;
    if (!dirty || !intent) {
      setPreviewState({ phase: "idle" });
      return;
    }
    const controller = new AbortController();
    setPreviewState({ phase: "building", intentKey });
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const value = await onPreview(intent, controller.signal);
          if (controller.signal.aborted || previewRequestRef.current !== requestId) return;
          setPreviewState({ phase: "ready", intentKey, value });
        } catch (cause) {
          if (controller.signal.aborted || previewRequestRef.current !== requestId || isAbortError(cause)) return;
          setPreviewState({
            phase: "error",
            intentKey,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      })();
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [dirty, intentKey, onPreview]);

  const preview = previewState.phase === "ready" && previewState.intentKey === intentKey
    ? previewState.value
    : null;
  const canApply = Boolean(
    dirty &&
    intent &&
    preview &&
    preview.changedIds.length > 0 &&
    !applying,
  );

  const restoreCloseFocus = () => {
    requestAnimationFrame(() => {
      if (!dialogRef.current) return;
      const focusable = dialogFocusableElements(dialogRef.current);
      mapTopologyFocusRestoreTarget(
        focusable,
        closeReturnFocusIndexRef.current,
      )?.focus();
    });
  };

  const apply = async () => {
    if (!intent || !canApply) return;
    const restoreAfterFailure = confirmClose;
    setApplying(true);
    setApplyError(null);
    try {
      await onApply(mapTopologyCommitIntent(intent, preview!));
      setApplying(false);
      onClose();
    } catch (cause) {
      setApplyError(cause instanceof Error ? cause.message : String(cause));
      setConfirmClose(false);
      setApplying(false);
      if (restoreAfterFailure) restoreCloseFocus();
    }
  };

  const requestClose = () => {
    if (applying) return;
    if (!dirty) {
      onClose();
      return;
    }
    const focusable = dialogRef.current
      ? dialogFocusableElements(dialogRef.current)
      : [];
    closeReturnFocusIndexRef.current = mapTopologyFocusRestoreIndex(
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
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      if (canApply) void apply();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (applying) return;
      if (confirmClose) cancelClose();
      else requestClose();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    trapDialogFocus(event, dialogRef.current);
  };

  const chooseMembership = (next: MapTopologyMembershipMode) => {
    setMembership(next);
    setSourceReplacementEntryId("");
    if (next === "standalone") setEntryMode("keep-existing");
    else if (next === "new") setEntryMode("make-selected");
    else setEntryMode(defaultEntryMode(baseline, existingChain));
  };

  const chooseExistingChain = (next: string) => {
    setExistingChain(next);
    setEntryMode(defaultEntryMode(baseline, next));
    setSourceReplacementEntryId("");
  };

  return (
    <div className="map-topology-layer" role="presentation">
      <button
        type="button"
        className="map-topology-backdrop"
        aria-hidden="true"
        tabIndex={-1}
        disabled={applying}
        onClick={requestClose}
      />
      <section
        ref={dialogRef}
        className={`map-topology-dialog${confirmClose ? " confirming" : ""}`}
        role={confirmClose ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-busy={applying || previewState.phase === "building"}
        aria-labelledby={`${domId}-title`}
        aria-describedby={`${domId}-description`}
        onKeyDown={handleKeyDown}
      >
        {confirmClose ? (
          <>
            <header className="map-topology-dialog-header danger">
              <div>
                <span>UNSAVED WORLD TOPOLOGY</span>
                <strong id={`${domId}-title`}>Discard topology change?</strong>
                <small id={`${domId}-description`}>No map source has been changed yet.</small>
              </div>
            </header>
            <div className="map-topology-confirm-body">
              <i aria-hidden="true">!</i>
              <strong>Leave the topology editor?</strong>
              <p>Your exact chain destination, entry rule, and source replacement choice will be lost.</p>
              {applyError && <div className="map-topology-error" role="alert"><strong>Apply failed</strong><code>{applyError}</code></div>}
            </div>
            <footer className="map-topology-dialog-footer confirm-actions">
              <button ref={keepEditingRef} type="button" disabled={applying} onClick={cancelClose}>Keep editing <kbd>Esc</kbd></button>
              <button type="button" className="danger" disabled={applying} onClick={onClose}>Discard &amp; close</button>
              <button type="button" className="primary" disabled={!canApply} onClick={() => void apply()}>Apply topology</button>
            </footer>
          </>
        ) : (
          <>
            <header className="map-topology-dialog-header">
              <div>
                <span>WORLD DATABASE</span>
                <strong id={`${domId}-title`}>Map Topology</strong>
                <small id={`${domId}-description`}>Move one map and transfer chain entry roles as one validated project change.</small>
              </div>
              <button type="button" aria-label="Close Map Topology" disabled={applying} onClick={requestClose}>×</button>
            </header>

            <div className="map-topology-dialog-body">
              <section className="map-topology-identity" aria-label="Selected map identity">
                <div><span>SELECTED MAP</span><strong>{baseline.selected.name}</strong></div>
                <dl>
                  <div><dt>Stable map ID</dt><dd><code>map:{baseline.selected.id}</code></dd></div>
                  <div><dt>Current chain ID</dt><dd><ExactChainValue chain={baseline.sourceChain} /></dd></div>
                  <div><dt>Current role</dt><dd>{baseline.sourceChain === null ? "Independent" : baseline.selected.isEntry ? "Entry map" : "Member map"}</dd></div>
                </dl>
                <p>Stable map ID and authored routes are not renamed or rewritten by this operation.</p>
              </section>

              <fieldset className="map-topology-membership">
                <legend>Membership</legend>
                <p className="map-topology-section-help">Choose a logical chain. Chain IDs are exact authored strings and are never trimmed.</p>
                <div className="map-topology-mode-grid">
                  <label className={membership === "standalone" ? "selected" : ""}>
                    <input type="radio" name="map-topology-membership" checked={membership === "standalone"} onChange={() => chooseMembership("standalone")} />
                    <span aria-hidden="true">◇</span><strong>Standalone</strong><small>No chain membership</small>
                  </label>
                  <label className={membership === "existing" ? "selected" : ""}>
                    <input type="radio" name="map-topology-membership" checked={membership === "existing"} disabled={baseline.chains.length === 0} onChange={() => chooseMembership("existing")} />
                    <span aria-hidden="true">⌘</span><strong>Existing chain</strong><small>{baseline.chains.length} authored</small>
                  </label>
                  <label className={membership === "new" ? "selected" : ""}>
                    <input type="radio" name="map-topology-membership" checked={membership === "new"} onChange={() => chooseMembership("new")} />
                    <span aria-hidden="true">＋</span><strong>New exact chain</strong><small>Create with this map</small>
                  </label>
                </div>

                {membership === "standalone" && (
                  <div className="map-topology-mode-detail standalone">
                    <strong>Independent map</strong>
                    <p>The authored <code>chain</code> and <code>is_entry</code> fields will be removed.</p>
                  </div>
                )}
                {membership === "existing" && (
                  <div className="map-topology-mode-detail">
                    <label>
                      <span>Existing chain</span>
                      <select value={existingChain} onChange={(event) => chooseExistingChain(event.target.value)}>
                        {baseline.chains.map((chain) => (
                          <option value={chain.chain} key={chain.chain}>
                            {mapCatalogChainLabelFromKey(chain.chain)} · {chain.memberIds.length} map{chain.memberIds.length === 1 ? "" : "s"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="map-topology-exact-value">
                      <span>Exact chain ID</span>
                      <code>{existingChain ? JSON.stringify(existingChain) : "No chain selected"}</code>
                    </div>
                  </div>
                )}
                {membership === "new" && (
                  <div className="map-topology-mode-detail">
                    <label>
                      <span>New exact chain ID</span>
                      <input
                        value={newChain}
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={newChain.length === 0 || exactNewChainAlreadyExists}
                        aria-describedby={`${domId}-new-chain-help`}
                        onChange={(event) => {
                          setNewChain(event.target.value);
                          setSourceReplacementEntryId("");
                        }}
                      />
                      <small id={`${domId}-new-chain-help`}>Whitespace is preserved. Use Standalone instead of an empty value.</small>
                    </label>
                    <div className="map-topology-exact-value">
                      <span>Exact value preview</span>
                      <code>{JSON.stringify(newChain)}</code>
                    </div>
                  </div>
                )}
              </fieldset>

              <div className="map-topology-lower-grid">
                <fieldset className="map-topology-entry-rule">
                  <legend>Entry rule</legend>
                  <p className="map-topology-section-help">Every authored chain keeps exactly one entry map.</p>
                  {membership === "standalone" ? (
                    <div className="map-topology-fixed-rule"><i aria-hidden="true">◇</i><span><strong>Not a chain entry</strong><small>Standalone maps do not carry an entry role.</small></span></div>
                  ) : membership === "new" ? (
                    <div className="map-topology-fixed-rule"><i aria-hidden="true">◆</i><span><strong>{baseline.selected.name} becomes entry</strong><small>A new chain must begin with this map.</small></span></div>
                  ) : destinationEntryId === baseline.selected.id && destinationChain === baseline.sourceChain ? (
                    <div className="map-topology-fixed-rule"><i aria-hidden="true">◆</i><span><strong>This map remains entry</strong><small>{mapLabel(baseline.selected.id, mapById)} already owns the exact chain entry role.</small></span></div>
                  ) : (
                    <div className="map-topology-entry-options" role="radiogroup" aria-label="Destination entry rule">
                      <label className={effectiveEntryMode === "keep-existing" ? "selected" : ""}>
                        <input
                          type="radio"
                          name="map-topology-entry-rule"
                          checked={effectiveEntryMode === "keep-existing"}
                          disabled={destinationEntryId === null}
                          onChange={() => setEntryMode("keep-existing")}
                        />
                        <span><strong>Keep destination entry</strong><small>{destinationEntryId ? mapLabel(destinationEntryId, mapById) : "No entry is available"}</small></span>
                      </label>
                      <label className={effectiveEntryMode === "make-selected" ? "selected" : ""}>
                        <input type="radio" name="map-topology-entry-rule" checked={effectiveEntryMode === "make-selected"} onChange={() => setEntryMode("make-selected")} />
                        <span><strong>Make this map entry</strong><small>{destinationEntryId && destinationEntryId !== baseline.selected.id ? `Transfers role from ${mapLabel(destinationEntryId, mapById)}` : "Selected map owns the entry role"}</small></span>
                      </label>
                    </div>
                  )}

                  {needsSourceReplacement && (
                    <label className="map-topology-source-replacement">
                      <span>Replacement entry in <ExactChainValue chain={baseline.sourceChain} /></span>
                      <select value={sourceReplacementEntryId} aria-invalid={!sourceReplacementEntryId} onChange={(event) => setSourceReplacementEntryId(event.target.value)}>
                        <option value="">Choose replacement…</option>
                        {sourceRemainingMaps.map((map) => <option value={map.id} key={map.id}>{map.name} · map:{map.id}</option>)}
                      </select>
                      <small>The selected map currently owns the source chain entry role.</small>
                    </label>
                  )}
                </fieldset>

                <section className="map-topology-preview" aria-labelledby={`${domId}-preview-title`}>
                  <header><div><span>ATOMIC CHANGE</span><strong id={`${domId}-preview-title`}>Validation preview</strong></div><PreviewPhase phase={previewState.phase} /></header>
                  <div className="map-topology-intent-summary">
                    <span><small>Move</small><code>map:{baseline.selected.id}</code></span>
                    <i aria-hidden="true">→</i>
                    <span><small>Destination</small><ExactChainValue chain={destinationChain} /></span>
                  </div>
                  {needsSourceReplacement && sourceReplacementEntryId && <p className="map-topology-transfer-note"><strong>Source entry</strong> transfers to {mapLabel(sourceReplacementEntryId, mapById)}.</p>}
                  {destinationChain !== null && effectiveEntryMode === "make-selected" && destinationEntryId && destinationEntryId !== baseline.selected.id && <p className="map-topology-transfer-note"><strong>Destination entry</strong> transfers from {mapLabel(destinationEntryId, mapById)}.</p>}
                  {localError && <div className="map-topology-inline-warning" role="status">{localError}</div>}
                  {!localError && previewState.phase === "idle" && <div className="map-topology-preview-empty">Choose a different destination or entry rule to build a preview.</div>}
                  {previewState.phase === "building" && <div className="map-topology-preview-building" role="status"><i /><span><strong>Validating the whole map graph…</strong><small>No project source is being written.</small></span></div>}
                  {previewState.phase === "error" && previewState.intentKey === intentKey && <div className="map-topology-error" role="alert"><strong>Topology rejected · draft preserved</strong><code>{previewState.error}</code><small>No project source was changed.</small></div>}
                  {preview && <div className="map-topology-preview-ready" role="status" aria-live="polite">
                    <strong>Project validation passed</strong>
                    <small>{preview.changedIds.length} source file{preview.changedIds.length === 1 ? "" : "s"} will change together.</small>
                    <ul>{preview.assignments.map((assignment) => <li key={assignment.id}><span>{mapLabel(assignment.id, mapById)}</span><ExactChainValue chain={assignment.chain} /><b>{assignment.isEntry ? "ENTRY" : assignment.chain === null ? "INDEPENDENT" : "MEMBER"}</b></li>)}</ul>
                  </div>}
                  {applyError && <div className="map-topology-error" role="alert"><strong>Apply failed · topology draft preserved</strong><code>{applyError}</code><small>Refresh or revise the draft before retrying.</small></div>}
                </section>
              </div>
            </div>

            <footer className="map-topology-dialog-footer">
              <span className={dirty ? "dirty" : preview ? "ready" : "clean"}><i />{applying ? "COMMITTING ATOMIC CHANGE" : dirty ? preview ? "VALIDATED TOPOLOGY DRAFT" : "UNSAVED TOPOLOGY DRAFT" : "NO TOPOLOGY CHANGES"}</span>
              <div>
                <button type="button" disabled={applying} onClick={requestClose}>Cancel</button>
                <button type="button" className="primary" disabled={!canApply} onClick={() => void apply()}>{applying ? "Applying…" : <>Apply topology <kbd>⌘S</kbd></>}</button>
              </div>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}

function createDialogBaseline(
  project: ProjectResponse,
  selectedMap: MapDef,
  providedChains: readonly MapTopologyChain[],
): DialogBaseline {
  const maps = project.maps.map((map) => ({
    id: map.id,
    name: map.name,
    ...(map.chain !== undefined ? { chain: map.chain } : {}),
    ...(map.isEntry ? { isEntry: true } : {}),
  }));
  const selected = maps.find((map) => map.id === selectedMap.id) ?? {
    id: selectedMap.id,
    name: selectedMap.name,
    ...(selectedMap.chain !== undefined ? { chain: selectedMap.chain } : {}),
    ...(selectedMap.isEntry ? { isEntry: true } : {}),
  };
  const derivedChains = buildMapTopologyChains(maps);
  const chains: MapTopologyChain[] = (providedChains.length > 0 ? providedChains : derivedChains)
    .filter((chain) => chain.chain.length > 0)
    .map((chain) => ({
      chain: chain.chain,
      memberIds: [...chain.memberIds],
      entryIds: [...chain.entryIds],
    }));
  for (const derived of derivedChains) {
    if (!chains.some((chain) => chain.chain === derived.chain)) chains.push(derived);
  }
  chains.sort((left, right) => compareMapCatalogChainKeys(left.chain, right.chain));
  const sourceChain = selected.chain ?? null;
  const sourceEntryId = exactChainEntryId(maps, sourceChain);
  const initialMembership: MapTopologyMembershipMode = sourceChain === null
    ? "standalone"
    : "existing";
  const initialExistingChain = sourceChain ?? chains[0]?.chain ?? "";
  const initialEntryMode: MapTopologyEntryMode = selected.isEntry
    ? "make-selected"
    : "keep-existing";
  return {
    maps,
    selected,
    chains,
    sourceChain,
    sourceEntryId,
    initialMembership,
    initialExistingChain,
    initialEntryMode,
  };
}

function defaultEntryMode(
  baseline: DialogBaseline,
  destinationChain: string,
): MapTopologyEntryMode {
  const entryId = exactChainEntryId(baseline.maps, destinationChain || null);
  return entryId === baseline.selected.id
    ? "make-selected"
    : entryId
      ? "keep-existing"
      : "make-selected";
}

function exactChainEntryId(
  maps: readonly Pick<MapDef, "id" | "chain" | "isEntry">[],
  chain: string | null,
): string | null {
  if (chain === null) return null;
  const entries = maps.filter((map) => map.chain === chain && map.isEntry);
  if (entries.length > 1) {
    throw new Error(`chain ${JSON.stringify(chain)} has multiple entries: ${entries.map((map) => map.id).join(", ")}`);
  }
  return entries[0]?.id ?? null;
}

function topologyDraftError({
  membership,
  existingChain,
  newChain,
  exactNewChainAlreadyExists,
  destinationEntryIds,
  effectiveEntryMode,
  needsSourceReplacement,
  sourceReplacementEntryId,
}: {
  membership: MapTopologyMembershipMode;
  existingChain: string;
  newChain: string;
  exactNewChainAlreadyExists: boolean;
  destinationEntryIds: string[];
  effectiveEntryMode: MapTopologyEntryMode;
  needsSourceReplacement: boolean;
  sourceReplacementEntryId: string;
}): string | null {
  if (membership === "existing" && existingChain.length === 0) return "Choose an existing exact chain.";
  if (membership === "new" && newChain.length === 0) return "New chain ID must not be empty. Whitespace is preserved; use Standalone for no chain.";
  if (exactNewChainAlreadyExists) return `Exact chain ${JSON.stringify(newChain)} already exists. Choose Existing chain to edit its entry rule.`;
  if (destinationEntryIds.length > 1) return `Destination chain has multiple entries: ${destinationEntryIds.join(", ")}. Repair the authoritative topology first.`;
  if (membership === "existing" && effectiveEntryMode === "keep-existing" && destinationEntryIds.length === 0) return "The destination chain has no entry to keep. Make this map its entry.";
  if (needsSourceReplacement && !sourceReplacementEntryId) return "Choose a replacement entry for the source chain before previewing.";
  return null;
}

function mapLabel(
  mapId: string,
  mapById: ReadonlyMap<string, TopologyMapSnapshot>,
): string {
  const map = mapById.get(mapId);
  return map ? `${map.name} (map:${map.id})` : `map:${mapId}`;
}

function ExactChainValue({ chain }: { chain: string | null }) {
  return chain === null
    ? <span className="map-topology-standalone-value">Standalone</span>
    : <code className="map-topology-chain-value">{JSON.stringify(chain)}</code>;
}

function PreviewPhase({ phase }: { phase: PreviewState["phase"] }) {
  const label = phase === "building"
    ? "VALIDATING"
    : phase === "ready"
      ? "READY"
      : phase === "error"
        ? "REJECTED"
        : "WAITING";
  return <span className={`map-topology-preview-phase ${phase}`}><i />{label}</span>;
}

function trapDialogFocus(
  event: React.KeyboardEvent<HTMLElement>,
  dialog: HTMLElement,
) {
  const focusable = dialogFocusableElements(dialog);
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

function dialogFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.closest('[aria-hidden="true"]'));
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException
    ? cause.name === "AbortError"
    : cause instanceof Error && cause.name === "AbortError";
}

export function preventTopologyDraftUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = "";
}

export function mapTopologyFocusRestoreIndex<T>(
  focusable: readonly T[],
  active: T | null,
): number {
  return Math.max(0, active === null ? -1 : focusable.indexOf(active));
}

export function mapTopologyFocusRestoreTarget<T>(
  focusable: readonly T[],
  index: number,
): T | undefined {
  return focusable[index] ?? focusable[0];
}
