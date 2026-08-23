import React, { useEffect, useMemo, useState } from "react";
import type {
  Condition,
  MapDef,
  MapEventTrigger,
  MapPlacementDef,
  MapLayoutDef,
  ProjectResourceKind,
  ProjectResourceNode,
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
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchProject()
      .then((value) => {
        setProject(value);
        setSelectedKey(
          value.graph.resources.find((resource) => resource.kind === "map")?.key ??
            value.graph.resources[0]?.key ?? null,
        );
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  const groups = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const resources = (project?.graph.resources ?? []).filter((resource) =>
      normalized.length === 0 ||
      resource.key.toLowerCase().includes(normalized) ||
      resource.label.toLowerCase().includes(normalized)
    );
    return KIND_ORDER.flatMap((kind) => {
      const rows = resources.filter((resource) => resource.kind === kind);
      return rows.length > 0 ? [{ kind, rows }] : [];
    });
  }, [project, query]);

  if (error) return <div className="empty">⚠ {error}</div>;
  if (!project) return <div className="empty">loading project…</div>;

  const selected = project.graph.resources.find((row) => row.key === selectedKey);
  const map = selected?.kind === "map"
    ? project.maps.find((candidate) => candidate.id === selected.id)
    : undefined;

  return (
    <div className="project-layout">
      <aside className="project-tree">
        <div className="project-tree-heading">
          <h1>Project</h1>
          <span>{project.graph.resources.length} resources</span>
        </div>
        <input
          className="project-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search resources…"
          aria-label="Search project resources"
        />
        {groups.map(({ kind, rows }) => (
          <section className="resource-group" key={kind}>
            <h2>{kind}<span>{rows.length}</span></h2>
            {rows.map((resource) => (
              <button
                type="button"
                draggable={PLACEABLE_KINDS.has(resource.kind)}
                className={`resource-row ${selectedKey === resource.key ? "selected" : ""}`}
                key={resource.key}
                onClick={() => setSelectedKey(resource.key)}
                onDragStart={(event) => {
                  if (!PLACEABLE_KINDS.has(resource.kind)) {
                    event.preventDefault();
                    return;
                  }
                  event.dataTransfer.setData("application/x-autogal-resource", resource.key);
                  event.dataTransfer.effectAllowed = "copy";
                }}
              >
                <span>{resource.label}</span>
                <small>{resource.id}</small>
              </button>
            ))}
          </section>
        ))}
      </aside>
      <section className="project-detail">
        {selected ? (
          <ResourceDetail
            node={selected}
            map={map}
            resources={project.graph.resources}
            backlinks={project.graph.backlinks[selected.key] ?? []}
            missing={project.graph.missing.filter((entry) =>
              entry.referencedBy.includes(selected.key)
            )}
            unreferenced={project.graph.unreferenced.includes(selected.key)}
            onProjectSaved={setProject}
          />
        ) : (
          <div className="empty">Select a project resource.</div>
        )}
      </section>
    </div>
  );
}

function ResourceDetail({
  node,
  map,
  resources,
  backlinks,
  missing,
  unreferenced,
  onProjectSaved,
}: {
  node: ProjectResourceNode;
  map?: MapDef;
  resources: ProjectResourceNode[];
  backlinks: string[];
  missing: Array<{ key: string; referencedBy: string[] }>;
  unreferenced: boolean;
  onProjectSaved: (project: ProjectResponse) => void;
}) {
  return (
    <>
      <header className="resource-detail-header">
        <span className={`kind-badge ${node.kind}`}>{node.kind}</span>
        <h1>{node.label}</h1>
        <code>{node.key}</code>
        {node.source && <div className="resource-source">{node.source}</div>}
      </header>

      {map && (
        <MapOverview
          map={map}
          resources={resources}
          onProjectSaved={onProjectSaved}
        />
      )}

      {node.source && node.editable !== false && (
        <ResourceSourceEditor node={node} onProjectSaved={onProjectSaved} />
      )}

      <div className="reference-grid">
        <ReferenceList title="References" values={node.refs} />
        <ReferenceList title="Used by" values={backlinks} />
      </div>
      {missing.length > 0 && (
        <section className="project-warning">
          <strong>Missing references</strong>
          {missing.map((entry) => <code key={entry.key}>{entry.key}</code>)}
        </section>
      )}
      {unreferenced && (
        <section className="project-warning advisory">
          <strong>Unreferenced candidate</strong>
          <span>No registry resource points here. Entry maps, root scripts, and module-discovered resources may be intentional.</span>
        </section>
      )}
    </>
  );
}

function ResourceSourceEditor({
  node,
  onProjectSaved,
}: {
  node: ProjectResourceNode;
  onProjectSaved: (project: ProjectResponse) => void;
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

  return (
    <section className="detail-section resource-source-editor">
      <header>
        <div><h2>Source file</h2><code>{sourcePath}</code></div>
        {!editing ? (
          <button type="button" disabled={loading} onClick={begin}>
            {loading ? "Loading…" : "Edit source"}
          </button>
        ) : (
          <div>
            <button type="button" className="primary" disabled={saving} onClick={save}>
              {saving ? "Validating…" : "Save & validate"}
            </button>
            <button type="button" disabled={saving} onClick={() => {
              setEditing(false);
              setError(null);
            }}>Cancel</button>
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
  onProjectSaved,
}: {
  map: MapDef;
  resources: ProjectResourceNode[];
  onProjectSaved: (project: ProjectResponse) => void;
}) {
  const [draft, setDraft] = useState<MapDef>(() => cloneMap(map));
  const [editing, setEditing] = useState(false);
  const [selectedPlacementId, setSelectedPlacementId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(cloneMap(map));
    setEditing(false);
    setSelectedPlacementId(null);
    setSaveError(null);
  }, [map]);

  const width = draft.layout?.width ?? 1;
  const height = draft.layout?.height ?? 1;
  const selectedPlacement = draft.placements?.find(
    (placement) => placement.id === selectedPlacementId,
  );
  const stacks = groupedStacks(draft.placements ?? []);

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
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="map-overview">
      <div className="map-overview-meta">
        <div>
          <h2>Map resource</h2>
          <p>{map.description || "No description."}</p>
        </div>
        <div className="map-stats">
          <span>{draft.layout ? `${width} × ${height}` : "node map"}</span>
          <span>{draft.layout?.layers.length ?? 0} layers</span>
          <span>{draft.placements?.length ?? 0} placements</span>
          <span>{stacks.length} stacked cells</span>
        </div>
        <div className="map-editor-actions">
          {!editing ? (
            <button type="button" onClick={() => setEditing(true)}>Edit map</button>
          ) : (
            <>
              <button type="button" className="primary" disabled={saving} onClick={save}>
                {saving ? "Saving…" : "Save YAML"}
              </button>
              <button type="button" disabled={saving} onClick={() => {
                setDraft(cloneMap(map));
                setEditing(false);
                setSaveError(null);
              }}>Discard</button>
            </>
          )}
        </div>
      </div>
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
        <><div className="layout-fields">
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
        /></>
      )}
      {draft.layout ? (
        <div
          className={`map-canvas ${editing ? "editing" : ""}`}
          style={{ aspectRatio: `${width} / ${height}` }}
          aria-label={`${map.name} spatial preview`}
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
              onClick={() => setSelectedPlacementId(placement.id)}
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
          <strong>{map.name}</strong>
          <span>Headless/Hub node · no spatial layout authored</span>
        </div>
      )}
      {editing && selectedPlacement && (
        <PlacementEditor
          placement={selectedPlacement}
          layers={draft.layout?.layers.map((layer) => layer.id) ?? []}
          onChange={(update) => mutatePlacement(selectedPlacement.id, update)}
          onDelete={() => {
            setDraft((current) => ({
              ...current,
              placements: (current.placements ?? []).filter((placement) => placement.id !== selectedPlacement.id),
            }));
            setSelectedPlacementId(null);
          }}
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
  onChange,
  onDelete,
}: {
  placement: MapPlacementDef;
  layers: string[];
  onChange: (update: (placement: MapPlacementDef) => MapPlacementDef) => void;
  onDelete: () => void;
}) {
  const setNumber = (axis: "x" | "y", value: number) => onChange((current) => ({
    ...current,
    at: { ...current.at, [axis]: value },
  }));
  return (
    <section className="placement-editor">
      <header><div><strong>{placement.id}</strong><code>{placement.resource ? `${placement.resource.kind}:${placement.resource.id}` : "event-only"}</code></div><button type="button" className="danger" onClick={onDelete}>Delete</button></header>
      <div className="placement-fields">
        <label>X<input type="number" min="0" value={placement.at.x} onChange={(event) => setNumber("x", Number(event.target.value))} /></label>
        <label>Y<input type="number" min="0" value={placement.at.y} onChange={(event) => setNumber("y", Number(event.target.value))} /></label>
        <label>Z<input type="number" value={placement.z} onChange={(event) => onChange((current) => ({ ...current, z: Number(event.target.value) }))} /></label>
        <label>Width<input type="number" min="1" value={placement.footprint.width} onChange={(event) => onChange((current) => ({ ...current, footprint: { ...current.footprint, width: Number(event.target.value) } }))} /></label>
        <label>Height<input type="number" min="1" value={placement.footprint.height} onChange={(event) => onChange((current) => ({ ...current, footprint: { ...current.footprint, height: Number(event.target.value) } }))} /></label>
        <label>Layer<select value={placement.layer ?? ""} onChange={(event) => onChange((current) => ({ ...current, layer: event.target.value || undefined }))}><option value="">none</option>{layers.map((layer) => <option key={layer}>{layer}</option>)}</select></label>
        <label>Collision<select value={placement.collision} onChange={(event) => onChange((current) => ({ ...current, collision: event.target.value as MapPlacementDef["collision"] }))}><option>none</option><option>block</option><option>trigger</option></select></label>
        <label>Facing<select value={placement.facing ?? ""} onChange={(event) => onChange((current) => ({ ...current, facing: (event.target.value || undefined) as MapPlacementDef["facing"] }))}><option value="">none</option><option>north</option><option>east</option><option>south</option><option>west</option></select></label>
        <label className="checkbox-field"><input type="checkbox" checked={placement.visible} onChange={(event) => onChange((current) => ({ ...current, visible: event.target.checked }))} />Visible</label>
      </div>
      <ConditionJsonEditor
        label="Placement condition"
        value={placement.requires}
        onChange={(requires) => onChange((current) => ({ ...current, requires }))}
      />
      <div className="placement-events">
        <header><h3>Events</h3><button type="button" onClick={() => onChange((current) => ({
          ...current,
          events: [...current.events, {
            id: uniqueLocalId("event", current.events.map((event) => event.id)),
            trigger: "interact",
            label: "Interact",
            order: current.events.length,
          }],
        }))}>+ Event</button></header>
        {placement.events.map((event, index) => (
          <div className="placement-event-row" key={index}>
            <input value={event.id} aria-label={`Event ${index + 1} id`} onChange={(change) => onChange((current) => ({
              ...current,
              events: current.events.map((candidate, eventIndex) => eventIndex === index ? { ...candidate, id: change.target.value } : candidate),
            }))} />
            <select value={event.trigger} onChange={(change) => onChange((current) => ({
              ...current,
              events: current.events.map((candidate, eventIndex) => eventIndex === index ? { ...candidate, trigger: change.target.value as MapEventTrigger } : candidate),
            }))}>
              {EVENT_TRIGGERS.map((trigger) => <option key={trigger}>{trigger}</option>)}
            </select>
            <input value={event.label ?? ""} placeholder="Player label" onChange={(change) => onChange((current) => ({
              ...current,
              events: current.events.map((candidate, eventIndex) => eventIndex === index ? { ...candidate, label: change.target.value || undefined } : candidate),
            }))} />
            <input type="number" value={event.order} title="Order" onChange={(change) => onChange((current) => ({
              ...current,
              events: current.events.map((candidate, eventIndex) => eventIndex === index ? { ...candidate, order: Number(change.target.value) } : candidate),
            }))} />
            <input type="number" min="0" max="1" step="0.05" value={event.chance ?? 1} title="Chance" onChange={(change) => onChange((current) => ({
              ...current,
              events: current.events.map((candidate, eventIndex) => eventIndex === index ? { ...candidate, chance: Number(change.target.value) } : candidate),
            }))} />
            <select value={event.run?.kind ?? ""} title="Run kind" onChange={(change) => onChange((current) => ({
              ...current,
              events: current.events.map((candidate, eventIndex) => eventIndex === index ? {
                ...candidate,
                run: change.target.value ? { kind: change.target.value as ProjectResourceKind, id: candidate.run?.id ?? "" } : undefined,
              } : candidate),
            }))}><option value="">placement resource</option>{RUN_RESOURCE_KINDS.map((kind) => <option key={kind}>{kind}</option>)}</select>
            <input value={event.run?.id ?? ""} placeholder="run id" disabled={!event.run} onChange={(change) => onChange((current) => ({
              ...current,
              events: current.events.map((candidate, eventIndex) => eventIndex === index && candidate.run ? { ...candidate, run: { ...candidate.run, id: change.target.value } } : candidate),
            }))} />
            <input value={event.lockedHint ?? ""} placeholder="locked hint" onChange={(change) => onChange((current) => ({
              ...current,
              events: current.events.map((candidate, eventIndex) => eventIndex === index ? { ...candidate, lockedHint: change.target.value || undefined } : candidate),
            }))} />
            <ConditionJsonEditor
              label="Event condition"
              compact
              value={event.requires}
              onChange={(requires) => onChange((current) => ({
                ...current,
                events: current.events.map((candidate, eventIndex) => eventIndex === index ? { ...candidate, requires } : candidate),
              }))}
            />
            <button type="button" className="danger" onClick={() => onChange((current) => ({
              ...current,
              events: current.events.filter((_, eventIndex) => eventIndex !== index),
            }))}>×</button>
          </div>
        ))}
      </div>
    </section>
  );
}

function ConditionJsonEditor({
  label,
  value,
  onChange,
  compact = false,
}: {
  label: string;
  value?: Condition;
  onChange: (value?: Condition) => void;
  compact?: boolean;
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
    <label className={`condition-editor ${compact ? "compact" : ""}${error ? " invalid" : ""}`}>
      <span>{label}</span>
      <textarea value={text} placeholder='{"switch":{"name":"flag","eq":true}}' onChange={(event) => setText(event.target.value)} />
      <button type="button" onClick={apply}>{error ? "Invalid JSON" : "Apply"}</button>
    </label>
  );
}

const EVENT_TRIGGERS: MapEventTrigger[] = [
  "interact", "player_touch", "event_touch", "manual", "map_enter", "autorun", "parallel",
];

const RUN_RESOURCE_KINDS: ProjectResourceKind[] = ["action", "script", "map"];

function cloneMap(map: MapDef): MapDef {
  return structuredClone(map);
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
