export interface MapPreviewRequest {
  sequence: number;
  controller: AbortController;
}

export interface MapPreviewRequestGate {
  begin(): MapPreviewRequest;
  isCurrent(request: MapPreviewRequest): boolean;
  cancel(request?: MapPreviewRequest): void;
}

export const MAP_PREVIEW_DRAFT_DEBOUNCE_MS = 180;

export function scheduleMapPreviewRequest(
  run: () => void,
  delay = MAP_PREVIEW_DRAFT_DEBOUNCE_MS,
): () => void {
  const timer = globalThis.setTimeout(run, delay);
  return () => globalThis.clearTimeout(timer);
}

/**
 * Keeps semantic map previews ordered while authors edit quickly. Beginning a
 * request aborts the previous one, and isCurrent also rejects responses that
 * happened to settle immediately before their abort was observed.
 */
export function createMapPreviewRequestGate(): MapPreviewRequestGate {
  let sequence = 0;
  let active: MapPreviewRequest | null = null;
  return {
    begin() {
      active?.controller.abort();
      active = {
        sequence: ++sequence,
        controller: new AbortController(),
      };
      return active;
    },
    isCurrent(request) {
      return active === request && !request.controller.signal.aborted;
    },
    cancel(request) {
      if (request && active !== request) return;
      active?.controller.abort();
      active = null;
    },
  };
}

export function isAbortError(cause: unknown): boolean {
  return !!cause && typeof cause === "object" &&
    "name" in cause && (cause as { name?: unknown }).name === "AbortError";
}
