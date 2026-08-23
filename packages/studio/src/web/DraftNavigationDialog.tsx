import React, { useEffect, useRef } from "react";

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
  const dialogRef = useRef<HTMLElement | null>(null);
  const stayRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (saving) dialogRef.current?.focus();
    else stayRef.current?.focus();
  }, [saving]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      if (!saving) onSave();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!saving) onStay();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
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
  };

  return (
    <div className="draft-navigation-layer" role="presentation">
      <button type="button" className="draft-navigation-backdrop" aria-hidden="true" tabIndex={-1} disabled={saving} onClick={onStay} />
      <section ref={dialogRef} tabIndex={-1} className="draft-navigation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="draft-navigation-title" aria-describedby="draft-navigation-description" onKeyDown={onKeyDown}>
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
          <button ref={stayRef} type="button" disabled={saving} onClick={onStay}>Keep editing <kbd>Esc</kbd></button>
          <button type="button" className="danger" disabled={saving} onClick={onDiscard}>Discard &amp; leave</button>
          <button type="button" className="primary" disabled={saving} onClick={onSave}>{saving ? "Validating…" : <>Save &amp; leave <kbd>⌘S</kbd></>}</button>
        </footer>
      </section>
    </div>
  );
}
