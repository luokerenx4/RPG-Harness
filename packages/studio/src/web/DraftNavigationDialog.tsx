import React, { useEffect } from "react";

export interface StudioDraftGuard {
  label: string;
  save: () => Promise<boolean>;
  discard: () => void;
}

export function DraftNavigationDialog({
  guard,
  destination,
  saving,
  error,
  onStay,
  onSave,
  onDiscard,
}: {
  guard: StudioDraftGuard;
  destination: string;
  saving: boolean;
  error?: string | null;
  onStay: () => void;
  onSave: () => void;
  onDiscard: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving) return;
      event.preventDefault();
      onStay();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saving, onStay]);

  return (
    <div className="draft-navigation-layer" role="presentation">
      <button type="button" className="draft-navigation-backdrop" aria-label="Keep editing" disabled={saving} onClick={onStay} />
      <section className="draft-navigation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="draft-navigation-title" aria-describedby="draft-navigation-description">
        <header>
          <span>UNSAVED PROJECT CHANGES</span>
          <strong id="draft-navigation-title">Save before leaving?</strong>
          <p id="draft-navigation-description">You are editing <b>{guard.label}</b>. Choose what should happen before opening <b>{destination}</b>.</p>
        </header>
        <div className="draft-navigation-summary">
          <i aria-hidden="true">◆</i>
          <div><span>ACTIVE DRAFT</span><strong>{guard.label}</strong><small>Source files remain unchanged until validation succeeds.</small></div>
        </div>
        {error && <div className="draft-navigation-error" role="alert"><strong>Save failed</strong><span>{error}</span></div>}
        <footer>
          <button type="button" disabled={saving} onClick={onStay}>Keep editing <kbd>Esc</kbd></button>
          <button type="button" className="danger" disabled={saving} onClick={onDiscard}>Discard &amp; leave</button>
          <button type="button" className="primary" disabled={saving} onClick={onSave}>{saving ? "Validating…" : "Save & leave"}</button>
        </footer>
      </section>
    </div>
  );
}
