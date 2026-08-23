import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import AnsiToHtml from "ansi-to-html";
import type {
  AssetRow,
  ColorMode,
  DitherMode,
  HealthState,
  RenderOptions,
  SymbolSet,
} from "../api";
import {
  fetchAsset,
  fetchHealth,
  fetchTuiAns,
  fetchTuiTxt,
  patchSpec,
  renderTui,
  sourceCompressedImageUrl,
  sourceQualityImageUrl,
  uploadSource,
} from "../api";
import type { PatchableSpecFields } from "../api";

// Server's whitelist (mirrored here for the dropdown). Each entry
// carries a one-line `hint` shown next to the dropdown when that
// option is selected — gives the author actionable trade-off info
// without forcing them to A/B every option.
//
// "density" column = effective pixels per character cell. Higher
// density = more visual info, but needs a font shipping those
// Unicode ranges. Most modern monospace fonts (SF Mono, Menlo,
// Fira Code, JetBrains Mono, any Nerd Font) cover through sextant;
// octant is Unicode 16 and rolling out gradually.
interface SymbolOpt {
  value: SymbolSet;
  label: string;
  hint: string;
}
const SYMBOL_OPTIONS: SymbolOpt[] = [
  {
    value: "block",
    label: "block",
    hint: "▀▄█ half-blocks. 1×2 density. Works everywhere; loses detail on portraits.",
  },
  {
    value: "half",
    label: "half",
    hint: "▀▄ + ▌▐. Same density as block; slightly richer pattern set.",
  },
  {
    value: "quad",
    label: "quad",
    hint: "▖▗▘▙ quadrants. 2×2 density. Good middle ground; broad font support.",
  },
  {
    value: "sextant",
    label: "sextant",
    hint: "🬀–🬻 sextants. 2×3 density — 3× more detail than block. Needs SF Mono / Fira / etc.",
  },
  {
    value: "braille",
    label: "braille",
    hint: "⠁⠂⠃ Braille dots. 2×4 density, pointillist look. Best for line art / text-y subjects.",
  },
  {
    value: "octant",
    label: "octant",
    hint: "𜺨–𜻿 octants. 2×4 density. Unicode 16; only newest fonts render it correctly.",
  },
  {
    value: "ascii",
    label: "ascii",
    hint: "Plain ASCII only (no Unicode). Lowest quality, max compatibility (logs / email).",
  },
  {
    value: "all",
    label: "all",
    hint: "chafa picks from every supported glyph. Highest perceived quality; output varies.",
  },
];

interface ColorOpt {
  value: ColorMode;
  label: string;
  hint: string;
}
const COLOR_OPTIONS: ColorOpt[] = [
  {
    value: "none",
    label: "none",
    hint: "Monochrome. Writes tui.txt. Smallest, most portable; loses color entirely.",
  },
  {
    value: "16",
    label: "16",
    hint: "Basic ANSI palette. Writes tui.ans. Works on every terminal but quantizes hard.",
  },
  {
    value: "256",
    label: "256",
    hint: "Xterm 256 palette. Writes tui.ans. Sweet spot — most modern terminals support it.",
  },
  {
    value: "full",
    label: "full (truecolor)",
    hint: "24-bit RGB. Writes tui.ans. Needs a truecolor terminal (Ghostty / iTerm2 / WezTerm / modern Kitty).",
  },
];

interface DitherOpt {
  value: DitherMode;
  label: string;
  hint: string;
}
const DITHER_OPTIONS: DitherOpt[] = [
  {
    value: "none",
    label: "none",
    hint: "No dithering. Crisp edges, posterized flats. Best for line art, logos, pixel art.",
  },
  {
    value: "ordered",
    label: "ordered",
    hint: "Bayer pattern. Adds a uniform texture to flat regions; predictable, looks 'engineered'.",
  },
  {
    value: "diffusion",
    label: "diffusion",
    hint: "Floyd-Steinberg error diffusion. Smoothest gradients; best for photos / faces.",
  },
];

// Human-readable bytes formatter for the source-tier size labels.
// Picks B / KB / MB at the natural breakpoints; one decimal for K/M.
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Asset detail. Two-column layout:
//   left  — spec metadata (kind, refs, size_hint, tags, placeholder)
//   right — prompt (copyable) + tier-aware source previews + tui.txt
//
// The route path is `/asset/<asset-path>` where <asset-path> may
// itself contain slashes (e.g. "assets/portraits/kagari-smile").
// React Router's splat (`/asset/*`) preserves that, accessible via
// useLocation since `useParams` only gives the splat as a single
// param — same effect via location.pathname.slice.
export function AssetDetail() {
  const loc = useLocation();
  const assetPath = loc.pathname.replace(/^\/asset\//, "");

  const [asset, setAsset] = useState<AssetRow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Preview content lives in one slot; `kind` tells us whether it's
  // ANSI-escape-laden (tui.ans, render colored) or plain text
  // (tui.txt, render as <pre>). When both files exist on disk, .ans
  // wins — matches the TUI's selectRendering priority so the preview
  // shows the same thing the player would see.
  const [tuiPreview, setTuiPreview] = useState<
    { kind: "ans" | "txt"; content: string } | null
  >(null);
  const [toast, setToast] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthState | null>(null);
  const [busy, setBusy] = useState<"upload" | "render" | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Render options form state. Defaults are "use chafa's own / spec's
  // hint" — only fields the user explicitly touched go into the POST
  // body. Hydrated from spec.tuiRender on asset load (v3): a winning
  // combo persisted by the auto-save pathway pre-fills the form so
  // re-rendering preserves the author's choice.
  const [symbols, setSymbols] = useState<SymbolSet | "">("");
  const [dither, setDither] = useState<DitherMode | "">("");
  const [colors, setColors] = useState<ColorMode | "">("");
  const [overrideSize, setOverrideSize] = useState(false);
  const [cols, setCols] = useState<string>("");
  const [rows, setRows] = useState<string>("");

  // Edit-mode state for spec fields. `editing` toggles the read-only
  // <dl> into a form; `editBuf` carries the dirty values until save.
  // On save, we send only the keys that differ from `asset` so the
  // YAML round-trip stays minimal (untouched keys keep their author-
  // formatted layout). On discard, we drop the buffer.
  const [editing, setEditing] = useState(false);
  const [editBuf, setEditBuf] = useState<{
    description: string;
    prompt: string;
    placeholder: string;
    tagsCsv: string;
    sizeTuiCols: string;
    sizeTuiRows: string;
    sizeWebAspect: string;
    refsCharactersCsv: string;
    refsEmotion: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  // After an upload or render, the asset's renderings flip on the
  // server — refetch + re-pull the preview so the UI mirrors disk.
  // Reused by both upload and render handlers + the source.quality.png
  // preview cache-busts on the new query string.
  const [cacheKey, setCacheKey] = useState(0);

  useEffect(() => {
    setAsset(null);
    setErr(null);
    setTuiPreview(null);
    setEditing(false);
    fetchAsset(assetPath)
      .then((a) => {
        setAsset(a);
        // Hydrate render-options form from persisted prefs. Setting
        // each control from spec.tuiRender means a freshly opened
        // page reflects the author's last successful render, not the
        // generic "(default)" placeholders.
        if (a.tuiRender) {
          if (a.tuiRender.symbols) setSymbols(a.tuiRender.symbols as SymbolSet);
          if (a.tuiRender.dither) setDither(a.tuiRender.dither as DitherMode);
          if (a.tuiRender.colors) setColors(a.tuiRender.colors as ColorMode);
          if (
            typeof a.tuiRender.cols === "number" &&
            typeof a.tuiRender.rows === "number"
          ) {
            setOverrideSize(true);
            setCols(String(a.tuiRender.cols));
            setRows(String(a.tuiRender.rows));
          }
        }
        // Match the TUI's priority: .ans wins over .txt. The preview
        // is a nice-to-have; fetch failures just leave the section
        // empty instead of erroring the whole page.
        if (a.renderings.tuiAns) {
          fetchTuiAns(assetPath)
            .then((content) => setTuiPreview({ kind: "ans", content }))
            .catch(() => {});
        } else if (a.renderings.tuiTxt) {
          fetchTuiTxt(assetPath)
            .then((content) => setTuiPreview({ kind: "txt", content }))
            .catch(() => {});
        }
      })
      .catch((e) => setErr(e.message));
  }, [assetPath, cacheKey]);

  // ansi-to-html converter, built once per render and parameterized
  // to match the studio's dark theme so colors look right against
  // the panel background. fg/bg here only set the document defaults;
  // chafa's SGR escapes override each cell.
  const ansiConverter = useMemo(
    () =>
      new AnsiToHtml({
        fg: "#e6e6e6",
        bg: "#0f1115",
        newline: true,
        escapeXML: true,
        stream: false,
      }),
    [],
  );
  const previewHtml = useMemo(() => {
    if (!tuiPreview || tuiPreview.kind !== "ans") return null;
    return ansiConverter.toHtml(tuiPreview.content);
  }, [tuiPreview, ansiConverter]);

  // Health is global; fetch once on mount and reuse for the whole
  // session. The user installing chafa mid-session would need to
  // refresh — acceptable for v2.
  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch(() => {
        /* health is advisory; failures fall back to "chafa unknown" */
      });
  }, []);

  if (err) return <Layout backTo="/"><div className="empty">⚠ {err}</div></Layout>;
  if (!asset) return <Layout backTo="/"><div className="empty">loading…</div></Layout>;

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(asset.prompt);
      showToast(setToast, "prompt copied");
    } catch {
      showToast(setToast, "copy failed (clipboard permission)");
    }
  };
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(asset.path);
      showToast(setToast, "path copied");
    } catch {
      showToast(setToast, "copy failed");
    }
  };

  // Begin edit mode: snapshot the asset's current values into the
  // edit buffer. Tags + refs.characters are flattened to comma-
  // separated strings for the textinput; on save we split them back.
  // The other fields are direct string copies.
  const startEditing = () => {
    if (!asset) return;
    setEditBuf({
      description: asset.description,
      prompt: asset.prompt,
      placeholder: asset.placeholder,
      tagsCsv: (asset.tags ?? []).join(", "),
      sizeTuiCols: asset.sizeHint?.tui?.cols
        ? String(asset.sizeHint.tui.cols)
        : "",
      sizeTuiRows: asset.sizeHint?.tui?.rows
        ? String(asset.sizeHint.tui.rows)
        : "",
      sizeWebAspect: asset.sizeHint?.web?.aspect ?? "",
      refsCharactersCsv: (asset.refs?.characters ?? []).join(", "),
      refsEmotion:
        typeof asset.refs?.emotion === "string" ? asset.refs.emotion : "",
    });
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setEditBuf(null);
  };

  // Build a PatchableSpecFields payload from the diff between asset
  // and editBuf. Only changed keys are sent — the YAML Document API
  // on the server then only touches those lines, preserving any
  // surrounding comments and key ordering.
  const handleSave = async () => {
    if (!asset || !editBuf) return;
    const patch: PatchableSpecFields = {};

    if (editBuf.description !== asset.description) {
      patch.description = editBuf.description;
    }
    if (editBuf.prompt !== asset.prompt) {
      patch.prompt = editBuf.prompt;
    }
    if (editBuf.placeholder !== asset.placeholder) {
      patch.placeholder = editBuf.placeholder;
    }

    const newTags = editBuf.tagsCsv
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (
      JSON.stringify(newTags) !== JSON.stringify(asset.tags ?? [])
    ) {
      patch.tags = newTags;
    }

    // sizeHint: collect a new full object iff anything inside changed.
    const newSizeHint: AssetRow["sizeHint"] = {};
    if (editBuf.sizeTuiCols !== "" || editBuf.sizeTuiRows !== "") {
      const c = parseInt(editBuf.sizeTuiCols, 10);
      const r = parseInt(editBuf.sizeTuiRows, 10);
      if (Number.isFinite(c) && c > 0 && Number.isFinite(r) && r > 0) {
        newSizeHint.tui = { cols: c, rows: r };
      }
    }
    if (editBuf.sizeWebAspect !== "") {
      newSizeHint.web = { aspect: editBuf.sizeWebAspect };
    }
    if (JSON.stringify(newSizeHint) !== JSON.stringify(asset.sizeHint ?? {})) {
      patch.sizeHint = newSizeHint;
    }

    // refs: only the structured fields (characters, emotion). Other
    // free-form ref keys would round-trip through the server but the
    // form doesn't expose them — full-edit lives in spec.yaml direct.
    const newCharacters = editBuf.refsCharactersCsv
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const oldCharacters = asset.refs?.characters ?? [];
    const oldEmotion =
      typeof asset.refs?.emotion === "string" ? asset.refs.emotion : "";
    if (
      JSON.stringify(newCharacters) !== JSON.stringify(oldCharacters) ||
      editBuf.refsEmotion !== oldEmotion
    ) {
      // Preserve other ref keys verbatim; only mutate characters /
      // emotion. The server replaces sub-objects whole when we set
      // refs, so we need to carry the unchanged keys through.
      const merged: Record<string, unknown> = { ...(asset.refs ?? {}) };
      if (newCharacters.length > 0) merged.characters = newCharacters;
      else delete merged.characters;
      if (editBuf.refsEmotion !== "") merged.emotion = editBuf.refsEmotion;
      else delete merged.emotion;
      patch.refs = merged as AssetRow["refs"];
    }

    if (Object.keys(patch).length === 0) {
      showToast(setToast, "no changes");
      setEditing(false);
      setEditBuf(null);
      return;
    }

    setSaving(true);
    try {
      const updated = await patchSpec(assetPath, patch);
      setAsset(updated);
      setEditing(false);
      setEditBuf(null);
      showToast(setToast, "spec saved");
    } catch (e) {
      showToast(setToast, (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // Upload handler shared by the file picker and drag-drop pathways.
  // Both end up here with a single Blob. v2 enforces PNG client-side
  // for a friendlier error message; the server enforces it too.
  const handleUpload = async (file: File) => {
    if (!file.type.startsWith("image/png")) {
      showToast(setToast, "PNG only — got " + (file.type || "unknown"));
      return;
    }
    setBusy("upload");
    try {
      await uploadSource(assetPath, file);
      setCacheKey((k) => k + 1);
      showToast(setToast, "source.quality.png uploaded");
    } catch (e) {
      showToast(setToast, (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const onPickFile: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const f = e.target.files?.[0];
    if (f) void handleUpload(f);
    // Reset so picking the same file twice still fires onChange.
    e.target.value = "";
  };
  const onDrop: React.DragEventHandler<HTMLDivElement> = (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) void handleUpload(f);
  };

  const handleRender = async () => {
    // Compose options from the form: include each field only if the
    // user touched it. Empty options sends an empty body (server
    // preserves backward-compatible defaults — block / spec.sizeHint).
    const options: RenderOptions = {};
    if (symbols !== "") options.symbols = symbols;
    if (dither !== "") options.dither = dither;
    if (colors !== "") options.colors = colors;
    if (overrideSize) {
      const c = parseInt(cols, 10);
      const r = parseInt(rows, 10);
      if (Number.isFinite(c) && c > 0) options.cols = c;
      if (Number.isFinite(r) && r > 0) options.rows = r;
    }

    setBusy("render");
    try {
      await renderTui(assetPath, options);
      setCacheKey((k) => k + 1);
      showToast(setToast, "tui.txt rendered");
    } catch (e) {
      // 503 (no chafa) gets a more actionable hint than the raw
      // server message — the user shouldn't have to read JSON.
      const status = (e as Error & { status?: number }).status;
      if (status === 503) {
        showToast(setToast, "chafa not installed — try `brew install chafa`");
      } else if (status === 412) {
        showToast(setToast, "upload a source.quality.png first");
      } else {
        showToast(setToast, (e as Error).message);
      }
    } finally {
      setBusy(null);
    }
  };

  const chafaPresent = health?.chafa.present ?? false;
  // chafa wants the high-res master, not the lossy compressed copy.
  // If the author has only a compressed file (e.g. cloned the repo
  // without ever generating their own quality master), regenerating
  // tui.* from it would lock in compression artifacts.
  const canRender =
    asset.renderings.sourceQuality && chafaPresent && busy === null;

  return (
    <Layout backTo="/assets">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ marginBottom: 4 }}>
            <span className={`kind-badge ${asset.kind}`}>{asset.kind}</span>{" "}
            <span style={{ marginLeft: 8 }}>{asset.placeholder}</span>
          </h1>
          <div className="path mono muted">{asset.path}</div>
        </div>
        <button className="btn" onClick={copyPath}>
          copy path
        </button>
      </div>

      <div className="detail-layout">
        <div>
          <div className="detail-section">
            <h2 style={{ display: "flex", justifyContent: "space-between" }}>
              <span>spec</span>
              {editing ? (
                <span className="row">
                  <button
                    className="btn"
                    onClick={cancelEditing}
                    disabled={saving}
                  >
                    discard
                  </button>
                  <button
                    className="btn primary"
                    onClick={handleSave}
                    disabled={saving}
                  >
                    {saving ? "saving…" : "save"}
                  </button>
                </span>
              ) : (
                <button className="btn" onClick={startEditing}>
                  edit
                </button>
              )}
            </h2>
            {!editing && (
              <dl className="kv">
                <dt>kind</dt>
                <dd>{asset.kind}</dd>
                <dt>placeholder</dt>
                <dd>{asset.placeholder}</dd>
                {asset.styleRef && (
                  <>
                    <dt>style_ref</dt>
                    <dd className="mono">{asset.styleRef}</dd>
                  </>
                )}
                {asset.sizeHint?.tui && (
                  <>
                    <dt>size_hint.tui</dt>
                    <dd className="mono">
                      {asset.sizeHint.tui.cols} × {asset.sizeHint.tui.rows}
                    </dd>
                  </>
                )}
                {asset.sizeHint?.web && (
                  <>
                    <dt>size_hint.web</dt>
                    <dd className="mono">aspect {asset.sizeHint.web.aspect}</dd>
                  </>
                )}
                {asset.tags && asset.tags.length > 0 && (
                  <>
                    <dt>tags</dt>
                    <dd>{asset.tags.join(", ")}</dd>
                  </>
                )}
              </dl>
            )}
            {editing && editBuf && (
              <div className="edit-form">
                <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
                  kind = <code>{asset.kind}</code> (not editable). path ={" "}
                  <code>{asset.path}</code>.
                </div>
                <label className="edit-field">
                  <span>placeholder</span>
                  <textarea
                    rows={2}
                    value={editBuf.placeholder}
                    onChange={(e) =>
                      setEditBuf({ ...editBuf, placeholder: e.target.value })
                    }
                  />
                </label>
                <label className="edit-field">
                  <span>tags (csv)</span>
                  <input
                    type="text"
                    value={editBuf.tagsCsv}
                    placeholder="chapter-1, main-cast"
                    onChange={(e) =>
                      setEditBuf({ ...editBuf, tagsCsv: e.target.value })
                    }
                  />
                </label>
                <div className="edit-field-row">
                  <label className="edit-field">
                    <span>tui cols</span>
                    <input
                      type="number"
                      min={1}
                      max={500}
                      value={editBuf.sizeTuiCols}
                      onChange={(e) =>
                        setEditBuf({ ...editBuf, sizeTuiCols: e.target.value })
                      }
                    />
                  </label>
                  <label className="edit-field">
                    <span>tui rows</span>
                    <input
                      type="number"
                      min={1}
                      max={500}
                      value={editBuf.sizeTuiRows}
                      onChange={(e) =>
                        setEditBuf({ ...editBuf, sizeTuiRows: e.target.value })
                      }
                    />
                  </label>
                  <label className="edit-field">
                    <span>web aspect</span>
                    <input
                      type="text"
                      value={editBuf.sizeWebAspect}
                      placeholder="3:4"
                      onChange={(e) =>
                        setEditBuf({
                          ...editBuf,
                          sizeWebAspect: e.target.value,
                        })
                      }
                    />
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* refs section: read-only when not editing; the structured
              characters/emotion fields edited inline below. Free-form
              ref keys (location, time, ...) only round-trip through
              the API — not exposed in the form yet. */}
          {!editing && asset.refs && Object.keys(asset.refs).length > 0 && (
            <div className="detail-section" style={{ marginTop: 16 }}>
              <h2>refs</h2>
              <dl className="kv">
                {asset.refs.characters && (
                  <>
                    <dt>characters</dt>
                    <dd>{asset.refs.characters.join(", ")}</dd>
                  </>
                )}
                {asset.refs.emotion && (
                  <>
                    <dt>emotion</dt>
                    <dd>{asset.refs.emotion}</dd>
                  </>
                )}
                {Object.entries(asset.refs)
                  .filter(
                    ([k]) => k !== "characters" && k !== "emotion",
                  )
                  .map(([k, v]) => (
                    <React.Fragment key={k}>
                      <dt>{k}</dt>
                      <dd>{String(v)}</dd>
                    </React.Fragment>
                  ))}
              </dl>
            </div>
          )}
          {editing && editBuf && (
            <div className="detail-section" style={{ marginTop: 16 }}>
              <h2>refs</h2>
              <label className="edit-field">
                <span>characters (csv)</span>
                <input
                  type="text"
                  value={editBuf.refsCharactersCsv}
                  placeholder="kagari, kasumi"
                  onChange={(e) =>
                    setEditBuf({
                      ...editBuf,
                      refsCharactersCsv: e.target.value,
                    })
                  }
                />
              </label>
              <label className="edit-field">
                <span>emotion</span>
                <input
                  type="text"
                  value={editBuf.refsEmotion}
                  placeholder="smile"
                  onChange={(e) =>
                    setEditBuf({ ...editBuf, refsEmotion: e.target.value })
                  }
                />
              </label>
              {asset.refs &&
                Object.keys(asset.refs).some(
                  (k) => k !== "characters" && k !== "emotion",
                ) && (
                  <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                    other refs (location/time/etc.) preserved through save;
                    edit them in spec.yaml directly.
                  </div>
                )}
            </div>
          )}

          <div className="detail-section" style={{ marginTop: 16 }}>
            <h2>description</h2>
            {!editing && (
              <div style={{ whiteSpace: "pre-wrap" }}>{asset.description}</div>
            )}
            {editing && editBuf && (
              <textarea
                className="edit-textarea-full"
                rows={6}
                value={editBuf.description}
                onChange={(e) =>
                  setEditBuf({ ...editBuf, description: e.target.value })
                }
              />
            )}
          </div>

          <div className="detail-section" style={{ marginTop: 16 }}>
            <h2>renderings</h2>
            <div className="rendering-flags">
              <span className={"flag" + (asset.renderings.tuiAns ? " present" : "")}>
                tui.ans
              </span>
              <span className={"flag" + (asset.renderings.tuiTxt ? " present" : "")}>
                tui.txt
              </span>
              <span className={"flag" + (asset.renderings.sourceQuality ? " present" : "")}>
                source.quality.png
              </span>
              <span className={"flag" + (asset.renderings.sourceCompressed ? " present" : "")}>
                source.compressed.*
              </span>
              <span className={"flag" + (asset.renderings.web ? " present" : "")}>
                web.*
              </span>
            </div>
          </div>
        </div>

        <div>
          <div className="detail-section">
            <h2 style={{ display: "flex", justifyContent: "space-between" }}>
              <span>prompt</span>
              {!editing && (
                <button className="btn primary" onClick={copyPrompt}>
                  copy
                </button>
              )}
            </h2>
            {!editing && <div className="prompt-block">{asset.prompt}</div>}
            {editing && editBuf && (
              <textarea
                className="edit-textarea-full mono"
                rows={10}
                value={editBuf.prompt}
                onChange={(e) =>
                  setEditBuf({ ...editBuf, prompt: e.target.value })
                }
              />
            )}
          </div>

          {/* source.quality.png — author's high-res master (gitignored).
              Uploadable; chafa renders TUI from here.                 */}
          <div className="detail-section" style={{ marginTop: 16 }}>
            <h2 style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span>
                source.quality.png
                {asset.sourceQualityBytes !== undefined && (
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                    {formatBytes(asset.sourceQualityBytes)}
                  </span>
                )}
              </span>
              <button
                className="btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy !== null}
              >
                {asset.renderings.sourceQuality ? "replace" : "upload"}
              </button>
            </h2>
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              author master · gitignored · local + personal backup only · chafa input
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png"
              onChange={onPickFile}
              style={{ display: "none" }}
            />
            <div
              className={
                "preview-img droppable" + (busy === "upload" ? " busy" : "")
              }
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
            >
              {asset.renderings.sourceQuality ? (
                <img
                  // Cache-bust on cacheKey so a re-upload of the same
                  // path doesn't show the stale browser-cached image.
                  src={`${sourceQualityImageUrl(asset.path)}?v=${cacheKey}`}
                  alt={asset.placeholder}
                />
              ) : (
                <div className="empty" style={{ padding: 32 }}>
                  drop a PNG here or click <em>upload</em>
                </div>
              )}
              {busy === "upload" && (
                <div className="overlay">uploading…</div>
              )}
            </div>
          </div>

          {/* source.compressed.* — distribution copy that travels with
              the repo. Read-only here for now; produced offline via
              cwebp / pngquant per skill convention.                   */}
          <div className="detail-section" style={{ marginTop: 16 }}>
            <h2 style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span>
                source.compressed.*
                {asset.sourceCompressedBytes !== undefined && (
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                    {formatBytes(asset.sourceCompressedBytes)}
                    {asset.sourceQualityBytes !== undefined && (
                      <>
                        {" · "}
                        {(
                          (asset.sourceCompressedBytes / asset.sourceQualityBytes) *
                          100
                        ).toFixed(1)}
                        % of master
                      </>
                    )}
                  </span>
                )}
              </span>
            </h2>
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              distribution copy · tracked in git · cwebp / pngquant output · web frontend input
            </div>
            <div className="preview-img">
              {asset.renderings.sourceCompressed ? (
                <img
                  src={`${sourceCompressedImageUrl(asset.path)}?v=${cacheKey}`}
                  alt={asset.placeholder + " (compressed)"}
                />
              ) : (
                <div className="empty" style={{ padding: 32 }}>
                  no compressed copy. run{" "}
                  <code>cwebp -q 80 source.quality.png -o source.compressed.webp</code>
                </div>
              )}
            </div>
          </div>

          <div className="detail-section" style={{ marginTop: 16 }}>
            <h2 style={{ display: "flex", justifyContent: "space-between" }}>
              <span>tui.txt</span>
              <button
                className="btn primary"
                onClick={handleRender}
                disabled={!canRender}
                title={
                  !asset.renderings.sourceQuality
                    ? "upload source.quality.png first"
                    : !chafaPresent
                      ? "chafa not installed — brew install chafa"
                      : busy === "render"
                        ? "rendering…"
                        : "run chafa to regenerate"
                }
              >
                {busy === "render"
                  ? "rendering…"
                  : asset.renderings.tuiTxt
                    ? "re-render"
                    : "render (chafa)"}
              </button>
            </h2>
            {!chafaPresent && (
              <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                chafa not detected on PATH. Install with{" "}
                <code>brew install chafa</code> (macOS) and restart studio.
              </div>
            )}

            <details className="render-opts" open>
              <summary>render options</summary>

              <div className="render-opts-grid">
                <label>
                  <span>symbols</span>
                  <select
                    value={symbols}
                    onChange={(e) =>
                      setSymbols(e.target.value as SymbolSet | "")
                    }
                  >
                    <option value="">(default: block)</option>
                    {SYMBOL_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="opt-hint">
                  {symbols === ""
                    ? SYMBOL_OPTIONS[0]!.hint
                    : SYMBOL_OPTIONS.find((o) => o.value === symbols)?.hint}
                </div>

                <label>
                  <span>colors</span>
                  <select
                    value={colors}
                    onChange={(e) =>
                      setColors(e.target.value as ColorMode | "")
                    }
                  >
                    <option value="">(default: none — mono)</option>
                    {COLOR_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="opt-hint">
                  {colors === ""
                    ? COLOR_OPTIONS[0]!.hint
                    : COLOR_OPTIONS.find((o) => o.value === colors)?.hint}
                </div>

                <label>
                  <span>dither</span>
                  <select
                    value={dither}
                    onChange={(e) =>
                      setDither(e.target.value as DitherMode | "")
                    }
                  >
                    <option value="">(default: none)</option>
                    {DITHER_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="opt-hint">
                  {dither === ""
                    ? DITHER_OPTIONS[0]!.hint
                    : DITHER_OPTIONS.find((o) => o.value === dither)?.hint}
                </div>

                <label className="size-toggle">
                  <span>
                    <input
                      type="checkbox"
                      checked={overrideSize}
                      onChange={(e) => {
                        setOverrideSize(e.target.checked);
                        if (e.target.checked && cols === "" && rows === "") {
                          // Seed from spec hint when toggling on, so
                          // tweaking is editing-not-typing-from-scratch.
                          setCols(
                            asset.sizeHint?.tui?.cols
                              ? String(asset.sizeHint.tui.cols)
                              : "",
                          );
                          setRows(
                            asset.sizeHint?.tui?.rows
                              ? String(asset.sizeHint.tui.rows)
                              : "",
                          );
                        }
                      }}
                    />{" "}
                    override size
                  </span>
                  {overrideSize && (
                    <span className="size-inputs">
                      <input
                        type="number"
                        min={1}
                        max={500}
                        value={cols}
                        onChange={(e) => setCols(e.target.value)}
                        placeholder="cols"
                      />
                      <span>×</span>
                      <input
                        type="number"
                        min={1}
                        max={500}
                        value={rows}
                        onChange={(e) => setRows(e.target.value)}
                        placeholder="rows"
                      />
                    </span>
                  )}
                </label>
                <div className="opt-hint">
                  {overrideSize
                    ? "Bigger = more detail but eats stage area. Portraits: 40×24 ≈ half-screen. BGs: 80×30 ≈ full-stage."
                    : asset.sizeHint?.tui
                      ? `Using spec hint: ${asset.sizeHint.tui.cols}×${asset.sizeHint.tui.rows}. Tick to override per-render.`
                      : "No spec hint set. chafa will pick its own (terminal-sized — likely too big to commit). Tick to set explicitly."}
                </div>
              </div>

              <div className="render-opts-tip">
                <strong>Quick recipe:</strong> portraits →{" "}
                <code>sextant</code> + <code>256</code> +{" "}
                <code>diffusion</code>; bg / scenery →{" "}
                <code>sextant</code> + <code>full</code> +{" "}
                <code>ordered</code>; line-art or logos →{" "}
                <code>quad</code> + <code>none</code> +{" "}
                <code>none</code>.
              </div>
            </details>

            {tuiPreview ? (
              tuiPreview.kind === "ans" && previewHtml ? (
                // dangerouslySetInnerHTML is the standard idiom for
                // injecting a controlled HTML string into React; the
                // input is generated by ansi-to-html with escapeXML on,
                // so chafa output can't smuggle <script> through.
                <div
                  className="tui-preview ansi"
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              ) : (
                <div className="tui-preview">{tuiPreview.content}</div>
              )
            ) : (
              <div className="empty" style={{ padding: 16 }}>
                no tui rendering yet
              </div>
            )}
            {tuiPreview && (
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                showing <code>{tuiPreview.kind === "ans" ? "tui.ans" : "tui.txt"}</code>
                {asset.renderings.tuiAns && asset.renderings.tuiTxt
                  ? " (both .ans and .txt exist on disk; .ans wins)"
                  : ""}
              </div>
            )}
          </div>
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </Layout>
  );
}

function Layout({
  children,
  backTo,
}: {
  children: React.ReactNode;
  backTo: string;
}) {
  return (
    <div className="asset-detail-page">
      <Link to={backTo} className="back-link">
        <span>‹</span> Asset Library
      </Link>
      {children}
    </div>
  );
}

function showToast(
  setToast: (s: string | null) => void,
  msg: string,
): void {
  setToast(msg);
  setTimeout(() => setToast(null), 1800);
}
