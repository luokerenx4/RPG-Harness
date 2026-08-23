import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  Condition,
  MapDef,
  MapEventTrigger,
  MapPlacementEventDef,
  MapPlacementDef,
  MapLayoutDef,
  ProjectResourceKind,
  ProjectResourceNode,
  SwitchDef,
  VariableDef,
} from "@rpg-harness/engine";
import {
  fetchProject,
  fetchMapPreview,
  fetchResourceSource,
  saveMapSpatial,
  saveResourceSource,
  type ProjectResponse,
  type MapPreviewResponse,
} from "../api";

const KIND_ORDER: ProjectResourceKind[] = [
  "manifest",
  "map",
  "character",
  "item",
  "weapon",
  "skill",
  "enemy",
  "action",
  "script",
  "asset",
  "module",
  "test",
  "issue",
  "custom",
];

type ProjectSection = "world" | "database" | "story" | "qa";

const SECTION_KINDS: Record<ProjectSection, ProjectResourceKind[]> = {
  world: ["manifest", "map"],
  database: ["character", "item", "weapon", "skill", "enemy", "action"],
  story: ["script", "asset", "module", "custom"],
  qa: ["test", "issue"],
};

const SECTION_META: Array<{ id: ProjectSection; icon: string; label: string }> = [
  { id: "world", icon: "▦", label: "World" },
  { id: "database", icon: "◫", label: "Database" },
  { id: "story", icon: "¶", label: "Story" },
  { id: "qa", icon: "✓", label: "QA" },
];

const KIND_META: Partial<Record<ProjectResourceKind, { icon: string; label: string }>> = {
  manifest: { icon: "◆", label: "Project" },
  map: { icon: "▦", label: "Maps" },
  character: { icon: "♙", label: "Characters" },
  item: { icon: "◇", label: "Items" },
  weapon: { icon: "†", label: "Weapons" },
  skill: { icon: "✦", label: "Skills" },
  enemy: { icon: "♞", label: "Enemies" },
  action: { icon: "▶", label: "Actions" },
  script: { icon: "¶", label: "Scripts" },
  asset: { icon: "▧", label: "Assets" },
  module: { icon: "⬡", label: "Modules" },
  test: { icon: "✓", label: "Tests" },
  issue: { icon: "!", label: "Issues" },
  custom: { icon: "＋", label: "Custom" },
};

const PLACEABLE_KINDS = new Set<ProjectResourceKind>([
  "map",
  "character",
  "item",
  "weapon",
  "skill",
  "enemy",
  "action",
  "script",
  "asset",
  "module",
  "custom",
]);

export function Project() {
  const [project, setProject] = useState<ProjectResponse | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [openKeys, setOpenKeys] = useState<string[]>([]);
  const [section, setSection] = useState<ProjectSection>("world");
  const [collapsedKinds, setCollapsedKinds] = useState<Set<ProjectResourceKind>>(
    () => new Set(["manifest"]),
  );
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    fetchProject()
      .then((value) => {
        setProject(value);
        const initial = value.graph.resources.find((resource) => resource.kind === "map")?.key ??
          value.graph.resources[0]?.key ?? null;
        setSelectedKey(initial);
        setOpenKeys(initial ? [initial] : []);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
      if (event.key === "Escape" && document.activeElement === searchRef.current) {
        setQuery("");
        searchRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const groups = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const allowedKinds = new Set(SECTION_KINDS[section]);
    const resources = (project?.graph.resources ?? []).filter((resource) => {
      const matches = normalized.length === 0 ||
        resource.key.toLowerCase().includes(normalized) ||
        resource.label.toLowerCase().includes(normalized);
      return matches && (normalized.length > 0 || allowedKinds.has(resource.kind));
    });
    return KIND_ORDER.flatMap((kind) => {
      const rows = resources.filter((resource) => resource.kind === kind);
      return rows.length > 0 ? [{ kind, rows }] : [];
    });
  }, [project, query, section]);

  if (error) return <div className="empty">⚠ {error}</div>;
  if (!project) return <div className="empty">loading project…</div>;

  const selected = project.graph.resources.find((row) => row.key === selectedKey);
  const map = selected?.kind === "map"
    ? project.maps.find((candidate) => candidate.id === selected.id)
    : undefined;

  const selectResource = (key: string) => {
    setSelectedKey(key);
    setOpenKeys((current) => current.includes(key) ? current : [...current.slice(-6), key]);
  };

  const closeTab = (key: string) => {
    setOpenKeys((current) => {
      const next = current.filter((candidate) => candidate !== key);
      if (selectedKey === key) setSelectedKey(next.at(-1) ?? null);
      return next;
    });
  };

  return (
    <div className="project-workbench">
      <nav className="project-activitybar" aria-label="Project sections">
        {SECTION_META.map((item) => (
          <button
            type="button"
            className={section === item.id && !query ? "active" : ""}
            key={item.id}
            title={item.label}
            aria-label={item.label}
            onClick={() => { setSection(item.id); setQuery(""); }}
          ><span>{item.icon}</span><small>{item.label}</small></button>
        ))}
      </nav>

      <aside className="project-explorer">
        <header className="explorer-heading">
          <div><span>PROJECT</span><strong>{SECTION_META.find((item) => item.id === section)?.label}</strong></div>
          <small>{project.graph.resources.length}</small>
        </header>
        <label className="project-searchbox">
          <span aria-hidden="true">⌕</span>
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find anything"
            aria-label="Search project resources"
          />
          {query ? <button type="button" aria-label="Clear search" onClick={() => setQuery("")}>×</button> : <kbd>⌘K</kbd>}
        </label>
        <div className="resource-tree-scroll">
          {groups.length === 0 && <div className="tree-empty">No matching resources</div>}
          {groups.map(({ kind, rows }) => {
            const meta = KIND_META[kind] ?? { icon: "·", label: kind };
            const collapsed = query.length === 0 && collapsedKinds.has(kind);
            return (
              <section className="resource-group" key={kind}>
                <button
                  type="button"
                  className="resource-group-heading"
                  aria-expanded={!collapsed}
                  onClick={() => setCollapsedKinds((current) => {
                    const next = new Set(current);
                    next.has(kind) ? next.delete(kind) : next.add(kind);
                    return next;
                  })}
                >
                  <span className="tree-chevron">{collapsed ? "›" : "⌄"}</span>
                  <span className="tree-kind-icon">{meta.icon}</span>
                  <strong>{meta.label}</strong>
                  <small>{rows.length}</small>
                </button>
                {!collapsed && rows.map((resource) => (
                  <button
                    type="button"
                    draggable={PLACEABLE_KINDS.has(resource.kind)}
                    className={`resource-row ${selectedKey === resource.key ? "selected" : ""}`}
                    key={resource.key}
                    onClick={() => selectResource(resource.key)}
                    onDragStart={(event) => {
                      if (!PLACEABLE_KINDS.has(resource.kind)) {
                        event.preventDefault();
                        return;
                      }
                      event.dataTransfer.setData("application/x-autogal-resource", resource.key);
                      event.dataTransfer.effectAllowed = "copy";
                    }}
                  >
                    <span className="resource-node-icon">{meta.icon}</span>
                    <span className="resource-node-copy"><strong>{resource.label}</strong><small>{resource.id}</small></span>
                    {project.graph.missing.some((entry) => entry.referencedBy.includes(resource.key)) && <i className="resource-problem" title="Missing reference">!</i>}
                  </button>
                ))}
              </section>
            );
          })}
        </div>
        <footer className="explorer-footer">
          <span>{groups.reduce((total, group) => total + group.rows.length, 0)} shown</span>
          <span>Drag resources onto maps</span>
        </footer>
      </aside>

      <section className="project-editor-shell">
        <nav className="document-tabs" aria-label="Open resources">
          {openKeys.map((key) => {
            const resource = project.graph.resources.find((candidate) => candidate.key === key);
            if (!resource) return null;
            const meta = KIND_META[resource.kind] ?? { icon: "·", label: resource.kind };
            return (
              <div className={`document-tab ${selectedKey === key ? "active" : ""}`} key={key}>
                <button type="button" onClick={() => setSelectedKey(key)}>
                  <span>{meta.icon}</span><strong>{resource.label}</strong>
                </button>
                <button type="button" className="document-tab-close" aria-label={`Close ${resource.label}`} onClick={() => closeTab(key)}>×</button>
              </div>
            );
          })}
          <span className="document-tabs-fill" />
        </nav>
        <div className="project-detail">
          {selected ? (
            <ResourceDetail
              node={selected}
              map={map}
              resources={project.graph.resources}
              switches={project.switches}
              variables={project.variables}
              backlinks={project.graph.backlinks[selected.key] ?? []}
              missing={project.graph.missing.filter((entry) => entry.referencedBy.includes(selected.key))}
              unreferenced={project.graph.unreferenced.includes(selected.key)}
              onProjectSaved={setProject}
            />
          ) : (
            <div className="editor-empty"><span>▦</span><strong>No resource open</strong><p>Select something in the Project tree.</p></div>
          )}
        </div>
      </section>
    </div>
  );
}

function ResourceDetail({
  node,
  map,
  resources,
  switches,
  variables,
  backlinks,
  missing,
  unreferenced,
  onProjectSaved,
}: {
  node: ProjectResourceNode;
  map?: MapDef;
  resources: ProjectResourceNode[];
  switches: SwitchDef[];
  variables: VariableDef[];
  backlinks: string[];
  missing: Array<{ key: string; referencedBy: string[] }>;
  unreferenced: boolean;
  onProjectSaved: (project: ProjectResponse) => void;
}) {
  const meta = KIND_META[node.kind] ?? { icon: "·", label: node.kind };
  const [sourceEditKey, setSourceEditKey] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  return (
    <div className={`resource-workspace${inspectorOpen ? "" : " inspector-collapsed"}`}>
      <main className="resource-editor-pane">
        <header className="resource-editor-heading">
          <div className={`resource-editor-icon kind-${node.kind}`}>{meta.icon}</div>
          <div><span>{meta.label}</span><h1>{node.label}</h1><code>{node.key}</code></div>
          <button
            type="button"
            className="editor-inspector-toggle"
            aria-pressed={inspectorOpen}
            onClick={() => setInspectorOpen((current) => !current)}
          ><span aria-hidden="true">◫</span>{inspectorOpen ? "Hide Inspector" : "Show Inspector"}</button>
        </header>
        {map ? (
          <MapOverview map={map} resources={resources} switches={switches} variables={variables} onProjectSaved={onProjectSaved} />
        ) : (
          <ResourceRecordEditor
            node={node}
            icon={meta.icon}
            kindLabel={meta.label}
            onProjectSaved={onProjectSaved}
            onEditSource={node.source && node.editable !== false
              ? () => setSourceEditKey(node.key)
              : undefined}
          />
        )}
      </main>

      <aside className="resource-inspector">
        <header><span>INSPECTOR</span><strong>{meta.label}</strong></header>
        <section className="inspector-section">
          <h2>Identity</h2>
          <dl className="inspector-properties">
            <div><dt>Kind</dt><dd><span className={`kind-badge ${node.kind}`}>{node.kind}</span></dd></div>
            <div><dt>ID</dt><dd><code>{node.id}</code></dd></div>
            {node.source && <div><dt>Source</dt><dd><code>{node.source}</code></dd></div>}
          </dl>
        </section>
        {node.source && node.editable !== false && (
          <ResourceSourceEditor
            node={node}
            onProjectSaved={onProjectSaved}
            openRequested={sourceEditKey === node.key}
            onOpenHandled={() => setSourceEditKey(null)}
          />
        )}
        {missing.length > 0 && (
          <section className="project-warning">
            <strong>Missing references</strong>
            {missing.map((entry) => <code key={entry.key}>{entry.key}</code>)}
          </section>
        )}
        {unreferenced && (
          <section className="project-warning advisory">
            <strong>Unreferenced candidate</strong>
            <span>Nothing in the registry points here. Roots and module-discovered resources may be intentional.</span>
          </section>
        )}
        <ReferenceList title="References" values={node.refs} />
        <ReferenceList title="Used by" values={backlinks} />
      </aside>
    </div>
  );
}

function ResourceRecordEditor({
  node,
  icon,
  kindLabel,
  onProjectSaved,
  onEditSource,
}: {
  node: ProjectResourceNode;
  icon: string;
  kindLabel: string;
  onProjectSaved: (project: ProjectResponse) => void;
  onEditSource?: () => void;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});

  useEffect(() => {
    let cancelled = false;
    setSource(null);
    setError(null);
    setEditing(false);
    setDraft({});
    if (!node.source) return () => { cancelled = true; };
    void fetchResourceSource(node.kind, node.id)
      .then((result) => {
        if (!cancelled) setSource(result.source);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, [node]);

  const summary = useMemo(() => source ? summarizeResourceSource(source) : null, [source]);
  const fields = useMemo(() => source ? parseResourceScalarFields(source) : [], [source]);
  const editableFields = fields.filter((field) => field.editable);
  const dirty = editableFields.some((field) => draft[field.key] !== field.value);
  const invalid = editableFields.some((field) =>
    field.kind === "number" && !Number.isFinite(Number(draft[field.key])),
  );

  const beginRecordEdit = () => {
    setDraft(Object.fromEntries(editableFields.map((field) => [field.key, field.value])));
    setError(null);
    setEditing(true);
  };

  const saveRecord = async () => {
    if (!source || !dirty || invalid) return;
    setSaving(true);
    setError(null);
    try {
      const nextSource = patchResourceScalarFields(source, draft);
      const result = await saveResourceSource(node.kind, node.id, nextSource);
      setSource(result.source);
      setEditing(false);
      setDraft({});
      onProjectSaved(result.project);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        setEditing(false);
        setError(null);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!saving && dirty && !invalid) void saveRecord();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing, saving, dirty, invalid, source, draft]);

  return (
    <section className="resource-record-editor">
      <header className="record-toolbar">
        <div><span>DATABASE RECORD</span><strong>{singularResourceLabel(kindLabel)}</strong></div>
        <div className="record-toolbar-actions">
          <code>{node.source ?? "virtual resource"}</code>
          {editing ? (
            <>
              <span className="record-dirty-state">{dirty ? "UNSAVED" : "EDITING"}</span>
              <button type="button" className="primary" disabled={!dirty || invalid || saving} onClick={() => void saveRecord()}>
                {saving ? "Validating…" : "Save changes  ⌘S"}
              </button>
              <button type="button" disabled={saving} onClick={() => { setEditing(false); setError(null); }}>Cancel</button>
            </>
          ) : (
            <>
              {editableFields.length > 0 && <button type="button" className="primary" onClick={beginRecordEdit}>Edit record</button>}
              {onEditSource && <button type="button" onClick={onEditSource}>Source</button>}
            </>
          )}
        </div>
      </header>
      <div className="record-hero">
        <div className="record-hero-icon">{icon}</div>
        <div><span>{node.kind}</span><h2>{node.label}</h2><code>{node.id}</code></div>
        <span className="record-authority"><i /> AUTHORITATIVE</span>
      </div>
      {!node.source ? (
        <div className="record-message"><strong>Virtual resource</strong><span>This record is provided by project code and has no standalone source document.</span></div>
      ) : error ? (
        <div className="record-message error"><strong>Source preview unavailable</strong><span>{error}</span></div>
      ) : !summary ? (
        <div className="record-loading"><i /><span>Reading source record…</span></div>
      ) : (
        <div className="record-body">
          {error && <div className="record-save-error" role="alert"><strong>Changes rejected</strong><span>{error}</span></div>}
          <section className="record-section">
            <header><span>FIELDS</span><small>{fields.length} · {editableFields.length} editable</small></header>
            {fields.length > 0 ? (
              <div className={`record-properties${editing ? " is-editing" : ""}`}>
                {fields.map((field) => field.editable && editing ? (
                  <label className="record-property-field" key={field.key}>
                    <span>{field.key}</span>
                    {field.kind === "boolean" ? (
                      <select
                        value={String(draft[field.key])}
                        onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value === "true" }))}
                      ><option value="true">true</option><option value="false">false</option></select>
                    ) : (
                      <input
                        type={field.kind === "number" ? "number" : "text"}
                        value={String(draft[field.key] ?? "")}
                        aria-invalid={field.kind === "number" && !Number.isFinite(Number(draft[field.key]))}
                        onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))}
                      />
                    )}
                  </label>
                ) : (
                  <div className={!field.editable ? "record-property-locked" : ""} key={field.key}>
                    <dt>{field.key}{!field.editable && <span title="Edit this structured value in source">◇</span>}</dt>
                    <dd>{field.displayValue}</dd>
                  </div>
                ))}
              </div>
            ) : <p className="record-empty">No top-level fields detected.</p>}
          </section>
          {(summary.sections.length > 0 || summary.excerpt) && (
            <section className="record-section record-document">
              <header><span>DOCUMENT</span><small>{summary.sections.length} sections</small></header>
              {summary.sections.length > 0 && (
                <div className="record-outline">
                  {summary.sections.map((section) => <span key={section}>{section}</span>)}
                </div>
              )}
              {summary.excerpt && <p>{summary.excerpt}</p>}
            </section>
          )}
          {node.refs.length > 0 && (
            <section className="record-section">
              <header><span>LINKED RESOURCES</span><small>{node.refs.length}</small></header>
              <div className="record-links">{node.refs.map((ref) => <code key={ref}>{ref}</code>)}</div>
            </section>
          )}
        </div>
      )}
    </section>
  );
}

type ResourceScalarField = {
  key: string;
  kind: "text" | "number" | "boolean" | "complex";
  value: string | boolean;
  displayValue: string;
  editable: boolean;
};

export function parseResourceScalarFields(source: string): ResourceScalarField[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const { start, end } = sourceMetadataRange(lines);
  const fields: ResourceScalarField[] = [];
  for (const line of lines.slice(start, end)) {
    const match = line.match(/^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/);
    if (!match?.[1]) continue;
    const key = match[1];
    const scalar = splitInlineYamlComment((match[2] ?? "").trim()).value;
    const complex = scalar.length === 0 || /^[\[{|>]/.test(scalar);
    if (complex) {
      fields.push({ key, kind: "complex", value: scalar, displayValue: scalar || "{…}", editable: false });
      continue;
    }
    if (scalar === "true" || scalar === "false") {
      const value = scalar === "true";
      fields.push({ key, kind: "boolean", value, displayValue: String(value), editable: key !== "id" });
      continue;
    }
    if (/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(scalar)) {
      fields.push({ key, kind: "number", value: scalar, displayValue: scalar, editable: key !== "id" });
      continue;
    }
    const value = cleanSourceValue(scalar);
    fields.push({ key, kind: "text", value, displayValue: value, editable: key !== "id" });
  }
  return fields.slice(0, 24);
}

export function patchResourceScalarFields(
  source: string,
  values: Record<string, string | boolean>,
): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const { start, end } = sourceMetadataRange(lines);
  const fields = new Map(parseResourceScalarFields(source).map((field) => [field.key, field]));
  const next = lines.map((line, index) => {
    if (index < start || index >= end) return line;
    const match = line.match(/^([A-Za-z0-9_.-]+):(\s*)(.*)$/);
    const key = match?.[1];
    if (!key || !Object.prototype.hasOwnProperty.call(values, key)) return line;
    const field = fields.get(key);
    if (!field?.editable) return line;
    const suffix = splitInlineYamlComment(match[3] ?? "");
    const serialized = serializeResourceScalar(values[key]!, field.kind, suffix.value.trim());
    return `${key}:${match[2] || " "}${serialized}${suffix.comment ? ` ${suffix.comment}` : ""}`;
  });
  return next.join(newline);
}

function sourceMetadataRange(lines: string[]): { start: number; end: number } {
  if (lines[0]?.trim() !== "---") return { start: 0, end: lines.length };
  const closing = lines.slice(1).findIndex((line) => line.trim() === "---");
  return { start: 1, end: closing >= 0 ? closing + 1 : lines.length };
}

function splitInlineYamlComment(raw: string): { value: string; comment: string } {
  let quote: "\"" | "'" | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if ((char === "\"" || char === "'") && raw[index - 1] !== "\\") {
      quote = quote === char ? null : quote ?? char;
      continue;
    }
    if (char === "#" && quote === null && (index === 0 || /\s/.test(raw[index - 1] ?? ""))) {
      return { value: raw.slice(0, index).trimEnd(), comment: raw.slice(index).trim() };
    }
  }
  return { value: raw.trimEnd(), comment: "" };
}

function serializeResourceScalar(
  value: string | boolean,
  kind: ResourceScalarField["kind"],
  original: string,
): string {
  if (kind === "boolean") return String(value === true || value === "true");
  if (kind === "number") return String(Number(value));
  const text = String(value);
  if (original.startsWith("'") && original.endsWith("'")) return `'${text.replace(/'/g, "''")}'`;
  if (original.startsWith('"') && original.endsWith('"')) return JSON.stringify(text);
  if (isSafePlainYamlScalar(text)) return text;
  return JSON.stringify(text);
}

function isSafePlainYamlScalar(value: string): boolean {
  return value.length > 0 &&
    value.trim() === value &&
    !/^(?:true|false|null|~|[-+]?(?:\d+\.?\d*|\.\d+))$/i.test(value) &&
    !/^[\-?:,\[\]{}#&*!|>'"%@`]/.test(value) &&
    !/[:#]\s/.test(value);
}

function summarizeResourceSource(source: string): {
  properties: Array<{ key: string; value: string }>;
  sections: string[];
  excerpt: string;
} {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let metadata = lines;
  let body = lines;
  let hasFrontmatter = false;
  if (lines[0]?.trim() === "---") {
    const end = lines.slice(1).findIndex((line) => line.trim() === "---");
    if (end >= 0) {
      hasFrontmatter = true;
      metadata = lines.slice(1, end + 1);
      body = lines.slice(end + 2);
    }
  }
  const properties = metadata.flatMap((line) => {
    const match = line.match(/^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/);
    if (!match?.[1]) return [];
    const value = (match[2] ?? "").trim();
    return [{ key: match[1], value: cleanSourceValue(value || "{…}") }];
  }).slice(0, 16);
  const documentLines = hasFrontmatter ? body : [];
  const sections = documentLines.flatMap((line) => {
    const match = line.match(/^#{1,4}\s+(.+)$/);
    return match?.[1] ? [match[1].trim()] : [];
  }).slice(0, 8);
  const excerpt = documentLines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("@") && !line.startsWith("[") && !line.startsWith(":"))
    .join(" ")
    .replace(/[*_`]/g, "")
    .slice(0, 420);
  return { properties, sections, excerpt };
}

function singularResourceLabel(label: string): string {
  if (label.endsWith("ies")) return `${label.slice(0, -3)}y`;
  if (label.endsWith("s")) return label.slice(0, -1);
  return label;
}

function cleanSourceValue(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function ResourceSourceEditor({
  node,
  onProjectSaved,
  openRequested = false,
  onOpenHandled,
}: {
  node: ProjectResourceNode;
  onProjectSaved: (project: ProjectResponse) => void;
  openRequested?: boolean;
  onOpenHandled?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [source, setSource] = useState("");
  const [sourcePath, setSourcePath] = useState(node.source ?? "");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEditing(false);
    setSource("");
    setSourcePath(node.source ?? "");
    setError(null);
  }, [node.key, node.source]);

  const begin = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchResourceSource(node.kind, node.id);
      setSource(result.source);
      setSourcePath(result.path);
      setEditing(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!openRequested || editing || loading) return;
    onOpenHandled?.();
    void begin();
  }, [openRequested]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await saveResourceSource(node.kind, node.id, source);
      setSource(result.source);
      setSourcePath(result.path);
      onProjectSaved(result.project);
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        setEditing(false);
        setError(null);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!saving) void save();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing, saving, source]);

  return (
    <>
    {editing && (
      <button
        type="button"
        className="source-editor-backdrop"
        aria-label="Close source editor"
        onClick={() => {
          if (saving) return;
          setEditing(false);
          setError(null);
        }}
      />
    )}
    <section className={`detail-section resource-source-editor ${editing ? "is-editing" : ""}`}>
      <header>
        <div><h2>Source file</h2><code>{sourcePath}</code></div>
        {!editing ? (
          <button type="button" disabled={loading} onClick={begin}>
            {loading ? "Loading…" : "Edit source"}
          </button>
        ) : (
          <div>
            <button type="button" className="primary" disabled={saving} onClick={save}>
              {saving ? "Validating…" : "Save & validate  ⌘S"}
            </button>
            <button type="button" disabled={saving} onClick={() => {
              setEditing(false);
              setError(null);
            }}>Cancel  Esc</button>
          </div>
        )}
      </header>
      <p className="muted">YAML/Markdown remains the source of truth. Invalid edits are rolled back atomically.</p>
      {error && <div className="project-warning"><strong>Source rejected</strong><code>{error}</code></div>}
      {editing && (
        <textarea
          className="project-source-textarea"
          value={source}
          onChange={(event) => setSource(event.target.value)}
          spellCheck={false}
          aria-label={`${node.label} source`}
        />
      )}
    </section>
    </>
  );
}

function ReferenceList({ title, values }: { title: string; values: string[] }) {
  return (
    <section className="detail-section reference-list">
      <h2>{title} · {values.length}</h2>
      {values.length === 0
        ? <span className="muted">none</span>
        : values.map((value) => <code key={value}>{value}</code>)}
    </section>
  );
}

function MapOverview({
  map,
  resources,
  switches,
  variables,
  onProjectSaved,
}: {
  map: MapDef;
  resources: ProjectResourceNode[];
  switches: SwitchDef[];
  variables: VariableDef[];
  onProjectSaved: (project: ProjectResponse) => void;
}) {
  const [draft, setDraft] = useState<MapDef>(() => cloneMap(map));
  const [editing, setEditing] = useState(false);
  const [selectedPlacementId, setSelectedPlacementId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [zoom, setZoom] = useState(100);

  useEffect(() => {
    setDraft(cloneMap(map));
    setEditing(false);
    setSelectedPlacementId(null);
    setSaveError(null);
    setConfirmDiscard(false);
    setZoom(100);
  }, [map]);

  const width = draft.layout?.width ?? 1;
  const height = draft.layout?.height ?? 1;
  const selectedPlacement = draft.placements?.find(
    (placement) => placement.id === selectedPlacementId,
  );
  const stacks = groupedStacks(draft.placements ?? []);
  const dirty = hasMapDraftChanges(map, draft);

  const mutatePlacement = (
    id: string,
    update: (placement: MapPlacementDef) => MapPlacementDef,
  ) => {
    setDraft((current) => ({
      ...current,
      placements: (current.placements ?? []).map((placement) =>
        placement.id === id ? update(placement) : placement
      ),
    }));
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const project = await saveMapSpatial(draft);
      onProjectSaved(project);
      const saved = project.maps.find((candidate) => candidate.id === map.id);
      if (saved) setDraft(cloneMap(saved));
      setEditing(false);
      setConfirmDiscard(false);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setDraft(cloneMap(map));
    setEditing(false);
    setSelectedPlacementId(null);
    setSaveError(null);
    setConfirmDiscard(false);
  };

  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (dirty && !saving) void save();
        return;
      }
      if (event.key !== "Escape" || saving) return;
      event.preventDefault();
      if (selectedPlacementId) {
        setSelectedPlacementId(null);
      } else if (dirty) {
        setConfirmDiscard(true);
      } else {
        setEditing(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing, dirty, saving, selectedPlacementId, draft]);

  useEffect(() => {
    if (!editing || !dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [editing, dirty]);

  return (
    <section className="map-overview">
      <div className="map-editor-toolbar">
        <div className="map-editor-context">
          <span className={`edit-state ${editing ? "editing" : ""}`}>{editing ? "EDITING" : "PREVIEW"}</span>
          {editing && <span className={`map-save-state ${dirty ? "dirty" : "clean"}`}><i />{dirty ? "UNSAVED CHANGES" : "ALL CHANGES SAVED"}</span>}
          <p>{map.description || "No map description authored."}</p>
        </div>
        <div className="map-view-tools" aria-label="Map view tools">
          <button type="button" className={showGrid ? "active" : ""} onClick={() => setShowGrid((value) => !value)} title="Toggle grid">#</button>
          <span className="toolbar-separator" />
          <button type="button" onClick={() => setZoom((value) => Math.max(60, value - 20))} aria-label="Zoom out">−</button>
          <output>{zoom}%</output>
          <button type="button" onClick={() => setZoom((value) => Math.min(180, value + 20))} aria-label="Zoom in">＋</button>
        </div>
        <div className="map-stats">
          <span>{draft.layout ? `${width} × ${height}` : "node map"}</span>
          <span>{draft.layout?.layers.length ?? 0} layers</span>
          <span>{draft.placements?.length ?? 0} placements</span>
          {stacks.length > 0 && <span className="stat-attention">{stacks.length} stacks</span>}
        </div>
        <div className="map-editor-actions">
          {!editing ? (
            <button type="button" onClick={() => { setEditing(true); setConfirmDiscard(false); }}>Edit map</button>
          ) : (
            <>
              <button type="button" className="primary" disabled={!dirty || saving} onClick={save}>
                {saving ? "Validating…" : "Save changes  ⌘S"}
              </button>
              <button type="button" disabled={saving} onClick={() => {
                if (!dirty) {
                  discard();
                  return;
                }
                setSelectedPlacementId(null);
                setConfirmDiscard(true);
              }}>Discard</button>
            </>
          )}
        </div>
      </div>
      {confirmDiscard && (
        <section className="map-discard-confirmation" role="alertdialog" aria-labelledby="discard-map-title">
          <div><span>UNSAVED MAP DRAFT</span><strong id="discard-map-title">Discard spatial changes?</strong><p>Layout, placement, and event-page edits made since the last save will be lost.</p></div>
          <div><button type="button" className="danger" onClick={discard}>Discard changes</button><button type="button" className="primary" onClick={() => setConfirmDiscard(false)}>Keep editing</button></div>
        </section>
      )}
      {saveError && <div className="project-warning"><strong>Validation failed</strong><code>{saveError}</code></div>}
      {editing && !draft.layout && (
        <button
          type="button"
          className="create-layout"
          onClick={() => setDraft((current) => ({
            ...current,
            layout: {
              width: 12,
              height: 8,
              tileWidth: 32,
              tileHeight: 32,
              layers: [{ id: "objects", kind: "object", z: 0, visible: true }],
              regions: [],
            },
          }))}
        >Add 12 × 8 spatial layout</button>
      )}
      {editing && draft.layout && (
        <details className="map-authoring-panels">
          <summary><span>Map setup</span><small>size, player start, layers and regions</small></summary>
          <div className="layout-fields">
          <label>Width<input type="number" min="1" value={draft.layout.width} onChange={(event) => setDraft((current) => ({
            ...current,
            layout: current.layout ? { ...current.layout, width: Number(event.target.value) } : undefined,
          }))} /></label>
          <label>Height<input type="number" min="1" value={draft.layout.height} onChange={(event) => setDraft((current) => ({
            ...current,
            layout: current.layout ? { ...current.layout, height: Number(event.target.value) } : undefined,
          }))} /></label>
          <label>Start X<input type="number" min="0" value={draft.layout.playerStart?.x ?? 0} onChange={(event) => setDraft((current) => ({
            ...current,
            layout: current.layout ? {
              ...current.layout,
              playerStart: { x: Number(event.target.value), y: current.layout.playerStart?.y ?? 0 },
            } : undefined,
          }))} /></label>
          <label>Start Y<input type="number" min="0" value={draft.layout.playerStart?.y ?? 0} onChange={(event) => setDraft((current) => ({
            ...current,
            layout: current.layout ? {
              ...current.layout,
              playerStart: { x: current.layout.playerStart?.x ?? 0, y: Number(event.target.value) },
            } : undefined,
          }))} /></label>
          <span>Drag any resource from the project tree onto the canvas.</span>
        </div>
          <MapStructureEditor
            layout={draft.layout}
            onChange={(layout) => setDraft((current) => ({ ...current, layout }))}
          />
        </details>
      )}
      <div className="map-stage">
        {draft.layout && (draft.placements ?? []).length > 0 && (
          <div className="map-object-strip" aria-label="Map objects">
            <span>OBJECTS</span>
            {(draft.placements ?? []).map((placement) => (
              <button
                type="button"
                className={selectedPlacementId === placement.id ? "selected" : ""}
                key={placement.id}
                onClick={() => setSelectedPlacementId(placement.id)}
              ><i className={`object-dot collision-${placement.collision}`} />{placement.id}<small>{placement.at.x},{placement.at.y}</small></button>
            ))}
          </div>
        )}
        <div className="map-canvas-scroll">
      {draft.layout ? (
        <div
          className={`map-canvas ${editing ? "editing" : ""} ${showGrid ? "" : "grid-hidden"}`}
          style={{
            aspectRatio: `${width} / ${height}`,
            width: `${zoom}%`,
            "--map-cols": width,
            "--map-rows": height,
          } as React.CSSProperties}
          aria-label={`${map.name} spatial preview`}
          onClick={() => setSelectedPlacementId(null)}
          onDragOver={(event) => {
            if (!editing) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = event.dataTransfer.types.includes("application/x-autogal-placement") ? "move" : "copy";
          }}
          onDrop={(event) => {
            if (!editing) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const x = clamp(Math.floor((event.clientX - rect.left) / rect.width * width), 0, width - 1);
            const y = clamp(Math.floor((event.clientY - rect.top) / rect.height * height), 0, height - 1);
            const placementId = event.dataTransfer.getData("application/x-autogal-placement");
            if (placementId) {
              mutatePlacement(placementId, (placement) => ({ ...placement, at: { x, y } }));
              setSelectedPlacementId(placementId);
              return;
            }
            const resourceKey = event.dataTransfer.getData("application/x-autogal-resource");
            const resource = resources.find((candidate) => candidate.key === resourceKey);
            if (!resource || !PLACEABLE_KINDS.has(resource.kind)) return;
            const id = uniquePlacementId(resource.id, draft.placements ?? []);
            const placement: MapPlacementDef = {
              id,
              at: { x, y },
              resource: { kind: resource.kind, id: resource.id },
              z: 0,
              footprint: { width: 1, height: 1 },
              collision: resource.kind === "map" ? "trigger" : "none",
              visible: true,
              events: resource.kind === "map" || resource.kind === "script" || resource.kind === "action"
                ? [{ id: "activate", trigger: "interact", label: resource.label, order: 0 }]
                : [],
            };
            setDraft((current) => ({
              ...current,
              placements: [...(current.placements ?? []), placement],
            }));
            setSelectedPlacementId(id);
          }}
        >
          {draft.layout.regions.map((region) => (
            <div
              className="map-region"
              key={region.id}
              title={region.name ?? region.id}
              style={{
                left: `${region.x / width * 100}%`,
                top: `${region.y / height * 100}%`,
                width: `${region.width / width * 100}%`,
                height: `${region.height / height * 100}%`,
              }}
            />
          ))}
          {draft.layout.playerStart && (
            <div
              className="map-player-start"
              title={`Player start · ${draft.layout.playerStart.x},${draft.layout.playerStart.y}`}
              style={{
                left: `${draft.layout.playerStart.x / width * 100}%`,
                top: `${draft.layout.playerStart.y / height * 100}%`,
                width: `${100 / width}%`,
                height: `${100 / height}%`,
              }}
            >◆</div>
          )}
          {(draft.placements ?? []).map((placement) => (
            <div
              className={`map-placement collision-${placement.collision}${selectedPlacementId === placement.id ? " selected" : ""}`}
              key={placement.id}
              draggable={editing}
              onDragStart={(event) => {
                event.dataTransfer.setData("application/x-autogal-placement", placement.id);
                event.dataTransfer.effectAllowed = "move";
              }}
              onClick={(event) => { event.stopPropagation(); setSelectedPlacementId(placement.id); }}
              title={`${placement.id} · ${placement.resource?.kind ?? "event"}:${placement.resource?.id ?? ""}`}
              style={{
                left: `${(placement.at.x / width) * 100}%`,
                top: `${(placement.at.y / height) * 100}%`,
                width: `${(placement.footprint.width / width) * 100}%`,
                height: `${(placement.footprint.height / height) * 100}%`,
                zIndex: Math.round(placement.z + 100),
                opacity: placement.visible ? 1 : 0.45,
              }}
            >
              <span>{placement.id}</span>
              <small>{placement.resource?.kind ?? "event"}</small>
            </div>
          ))}
        </div>
      ) : (
        <div className="node-map-preview">
          <span className="node-map-symbol">◇</span>
          <strong>Node map</strong>
          <p>This map currently folds into Hub, TUI and Headless navigation.</p>
          {editing && <small>Add a spatial layout to turn it into a 2D scene.</small>}
        </div>
      )}
        </div>
        <footer className="map-stage-footer">
          <span>{editing ? "Drag project resources onto the canvas · drag objects to move" : "Preview is read-only"}</span>
          <span>{draft.layout ? `${width * height} cells` : "semantic node"}</span>
        </footer>
      </div>
      {editing && selectedPlacement && (
        <PlacementEditor
          placement={selectedPlacement}
          layers={draft.layout?.layers.map((layer) => layer.id) ?? []}
          resources={resources}
          switches={switches}
          variables={variables}
          onChange={(update) => mutatePlacement(selectedPlacement.id, update)}
          onDelete={() => {
            setDraft((current) => ({
              ...current,
              placements: (current.placements ?? []).filter((placement) => placement.id !== selectedPlacement.id),
            }));
            setSelectedPlacementId(null);
          }}
          onClose={() => setSelectedPlacementId(null)}
        />
      )}
      {stacks.length > 0 && (
        <section className="map-stacks">
          <h3>Stacked cells</h3>
          {stacks.map((stack) => (
            <div key={stack.key}><code>{stack.key}</code><span>{stack.ids.join(" · ")}</span></div>
          ))}
        </section>
      )}
      <MapSurfacePreviews map={draft} />
    </section>
  );
}

function MapStructureEditor({
  layout,
  onChange,
}: {
  layout: MapLayoutDef;
  onChange: (layout: MapLayoutDef) => void;
}) {
  const patchLayer = (index: number, patch: Partial<MapLayoutDef["layers"][number]>) =>
    onChange({
      ...layout,
      layers: layout.layers.map((layer, candidate) =>
        candidate === index ? { ...layer, ...patch } : layer
      ),
    });
  const patchRegion = (index: number, patch: Partial<MapLayoutDef["regions"][number]>) =>
    onChange({
      ...layout,
      regions: layout.regions.map((region, candidate) =>
        candidate === index ? { ...region, ...patch } : region
      ),
    });
  return (
    <div className="map-structure-editor">
      <section>
        <header><h3>Layers</h3><button type="button" onClick={() => onChange({
          ...layout,
          layers: [...layout.layers, {
            id: uniqueLocalId("layer", layout.layers.map((layer) => layer.id)),
            kind: "object",
            z: layout.layers.length,
            visible: true,
          }],
        })}>+ Layer</button></header>
        {layout.layers.map((layer, index) => (
          <div className="structure-row layer-row" key={`${layer.id}-${index}`}>
            <input aria-label={`Layer ${index + 1} id`} value={layer.id} onChange={(event) => patchLayer(index, { id: event.target.value })} />
            <select value={layer.kind} onChange={(event) => patchLayer(index, { kind: event.target.value as typeof layer.kind })}>
              <option>tile</option><option>image</option><option>object</option><option>collision</option><option>region</option>
            </select>
            <input type="number" aria-label={`${layer.id} z`} value={layer.z} onChange={(event) => patchLayer(index, { z: Number(event.target.value) })} />
            <input placeholder="asset (optional)" value={layer.asset ?? ""} onChange={(event) => patchLayer(index, { asset: event.target.value || undefined })} />
            <label><input type="checkbox" checked={layer.visible} onChange={(event) => patchLayer(index, { visible: event.target.checked })} /> visible</label>
            <button type="button" className="danger" onClick={() => onChange({ ...layout, layers: layout.layers.filter((_, candidate) => candidate !== index) })}>×</button>
          </div>
        ))}
      </section>
      <section>
        <header><h3>Regions</h3><button type="button" onClick={() => onChange({
          ...layout,
          regions: [...layout.regions, {
            id: uniqueLocalId("region", layout.regions.map((region) => region.id)),
            x: 0,
            y: 0,
            width: 1,
            height: 1,
          }],
        })}>+ Region</button></header>
        {layout.regions.map((region, index) => (
          <div className="structure-row region-row" key={`${region.id}-${index}`}>
            <input aria-label={`Region ${index + 1} id`} value={region.id} onChange={(event) => patchRegion(index, { id: event.target.value })} />
            <input placeholder="name" value={region.name ?? ""} onChange={(event) => patchRegion(index, { name: event.target.value || undefined })} />
            {(["x", "y", "width", "height"] as const).map((field) => (
              <label key={field}>{field}<input type="number" min={field === "width" || field === "height" ? 1 : 0} value={region[field]} onChange={(event) => patchRegion(index, { [field]: Number(event.target.value) })} /></label>
            ))}
            <button type="button" className="danger" onClick={() => onChange({ ...layout, regions: layout.regions.filter((_, candidate) => candidate !== index) })}>×</button>
          </div>
        ))}
      </section>
    </div>
  );
}

type MapPreviewSurface = "2d" | "hub" | "tui" | "headless";

function MapSurfacePreviews({ map }: { map: MapDef }) {
  const [surface, setSurface] = useState<MapPreviewSurface>("2d");
  const [preview, setPreview] = useState<MapPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPreview(null);
    setError(null);
    fetchMapPreview(map.id)
      .then(setPreview)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [map.id, map.layout, map.placements]);

  return (
    <section className="map-surface-previews">
      <header>
        <div><h3>Surface projections</h3><span>same Map v2 resource · deterministic initial state</span></div>
        <nav aria-label="Map surface previews">
          {(["2d", "hub", "tui", "headless"] as const).map((name) => (
            <button
              type="button"
              className={surface === name ? "selected" : ""}
              key={name}
              onClick={() => setSurface(name)}
            >{name === "2d" ? "2D" : name === "tui" ? "TUI" : name[0]!.toUpperCase() + name.slice(1)}</button>
          ))}
        </nav>
      </header>
      {error && <div className="project-warning"><strong>Preview unavailable</strong><code>{error}</code></div>}
      {surface === "2d" && (
        <div className="projection-placement-list">
          {(map.placements ?? []).length === 0
            ? <span className="muted">No positioned resources; this map renders as a folded node.</span>
            : (map.placements ?? []).map((placement) => (
              <div key={placement.id}>
                <code>{placement.at.x},{placement.at.y}</code>
                <strong>{placement.id}</strong>
                <span>{placement.resource ? `${placement.resource.kind}:${placement.resource.id}` : "event-only"}</span>
                <small>{placement.events.map((event) => event.trigger).join(" · ") || "no trigger"}</small>
              </div>
            ))}
        </div>
      )}
      {surface === "hub" && preview && (
        <div className="projection-hub">
          {preview.hub.map((activity) => (
            <button type="button" disabled={!activity.available} key={activity.id}>
              <strong>{activity.title}</strong>
              <small>{activity.available ? activity.category : activity.lockedReason}</small>
            </button>
          ))}
          {preview.hub.length === 0 && <span className="muted">No player-facing Hub activities.</span>}
        </div>
      )}
      {surface === "tui" && preview && (
        <pre className="projection-tui">{preview.tui.length > 0 ? preview.tui.join("\n") : "(no selectable operations)"}</pre>
      )}
      {surface === "headless" && preview && (
        <div className="projection-headless">
          {preview.headless.map((resource) => (
            <div key={resource.key}>
              <code>{resource.key}</code>
              <span>{resource.label}</span>
              <small>{resource.activity ? resource.activity.id : resource.trigger ?? "resource"}</small>
              <b className={resource.available ? "available" : "locked"}>{resource.available ? "available" : "locked"}</b>
            </div>
          ))}
        </div>
      )}
      {!preview && surface !== "2d" && !error && <span className="muted">building semantic preview…</span>}
    </section>
  );
}

function PlacementEditor({
  placement,
  layers,
  resources,
  switches,
  variables,
  onChange,
  onDelete,
  onClose,
}: {
  placement: MapPlacementDef;
  layers: string[];
  resources: ProjectResourceNode[];
  switches: SwitchDef[];
  variables: VariableDef[];
  onChange: (update: (placement: MapPlacementDef) => MapPlacementDef) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const setNumber = (axis: "x" | "y", value: number) => onChange((current) => ({
    ...current,
    at: { ...current.at, [axis]: value },
  }));
  const placementKind = placement.resource?.kind;
  const placementChoices = resourceChoices(resources, placementKind);
  return (
    <section className="placement-editor">
      <header className="placement-editor-heading">
        <div><span>SELECTED OBJECT</span><strong>{placement.id}</strong><code>{placement.resource ? `${placement.resource.kind}:${placement.resource.id}` : "event-only"}</code></div>
        <div className="placement-heading-actions"><button type="button" className="danger" onClick={onDelete}>Delete object</button><button type="button" aria-label="Close object inspector" onClick={onClose}>×</button></div>
      </header>
      <div className="placement-editor-grid">
        <section className="placement-panel placement-resource-panel">
          <header><h3>Resource</h3><span>{placement.resource ? placement.resource.kind : "event-only"}</span></header>
          <div className="placement-resource-fields">
            <label>Kind<select value={placementKind ?? ""} onChange={(event) => {
              const kind = event.target.value as ProjectResourceKind | "";
              onChange((current) => ({
                ...current,
                resource: kind ? { kind, id: resourceChoices(resources, kind)[0]?.id ?? "" } : undefined,
              }));
            }}><option value="">event-only</option>{[...PLACEABLE_KINDS].map((kind) => <option key={kind}>{kind}</option>)}</select></label>
            <label>Project record<select value={placement.resource?.id ?? ""} disabled={!placementKind} onChange={(event) => onChange((current) => ({
              ...current,
              resource: current.resource ? { ...current.resource, id: event.target.value } : undefined,
            }))}>
              {placement.resource && !placementChoices.some((choice) => choice.id === placement.resource?.id) && (
                <option value={placement.resource.id}>{placement.resource.id} · missing</option>
              )}
              {placementChoices.map((choice) => <option value={choice.id} key={choice.key}>{choice.label} · {choice.id}</option>)}
            </select></label>
          </div>
          <p>Choose from the project database. The stable resource ID is written into the map source.</p>
        </section>
        <section className="placement-panel">
          <header><h3>Transform</h3><span>{placement.at.x}, {placement.at.y}</span></header>
          <div className="placement-fields">
            <label>X<input type="number" min="0" value={placement.at.x} onChange={(event) => setNumber("x", Number(event.target.value))} /></label>
            <label>Y<input type="number" min="0" value={placement.at.y} onChange={(event) => setNumber("y", Number(event.target.value))} /></label>
            <label>Z<input type="number" value={placement.z} onChange={(event) => onChange((current) => ({ ...current, z: Number(event.target.value) }))} /></label>
            <label>Width<input type="number" min="1" value={placement.footprint.width} onChange={(event) => onChange((current) => ({ ...current, footprint: { ...current.footprint, width: Number(event.target.value) } }))} /></label>
            <label>Height<input type="number" min="1" value={placement.footprint.height} onChange={(event) => onChange((current) => ({ ...current, footprint: { ...current.footprint, height: Number(event.target.value) } }))} /></label>
          </div>
        </section>
        <section className="placement-panel">
          <header><h3>Behavior</h3><span>{placement.events.length} events</span></header>
          <div className="placement-fields behavior-fields">
            <label>Layer<select value={placement.layer ?? ""} onChange={(event) => onChange((current) => ({ ...current, layer: event.target.value || undefined }))}><option value="">none</option>{layers.map((layer) => <option key={layer}>{layer}</option>)}</select></label>
            <label>Collision<select value={placement.collision} onChange={(event) => onChange((current) => ({ ...current, collision: event.target.value as MapPlacementDef["collision"] }))}><option>none</option><option>block</option><option>trigger</option></select></label>
            <label>Facing<select value={placement.facing ?? ""} onChange={(event) => onChange((current) => ({ ...current, facing: (event.target.value || undefined) as MapPlacementDef["facing"] }))}><option value="">none</option><option>north</option><option>east</option><option>south</option><option>west</option></select></label>
            <label className="checkbox-field"><input type="checkbox" checked={placement.visible} onChange={(event) => onChange((current) => ({ ...current, visible: event.target.checked }))} />Visible</label>
          </div>
          <ConditionBuilder label="Placement condition" value={placement.requires} resources={resources} switches={switches} variables={variables} onChange={(requires) => onChange((current) => ({ ...current, requires }))} />
        </section>
      </div>
      <EventPagesEditor
        placement={placement}
        resources={resources}
        switches={switches}
        variables={variables}
        onChange={onChange}
      />
    </section>
  );
}

function EventPagesEditor({
  placement,
  resources,
  switches,
  variables,
  onChange,
}: {
  placement: MapPlacementDef;
  resources: ProjectResourceNode[];
  switches: SwitchDef[];
  variables: VariableDef[];
  onChange: (update: (placement: MapPlacementDef) => MapPlacementDef) => void;
}) {
  const [selectedEventId, setSelectedEventId] = useState<string | null>(placement.events[0]?.id ?? null);
  const selectedIndex = Math.max(0, placement.events.findIndex((event) => event.id === selectedEventId));
  const selected = placement.events[selectedIndex];

  useEffect(() => {
    if (selectedEventId && placement.events.some((event) => event.id === selectedEventId)) return;
    setSelectedEventId(placement.events[0]?.id ?? null);
  }, [placement.id, placement.events, selectedEventId]);

  const patchSelected = (patch: Partial<MapPlacementEventDef>) => onChange((current) => ({
    ...current,
    events: current.events.map((event, index) => index === selectedIndex ? { ...event, ...patch } : event),
  }));

  const addPage = (source?: MapPlacementEventDef) => {
    const id = uniqueLocalId(source ? `${source.id}_copy` : "event", placement.events.map((event) => event.id));
    const next: MapPlacementEventDef = source
      ? { ...structuredClone(source), id, order: placement.events.length }
      : { id, trigger: "interact", label: "Interact", order: placement.events.length };
    onChange((current) => ({ ...current, events: [...current.events, next] }));
    setSelectedEventId(id);
  };

  const deletePage = () => {
    if (!selected) return;
    const nextId = placement.events[selectedIndex + 1]?.id ?? placement.events[selectedIndex - 1]?.id ?? null;
    onChange((current) => ({
      ...current,
      events: current.events
        .filter((_, index) => index !== selectedIndex)
        .map((event, index) => ({ ...event, order: index })),
    }));
    setSelectedEventId(nextId);
  };

  const movePage = (direction: -1 | 1) => {
    const destination = selectedIndex + direction;
    if (!selected || destination < 0 || destination >= placement.events.length) return;
    onChange((current) => {
      const events = [...current.events];
      [events[selectedIndex], events[destination]] = [events[destination]!, events[selectedIndex]!];
      return { ...current, events: events.map((event, index) => ({ ...event, order: index })) };
    });
  };

  const trigger = selected ? eventTriggerMeta(selected.trigger) : null;
  return (
    <section className="placement-events event-pages-workbench">
      <header>
        <div><h3>Event pages</h3><span>RPG Maker-style bindings · same engine events</span></div>
        <button type="button" onClick={() => addPage()}>+ New page</button>
      </header>
      {placement.events.length === 0 || !selected ? (
        <div className="events-empty"><strong>No event pages</strong><span>Add a page to expose an interaction, transfer, cutscene, or automatic process.</span><button type="button" onClick={() => addPage()}>Create first page</button></div>
      ) : (
        <div className="event-pages-layout">
          <nav className="event-page-index" aria-label="Event pages">
            <header><span>PAGES</span><small>{placement.events.length}</small></header>
            {placement.events.map((event, index) => {
              const meta = eventTriggerMeta(event.trigger);
              return (
                <button type="button" className={index === selectedIndex ? "selected" : ""} aria-current={index === selectedIndex ? "page" : undefined} key={`${event.id}-${index}`} onClick={() => setSelectedEventId(event.id)}>
                  <span className="event-page-number">{index + 1}</span>
                  <span className="event-page-copy"><strong>{event.label || meta.label}</strong><small>{event.id}</small></span>
                  <i title={meta.description}>{meta.icon}</i>
                  {event.requires && <b title="This page has a condition">◆</b>}
                </button>
              );
            })}
            <button type="button" className="event-page-add" onClick={() => addPage()}>＋ Add page</button>
          </nav>

          <article className="event-page-editor">
            <header className="event-page-heading">
              <div className="event-trigger-emblem" aria-hidden="true">{trigger?.icon}</div>
              <div><span>EVENT PAGE · {selectedIndex + 1}</span><strong>{selected.label || trigger?.label}</strong><small>{trigger?.description}</small></div>
              <div className="event-page-actions">
                <button type="button" aria-label="Move page up" disabled={selectedIndex === 0} onClick={() => movePage(-1)}>↑</button>
                <button type="button" aria-label="Move page down" disabled={selectedIndex === placement.events.length - 1} onClick={() => movePage(1)}>↓</button>
                <button type="button" onClick={() => addPage(selected)}>Duplicate</button>
                <button type="button" className="danger" aria-label={`Delete event ${selected.id}`} onClick={deletePage}>Delete</button>
              </div>
            </header>

            <div className="event-page-properties">
              <label>Page ID<input value={selected.id} aria-label={`Event ${selectedIndex + 1} id`} onChange={(change) => {
                setSelectedEventId(change.target.value);
                patchSelected({ id: change.target.value });
              }} /></label>
              <label>Player label<input value={selected.label ?? ""} placeholder={trigger?.label} onChange={(change) => patchSelected({ label: change.target.value || undefined })} /></label>
              <label>Trigger<select value={selected.trigger} aria-label={`Event ${selectedIndex + 1} trigger`} onChange={(change) => patchSelected({ trigger: change.target.value as MapEventTrigger })}>
                {!EVENT_TRIGGERS.includes(selected.trigger) && <option value={selected.trigger}>{selected.trigger}</option>}
                {EVENT_TRIGGERS.map((name) => <option value={name} key={name}>{eventTriggerMeta(name).label}</option>)}
              </select></label>
              <label>Priority<input type="number" value={selected.order} onChange={(change) => patchSelected({ order: Number(change.target.value) })} /></label>
              <label>Probability<input type="number" min="0" max="1" step="0.05" value={selected.chance ?? 1} onChange={(change) => patchSelected({ chance: Number(change.target.value) })} /></label>
            </div>

            <section className="event-command-list">
              <header><span>COMMAND LIST</span><small>{selected.requires ? "2 commands" : "1 command"}</small></header>
              <div className={`event-command-row condition-command${selected.requires ? " active" : ""}`}>
                <span className="event-command-gutter">◆</span>
                <div><strong>Conditional branch</strong><small>{selected.requires ? "Evaluate this page condition before activation" : "No condition · page is always eligible"}</small></div>
              </div>
              <ConditionBuilder
                label="Page condition"
                value={selected.requires}
                resources={resources}
                switches={switches}
                variables={variables}
                onChange={(requires) => patchSelected({ requires })}
              />
              <div className="event-command-row run-command">
                <span className="event-command-gutter">▶</span>
                <div><strong>Activate resource</strong><small>Transfer, run a script, or dispatch an action through the engine registry.</small></div>
                <label>Type<select value={selected.run?.kind ?? ""} onChange={(change) => patchSelected({
                  run: change.target.value ? {
                    kind: change.target.value as ProjectResourceKind,
                    id: resourceChoices(resources, change.target.value as ProjectResourceKind)[0]?.id ?? "",
                  } : undefined,
                })}><option value="">placement resource</option>{RUN_RESOURCE_KINDS.map((kind) => <option key={kind}>{kind}</option>)}</select></label>
                <label>Project record<select value={selected.run?.id ?? ""} disabled={!selected.run} onChange={(change) => patchSelected({
                  run: selected.run ? { ...selected.run, id: change.target.value } : undefined,
                })}>
                  {!selected.run ? <option value="">same as placement</option> : (
                    <>
                      {!resourceChoices(resources, selected.run.kind).some((choice) => choice.id === selected.run?.id) && <option value={selected.run.id}>{selected.run.id} · missing</option>}
                      {resourceChoices(resources, selected.run.kind).map((choice) => <option value={choice.id} key={choice.key}>{choice.label} · {choice.id}</option>)}
                    </>
                  )}
                </select></label>
              </div>
              <label className="event-locked-feedback"><span>Unavailable message</span><input value={selected.lockedHint ?? ""} placeholder="Optional player-facing reason when the condition is locked" onChange={(change) => patchSelected({ lockedHint: change.target.value || undefined })} /></label>
            </section>
          </article>
        </div>
      )}
    </section>
  );
}

type ConditionEditorMode =
  | "none"
  | "switch"
  | "variable"
  | "affection"
  | "scriptCompleted"
  | "inventory"
  | "weaponPower"
  | "knowsSkill"
  | "selfSwitch"
  | "advanced";

const CONDITION_MODES: Array<{ value: ConditionEditorMode; label: string }> = [
  { value: "none", label: "Always / no condition" },
  { value: "switch", label: "Switch" },
  { value: "variable", label: "Variable" },
  { value: "affection", label: "Character affection" },
  { value: "scriptCompleted", label: "Script completed" },
  { value: "inventory", label: "Inventory count" },
  { value: "weaponPower", label: "Weapon power" },
  { value: "knowsSkill", label: "Skill learned" },
  { value: "selfSwitch", label: "Self switch" },
  { value: "advanced", label: "Advanced JSON" },
];

function ConditionBuilder({
  label,
  value,
  resources,
  switches,
  variables,
  onChange,
}: {
  label: string;
  value?: Condition;
  resources: ProjectResourceNode[];
  switches: SwitchDef[];
  variables: VariableDef[];
  onChange: (value?: Condition) => void;
}) {
  const mode = conditionEditorMode(value);
  const setMode = (next: ConditionEditorMode) => onChange(createConditionDraft(next, resources, switches, variables));
  return (
    <section className={`condition-builder mode-${mode}`}>
      <header>
        <span>{label}</span>
        <select aria-label={`${label} type`} value={mode} onChange={(event) => setMode(event.target.value as ConditionEditorMode)}>
          {CONDITION_MODES.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
        </select>
      </header>
      {mode === "none" && <p>No runtime gate. This event is available whenever its trigger runs.</p>}
      {mode === "switch" && value && "switch" in value && (
        <div className="condition-fields">
          <label>Switch<select value={value.switch.name} onChange={(event) => onChange({ switch: { ...value.switch, name: event.target.value } })}>
            {!switches.some((candidate) => candidate.id === value.switch.name) && value.switch.name && <option value={value.switch.name}>{value.switch.name} · missing</option>}
            {switches.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.label ?? candidate.description ?? candidate.id} · {candidate.id}</option>)}
          </select></label>
          <label>Required value<select value={String(value.switch.eq ?? true)} onChange={(event) => onChange({ switch: { ...value.switch, eq: event.target.value === "true" } })}><option value="true">ON</option><option value="false">OFF</option></select></label>
        </div>
      )}
      {mode === "variable" && value && "variable" in value && (
        <div className="condition-fields condition-fields-range">
          <label>Variable<select value={value.variable.name} onChange={(event) => {
            const definition = variables.find((candidate) => candidate.id === event.target.value);
            onChange({ variable: { name: event.target.value, eq: definition?.initial ?? "" } });
          }}>
            {!variables.some((candidate) => candidate.id === value.variable.name) && value.variable.name && <option value={value.variable.name}>{value.variable.name} · missing</option>}
            {variables.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.label ?? candidate.description ?? candidate.id} · {candidate.id}</option>)}
          </select></label>
          <RangeControls
            range={value.variable}
            variable
            variableType={variables.find((candidate) => candidate.id === value.variable.name)?.type}
            onChange={(range) => onChange({ variable: { name: value.variable.name, ...range as { eq?: string | number; min?: number; max?: number } } })}
          />
        </div>
      )}
      {mode === "affection" && value && "affection" in value && (
        <div className="condition-fields condition-fields-range">
          <ResourceConditionSelect label="Character" kind="character" value={value.affection.character} resources={resources} onChange={(character) => onChange({ affection: { ...value.affection, character } })} />
          <RangeControls range={value.affection} onChange={(range) => onChange({ affection: { character: value.affection.character, ...range as { eq?: number; min?: number; max?: number } } })} />
        </div>
      )}
      {mode === "scriptCompleted" && value && "scriptCompleted" in value && (
        <div className="condition-fields condition-fields-single">
          <ResourceConditionSelect label="Completed script" kind="script" value={value.scriptCompleted} resources={resources} onChange={(scriptCompleted) => onChange({ scriptCompleted })} />
        </div>
      )}
      {mode === "inventory" && value && "inventory" in value && (
        <div className="condition-fields condition-fields-range">
          <ResourceConditionSelect label="Item" kind="item" value={value.inventory.itemId} resources={resources} onChange={(itemId) => onChange({ inventory: { ...value.inventory, itemId } })} />
          <RangeControls range={value.inventory} onChange={(range) => onChange({ inventory: { itemId: value.inventory.itemId, ...range as { eq?: number; min?: number; max?: number } } })} />
        </div>
      )}
      {mode === "weaponPower" && value && "weaponPower" in value && (
        <div className="condition-fields condition-fields-range">
          <ResourceConditionSelect label="Weapon" kind="weapon" value={value.weaponPower.weaponId} resources={resources} onChange={(weaponId) => onChange({ weaponPower: { ...value.weaponPower, weaponId } })} />
          <RangeControls range={value.weaponPower} onChange={(range) => onChange({ weaponPower: { weaponId: value.weaponPower.weaponId, ...range as { eq?: number; min?: number; max?: number } } })} />
        </div>
      )}
      {mode === "knowsSkill" && value && "knowsSkill" in value && (
        <div className="condition-fields condition-fields-single">
          <ResourceConditionSelect label="Learned skill" kind="skill" value={value.knowsSkill} resources={resources} onChange={(knowsSkill) => onChange({ knowsSkill })} />
        </div>
      )}
      {mode === "selfSwitch" && value && "selfSwitch" in value && (
        <div className="condition-fields condition-fields-self-switch">
          <ResourceConditionSelect label="Script" kind="script" value={value.selfSwitch.scriptId} resources={resources} onChange={(scriptId) => onChange({ selfSwitch: { ...value.selfSwitch, scriptId } })} />
          <label>Letter<select value={value.selfSwitch.name} onChange={(event) => onChange({ selfSwitch: { ...value.selfSwitch, name: event.target.value as "A" | "B" | "C" | "D" } })}>{["A", "B", "C", "D"].map((letter) => <option key={letter}>{letter}</option>)}</select></label>
          <label>Required value<select value={String(value.selfSwitch.eq ?? true)} onChange={(event) => onChange({ selfSwitch: { ...value.selfSwitch, eq: event.target.value === "true" } })}><option value="true">ON</option><option value="false">OFF</option></select></label>
        </div>
      )}
      {mode === "advanced" && <ConditionJsonEditor value={value} onChange={onChange} />}
    </section>
  );
}

function RangeControls({
  range,
  onChange,
  variable = false,
  variableType,
}: {
  range: { eq?: unknown; min?: number; max?: number };
  onChange: (range: { eq?: string | number; min?: number; max?: number }) => void;
  variable?: boolean;
  variableType?: VariableDef["type"];
}) {
  const operator = conditionRangeOperator(range);
  const raw = operator === "eq" ? range.eq ?? "" : range[operator] ?? 0;
  return (
    <>
      <label>Compare<select value={operator} onChange={(event) => {
        const next = event.target.value as "eq" | "min" | "max";
        onChange(next === "eq" ? { eq: variable ? "" : 0 } : { [next]: 0 });
      }}><option value="eq">equals</option>{variableType !== "string" && <><option value="min">at least</option><option value="max">at most</option></>}</select></label>
      <label>Value<input type={operator === "eq" && variable ? "text" : "number"} value={String(raw)} onChange={(event) => onChange(operator === "eq"
        ? { eq: variable ? parseConditionLiteral(event.target.value) : Number(event.target.value) }
        : { [operator]: Number(event.target.value) })} /></label>
    </>
  );
}

function ResourceConditionSelect({
  label,
  kind,
  value,
  resources,
  onChange,
}: {
  label: string;
  kind: ProjectResourceKind;
  value: string;
  resources: ProjectResourceNode[];
  onChange: (id: string) => void;
}) {
  const choices = resourceChoices(resources, kind);
  return (
    <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)}>
      {!choices.some((choice) => choice.id === value) && value && <option value={value}>{value} · missing</option>}
      {choices.map((choice) => <option value={choice.id} key={choice.key}>{choice.label} · {choice.id}</option>)}
    </select></label>
  );
}

function ConditionJsonEditor({
  value,
  onChange,
}: {
  value?: Condition;
  onChange: (value?: Condition) => void;
}) {
  const [text, setText] = useState(value ? JSON.stringify(value) : "");
  const [error, setError] = useState(false);
  useEffect(() => {
    setText(value ? JSON.stringify(value) : "");
    setError(false);
  }, [value]);
  const apply = () => {
    if (!text.trim()) {
      setError(false);
      onChange(undefined);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      setError(false);
      onChange(parsed as Condition);
    } catch {
      setError(true);
    }
  };
  return (
    <label className={`condition-editor advanced${error ? " invalid" : ""}`}>
      <span>JSON</span>
      <textarea value={text} placeholder='{"switch":{"name":"flag","eq":true}}' onChange={(event) => setText(event.target.value)} />
      <button type="button" onClick={apply}>{error ? "Invalid JSON" : "Apply"}</button>
    </label>
  );
}

export function conditionEditorMode(value: Condition | undefined): ConditionEditorMode {
  if (!value) return "none";
  for (const mode of ["switch", "variable", "affection", "scriptCompleted", "inventory", "weaponPower", "knowsSkill", "selfSwitch"] as const) {
    if (mode in value) return mode;
  }
  return "advanced";
}

export function createConditionDraft(
  mode: ConditionEditorMode,
  resources: ProjectResourceNode[],
  switches: SwitchDef[] = [],
  variables: VariableDef[] = [],
): Condition | undefined {
  const first = (kind: ProjectResourceKind) => resourceChoices(resources, kind)[0]?.id ?? "";
  switch (mode) {
    case "none": return undefined;
    case "switch": return { switch: { name: switches[0]?.id ?? "", eq: true } };
    case "variable": return { variable: { name: variables[0]?.id ?? "", eq: variables[0]?.initial ?? "" } };
    case "affection": return { affection: { character: first("character"), min: 1 } };
    case "scriptCompleted": return { scriptCompleted: first("script") };
    case "inventory": return { inventory: { itemId: first("item"), min: 1 } };
    case "weaponPower": return { weaponPower: { weaponId: first("weapon"), min: 1 } };
    case "knowsSkill": return { knowsSkill: first("skill") };
    case "selfSwitch": return { selfSwitch: { scriptId: first("script"), name: "A", eq: true } };
    case "advanced": return { all: [] };
  }
}

function conditionRangeOperator(range: { eq?: unknown; min?: number; max?: number }): "eq" | "min" | "max" {
  if (range.eq !== undefined) return "eq";
  if (range.max !== undefined) return "max";
  return "min";
}

function parseConditionLiteral(value: string): string | number {
  if (value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return value;
}

const EVENT_TRIGGERS: MapEventTrigger[] = [
  "interact", "player_touch", "event_touch", "manual", "map_enter", "autorun", "parallel",
];

const EVENT_TRIGGER_META: Record<string, { icon: string; label: string; description: string }> = {
  interact: { icon: "◎", label: "Action Button", description: "Runs when the player deliberately interacts with this object." },
  player_touch: { icon: "→", label: "Player Touch", description: "Runs when the player enters the object's trigger area." },
  event_touch: { icon: "←", label: "Event Touch", description: "Runs when this event reaches or touches the player." },
  manual: { icon: "◇", label: "Manual Call", description: "Only runs when another system explicitly dispatches this page." },
  map_enter: { icon: "↳", label: "Map Enter", description: "Runs when this map becomes the active player location." },
  autorun: { icon: "▶", label: "Autorun", description: "Runs automatically while its page condition is eligible." },
  parallel: { icon: "∞", label: "Parallel Process", description: "Observes the map in parallel while its condition remains eligible." },
};

export function eventTriggerMeta(trigger: MapEventTrigger): { icon: string; label: string; description: string } {
  return EVENT_TRIGGER_META[trigger] ?? {
    icon: "⌁",
    label: trigger.split(":").map((part) => part.replace(/[_-]+/g, " ")).join(" · "),
    description: `Custom engine trigger: ${trigger}`,
  };
}

const RUN_RESOURCE_KINDS: ProjectResourceKind[] = ["action", "script", "map"];

export function resourceChoices(
  resources: ProjectResourceNode[],
  kind: ProjectResourceKind | undefined,
): ProjectResourceNode[] {
  if (!kind) return [];
  return resources
    .filter((resource) => resource.kind === kind)
    .sort((left, right) => left.label.localeCompare(right.label));
}

function cloneMap(map: MapDef): MapDef {
  return structuredClone(map);
}

export function hasMapDraftChanges(saved: MapDef, draft: MapDef): boolean {
  return JSON.stringify({ layout: saved.layout, placements: saved.placements ?? [] }) !==
    JSON.stringify({ layout: draft.layout, placements: draft.placements ?? [] });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function uniquePlacementId(resourceId: string, placements: MapPlacementDef[]): string {
  const base = resourceId.replace(/[^a-zA-Z0-9_-]+/g, "_") || "resource";
  const used = new Set(placements.map((placement) => placement.id));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

function uniqueLocalId(base: string, ids: string[]): string {
  const used = new Set(ids);
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

function groupedStacks(placements: MapPlacementDef[]): Array<{ key: string; ids: string[] }> {
  const groups = new Map<string, string[]>();
  for (const placement of placements) {
    const key = `${placement.at.x},${placement.at.y}`;
    groups.set(key, [...(groups.get(key) ?? []), placement.id]);
  }
  return [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({ key, ids }));
}
