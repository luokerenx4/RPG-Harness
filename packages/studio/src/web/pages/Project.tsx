import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  Condition,
  MapDef,
  MapEventTrigger,
  MapLayerDef,
  MapPlacementEventDef,
  MapPlacementDef,
  MapLayoutDef,
  ProjectResourceKind,
  ProjectResourceNode,
  SwitchDef,
  VariableDef,
} from "@rpg-harness/engine";
import { collectMapImageLayers, isMapPlacementLayerVisible, mapLayerDisplayOrder, mapPlacementDisplayOrder, mapPlayerDisplayOrder } from "@rpg-harness/engine";
import {
  fetchProject,
  fetchMapPreview,
  fetchResourceSource,
  createProjectResource,
  duplicateProjectResource,
  fetchStudioTrash,
  planResourceRename,
  renameProjectResource,
  restoreStudioTrashEntry,
  trashProjectResource,
  saveMapSpatial,
  saveResourceSource,
  sourceImageUrl,
  type ProjectAssetPreview,
  type ProjectResponse,
  type MapPreviewResponse,
  type StudioTrashEntry,
  type ResourceRenamePlan,
} from "../api";
import { DraftNavigationDialog, type StudioDraftGuard } from "../DraftNavigationDialog";

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

const CREATABLE_SECTION_KINDS: Record<ProjectSection, ProjectResourceKind[]> = {
  world: ["map"],
  database: ["character", "item", "weapon", "skill", "enemy", "action"],
  story: ["script"],
  qa: [],
};

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

const REMOVABLE_KINDS = new Set<ProjectResourceKind>([
  "map",
  "character",
  "item",
  "weapon",
  "skill",
  "enemy",
  "action",
  "script",
]);

type ProjectNavigationIntent =
  | { kind: "select"; key: string; label: string }
  | { kind: "close"; key: string; label: string };

export function Project({
  onDraftGuardChange,
}: {
  onDraftGuardChange?: (guard: StudioDraftGuard | null) => void;
}) {
  const [project, setProject] = useState<ProjectResponse | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [openKeys, setOpenKeys] = useState<string[]>([]);
  const [section, setSection] = useState<ProjectSection>("world");
  const [collapsedKinds, setCollapsedKinds] = useState<Set<ProjectResourceKind>>(
    () => new Set(["manifest"]),
  );
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [draftActive, setDraftActive] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<ProjectNavigationIntent | null>(null);
  const [navigationSaving, setNavigationSaving] = useState(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [trashDialogOpen, setTrashDialogOpen] = useState(false);
  const [trashEntries, setTrashEntries] = useState<StudioTrashEntry[]>([]);
  const [lifecycleReceipt, setLifecycleReceipt] = useState<{ title: string; path: string } | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const resourceTreeRef = useRef<HTMLDivElement | null>(null);
  const draftGuardRef = useRef<StudioDraftGuard | null>(null);
  const createResourceButtonRef = useRef<HTMLButtonElement | null>(null);
  const trashButtonRef = useRef<HTMLButtonElement | null>(null);

  const closeCreateDialog = () => {
    setCreateDialogOpen(false);
    requestAnimationFrame(() => createResourceButtonRef.current?.focus());
  };

  const closeTrashDialog = () => {
    setTrashDialogOpen(false);
    requestAnimationFrame(() => trashButtonRef.current?.focus());
  };

  const handleDraftGuardChange = useCallback((guard: StudioDraftGuard | null) => {
    draftGuardRef.current = guard;
    setDraftActive(Boolean(guard));
    onDraftGuardChange?.(guard);
    if (!guard) {
      setPendingNavigation(null);
      setNavigationError(null);
    }
  }, [onDraftGuardChange]);

  useEffect(() => () => onDraftGuardChange?.(null), [onDraftGuardChange]);

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
    void fetchStudioTrash().then(setTrashEntries).catch(() => {});
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
  const mapById = useMemo(
    () => new Map((project?.maps ?? []).map((candidate) => [candidate.id, candidate])),
    [project],
  );

  if (error) return <div className="empty">⚠ {error}</div>;
  if (!project) return <div className="empty">loading project…</div>;

  const selected = project.graph.resources.find((row) => row.key === selectedKey);
  const map = selected?.kind === "map"
    ? project.maps.find((candidate) => candidate.id === selected.id)
    : undefined;
  const asset = selected?.kind === "asset"
    ? project.assets.find((candidate) => candidate.path === selected.id)
    : undefined;

  const commitSelectResource = (key: string) => {
    setSelectedKey(key);
    setOpenKeys((current) => current.includes(key) ? current : [...current.slice(-6), key]);
  };

  const selectResource = (key: string) => {
    if (draftActive && selectedKey && key !== selectedKey) {
      const label = project.graph.resources.find((resource) => resource.key === key)?.label ?? key;
      setNavigationError(null);
      setPendingNavigation({ kind: "select", key, label });
      return;
    }
    commitSelectResource(key);
  };

  const focusFirstResource = () => {
    resourceTreeRef.current?.querySelector<HTMLButtonElement>(".resource-row")?.focus();
  };

  const navigateResourceTree = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "].includes(event.key)) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(
      ".resource-group-heading, .resource-row",
    ));
    const target = event.target instanceof HTMLButtonElement ? event.target : null;
    if (!target || !buttons.includes(target)) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      target.click();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const expanded = target.getAttribute("aria-expanded");
      if (expanded !== null) {
        const shouldExpand = event.key === "ArrowRight";
        if ((expanded === "true") !== shouldExpand) {
          event.preventDefault();
          target.click();
        }
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        target.closest(".resource-group")?.querySelector<HTMLButtonElement>(".resource-group-heading")?.focus();
      }
      return;
    }
    event.preventDefault();
    const currentIndex = buttons.indexOf(target);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : nextProjectTreeIndex(currentIndex, buttons.length, event.key === "ArrowDown" ? 1 : -1);
    buttons[nextIndex]?.focus();
  };

  const commitCloseTab = (key: string) => {
    setOpenKeys((current) => {
      const next = current.filter((candidate) => candidate !== key);
      if (selectedKey === key) setSelectedKey(next.at(-1) ?? null);
      return next;
    });
  };

  const closeTab = (key: string) => {
    if (draftActive && selectedKey === key) {
      const label = project.graph.resources.find((resource) => resource.key === key)?.label ?? key;
      setNavigationError(null);
      setPendingNavigation({ kind: "close", key, label });
      return;
    }
    commitCloseTab(key);
  };

  const finishNavigation = (intent: ProjectNavigationIntent) => {
    setPendingNavigation(null);
    setNavigationError(null);
    if (intent.kind === "select") commitSelectResource(intent.key);
    else commitCloseTab(intent.key);
  };

  const handleResourceTrashed = (trashed: Awaited<ReturnType<typeof trashProjectResource>>) => {
    const previousSectionResources = project.graph.resources.filter((resource) =>
      SECTION_KINDS[section].includes(resource.kind)
    );
    const removedIndex = previousSectionResources.findIndex((resource) => resource.key === trashed.resource.key);
    const preferredKeys = [
      previousSectionResources[removedIndex + 1]?.key,
      previousSectionResources[removedIndex - 1]?.key,
    ].filter((key): key is string => Boolean(key));
    const next = preferredKeys
      .map((key) => trashed.project.graph.resources.find((resource) => resource.key === key))
      .find(Boolean) ?? trashed.project.graph.resources.find((resource) => SECTION_KINDS[section].includes(resource.kind))
      ?? trashed.project.graph.resources[0];
    setProject(trashed.project);
    setSelectedKey(next?.key ?? null);
    setOpenKeys((current) => {
      const remaining = current.filter((key) => key !== trashed.resource.key);
      return next && !remaining.includes(next.key) ? [...remaining.slice(-6), next.key] : remaining;
    });
    setLifecycleReceipt({ title: `${trashed.resource.label} moved to Studio Trash`, path: trashed.trashPath });
    void fetchStudioTrash().then(setTrashEntries).catch(() => {});
  };

  const handleResourceRestored = (restored: Awaited<ReturnType<typeof restoreStudioTrashEntry>>) => {
    setProject(restored.project);
    setTrashEntries((current) => current.filter((entry) => entry.trashPath !== restored.entry.trashPath));
    setSelectedKey(restored.resource.key);
    setOpenKeys((current) => current.includes(restored.resource.key)
      ? current
      : [...current.slice(-6), restored.resource.key]);
    const restoredSection = SECTION_META.find((candidate) =>
      SECTION_KINDS[candidate.id].includes(restored.resource.kind)
    )?.id;
    if (restoredSection) setSection(restoredSection);
    setQuery("");
    setLifecycleReceipt({ title: `${restored.resource.label} restored`, path: restored.entry.sourcePath });
  };

  const handleResourceRenamed = (renamed: Awaited<ReturnType<typeof renameProjectResource>>) => {
    const previousKey = renamed.plan.resource.key;
    setProject(renamed.project);
    setSelectedKey(renamed.resource.key);
    setOpenKeys((current) => current.map((key) => key === previousKey ? renamed.resource.key : key));
    setLifecycleReceipt({
      title: `${renamed.resource.label} refactored to ${renamed.resource.id}`,
      path: `${renamed.plan.files.length} files · ${renamed.plan.totalChanges} semantic changes`,
    });
  };

  const handleResourceDuplicated = (duplicated: Awaited<ReturnType<typeof duplicateProjectResource>>) => {
    setProject(duplicated.project);
    setSelectedKey(duplicated.resource.key);
    setOpenKeys((current) => current.includes(duplicated.resource.key)
      ? current
      : [...current.slice(-6), duplicated.resource.key]);
    setLifecycleReceipt({
      title: `${duplicated.resource.label} duplicated`,
      path: duplicated.source.path,
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
            onClick={() => { setSection(item.id); setQuery(""); setCreateDialogOpen(false); }}
          ><span>{item.icon}</span><small>{item.label}</small></button>
        ))}
      </nav>

      <aside className="project-explorer">
        <header className="explorer-heading">
          <div><span>PROJECT</span><strong>{SECTION_META.find((item) => item.id === section)?.label}</strong></div>
          <div className="explorer-heading-actions">
            <small>{project.graph.resources.length}</small>
            <button
              ref={trashButtonRef}
              type="button"
              className="explorer-trash-button"
              aria-label={`Open Studio Trash${trashEntries.length > 0 ? `, ${trashEntries.length} entries` : ", empty"}`}
              title={draftActive ? "Save or discard the current draft first" : "Studio Trash"}
              disabled={draftActive}
              onClick={() => setTrashDialogOpen(true)}
            ><span aria-hidden="true">♲</span>{trashEntries.length > 0 && <i>{trashEntries.length}</i>}</button>
            {CREATABLE_SECTION_KINDS[section].length > 0 && (
              <button
                ref={createResourceButtonRef}
                type="button"
                aria-label={`New ${SECTION_META.find((item) => item.id === section)?.label} resource`}
                title={draftActive ? "Save or discard the current draft first" : "Create resource"}
                disabled={draftActive}
                onClick={() => setCreateDialogOpen(true)}
              >＋</button>
            )}
          </div>
        </header>
        <label className="project-searchbox">
          <span aria-hidden="true">⌕</span>
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown") return;
              event.preventDefault();
              focusFirstResource();
            }}
            placeholder="Find anything"
            aria-label="Search project resources"
          />
          {query ? <button type="button" aria-label="Clear search" onClick={() => setQuery("")}>×</button> : <kbd>⌘K</kbd>}
        </label>
        <div ref={resourceTreeRef} className="resource-tree-scroll" role="tree" aria-label="Project resources" onKeyDown={navigateResourceTree}>
          {groups.length === 0 && <div className="tree-empty">No matching resources</div>}
          {groups.map(({ kind, rows }) => {
            const meta = KIND_META[kind] ?? { icon: "·", label: kind };
            const collapsed = query.length === 0 && collapsedKinds.has(kind);
            return (
              <section className="resource-group" key={kind}>
                <button
                  type="button"
                  className="resource-group-heading"
                  role="treeitem"
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
                {!collapsed && rows.map((resource) => {
                  const mapSummary = resource.kind === "map"
                    ? summarizeMapTreeResource(mapById.get(resource.id))
                    : null;
                  return <button
                    type="button"
                    role="treeitem"
                    draggable={PLACEABLE_KINDS.has(resource.kind)}
                    className={`resource-row ${mapSummary ? "map-resource-row" : ""} ${selectedKey === resource.key ? "selected" : ""}`}
                    key={resource.key}
                    aria-selected={selectedKey === resource.key}
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
                    <span className="resource-node-copy">
                      <strong>{resource.label}</strong>
                      <small>{resource.id}</small>
                      {mapSummary && <span className={mapSummary.spatial ? "resource-map-summary spatial" : "resource-map-summary"}>{mapSummary.label}</span>}
                    </span>
                    {project.graph.missing.some((entry) => entry.referencedBy.includes(resource.key)) && <i className="resource-problem" title="Missing reference">!</i>}
                  </button>;
                })}
              </section>
            );
          })}
        </div>
        <footer className="explorer-footer">
          <span>{groups.reduce((total, group) => total + group.rows.length, 0)} shown</span>
          <span>↑↓ Navigate · Enter Open</span>
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
                <button type="button" onClick={() => selectResource(key)}>
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
              asset={asset}
              projectAssets={project.assets}
              resources={project.graph.resources}
              switches={project.switches}
              variables={project.variables}
              backlinks={project.graph.backlinks[selected.key] ?? []}
              missing={project.graph.missing.filter((entry) => entry.referencedBy.includes(selected.key))}
              unreferenced={project.graph.unreferenced.includes(selected.key)}
              onProjectSaved={setProject}
              onDraftGuardChange={handleDraftGuardChange}
              draftActive={draftActive}
              onSelectResource={selectResource}
              onResourceTrashed={handleResourceTrashed}
              onResourceRenamed={handleResourceRenamed}
              onResourceDuplicated={handleResourceDuplicated}
            />
          ) : (
            <div className="editor-empty"><span>▦</span><strong>No resource open</strong><p>Select something in the Project tree.</p></div>
          )}
        </div>
      </section>
      {pendingNavigation && draftGuardRef.current && (
        <DraftNavigationDialog
          guard={draftGuardRef.current}
          destination={pendingNavigation.kind === "select" ? pendingNavigation.label : "another open resource"}
          saving={navigationSaving}
          error={navigationError}
          onStay={() => { setPendingNavigation(null); setNavigationError(null); }}
          onDiscard={() => {
            const guard = draftGuardRef.current;
            if (!guard) return;
            guard.discard();
            finishNavigation(pendingNavigation);
          }}
          onSave={() => {
            const guard = draftGuardRef.current;
            if (!guard) return;
            setNavigationSaving(true);
            setNavigationError(null);
            void guard.save().then((saved) => {
              if (saved) finishNavigation(pendingNavigation);
              else setNavigationError("The project rejected this draft. Review the validation message in the editor, then try again.");
            }).finally(() => setNavigationSaving(false));
          }}
        />
      )}
      {createDialogOpen && (
        <CreateResourceDialog
          kinds={CREATABLE_SECTION_KINDS[section]}
          assets={project.assets}
          onClose={closeCreateDialog}
          onCreated={(created) => {
            setProject(created.project);
            setCreateDialogOpen(false);
            commitSelectResource(created.resource.key);
          }}
        />
      )}
      {trashDialogOpen && (
        <StudioTrashDialog
          entries={trashEntries}
          onClose={closeTrashDialog}
          onRestored={handleResourceRestored}
        />
      )}
      {lifecycleReceipt && (
        <div className="resource-trash-receipt" role="status">
          <span aria-hidden="true">↶</span>
          <div><strong>{lifecycleReceipt.title}</strong><code>{lifecycleReceipt.path}</code></div>
          <button type="button" aria-label="Dismiss lifecycle receipt" onClick={() => setLifecycleReceipt(null)}>×</button>
        </div>
      )}
    </div>
  );
}

function StudioTrashDialog({
  entries,
  onClose,
  onRestored,
}: {
  entries: StudioTrashEntry[];
  onClose: () => void;
  onRestored: (restored: Awaited<ReturnType<typeof restoreStudioTrashEntry>>) => void;
}) {
  const [restoringPath, setRestoringPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const firstRestoreButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    (firstRestoreButtonRef.current ?? closeButtonRef.current)?.focus();
  }, []);

  const restore = async (entry: StudioTrashEntry) => {
    setRestoringPath(entry.trashPath);
    setError(null);
    try {
      onRestored(await restoreStudioTrashEntry(entry.trashPath));
      setRestoringPath(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setRestoringPath(null);
    }
  };
  const trapDialogFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="studio-trash-overlay" role="dialog" aria-modal="true" aria-labelledby="studio-trash-title" onClick={restoringPath ? undefined : onClose} onKeyDown={(event) => {
      if (event.key === "Escape" && !restoringPath) onClose();
    }}>
      <div ref={dialogRef} className="studio-trash-dialog" onClick={(event) => event.stopPropagation()} onKeyDown={trapDialogFocus}>
        <header><div><span>RECOVERY SHELF</span><strong id="studio-trash-title">Studio Trash</strong><small>Restore source files to their original project location, then validate the complete game before accepting them.</small></div><button ref={closeButtonRef} type="button" aria-label="Close Studio Trash" disabled={Boolean(restoringPath)} onClick={onClose}>×</button></header>
        <div className="studio-trash-body">
          {entries.length === 0 ? (
            <div className="studio-trash-empty"><i aria-hidden="true">♲</i><strong>Studio Trash is empty</strong><span>Resources moved from the Database or World editor will wait here for recovery.</span></div>
          ) : entries.map((entry, index) => {
            const meta = KIND_META[entry.kind] ?? { icon: "·", label: entry.kind };
            return (
              <article className="studio-trash-entry" key={entry.trashPath}>
                <i className={`kind-${entry.kind}`} aria-hidden="true">{meta.icon}</i>
                <div><span>{meta.label}</span><strong>{entry.label}</strong><code>{entry.sourcePath}</code><small>Moved {formatTrashDate(entry.deletedAt)}</small></div>
                <button ref={index === 0 ? firstRestoreButtonRef : undefined} type="button" disabled={Boolean(restoringPath)} onClick={() => void restore(entry)}>{restoringPath === entry.trashPath ? "Validating…" : "Restore"}</button>
              </article>
            );
          })}
          {error && <div className="studio-trash-error" role="alert"><strong>Restore failed</strong><span>{error}</span><small>The entry remains in Studio Trash.</small></div>}
        </div>
        <footer><span>{entries.length} RECOVERABLE {entries.length === 1 ? "RESOURCE" : "RESOURCES"}</span><button type="button" disabled={Boolean(restoringPath)} onClick={onClose}>Done</button></footer>
      </div>
    </div>
  );
}

function formatTrashDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function CreateResourceDialog({
  kinds,
  assets,
  onClose,
  onCreated,
}: {
  kinds: ProjectResourceKind[];
  assets: ProjectAssetPreview[];
  onClose: () => void;
  onCreated: (created: Awaited<ReturnType<typeof createProjectResource>>) => void;
}) {
  const initialKind = kinds[0] ?? "script";
  const [kind, setKind] = useState<ProjectResourceKind>(initialKind);
  const [label, setLabel] = useState("");
  const [id, setId] = useState(`new_${initialKind}`);
  const [mapMode, setMapMode] = useState<"node" | "spatial">("node");
  const [mapWidth, setMapWidth] = useState("14");
  const [mapHeight, setMapHeight] = useState("10");
  const [mapTileset, setMapTileset] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const idValid = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id);
  const mapSizeValid = mapMode === "node" || (
    Number.isInteger(Number(mapWidth)) && Number(mapWidth) >= 2 && Number(mapWidth) <= 200 &&
    Number.isInteger(Number(mapHeight)) && Number(mapHeight) >= 2 && Number(mapHeight) <= 200
  );
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!label.trim() || !idValid || !mapSizeValid || creating) return;
    setCreating(true);
    setError(null);
    try {
      onCreated(await createProjectResource(kind, id, label, kind === "map" && mapMode === "spatial" ? {
        mapLayout: {
          width: Number(mapWidth),
          height: Number(mapHeight),
          ...(mapTileset ? { tileset: mapTileset } : {}),
        },
      } : {}));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setCreating(false);
    }
  };
  const trapDialogFocus = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="create-resource-overlay" role="dialog" aria-modal="true" aria-labelledby="create-resource-title" onClick={creating ? undefined : onClose} onKeyDown={(event) => {
      if (event.key === "Escape" && !creating) onClose();
    }}>
      <form ref={dialogRef} className="create-resource-dialog" onSubmit={(event) => void submit(event)} onClick={(event) => event.stopPropagation()} onKeyDown={trapDialogFocus}>
        <header>
          <div><span>NEW DATABASE RECORD</span><strong id="create-resource-title">Create project resource</strong><small>A validated standalone source file will become authoritative immediately. Scripts and actions start runtime-gated.</small></div>
          <button type="button" aria-label="Close new resource dialog" disabled={creating} onClick={onClose}>×</button>
        </header>
        <div className="create-resource-body">
          <label><span>Resource type</span><select value={kind} onChange={(event) => {
            const next = event.target.value as ProjectResourceKind;
            setId((current) => current === `new_${kind}` ? `new_${next}` : current);
            setKind(next);
          }}>{kinds.map((candidate) => <option value={candidate} key={candidate}>{KIND_META[candidate]?.label ?? candidate}</option>)}</select></label>
          {kind === "map" && <fieldset className="create-map-preset"><legend>Map topology</legend>
            <div className="create-map-mode" role="radiogroup" aria-label="Map topology">
              <button type="button" role="radio" aria-checked={mapMode === "node"} className={mapMode === "node" ? "selected" : ""} onClick={() => setMapMode("node")}><i aria-hidden="true">◇</i><span><strong>Node Map</strong><small>era-style location · connections and activities</small></span></button>
              <button type="button" role="radio" aria-checked={mapMode === "spatial"} className={mapMode === "spatial" ? "selected" : ""} onClick={() => setMapMode("spatial")}><i aria-hidden="true">▦</i><span><strong>2D Map</strong><small>RPG field · terrain, collision and objects</small></span></button>
            </div>
            {mapMode === "spatial" && <div className="create-map-layout-fields">
              <label><span>Width</span><input type="number" min="2" max="200" value={mapWidth} aria-invalid={!mapSizeValid} onChange={(event) => setMapWidth(event.target.value)} /></label>
              <label><span>Height</span><input type="number" min="2" max="200" value={mapHeight} aria-invalid={!mapSizeValid} onChange={(event) => setMapHeight(event.target.value)} /></label>
              <label><span>Tileset</span><select value={mapTileset} onChange={(event) => setMapTileset(event.target.value)}><option value="">Procedural colors</option>{assets.filter((asset) => asset.kind === "tileset").map((asset) => <option value={asset.path} key={asset.path}>{asset.placeholder}</option>)}</select></label>
              <small>Starts at the center with Ground, Collision and Objects layers. Everything remains editable after creation.</small>
            </div>}
          </fieldset>}
          <label><span>Display name</span><input autoFocus maxLength={160} required value={label} placeholder="What authors and players will see" onChange={(event) => setLabel(event.target.value)} /></label>
          <label><span>Stable ID</span><input value={id} maxLength={80} aria-invalid={!idValid} onChange={(event) => setId(event.target.value)} /><small>ASCII letters, numbers, dashes and underscores. This becomes the filename and resource key.</small></label>
          {error && <div className="create-resource-error" role="alert"><strong>Creation failed</strong><span>{error}</span><small>No partial resource was kept.</small></div>}
        </div>
        <footer>
          <span>FILES ARE AUTHORITATIVE · VALIDATE BEFORE COMMIT</span>
          <div><button type="button" disabled={creating} onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={!label.trim() || !idValid || !mapSizeValid || creating}>{creating ? "Validating…" : kind === "map" && mapMode === "spatial" ? "Create 2D map" : "Create record"}</button></div>
        </footer>
      </form>
    </div>
  );
}

function ResourceDetail({
  node,
  map,
  asset,
  projectAssets,
  resources,
  switches,
  variables,
  backlinks,
  missing,
  unreferenced,
  onProjectSaved,
  onDraftGuardChange,
  draftActive,
  onSelectResource,
  onResourceTrashed,
  onResourceRenamed,
  onResourceDuplicated,
}: {
  node: ProjectResourceNode;
  map?: MapDef;
  asset?: ProjectAssetPreview;
  projectAssets: ProjectAssetPreview[];
  resources: ProjectResourceNode[];
  switches: SwitchDef[];
  variables: VariableDef[];
  backlinks: string[];
  missing: Array<{ key: string; referencedBy: string[] }>;
  unreferenced: boolean;
  onProjectSaved: (project: ProjectResponse) => void;
  onDraftGuardChange: (guard: StudioDraftGuard | null) => void;
  draftActive: boolean;
  onSelectResource: (key: string) => void;
  onResourceTrashed: (trashed: Awaited<ReturnType<typeof trashProjectResource>>) => void;
  onResourceRenamed: (renamed: Awaited<ReturnType<typeof renameProjectResource>>) => void;
  onResourceDuplicated: (duplicated: Awaited<ReturnType<typeof duplicateProjectResource>>) => void;
}) {
  const meta = KIND_META[node.kind] ?? { icon: "·", label: node.kind };
  const [sourceEditKey, setSourceEditKey] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(() => map === undefined);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsButtonRef = useRef<HTMLButtonElement>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const adjacent = adjacentResourceKeys(resources, node.key);
  const resourceActionsAvailable = REMOVABLE_KINDS.has(node.kind) && Boolean(node.source) && node.editable !== false;

  useEffect(() => {
    setInspectorOpen(map === undefined);
    workspaceRef.current?.scrollTo({ top: 0, left: 0 });
    editorRef.current?.scrollTo({ top: 0, left: 0 });
    inspectorRef.current?.scrollTo({ top: 0, left: 0 });
  }, [node.key, map === undefined]);

  useEffect(() => {
    setDeleteOpen(false);
    setRenameOpen(false);
    setDuplicateOpen(false);
    setActionsOpen(false);
  }, [node.key]);

  useEffect(() => {
    if (!actionsOpen) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && !actionsMenuRef.current?.contains(target)) setActionsOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [actionsOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "d" &&
        resourceActionsAvailable &&
        !draftActive &&
        !deleteOpen &&
        !renameOpen &&
        !duplicateOpen &&
        !target?.matches("input, textarea, select, [contenteditable='true']")
      ) {
        event.preventDefault();
        setActionsOpen(false);
        setDuplicateOpen(true);
        return;
      }
      if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      const key = event.key === "ArrowLeft" ? adjacent.previous?.key : adjacent.next?.key;
      if (!key) return;
      event.preventDefault();
      onSelectResource(key);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [adjacent.previous?.key, adjacent.next?.key, deleteOpen, draftActive, duplicateOpen, onSelectResource, renameOpen, resourceActionsAvailable]);

  const openActionsMenu = () => {
    setActionsOpen(true);
    requestAnimationFrame(() => actionsMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
  };
  const closeResourceDialog = (setter: (open: boolean) => void) => {
    setter(false);
    requestAnimationFrame(() => actionsButtonRef.current?.focus());
  };
  const navigateActionsMenu = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!actionsOpen || !["ArrowDown", "ArrowUp", "Home", "End", "Escape"].includes(event.key)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setActionsOpen(false);
      actionsButtonRef.current?.focus();
      return;
    }
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
    if (buttons.length === 0) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : nextProjectTreeIndex(current, buttons.length, event.key === "ArrowDown" ? 1 : -1);
    buttons[next]?.focus();
  };

  return (
    <div ref={workspaceRef} className={`resource-workspace${inspectorOpen ? "" : " inspector-collapsed"}`}>
      <main ref={editorRef} className="resource-editor-pane">
        <header className="resource-editor-heading">
          <div className={`resource-editor-icon kind-${node.kind}`}>{meta.icon}</div>
          <div><span>{meta.label}</span><h1>{node.label}</h1><code>{node.key}</code></div>
          <div className="resource-editor-heading-actions">
            <nav className="resource-sibling-nav" aria-label={`${meta.label} records`}>
              <button
                type="button"
                disabled={!adjacent.previous}
                aria-label={`Previous ${singularResourceLabel(meta.label)}${adjacent.previous ? `: ${adjacent.previous.label}` : ""}`}
                aria-keyshortcuts="Alt+ArrowLeft"
                onClick={() => adjacent.previous && onSelectResource(adjacent.previous.key)}
              >‹</button>
              <span>{adjacent.position + 1} / {adjacent.total}</span>
              <button
                type="button"
                disabled={!adjacent.next}
                aria-label={`Next ${singularResourceLabel(meta.label)}${adjacent.next ? `: ${adjacent.next.label}` : ""}`}
                aria-keyshortcuts="Alt+ArrowRight"
                onClick={() => adjacent.next && onSelectResource(adjacent.next.key)}
              >›</button>
            </nav>
            {resourceActionsAvailable && (
              <div ref={actionsMenuRef} className="resource-actions-menu" onKeyDown={navigateActionsMenu}>
                <button
                  ref={actionsButtonRef}
                  type="button"
                  className="resource-actions-trigger"
                  aria-haspopup="menu"
                  aria-expanded={actionsOpen}
                  disabled={draftActive}
                  title={draftActive ? "Save or discard the current draft first" : "Resource actions"}
                  onClick={() => actionsOpen ? setActionsOpen(false) : openActionsMenu()}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowDown") return;
                    event.preventDefault();
                    openActionsMenu();
                  }}
                ><span aria-hidden="true">•••</span>Actions</button>
                {actionsOpen && (
                  <div className="resource-actions-popover" role="menu" aria-label={`${node.label} actions`}>
                    <header><span>RECORD</span><strong>{node.id}</strong></header>
                    <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); setDuplicateOpen(true); }}><i aria-hidden="true">⧉</i><span><strong>Duplicate</strong><small>Copy as a new record</small></span><kbd>⌘D</kbd></button>
                    <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); setRenameOpen(true); }}><i aria-hidden="true">⌘</i><span><strong>Rename ID</strong><small>Rewrite semantic references</small></span></button>
                    <hr />
                    <button type="button" role="menuitem" className="danger" onClick={() => { setActionsOpen(false); setDeleteOpen(true); }}><i aria-hidden="true">⌫</i><span><strong>Move to Trash</strong><small>Recoverable project move</small></span></button>
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              className="editor-inspector-toggle"
              aria-pressed={inspectorOpen}
              onClick={() => setInspectorOpen((current) => !current)}
            ><span aria-hidden="true">◫</span>{inspectorOpen ? "Hide Inspector" : "Show Inspector"}</button>
          </div>
        </header>
        {map ? (
          <MapOverview map={map} assets={projectAssets} resources={resources} switches={switches} variables={variables} onProjectSaved={onProjectSaved} onDraftGuardChange={onDraftGuardChange} />
        ) : (
          <ResourceRecordEditor
            node={node}
            icon={meta.icon}
            kindLabel={meta.label}
            asset={asset}
            projectAssets={projectAssets}
            resources={resources}
            onProjectSaved={onProjectSaved}
            onDraftGuardChange={onDraftGuardChange}
            draftBlocked={draftActive}
            onSelectResource={onSelectResource}
            onEditSource={node.source && node.editable !== false
              ? () => setSourceEditKey(node.key)
              : undefined}
          />
        )}
      </main>

      <aside ref={inspectorRef} className="resource-inspector">
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
            onDraftGuardChange={onDraftGuardChange}
            draftBlocked={draftActive}
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
        <ReferenceList title="References" values={node.refs} resources={resources} onSelectResource={onSelectResource} />
        <ReferenceList title="Used by" values={backlinks} resources={resources} onSelectResource={onSelectResource} />
      </aside>
      {deleteOpen && (
        <DeleteResourceDialog
          node={node}
          blockers={backlinks}
          resources={resources}
          onClose={() => {
            closeResourceDialog(setDeleteOpen);
          }}
          onTrashed={(trashed) => {
            setDeleteOpen(false);
            onResourceTrashed(trashed);
          }}
          onOpenBlocker={(key) => {
            setDeleteOpen(false);
            onSelectResource(key);
          }}
        />
      )}
      {renameOpen && (
        <RenameResourceDialog
          node={node}
          onClose={() => {
            closeResourceDialog(setRenameOpen);
          }}
          onRenamed={(renamed) => {
            setRenameOpen(false);
            onResourceRenamed(renamed);
          }}
        />
      )}
      {duplicateOpen && (
        <DuplicateResourceDialog
          node={node}
          onClose={() => closeResourceDialog(setDuplicateOpen)}
          onDuplicated={(duplicated) => {
            setDuplicateOpen(false);
            onResourceDuplicated(duplicated);
          }}
        />
      )}
    </div>
  );
}

function DuplicateResourceDialog({
  node,
  onClose,
  onDuplicated,
}: {
  node: ProjectResourceNode;
  onClose: () => void;
  onDuplicated: (duplicated: Awaited<ReturnType<typeof duplicateProjectResource>>) => void;
}) {
  const [newId, setNewId] = useState(`${node.id}_copy`.slice(0, 80));
  const [label, setLabel] = useState(`${node.label} Copy`.slice(0, 160));
  const [duplicating, setDuplicating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const idValid = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(newId) && newId !== node.id;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!idValid || !label.trim() || duplicating) return;
    setDuplicating(true);
    setError(null);
    try {
      onDuplicated(await duplicateProjectResource(node.kind, node.id, newId, label));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setDuplicating(false);
    }
  };
  const trapDialogFocus = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="duplicate-resource-overlay" role="dialog" aria-modal="true" aria-labelledby="duplicate-resource-title" onClick={duplicating ? undefined : onClose} onKeyDown={(event) => {
      if (event.key === "Escape" && !duplicating) onClose();
    }}>
      <form ref={dialogRef} className="duplicate-resource-dialog" onSubmit={(event) => void submit(event)} onClick={(event) => event.stopPropagation()} onKeyDown={trapDialogFocus}>
        <header><div><span>DATABASE COPY</span><strong id="duplicate-resource-title">Duplicate project resource</strong><small>Copy the authoritative record, assign a new identity, update self-references, and validate it as part of the complete game.</small></div><button type="button" aria-label="Close duplicate resource dialog" disabled={duplicating} onClick={onClose}>×</button></header>
        <div className="duplicate-resource-body">
          <div className="duplicate-resource-origin"><i aria-hidden="true">⧉</i><div><span>{node.kind.toUpperCase()}</span><strong>{node.label}</strong><code>{node.key}</code><small>{node.source}</small></div></div>
          <label><span>New stable ID</span><input ref={inputRef} value={newId} maxLength={80} aria-invalid={!idValid} autoComplete="off" onChange={(event) => setNewId(event.target.value)} /><small>The copy becomes authoritative immediately and keeps the original activation conditions.</small></label>
          <label><span>Display name</span><input value={label} maxLength={160} onChange={(event) => setLabel(event.target.value)} /></label>
          {error && <div className="duplicate-resource-error" role="alert"><strong>Duplicate failed</strong><span>{error}</span><small>No partial source file was kept.</small></div>}
        </div>
        <footer><span>COPY SOURCE · RETARGET SELF REFERENCES · VALIDATED RELOAD</span><div><button type="button" disabled={duplicating} onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={!idValid || !label.trim() || duplicating}>{duplicating ? "Validating…" : "Duplicate record"}</button></div></footer>
      </form>
    </div>
  );
}

function RenameResourceDialog({
  node,
  onClose,
  onRenamed,
}: {
  node: ProjectResourceNode;
  onClose: () => void;
  onRenamed: (renamed: Awaited<ReturnType<typeof renameProjectResource>>) => void;
}) {
  const [newId, setNewId] = useState(node.id);
  const [plan, setPlan] = useState<ResourceRenamePlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const idValid = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(newId);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    setPlan(null);
    setError(null);
    if (!idValid || newId === node.id) {
      setPlanning(false);
      return;
    }
    let cancelled = false;
    setPlanning(true);
    const timer = window.setTimeout(() => {
      void planResourceRename(node.kind, node.id, newId)
        .then((next) => {
          if (!cancelled) setPlan(next);
        })
        .catch((cause) => {
          if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          if (!cancelled) setPlanning(false);
        });
    }, 240);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [idValid, newId, node.id, node.kind]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!plan || plan.blockers.length > 0 || renaming) return;
    setRenaming(true);
    setError(null);
    try {
      onRenamed(await renameProjectResource(node.kind, node.id, newId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setRenaming(false);
    }
  };
  const trapDialogFocus = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="rename-resource-overlay" role="dialog" aria-modal="true" aria-labelledby="rename-resource-title" onClick={renaming ? undefined : onClose} onKeyDown={(event) => {
      if (event.key === "Escape" && !renaming) onClose();
    }}>
      <form ref={dialogRef} className="rename-resource-dialog" onSubmit={(event) => void submit(event)} onClick={(event) => event.stopPropagation()} onKeyDown={trapDialogFocus}>
        <header><div><span>DATABASE REFACTOR</span><strong id="rename-resource-title">Rename stable resource ID</strong><small>Studio rewrites only engine-proven semantic references, renames the authoritative source when applicable, then reloads the complete game atomically.</small></div><button type="button" aria-label="Close rename resource dialog" disabled={renaming} onClick={onClose}>×</button></header>
        <div className="rename-resource-body">
          <div className="rename-resource-identity"><i aria-hidden="true">⌘</i><div><span>{node.kind.toUpperCase()}</span><strong>{node.label}</strong><code>{node.id}</code></div><b aria-hidden="true">→</b><label><span>NEW STABLE ID</span><input ref={inputRef} value={newId} maxLength={80} aria-invalid={!idValid} autoComplete="off" onChange={(event) => setNewId(event.target.value)} /></label></div>
          {!idValid && <div className="rename-resource-hint invalid">Use 1–80 ASCII letters, numbers, dashes or underscores.</div>}
          {idValid && newId === node.id && <div className="rename-resource-hint">Enter a different stable ID to build the refactor plan.</div>}
          {planning && <div className="rename-resource-planning"><span>◌</span>Tracing semantic references…</div>}
          {plan && (
            <div className="rename-resource-plan">
              <header><div><span>REFACTOR PLAN</span><strong>{plan.files.length} files</strong></div><b>{plan.totalChanges} semantic changes</b></header>
              <div className="rename-resource-files">{plan.files.map((file) => (
                <article key={file.key}><i aria-hidden="true">{KIND_META[file.kind as ProjectResourceKind]?.icon ?? "·"}</i><div><strong>{file.label}</strong><code>{file.path}{file.destinationPath ? ` → ${file.destinationPath}` : ""}</code></div><b>{file.changes}</b></article>
              ))}</div>
            </div>
          )}
          {plan && plan.blockers.length > 0 && <div className="rename-resource-blockers" role="alert"><strong>Manual changes required</strong><span>Studio will not start the refactor while any source is unsafe:</span>{plan.blockers.map((blocker) => <div key={blocker.key}><code>{blocker.key}</code><small>{blocker.reason}</small></div>)}</div>}
          {error && <div className="rename-resource-error" role="alert"><strong>Refactor failed</strong><span>{error}</span><small>All authoritative files remain at their previous identity.</small></div>}
        </div>
        <footer><span>STRUCTURED REWRITE · CONFLICT CHECK · ATOMIC ROLLBACK</span><div><button type="button" disabled={renaming} onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={!plan || plan.blockers.length > 0 || renaming}>{renaming ? "Validating…" : plan?.blockers.length ? "Resolve blockers first" : plan ? `Rename & rewrite ${plan.totalChanges}` : "Build a valid plan"}</button></div></footer>
      </form>
    </div>
  );
}

function DeleteResourceDialog({
  node,
  blockers,
  resources,
  onClose,
  onTrashed,
  onOpenBlocker,
}: {
  node: ProjectResourceNode;
  blockers: string[];
  resources: ProjectResourceNode[];
  onClose: () => void;
  onTrashed: (trashed: Awaited<ReturnType<typeof trashProjectResource>>) => void;
  onOpenBlocker: (key: string) => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const confirmationInputRef = useRef<HTMLInputElement>(null);
  const blocked = blockers.length > 0;
  const confirmed = confirmation === node.id;

  useEffect(() => {
    (blocked ? closeButtonRef.current : confirmationInputRef.current)?.focus();
  }, [blocked]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (blocked || !confirmed || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      onTrashed(await trashProjectResource(node.kind, node.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setDeleting(false);
    }
  };
  const trapDialogFocus = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="delete-resource-overlay" role="dialog" aria-modal="true" aria-labelledby="delete-resource-title" onClick={deleting ? undefined : onClose} onKeyDown={(event) => {
      if (event.key === "Escape" && !deleting) onClose();
    }}>
      <form ref={dialogRef} className="delete-resource-dialog" onSubmit={(event) => void submit(event)} onClick={(event) => event.stopPropagation()} onKeyDown={trapDialogFocus}>
        <header>
          <div><span>RESOURCE LIFECYCLE</span><strong id="delete-resource-title">Move resource to Studio Trash?</strong><small>The source file stays recoverable inside this project. Studio reloads the whole game and restores it automatically if validation fails.</small></div>
          <button ref={closeButtonRef} type="button" aria-label="Close delete resource dialog" disabled={deleting} onClick={onClose}>×</button>
        </header>
        <div className="delete-resource-body">
          <div className="delete-resource-summary"><i aria-hidden="true">⌫</i><div><span>{node.kind.toUpperCase()}</span><strong>{node.label}</strong><code>{node.key}</code><small>{node.source}</small></div></div>
          {blocked ? (
            <div className="delete-resource-blockers" role="alert"><strong>Referenced resources cannot be moved</strong><span>Open a source below and remove its inbound reference first:</span><ul>{blockers.map((key) => <li key={key}><ResourceReference value={key} resources={resources} compact onSelectResource={onOpenBlocker} /></li>)}</ul></div>
          ) : (
            <label><span>Type <code>{node.id}</code> to confirm</span><input ref={confirmationInputRef} autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
          )}
          {error && <div className="delete-resource-error" role="alert"><strong>Move failed</strong><span>{error}</span><small>The authoritative source file was not removed.</small></div>}
        </div>
        <footer><span>RECOVERABLE MOVE · REFERENCE SAFE · VALIDATED RELOAD</span><div><button type="button" disabled={deleting} onClick={onClose}>Cancel</button><button type="submit" className="danger" disabled={blocked || !confirmed || deleting}>{deleting ? "Validating…" : blocked ? "Resolve references first" : "Move to Studio Trash"}</button></div></footer>
      </form>
    </div>
  );
}

function ResourceRecordEditor({
  node,
  icon,
  kindLabel,
  asset,
  projectAssets,
  resources,
  onProjectSaved,
  onDraftGuardChange,
  draftBlocked,
  onSelectResource,
  onEditSource,
}: {
  node: ProjectResourceNode;
  icon: string;
  kindLabel: string;
  asset?: ProjectAssetPreview;
  projectAssets: ProjectAssetPreview[];
  resources: ProjectResourceNode[];
  onProjectSaved: (project: ProjectResponse) => void;
  onDraftGuardChange: (guard: StudioDraftGuard | null) => void;
  draftBlocked: boolean;
  onSelectResource: (key: string) => void;
  onEditSource?: () => void;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});

  useEffect(() => {
    let cancelled = false;
    setSource(null);
    setLoadError(null);
    setSaveError(null);
    setEditing(false);
    setConfirmCancel(false);
    setDraft({});
    if (!node.source) return () => { cancelled = true; };
    void fetchResourceSource(node.kind, node.id)
      .then((result) => {
        if (!cancelled) setSource(result.source);
      })
      .catch((cause) => {
        if (!cancelled) setLoadError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, [node]);

  const summary = useMemo(() => source ? summarizeResourceSource(source) : null, [source]);
  const fields = useMemo(() => {
    const parsed = source ? parseResourceScalarFields(source) : [];
    if (node.kind !== "character" || parsed.some((field) => field.key === "map_sprite")) return parsed;
    return [...parsed, { key: "map_sprite", kind: "text" as const, value: "", displayValue: "System marker", editable: true }];
  }, [source, node.kind]);
  const editableFields = fields.filter((field) => field.editable);
  const dirty = editableFields.some((field) => draft[field.key] !== field.value);
  const invalid = editableFields.some((field) =>
    field.kind === "number" && !Number.isFinite(Number(draft[field.key])),
  );

  const beginRecordEdit = () => {
    setDraft(Object.fromEntries(editableFields.map((field) => [field.key, field.value])));
    setSaveError(null);
    setEditing(true);
  };

  const discardRecord = () => {
    setEditing(false);
    setDraft({});
    setSaveError(null);
    setConfirmCancel(false);
  };

  const saveRecord = async () => {
    if (!source || !dirty || invalid) return false;
    setSaving(true);
    setSaveError(null);
    try {
      const nextSource = patchResourceScalarFields(source, draft);
      const result = await saveResourceSource(node.kind, node.id, nextSource);
      setSource(result.source);
      setEditing(false);
      setDraft({});
      onProjectSaved(result.project);
      setConfirmCancel(false);
      return true;
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    onDraftGuardChange(editing && dirty ? {
      label: `${singularResourceLabel(kindLabel)} · ${node.label}`,
      save: saveRecord,
      discard: discardRecord,
    } : null);
  }, [editing, dirty, invalid, saving, source, draft, node.key, node.label, kindLabel, onDraftGuardChange]);

  useEffect(() => () => onDraftGuardChange(null), [onDraftGuardChange]);

  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        if (dirty) setConfirmCancel(true);
        else discardRecord();
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
              <button type="button" disabled={saving} onClick={() => dirty ? setConfirmCancel(true) : discardRecord()}>Cancel</button>
            </>
          ) : (
            <>
              {editableFields.length > 0 && <button type="button" className="primary" disabled={draftBlocked} onClick={beginRecordEdit}>Edit record</button>}
              {onEditSource && <button type="button" disabled={draftBlocked} onClick={onEditSource}>Source</button>}
            </>
          )}
        </div>
      </header>
      <div className="record-hero">
        <div className={`record-hero-icon${asset ? " has-asset-preview" : ""}`}>
          {asset?.renderings.source
            ? <img src={sourceImageUrl(asset.path)} alt={asset.placeholder} loading="lazy" />
            : icon}
        </div>
        <div>
          <span>{node.kind}</span><h2>{node.label}</h2><code>{node.id}</code>
          {asset && (
            <div className="record-rendering-flags" aria-label="Asset rendering availability">
              <span className={asset.renderings.source ? "present" : ""}>SRC</span>
              <span className={asset.renderings.tuiAns || asset.renderings.tuiTxt ? "present" : ""}>TUI</span>
              <span className={asset.renderings.web ? "present" : ""}>WEB</span>
            </div>
          )}
        </div>
        <span className="record-authority"><i /> AUTHORITATIVE</span>
      </div>
      {!node.source ? (
        <div className="record-message"><strong>Virtual resource</strong><span>This record is provided by project code and has no standalone source document.</span></div>
      ) : loadError ? (
        <div className="record-message error"><strong>Source preview unavailable</strong><span>{loadError}</span></div>
      ) : !summary ? (
        <div className="record-loading"><i /><span>Reading source record…</span></div>
      ) : (
        <div className="record-body">
          {saveError && <div className="record-save-error" role="alert"><strong>Changes rejected · draft preserved</strong><span>{saveError}</span></div>}
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
                    ) : field.key === "map_sprite" ? (
                      <select value={String(draft[field.key] ?? "")} onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))}>
                        <option value="">System marker</option>
                        {projectAssets.filter((candidate) => candidate.kind === "sprite").map((candidate) => <option value={candidate.path} key={candidate.path}>{candidate.placeholder} · {candidate.path}</option>)}
                      </select>
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
              <div className="record-links">{node.refs.map((ref) => (
                <ResourceReference
                  compact
                  key={ref}
                  value={ref}
                  resources={resources}
                  onSelectResource={onSelectResource}
                />
              ))}</div>
            </section>
          )}
        </div>
      )}
      {confirmCancel && (
        <DraftNavigationDialog
          guard={{ label: `${singularResourceLabel(kindLabel)} · ${node.label}`, save: saveRecord, discard: discardRecord }}
          destination="record preview"
          saving={saving}
          error={saveError}
          onStay={() => setConfirmCancel(false)}
          onDiscard={discardRecord}
          onSave={() => { void saveRecord().then((saved) => { if (saved) setConfirmCancel(false); }); }}
        />
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
  const next = lines.flatMap((line, index) => {
    if (index < start || index >= end) return line;
    const match = line.match(/^([A-Za-z0-9_.-]+):(\s*)(.*)$/);
    const key = match?.[1];
    if (!key || !Object.prototype.hasOwnProperty.call(values, key)) return line;
    const field = fields.get(key);
    if (!field?.editable) return line;
    if (key === "map_sprite" && values[key] === "") return [];
    const suffix = splitInlineYamlComment(match[3] ?? "");
    const serialized = serializeResourceScalar(values[key]!, field.kind, suffix.value.trim());
    return `${key}:${match[2] || " "}${serialized}${suffix.comment ? ` ${suffix.comment}` : ""}`;
  });
  const additions = Object.entries(values).flatMap(([key, value]) =>
    fields.has(key) || value === "" ? [] : [`${key}: ${serializeResourceScalar(value, "text", "")}`]
  );
  const insertion = lines[0]?.trim() === "---" ? end : next.length;
  next.splice(insertion, 0, ...additions);
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
  onDraftGuardChange,
  draftBlocked,
  openRequested = false,
  onOpenHandled,
}: {
  node: ProjectResourceNode;
  onProjectSaved: (project: ProjectResponse) => void;
  onDraftGuardChange: (guard: StudioDraftGuard | null) => void;
  draftBlocked: boolean;
  openRequested?: boolean;
  onOpenHandled?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [source, setSource] = useState("");
  const [savedSource, setSavedSource] = useState("");
  const [sourcePath, setSourcePath] = useState(node.source ?? "");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = editing && source !== savedSource;

  useEffect(() => {
    setEditing(false);
    setSource("");
    setSavedSource("");
    setSourcePath(node.source ?? "");
    setConfirmCancel(false);
    setError(null);
  }, [node.key, node.source]);

  const begin = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchResourceSource(node.kind, node.id);
      setSource(result.source);
      setSavedSource(result.source);
      setSourcePath(result.path);
      setEditing(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!openRequested || editing || loading || draftBlocked) return;
    onOpenHandled?.();
    void begin();
  }, [openRequested, editing, loading, draftBlocked]);

  const discardSource = () => {
    setSource(savedSource);
    setEditing(false);
    setError(null);
    setConfirmCancel(false);
  };

  const save = async () => {
    if (!dirty) return false;
    setSaving(true);
    setError(null);
    try {
      const result = await saveResourceSource(node.kind, node.id, source);
      setSource(result.source);
      setSavedSource(result.source);
      setSourcePath(result.path);
      onProjectSaved(result.project);
      setEditing(false);
      setConfirmCancel(false);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    onDraftGuardChange(dirty ? {
      label: `Source · ${node.label}`,
      save,
      discard: discardSource,
    } : null);
  }, [dirty, saving, source, savedSource, node.key, node.label, onDraftGuardChange]);

  useEffect(() => () => onDraftGuardChange(null), [onDraftGuardChange]);

  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        if (dirty) setConfirmCancel(true);
        else discardSource();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!saving && dirty) void save();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing, saving, dirty, source, savedSource]);

  return (
    <>
    {editing && (
      <button
        type="button"
        className="source-editor-backdrop"
        aria-label="Close source editor"
        onClick={() => {
          if (saving) return;
          if (dirty) setConfirmCancel(true);
          else discardSource();
        }}
      />
    )}
    <section className={`detail-section resource-source-editor ${editing ? "is-editing" : ""}`}>
      <header>
        <div><h2>Source file</h2><code>{sourcePath}</code></div>
        {!editing ? (
          <button type="button" disabled={loading || draftBlocked} onClick={begin}>
            {loading ? "Loading…" : draftBlocked ? "Finish active draft" : "Edit source"}
          </button>
        ) : (
          <div>
            <span className={`source-dirty-state ${dirty ? "dirty" : "clean"}`}><i />{dirty ? "UNSAVED" : "NO CHANGES"}</span>
            <button type="button" className="primary" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? "Validating…" : "Save & validate  ⌘S"}
            </button>
            <button type="button" disabled={saving} onClick={() => dirty ? setConfirmCancel(true) : discardSource()}>Cancel  Esc</button>
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
      {confirmCancel && (
        <DraftNavigationDialog
          guard={{ label: `Source · ${node.label}`, save, discard: discardSource }}
          destination="source preview"
          saving={saving}
          error={error}
          onStay={() => setConfirmCancel(false)}
          onDiscard={discardSource}
          onSave={() => { void save().then((saved) => { if (saved) setConfirmCancel(false); }); }}
        />
      )}
    </section>
    </>
  );
}

function ReferenceList({
  title,
  values,
  resources,
  onSelectResource,
}: {
  title: string;
  values: string[];
  resources: ProjectResourceNode[];
  onSelectResource: (key: string) => void;
}) {
  return (
    <section className="detail-section reference-list">
      <h2>{title} · {values.length}</h2>
      {values.length === 0
        ? <span className="muted">none</span>
        : <div className="reference-list-items">{values.map((value) => (
          <ResourceReference
            key={value}
            value={value}
            resources={resources}
            onSelectResource={onSelectResource}
          />
        ))}</div>}
    </section>
  );
}

function ResourceReference({
  value,
  resources,
  onSelectResource,
  compact = false,
}: {
  value: string;
  resources: ProjectResourceNode[];
  onSelectResource: (key: string) => void;
  compact?: boolean;
}) {
  const resource = resolveProjectReference(resources, value);
  if (!resource) return <code className="resource-reference-missing">{value}</code>;
  const meta = KIND_META[resource.kind] ?? { icon: "·", label: resource.kind };
  return (
    <button
      type="button"
      className={`resource-reference${compact ? " compact" : ""}`}
      aria-label={`Open ${singularResourceLabel(meta.label)}: ${resource.label}`}
      onClick={() => onSelectResource(resource.key)}
    >
      <span className={`resource-reference-icon kind-${resource.kind}`} aria-hidden="true">{meta.icon}</span>
      <span className="resource-reference-copy"><strong>{resource.label}</strong><code>{resource.key}</code></span>
      {!compact && <small>{resource.kind}</small>}
      <i aria-hidden="true">›</i>
    </button>
  );
}

type MapEditorTool = "objects" | "terrain" | "collision" | "regions";

export interface MapDraftHistory {
  past: MapDef[];
  present: MapDef;
  future: MapDef[];
  group?: string;
}

export type MapDraftHistoryAction =
  | { type: "change"; update: React.SetStateAction<MapDef>; group?: string }
  | { type: "reset"; map: MapDef }
  | { type: "undo" }
  | { type: "redo" };

export function createMapDraftHistory(map: MapDef): MapDraftHistory {
  return { past: [], present: cloneMap(map), future: [] };
}

export function mapDraftHistoryReducer(state: MapDraftHistory, action: MapDraftHistoryAction): MapDraftHistory {
  if (action.type === "reset") return createMapDraftHistory(action.map);
  if (action.type === "undo") {
    const previous = state.past.at(-1);
    if (!previous) return state;
    return { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future] };
  }
  if (action.type === "redo") {
    const next = state.future[0];
    if (!next) return state;
    return { past: [...state.past, state.present].slice(-80), present: next, future: state.future.slice(1) };
  }
  const next = typeof action.update === "function" ? action.update(state.present) : action.update;
  if (!hasMapDraftChanges(state.present, next)) return state;
  if (action.group && action.group === state.group) {
    return { ...state, present: next, future: [] };
  }
  return {
    past: [...state.past, state.present].slice(-80),
    present: next,
    future: [],
    ...(action.group ? { group: action.group } : {}),
  };
}

function MapOverview({
  map,
  assets,
  resources,
  switches,
  variables,
  onProjectSaved,
  onDraftGuardChange,
}: {
  map: MapDef;
  assets: ProjectAssetPreview[];
  resources: ProjectResourceNode[];
  switches: SwitchDef[];
  variables: VariableDef[];
  onProjectSaved: (project: ProjectResponse) => void;
  onDraftGuardChange: (guard: StudioDraftGuard | null) => void;
}) {
  const [draftHistory, dispatchDraft] = useReducer(mapDraftHistoryReducer, map, createMapDraftHistory);
  const draft = draftHistory.present;
  const setDraft = useCallback((update: React.SetStateAction<MapDef>, group?: string) => {
    dispatchDraft({ type: "change", update, ...(group ? { group } : {}) });
  }, []);
  const [editing, setEditing] = useState(false);
  const [selectedPlacementId, setSelectedPlacementId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveReceipt, setSaveReceipt] = useState<{ summary: string; savedAt: string } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [zoom, setZoom] = useState(100);
  const [paletteResourceKey, setPaletteResourceKey] = useState("");
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteKind, setPaletteKind] = useState<ProjectResourceKind | "all">("all");
  const [mapTool, setMapTool] = useState<MapEditorTool>("objects");
  const [paintLayerId, setPaintLayerId] = useState("");
  const [objectLayerId, setObjectLayerId] = useState("");
  const [paintBrush, setPaintBrush] = useState(1);
  const [canvasPainting, setCanvasPainting] = useState<"paint" | "erase" | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState("");
  const mapIdRef = useRef(map.id);
  const paintGestureRef = useRef(0);
  const activePaintGroupRef = useRef<string | undefined>(undefined);
  const discardButtonRef = useRef<HTMLButtonElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (mapIdRef.current !== map.id) setSaveReceipt(null);
    mapIdRef.current = map.id;
    dispatchDraft({ type: "reset", map });
    setEditing(false);
    setSelectedPlacementId(null);
    setSaveError(null);
    setConfirmDiscard(false);
    setZoom(100);
    setPaletteResourceKey("");
    setPaletteQuery("");
    setPaletteKind("all");
    setMapTool("objects");
    setPaintLayerId("");
    setObjectLayerId("");
    setPaintBrush(1);
    setCanvasPainting(null);
    setSelectedRegionId("");
  }, [map]);

  const width = draft.layout?.width ?? 1;
  const height = draft.layout?.height ?? 1;
  const selectedPlacement = draft.placements?.find(
    (placement) => placement.id === selectedPlacementId,
  );
  const stacks = groupedStacks(draft.placements ?? []);
  const dirty = hasMapDraftChanges(map, draft);
  const tilesets = assets.filter((candidate) => candidate.kind === "tileset");
  const tilesetAsset = draft.layout?.tileset
    ? tilesets.find((candidate) => candidate.path === draft.layout?.tileset)
    : undefined;
  const terrainLayers = draft.layout?.layers.filter((layer) => layer.kind === "tile") ?? [];
  const collisionLayers = draft.layout?.layers.filter((layer) => layer.kind === "collision") ?? [];
  const objectLayers = draft.layout?.layers.filter((layer) => layer.kind === "object") ?? [];
  const activeObjectLayer = objectLayers.find((layer) => layer.id === objectLayerId) ?? objectLayers[0];
  const layerStack = [...(draft.layout?.layers ?? [])].sort((left, right) => right.z - left.z);
  const toolLayers = mapTool === "terrain" ? terrainLayers : mapTool === "collision" ? collisionLayers : [];
  const paintLayer = toolLayers.find((layer) => layer.id === paintLayerId) ?? toolLayers[0];
  const paintTiles = draft.layout && paintLayer
    ? normalizeMapTileMatrix(paintLayer.tiles, draft.layout.width, draft.layout.height)
    : [];
  const selectedRegion = draft.layout?.regions.find((region) => region.id === selectedRegionId)
    ?? draft.layout?.regions[0];
  const paletteMatches = useMemo(
    () => filterPlacementPaletteResources(resources, paletteQuery),
    [resources, paletteQuery],
  );
  const paletteGroups = useMemo(() => {
    return KIND_ORDER.flatMap((kind) => {
      if (!PLACEABLE_KINDS.has(kind)) return [];
      if (paletteKind !== "all" && paletteKind !== kind) return [];
      const rows = paletteMatches.filter((resource) => resource.kind === kind);
      return rows.length > 0 ? [{ kind, rows }] : [];
    });
  }, [paletteMatches, paletteKind]);
  const paletteRows = paletteGroups.flatMap(({ rows }) => rows);
  const paletteKindCounts = useMemo(() => new Map(
    KIND_ORDER.map((kind) => [kind, paletteMatches.filter((resource) => resource.kind === kind).length]),
  ), [paletteMatches]);
  const playerResource = resources.find((resource) => resource.key === "character:player");
  const playerGraphicPath = playerResource ? mapPaletteResourceGraphicPath(playerResource, assets) : undefined;

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

  const addPalettePlacement = () => {
    if (!draft.layout || !paletteResourceKey) return;
    const resource = paletteResourceKey === "event-only"
      ? undefined
      : resources.find((candidate) => candidate.key === paletteResourceKey);
    if (paletteResourceKey !== "event-only" && !resource) return;
    const placement = createMapPlacementDraft(
      resource,
      draft.placements ?? [],
      nextAvailableMapCell(draft.layout, draft.placements ?? []),
      activeObjectLayer?.id,
    );
    setDraft((current) => ({
      ...current,
      placements: [...(current.placements ?? []), placement],
    }));
    setSelectedPlacementId(placement.id);
  };

  const selectMapTool = (tool: MapEditorTool) => {
    setMapTool(tool);
    setSelectedPlacementId(null);
    setCanvasPainting(null);
    if (tool === "terrain") {
      setPaintLayerId(terrainLayers[0]?.id ?? "");
      setPaintBrush(tilesetAsset?.tileGrid?.firstId ?? 1);
    } else if (tool === "collision") {
      setPaintLayerId(collisionLayers[0]?.id ?? "");
      setPaintBrush(1);
    } else if (tool === "regions") {
      setSelectedRegionId(draft.layout?.regions[0]?.id ?? "");
    } else if (tool === "objects") {
      setObjectLayerId(activeObjectLayer?.id ?? "");
    }
  };

  const selectMapLayer = (layer: MapLayerDef) => {
    if (layer.kind === "tile") {
      selectMapTool("terrain");
      setPaintLayerId(layer.id);
    } else if (layer.kind === "collision") {
      selectMapTool("collision");
      setPaintLayerId(layer.id);
    } else if (layer.kind === "object") {
      selectMapTool("objects");
      setObjectLayerId(layer.id);
    } else if (layer.kind === "region") {
      selectMapTool("regions");
    }
  };

  const toggleMapLayerVisibility = (id: string) => setDraft((current) => ({
    ...current,
    layout: current.layout ? {
      ...current.layout,
      layers: current.layout.layers.map((layer) => layer.id === id ? { ...layer, visible: !layer.visible } : layer),
    } : undefined,
  }));

  const paintCanvasCell = (x: number, y: number, tile: number, group?: string) => {
    if (!paintLayer) return;
    setDraft((current) => ({
      ...current,
      layout: current.layout ? paintMapLayerTile(current.layout, paintLayer.id, x, y, tile) : undefined,
    }), group);
  };

  const fillPaintLayer = (tile: number) => {
    if (!paintLayer) return;
    setDraft((current) => ({
      ...current,
      layout: current.layout ? fillMapLayerTiles(current.layout, paintLayer.id, tile) : undefined,
    }));
  };

  const addMapRegion = () => {
    if (!draft.layout) return;
    const region = {
      id: uniqueLocalId("region", draft.layout.regions.map((candidate) => candidate.id)),
      name: "New region",
      x: 0,
      y: 0,
      width: 2,
      height: 2,
    };
    setDraft((current) => ({
      ...current,
      layout: current.layout ? { ...current.layout, regions: [...current.layout.regions, region] } : undefined,
    }));
    setSelectedRegionId(region.id);
  };

  const moveSelectedRegion = (x: number, y: number) => {
    if (!selectedRegion) return;
    setDraft((current) => ({
      ...current,
      layout: current.layout ? {
        ...current.layout,
        regions: current.layout.regions.map((region) => region.id === selectedRegion.id ? {
          ...region,
          x: clamp(x, 0, Math.max(0, current.layout!.width - region.width)),
          y: clamp(y, 0, Math.max(0, current.layout!.height - region.height)),
        } : region),
      } : undefined,
    }));
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const project = await saveMapSpatial(draft);
      onProjectSaved(project);
      const saved = project.maps.find((candidate) => candidate.id === map.id);
      const validatedMap = saved ?? draft;
      if (saved) dispatchDraft({ type: "reset", map: saved });
      setSaveReceipt({
        summary: summarizeMapValidation(validatedMap),
        savedAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      });
      setEditing(false);
      setConfirmDiscard(false);
      return true;
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    dispatchDraft({ type: "reset", map });
    setEditing(false);
    setSelectedPlacementId(null);
    setSaveError(null);
    setConfirmDiscard(false);
  };

  useEffect(() => {
    onDraftGuardChange(editing && dirty ? {
      label: `Map · ${map.name}`,
      save,
      discard,
    } : null);
  }, [editing, dirty, saving, draft, map, onDraftGuardChange]);

  useEffect(() => () => onDraftGuardChange(null), [onDraftGuardChange]);

  useEffect(() => {
    if (confirmDiscard) keepEditingRef.current?.focus();
  }, [confirmDiscard]);

  const cancelDiscard = () => {
    setConfirmDiscard(false);
    requestAnimationFrame(() => discardButtonRef.current?.focus());
  };

  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const acceptsText = target?.matches("input, select, textarea, [contenteditable='true']");
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (dirty && !saving) void save();
        return;
      }
      if (!acceptsText && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        dispatchDraft({ type: event.shiftKey ? "redo" : "undo" });
        setSelectedPlacementId(null);
        return;
      }
      if (!acceptsText && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        dispatchDraft({ type: "redo" });
        setSelectedPlacementId(null);
        return;
      }
      if (!acceptsText && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (event.key === "1") {
          event.preventDefault();
          selectMapTool("objects");
          return;
        }
        if (event.key === "2" && terrainLayers.length > 0) {
          event.preventDefault();
          selectMapTool("terrain");
          return;
        }
        if (event.key === "3" && collisionLayers.length > 0) {
          event.preventDefault();
          selectMapTool("collision");
          return;
        }
        if (event.key === "4") {
          event.preventDefault();
          selectMapTool("regions");
          return;
        }
      }
      if (event.key !== "Escape" || saving) return;
      event.preventDefault();
      if (confirmDiscard) {
        cancelDiscard();
        return;
      }
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
  }, [editing, dirty, saving, selectedPlacementId, draft, confirmDiscard]);

  useEffect(() => {
    const stopPainting = () => {
      setCanvasPainting(null);
      activePaintGroupRef.current = undefined;
    };
    window.addEventListener("pointerup", stopPainting);
    window.addEventListener("pointercancel", stopPainting);
    return () => {
      window.removeEventListener("pointerup", stopPainting);
      window.removeEventListener("pointercancel", stopPainting);
    };
  }, []);

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
          {editing && <>
            <button type="button" disabled={draftHistory.past.length === 0} onClick={() => { dispatchDraft({ type: "undo" }); setSelectedPlacementId(null); }} aria-label="Undo map change" title="Undo · ⌘Z">↶</button>
            <button type="button" disabled={draftHistory.future.length === 0} onClick={() => { dispatchDraft({ type: "redo" }); setSelectedPlacementId(null); }} aria-label="Redo map change" title="Redo · ⇧⌘Z">↷</button>
            <span className="toolbar-separator" />
          </>}
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
              <button ref={discardButtonRef} type="button" disabled={saving} onClick={() => {
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
        <section className="map-discard-confirmation" role="alertdialog" aria-labelledby="discard-map-title" aria-describedby="discard-map-description">
          <div><span>UNSAVED MAP DRAFT</span><strong id="discard-map-title">Discard spatial changes?</strong><p id="discard-map-description">Layout, placement, and event-page edits made since the last save will be lost.</p></div>
          <div><button type="button" className="danger" onClick={discard}>Discard changes</button><button ref={keepEditingRef} type="button" className="primary" onClick={cancelDiscard}>Keep editing <kbd>Esc</kbd></button></div>
        </section>
      )}
      {saveReceipt && !saveError && (
        <section className="map-validation-receipt" role="status">
          <i aria-hidden="true">✓</i>
          <div><span>PROJECT VALIDATION PASSED</span><strong>{map.name} is saved and playable</strong><small>{saveReceipt.summary} · authoritative source reloaded successfully</small></div>
          <time>{saveReceipt.savedAt}</time>
          <button type="button" aria-label="Dismiss validation result" onClick={() => setSaveReceipt(null)}>×</button>
        </section>
      )}
      {saveError && <div className="project-warning map-validation-error" role="alert"><strong>Validation failed · draft preserved</strong><code>{saveError}</code><span>No project source was replaced. Correct the highlighted draft and try again.</span></div>}
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
            layout: current.layout ? resizeMapLayout(current.layout, { width: Number(event.target.value) }) : undefined,
          }))} /></label>
          <label>Height<input type="number" min="1" value={draft.layout.height} onChange={(event) => setDraft((current) => ({
            ...current,
            layout: current.layout ? resizeMapLayout(current.layout, { height: Number(event.target.value) }) : undefined,
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
          <label className="layout-tileset-field">Tileset<select value={draft.layout.tileset ?? ""} onChange={(event) => setDraft((current) => ({
            ...current,
            layout: current.layout ? { ...current.layout, tileset: event.target.value || undefined } : undefined,
          }))}><option value="">Procedural colors</option>{tilesets.map((candidate) => <option value={candidate.path} key={candidate.path}>{candidate.placeholder}</option>)}</select></label>
          <span>Drag any resource from the project tree onto the canvas.</span>
        </div>
          <MapStructureEditor
            layout={draft.layout}
            assets={assets}
            onChange={(layout) => setDraft((current) => ({ ...current, layout }))}
          />
        </details>
      )}
      {editing && draft.layout && (
        <section className="map-mode-toolbar" aria-label="Map editing tools">
          <nav>
            <button type="button" className={mapTool === "objects" ? "selected" : ""} aria-pressed={mapTool === "objects"} onClick={() => selectMapTool("objects")}><span>◆</span><strong>Objects</strong><small><kbd>1</kbd> events &amp; start</small></button>
            <button type="button" disabled={terrainLayers.length === 0} className={mapTool === "terrain" ? "selected" : ""} aria-pressed={mapTool === "terrain"} onClick={() => selectMapTool("terrain")}><span>▦</span><strong>Terrain</strong><small><kbd>2</kbd> tile layers</small></button>
            <button type="button" disabled={collisionLayers.length === 0} className={mapTool === "collision" ? "selected" : ""} aria-pressed={mapTool === "collision"} onClick={() => selectMapTool("collision")}><span>▧</span><strong>Collision</strong><small><kbd>3</kbd> passability</small></button>
            <button type="button" className={mapTool === "regions" ? "selected" : ""} aria-pressed={mapTool === "regions"} onClick={() => selectMapTool("regions")}><span>▱</span><strong>Regions</strong><small><kbd>4</kbd> map zones</small></button>
          </nav>
          {paintLayer && (
            <div className="map-mode-brushes">
              <label>Layer<select value={paintLayer.id} onChange={(event) => setPaintLayerId(event.target.value)}>{toolLayers.map((layer) => <option value={layer.id} key={layer.id}>{layer.name ?? layer.id}</option>)}</select></label>
              {mapTool === "terrain" && tilesetAsset?.tileGrid && (
                <div className="map-mode-atlas" aria-label="Terrain brush palette">
                  {Array.from({ length: tilesetAsset.tileGrid.columns * tilesetAsset.tileGrid.rows }, (_, index) => tilesetAsset.tileGrid!.firstId + index).map((tile) => (
                    <button type="button" aria-label={`Paint with tile ${tile}`} aria-pressed={paintBrush === tile} className={paintBrush === tile ? "selected" : ""} key={tile} style={studioTileAtlasStyle(tile, tilesetAsset)} onClick={() => setPaintBrush(tile)}><small>{tile}</small></button>
                  ))}
                </div>
              )}
              {mapTool === "collision" && (
                <div className="map-mode-passability" aria-label="Collision brush palette">
                  <button type="button" className={paintBrush !== 0 ? "selected blocked" : "blocked"} aria-pressed={paintBrush !== 0} onClick={() => setPaintBrush(1)}>Blocked</button>
                  <button type="button" className={paintBrush === 0 ? "selected passable" : "passable"} aria-pressed={paintBrush === 0} onClick={() => setPaintBrush(0)}>Passable</button>
                </div>
              )}
              <div className="map-mode-layer-actions"><button type="button" onClick={() => fillPaintLayer(paintBrush)}>Fill</button><button type="button" onClick={() => fillPaintLayer(0)}>Clear</button></div>
              <span className="map-mode-hint">Drag to paint · ⌥ click samples · right-click erases</span>
            </div>
          )}
          {mapTool === "regions" && (
            <div className="map-mode-brushes map-region-tools">
              <label>Region<select value={selectedRegion?.id ?? ""} onChange={(event) => setSelectedRegionId(event.target.value)}><option value="" disabled>No regions</option>{draft.layout.regions.map((region) => <option value={region.id} key={region.id}>{region.name ?? region.id}</option>)}</select></label>
              <button type="button" className="region-add" onClick={addMapRegion}>＋ New region</button>
              <button type="button" className="region-delete" disabled={!selectedRegion} onClick={() => {
                if (!selectedRegion) return;
                setDraft((current) => ({
                  ...current,
                  layout: current.layout ? { ...current.layout, regions: current.layout.regions.filter((region) => region.id !== selectedRegion.id) } : undefined,
                }));
                setSelectedRegionId("");
              }}>Delete</button>
              {selectedRegion && <span className="map-region-tool-readout"><strong>{selectedRegion.name ?? selectedRegion.id}</strong><code>{selectedRegion.x},{selectedRegion.y} · {selectedRegion.width}×{selectedRegion.height}</code></span>}
              <span className="map-mode-hint">Click a map cell to move the selected region · resize in Map setup</span>
            </div>
          )}
        </section>
      )}
      {editing && draft.layout && (
        <section className="map-layer-stack" aria-label="Map layer stack">
          <header><span>LAYERS</span><strong>{layerStack.length}</strong><small>top to bottom · z order</small></header>
          <div>
            {layerStack.map((layer) => {
              const active = (
                layer.kind === "object" && mapTool === "objects" && activeObjectLayer?.id === layer.id
              ) || (
                (layer.kind === "tile" && mapTool === "terrain" || layer.kind === "collision" && mapTool === "collision") && paintLayer?.id === layer.id
              ) || (
                layer.kind === "region" && mapTool === "regions"
              );
              const layerObjectCount = layer.kind === "object" ? (draft.placements ?? []).filter((placement) => placement.layer === layer.id).length : undefined;
              return <span className={`${active ? "active " : ""}${layer.visible ? "visible" : "hidden"}`} key={layer.id}>
                <button type="button" className="map-layer-select" disabled={layer.kind === "image"} aria-pressed={active} onClick={() => selectMapLayer(layer)}>
                  <i aria-hidden="true">{layer.kind === "tile" ? "▦" : layer.kind === "collision" ? "▧" : layer.kind === "object" ? "◆" : layer.kind === "region" ? "▱" : "▣"}</i>
                  <b>{layer.name ?? layer.id}</b>
                  <small>{layer.kind}{layerObjectCount !== undefined ? ` · ${layerObjectCount}` : ""}</small>
                  <code>z {layer.z}</code>
                </button>
                <button type="button" className="map-layer-visibility" aria-label={`${layer.visible ? "Hide" : "Show"} ${layer.name ?? layer.id} layer`} aria-pressed={layer.visible} onClick={() => toggleMapLayerVisibility(layer.id)}>{layer.visible ? "●" : "○"}</button>
              </span>;
            })}
          </div>
        </section>
      )}
      {editing && draft.layout && mapTool === "objects" && (
        <section className="map-object-palette" aria-label="Map object palette">
          <div className="map-object-palette-heading">
            <span>OBJECT PALETTE</span>
            <strong>Place a project resource</strong>
            <small>Creates an editable object at the first open map cell.</small>
          </div>
          <div className="map-object-palette-controls">
            <label>
              <span aria-hidden="true">⌕</span>
              <input
                aria-label="Filter map object resources"
                value={paletteQuery}
                placeholder="Filter by name, ID or kind"
                onChange={(event) => {
                  setPaletteQuery(event.target.value);
                  setPaletteResourceKey("");
                }}
              />
              {paletteQuery && <button type="button" aria-label="Clear object filter" onClick={() => setPaletteQuery("")}>×</button>}
            </label>
            <nav className="map-object-kind-tabs" aria-label="Map object resource kinds">
              <button type="button" className={paletteKind === "all" ? "selected" : ""} aria-pressed={paletteKind === "all"} onClick={() => { setPaletteKind("all"); setPaletteResourceKey(""); }}>All <small>{paletteMatches.length}</small></button>
              {KIND_ORDER.filter((kind) => PLACEABLE_KINDS.has(kind) && (paletteKindCounts.get(kind) ?? 0) > 0).map((kind) => (
                <button type="button" className={paletteKind === kind ? "selected" : ""} aria-pressed={paletteKind === kind} key={kind} onClick={() => { setPaletteKind(kind); setPaletteResourceKey(""); }}>
                  <span aria-hidden="true">{KIND_META[kind]?.icon ?? "◇"}</span>{KIND_META[kind]?.label ?? kind}<small>{paletteKindCounts.get(kind)}</small>
                </button>
              ))}
            </nav>
          </div>
          <div className="map-object-palette-results" role="listbox" aria-label="Project resource to place">
            {paletteKind === "all" && (paletteQuery.length === 0 || "event-only blank event pages".includes(paletteQuery.toLowerCase())) && (
              <button type="button" role="option" aria-selected={paletteResourceKey === "event-only"} className={paletteResourceKey === "event-only" ? "selected" : ""} onClick={() => setPaletteResourceKey("event-only")}>
                <span className="palette-resource-art fallback" aria-hidden="true">◇</span><span><strong>Event-only object</strong><small>blank event pages</small></span>
              </button>
            )}
            {paletteRows.slice(0, 24).map((resource) => {
              const graphicPath = mapPaletteResourceGraphicPath(resource, assets);
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={paletteResourceKey === resource.key}
                  className={paletteResourceKey === resource.key ? "selected" : ""}
                  key={resource.key}
                  draggable
                  onDragStart={(event) => { event.dataTransfer.setData("application/x-autogal-resource", resource.key); event.dataTransfer.effectAllowed = "copy"; }}
                  onClick={() => setPaletteResourceKey(resource.key)}
                >
                  <span className={`palette-resource-art${graphicPath ? " authored" : " fallback"}`} style={graphicPath ? { backgroundImage: `url(${JSON.stringify(sourceImageUrl(graphicPath))})` } : undefined} aria-hidden="true">{graphicPath ? "" : KIND_META[resource.kind]?.icon ?? "◇"}</span>
                  <span><strong>{resource.label}</strong><small>{resource.kind} · {resource.id}</small></span>
                </button>
              );
            })}
            {paletteRows.length === 0 && <span className="map-object-palette-empty">No matching project records</span>}
            {paletteRows.length > 24 && <span className="map-object-palette-more">24 of {paletteRows.length} shown · refine search</span>}
          </div>
          <button type="button" disabled={!paletteResourceKey} onClick={addPalettePlacement}>
            <span>＋</span><strong>Add to map</strong><small>select &amp; edit</small>
          </button>
        </section>
      )}
      <div className="map-stage">
        {draft.layout && (draft.placements ?? []).length > 0 && (!editing || mapTool === "objects") && (
          <div className="map-object-strip" aria-label="Map objects">
            <span>OBJECTS</span>
            {(draft.placements ?? []).map((placement) => {
              const label = mapPlacementResourceLabel(placement, resources);
              const graphicPath = mapPlacementGraphicPath(placement, resources, assets);
              const eventSummary = mapPlacementEventSummary(placement);
              return (
                <button
                  type="button"
                  className={selectedPlacementId === placement.id ? "selected" : ""}
                  key={placement.id}
                  onClick={() => { setSelectedPlacementId(placement.id); if (placement.layer) setObjectLayerId(placement.layer); }}
                >
                  <i className={`object-dot collision-${placement.collision}${graphicPath ? " authored" : ""}`} style={graphicPath ? { backgroundImage: `url(${JSON.stringify(sourceImageUrl(graphicPath))})` } : undefined} />
                  <span className="map-object-identity"><strong>{label}</strong><code>{placement.id}</code></span>
                  <b className={`map-object-event-state${eventSummary.gated ? " gated" : ""}${eventSummary.automatic ? " automatic" : ""}${eventSummary.hidden ? " hidden" : ""}`} title={eventSummary.title}><i>{eventSummary.icons || "—"}</i>{eventSummary.count}<small>{eventSummary.gated ? "◆" : eventSummary.hidden ? "○" : ""}</small></b>
                  <small>{placement.at.x},{placement.at.y}</small>
                </button>
              );
            })}
          </div>
        )}
        <div className="map-canvas-scroll">
      {draft.layout ? (
        <div
          className={`map-canvas ${editing ? `editing tool-${mapTool}` : ""} ${showGrid ? "" : "grid-hidden"}`}
          style={{
            aspectRatio: `${width} / ${height}`,
            width: `${zoom}%`,
            "--map-cols": width,
            "--map-rows": height,
          } as React.CSSProperties}
          aria-label={`${map.name} spatial preview`}
          onClick={() => { if (mapTool === "objects") setSelectedPlacementId(null); }}
          onDragOver={(event) => {
            if (!editing || mapTool !== "objects") return;
            event.preventDefault();
            event.dataTransfer.dropEffect = event.dataTransfer.types.includes("application/x-autogal-placement") ? "move" : "copy";
          }}
          onDrop={(event) => {
            if (!editing || mapTool !== "objects") return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const x = clamp(Math.floor((event.clientX - rect.left) / rect.width * width), 0, width - 1);
            const y = clamp(Math.floor((event.clientY - rect.top) / rect.height * height), 0, height - 1);
            if (event.dataTransfer.getData("application/x-autogal-player-start")) {
              setDraft((current) => ({
                ...current,
                layout: current.layout ? { ...current.layout, playerStart: { x, y } } : undefined,
              }));
              setSelectedPlacementId(null);
              return;
            }
            const placementId = event.dataTransfer.getData("application/x-autogal-placement");
            if (placementId) {
              mutatePlacement(placementId, (placement) => ({ ...placement, at: { x, y } }));
              setSelectedPlacementId(placementId);
              return;
            }
            const resourceKey = event.dataTransfer.getData("application/x-autogal-resource");
            const resource = resources.find((candidate) => candidate.key === resourceKey);
            if (!resource || !PLACEABLE_KINDS.has(resource.kind)) return;
            const placement = createMapPlacementDraft(resource, draft.placements ?? [], { x, y }, activeObjectLayer?.id);
            setDraft((current) => ({
              ...current,
              placements: [...(current.placements ?? []), placement],
            }));
            setSelectedPlacementId(placement.id);
          }}
        >
          {collectMapImageLayers(draft).map((layer) => <i
            aria-hidden="true"
            className="map-image-layer"
            key={layer.id}
            style={{ backgroundImage: `url(${JSON.stringify(sourceImageUrl(layer.asset!))})`, zIndex: mapLayerDisplayOrder(layer.z) }}
          />)}
          {collectMapEditorTiles(draft.layout).map((tile) => {
            const atlasStyle = tile.kind === "tile" ? studioTileAtlasStyle(tile.tile, tilesetAsset) : undefined;
            return (
            <i
              aria-hidden="true"
              className={`map-tile-preview kind-${tile.kind}${atlasStyle ? " atlas" : ""}`}
              key={`${tile.layerId}:${tile.x}:${tile.y}`}
              style={{
                left: `${tile.x / width * 100}%`,
                top: `${tile.y / height * 100}%`,
                width: `${100 / width}%`,
                height: `${100 / height}%`,
                zIndex: mapLayerDisplayOrder(tile.z),
                "--tile-id": tile.tile,
                ...atlasStyle,
              } as React.CSSProperties}
            />
            );
          })}
          {editing && paintLayer && mapTool !== "objects" && (
            <div
              className={`map-canvas-paint-grid kind-${paintLayer.kind}`}
              aria-label={`${paintLayer.name ?? paintLayer.id} direct paint grid`}
              style={{ "--map-cols": width, "--map-rows": height } as React.CSSProperties}
            >
              {paintTiles.flatMap((row, y) => row.map((tile, x) => (
                <button
                  type="button"
                  aria-label={`Paint ${x}, ${y}; current tile ${tile}`}
                  key={`${x}:${y}`}
                  title={`${x},${y} · ${tile}`}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    if (event.altKey) {
                      setPaintBrush(mapTool === "collision" ? (tile === 0 ? 0 : 1) : tile);
                      return;
                    }
                    const mode = tile === paintBrush ? "erase" : "paint";
                    const group = `paint-${++paintGestureRef.current}`;
                    activePaintGroupRef.current = group;
                    setCanvasPainting(mode);
                    paintCanvasCell(x, y, mode === "paint" ? paintBrush : 0, group);
                  }}
                  onPointerEnter={() => {
                    if (!canvasPainting) return;
                    paintCanvasCell(x, y, canvasPainting === "paint" ? paintBrush : 0, activePaintGroupRef.current);
                  }}
                  onClick={(event) => {
                    if (event.detail !== 0) return;
                    paintCanvasCell(x, y, tile === paintBrush ? 0 : paintBrush);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    paintCanvasCell(x, y, 0);
                  }}
                />
              )))}
            </div>
          )}
          {editing && mapTool === "regions" && (
            <div
              className="map-region-move-grid"
              aria-label="Region placement grid"
              style={{ "--map-cols": width, "--map-rows": height } as React.CSSProperties}
            >
              {Array.from({ length: width * height }, (_, index) => {
                const x = index % width;
                const y = Math.floor(index / width);
                return <button type="button" aria-label={`Move region to ${x}, ${y}`} key={`${x}:${y}`} onClick={() => moveSelectedRegion(x, y)} />;
              })}
            </div>
          )}
          {draft.layout.regions.map((region) => (
            <div
              className={`map-region${mapTool === "regions" && selectedRegion?.id === region.id ? " selected" : ""}`}
              key={region.id}
              title={region.name ?? region.id}
              style={{
                left: `${region.x / width * 100}%`,
                top: `${region.y / height * 100}%`,
                width: `${region.width / width * 100}%`,
                height: `${region.height / height * 100}%`,
              }}
            ><span>{region.name ?? region.id}</span></div>
          ))}
          {draft.layout.playerStart && (
            <div
              className={`map-player-start${editing ? " editable" : ""}`}
              title={editing
                ? `Player start · ${draft.layout.playerStart.x},${draft.layout.playerStart.y} · drag or use arrow keys`
                : `Player start · ${draft.layout.playerStart.x},${draft.layout.playerStart.y}`}
              role={editing ? "button" : undefined}
              tabIndex={editing ? 0 : -1}
              aria-label={editing ? `Player start at ${draft.layout.playerStart.x}, ${draft.layout.playerStart.y}. Drag or use arrow keys to move.` : undefined}
              draggable={editing && mapTool === "objects"}
              onDragStart={(event) => {
                event.dataTransfer.setData("application/x-autogal-player-start", "true");
                event.dataTransfer.effectAllowed = "move";
              }}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (!editing || !["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].includes(event.key)) return;
                event.preventDefault();
                setDraft((current) => ({
                  ...current,
                  layout: current.layout ? {
                    ...current.layout,
                    playerStart: nudgeMapPlayerStart(current.layout, current.layout.playerStart, event.key),
                  } : undefined,
                }));
              }}
              style={{
                left: `${draft.layout.playerStart.x / width * 100}%`,
                top: `${draft.layout.playerStart.y / height * 100}%`,
                width: `${100 / width}%`,
                height: `${100 / height}%`,
                zIndex: mapPlayerDisplayOrder(draft, draft.layout.playerStart),
              }}
            ><span className={playerGraphicPath ? "map-player-start-graphic" : ""} style={playerGraphicPath ? { backgroundImage: `url(${JSON.stringify(sourceImageUrl(playerGraphicPath))})` } : undefined}>{playerGraphicPath ? "" : "◆"}</span><small>START</small></div>
          )}
          {(draft.placements ?? []).map((placement) => {
            const resourceLabel = mapPlacementResourceLabel(placement, resources);
            const graphicPath = mapPlacementGraphicPath(placement, resources, assets);
            const rendered = isMapPlacementLayerVisible(draft, placement);
            const eventSummary = mapPlacementEventSummary(placement);
            return (
              <div
              className={`map-placement resource-${placement.resource?.kind ?? "event"} collision-${placement.collision}${selectedPlacementId === placement.id ? " selected" : ""}${rendered ? "" : " layer-hidden"}`}
              key={placement.id}
              draggable={editing && mapTool === "objects"}
              onDragStart={(event) => {
                event.dataTransfer.setData("application/x-autogal-placement", placement.id);
                event.dataTransfer.effectAllowed = "move";
              }}
              onClick={(event) => { event.stopPropagation(); setSelectedPlacementId(placement.id); if (placement.layer) setObjectLayerId(placement.layer); }}
              title={`${resourceLabel} · ${placement.id} · ${placement.resource?.kind ?? "event"}:${placement.resource?.id ?? ""}`}
              style={{
                left: `${(placement.at.x / width) * 100}%`,
                top: `${(placement.at.y / height) * 100}%`,
                width: `${(placement.footprint.width / width) * 100}%`,
                height: `${(placement.footprint.height / height) * 100}%`,
                zIndex: mapPlacementDisplayOrder(draft, placement),
                opacity: rendered ? 1 : 0.18,
              }}
            >
              {graphicPath && <span className="map-placement-graphic" style={{ backgroundImage: `url(${JSON.stringify(sourceImageUrl(graphicPath))})` }} aria-hidden="true" />}
              {eventSummary.count > 0 && <span className={`map-placement-event-summary${eventSummary.gated ? " gated" : ""}${eventSummary.automatic ? " automatic" : ""}`} title={eventSummary.title}><i>{eventSummary.icons}</i><b>{eventSummary.count}</b>{eventSummary.gated && <small>◆</small>}</span>}
              <span className="map-placement-copy">{resourceLabel}</span>
              <small className="map-placement-copy">{placement.resource?.kind ?? "event"} · {placement.id}</small>
              </div>
            );
          })}
          {editing && mapTool === "objects" && stacks.map((stack) => {
            const selectedIndex = selectedPlacementId ? stack.ids.indexOf(selectedPlacementId) : -1;
            return <button
              type="button"
              className={`map-stack-badge${selectedIndex >= 0 ? " selected" : ""}`}
              key={stack.key}
              aria-label={`Cycle ${stack.ids.length} objects at ${stack.key}`}
              title={stack.ids.join(" · ")}
              style={{ left: `${stack.x / width * 100}%`, top: `${stack.y / height * 100}%` }}
              onClick={(event) => {
                event.stopPropagation();
                const id = nextStackPlacementId(stack.ids, selectedPlacementId);
                const placement = draft.placements?.find((candidate) => candidate.id === id);
                setSelectedPlacementId(id);
                if (placement?.layer) setObjectLayerId(placement.layer);
              }}
            ><strong>×{stack.ids.length}</strong><small>{selectedIndex >= 0 ? `${selectedIndex + 1}/${stack.ids.length}` : "STACK"}</small></button>;
          })}
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
          <span>{editing
            ? mapTool === "objects"
              ? "Drag project resources onto the canvas · drag objects to move"
              : mapTool === "regions"
                ? `Positioning ${selectedRegion?.name ?? selectedRegion?.id ?? "region"} · click a cell to move`
                : `Painting ${paintLayer?.name ?? paintLayer?.id ?? "layer"} · drag to paint · right-click to erase`
            : "Preview is read-only"}</span>
          <span>{draft.layout ? `${width * height} cells` : "semantic node"}</span>
        </footer>
      </div>
      {editing && selectedPlacement && (
        <PlacementEditor
          map={draft}
          placement={selectedPlacement}
          layers={draft.layout?.layers ?? []}
          assets={assets}
          resources={resources}
          switches={switches}
          variables={variables}
          onChange={(update) => mutatePlacement(selectedPlacement.id, update)}
          onDuplicate={() => {
            if (!draft.layout) return;
            const duplicate = duplicateMapPlacementDraft(
              draft.layout,
              draft.placements ?? [],
              selectedPlacement,
            );
            setDraft((current) => ({
              ...current,
              placements: [...(current.placements ?? []), duplicate],
            }));
            setSelectedPlacementId(duplicate.id);
          }}
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
          <h3>Stacked cells <small>cycle objects sharing one origin cell</small></h3>
          {stacks.map((stack) => (
            <button type="button" key={stack.key} onClick={() => {
              const id = nextStackPlacementId(stack.ids, selectedPlacementId);
              const placement = draft.placements?.find((candidate) => candidate.id === id);
              setSelectedPlacementId(id);
              if (placement?.layer) setObjectLayerId(placement.layer);
            }}><code>{stack.key}</code><span>{stack.ids.join(" · ")}</span><small>{stack.ids.includes(selectedPlacementId ?? "") ? "next object →" : "inspect stack →"}</small></button>
          ))}
        </section>
      )}
      <MapSurfacePreviews map={draft} />
    </section>
  );
}

function MapStructureEditor({
  layout,
  assets,
  onChange,
}: {
  layout: MapLayoutDef;
  assets: ProjectAssetPreview[];
  onChange: (layout: MapLayoutDef) => void;
}) {
  const layerRows = layout.layers
    .map((layer, sourceIndex) => ({ layer, sourceIndex }))
    .sort((left, right) => right.layer.z - left.layer.z || left.sourceIndex - right.sourceIndex);
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
            z: layout.layers.length > 0 ? Math.max(...layout.layers.map((layer) => layer.z)) + 1 : 0,
            visible: true,
          }],
        })}>+ Layer</button></header>
        {layerRows.map(({ layer, sourceIndex }, displayIndex) => (
          <div className="structure-row layer-row" key={`${layer.id}-${sourceIndex}`}>
            <input aria-label={`Layer ${displayIndex + 1} id`} value={layer.id} onChange={(event) => patchLayer(sourceIndex, { id: event.target.value })} />
            <input aria-label={`${layer.id} name`} placeholder="display name" value={layer.name ?? ""} onChange={(event) => patchLayer(sourceIndex, { name: event.target.value || undefined })} />
            <select value={layer.kind} onChange={(event) => patchLayer(sourceIndex, { kind: event.target.value as typeof layer.kind })}>
              <option>tile</option><option>image</option><option>object</option><option>collision</option><option>region</option>
            </select>
            <input type="number" aria-label={`${layer.id} z`} value={layer.z} onChange={(event) => patchLayer(sourceIndex, { z: Number(event.target.value) })} />
            {layer.kind === "image" ? <select aria-label={`${layer.id} image asset`} value={layer.asset ?? ""} onChange={(event) => patchLayer(sourceIndex, { asset: event.target.value || undefined })}>
              <option value="">No image asset</option>
              {assets.filter((asset) => Object.values(asset.renderings).some(Boolean)).map((asset) => <option value={asset.path} key={asset.path}>{asset.placeholder} · {asset.kind}</option>)}
            </select> : <input placeholder="asset (optional)" value={layer.asset ?? ""} onChange={(event) => patchLayer(sourceIndex, { asset: event.target.value || undefined })} />}
            <label><input type="checkbox" checked={layer.visible} onChange={(event) => patchLayer(sourceIndex, { visible: event.target.checked })} /> visible</label>
            <span className="layer-order-controls">
              <button type="button" aria-label={`Move ${layer.id} layer up`} disabled={displayIndex === 0} onClick={() => onChange(moveMapLayer(layout, sourceIndex, -1))}>↑</button>
              <button type="button" aria-label={`Move ${layer.id} layer down`} disabled={displayIndex === layerRows.length - 1} onClick={() => onChange(moveMapLayer(layout, sourceIndex, 1))}>↓</button>
            </span>
            <button type="button" className="danger" onClick={() => onChange({ ...layout, layers: layout.layers.filter((_, candidate) => candidate !== sourceIndex) })}>×</button>
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
  map,
  placement,
  layers,
  assets,
  resources,
  switches,
  variables,
  onChange,
  onDuplicate,
  onDelete,
  onClose,
}: {
  map: MapDef;
  placement: MapPlacementDef;
  layers: MapLayerDef[];
  assets: ProjectAssetPreview[];
  resources: ProjectResourceNode[];
  switches: SwitchDef[];
  variables: VariableDef[];
  onChange: (update: (placement: MapPlacementDef) => MapPlacementDef) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editorSection, setEditorSection] = useState<"object" | "events">("events");
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const setNumber = (axis: "x" | "y", value: number) => onChange((current) => ({
    ...current,
    at: { ...current.at, [axis]: value },
  }));
  const placementKind = placement.resource?.kind;
  const placementChoices = resourceChoices(resources, placementKind);
  const placementLabel = mapPlacementResourceLabel(placement, resources);
  const graphicPath = mapPlacementGraphicPath(placement, resources, assets);
  const inheritedGraphic = placement.asset ? undefined : graphicPath;
  const placementLayer = layers.find((layer) => layer.id === placement.layer);
  const feetY = placement.at.y + placement.footprint.height - 1;
  const displayOrder = mapPlacementDisplayOrder(map, placement);

  useEffect(() => {
    setConfirmDelete(false);
    setEditorSection("events");
  }, [placement.id]);
  useEffect(() => {
    if (confirmDelete) cancelDeleteRef.current?.focus();
  }, [confirmDelete]);

  const cancelDelete = () => {
    setConfirmDelete(false);
    requestAnimationFrame(() => deleteButtonRef.current?.focus());
  };

  return (
    <section className="placement-editor">
      <header className="placement-editor-heading">
        <div><span>SELECTED OBJECT</span><strong>{placementLabel}</strong><code>{placement.id} · {placement.resource ? `${placement.resource.kind}:${placement.resource.id}` : "event-only"}</code></div>
        <nav className="placement-editor-tabs" aria-label="Object editor sections" role="tablist">
          <button type="button" role="tab" aria-selected={editorSection === "object"} className={editorSection === "object" ? "selected" : ""} onClick={() => setEditorSection("object")}><span>◇</span> Object</button>
          <button type="button" role="tab" aria-selected={editorSection === "events"} className={editorSection === "events" ? "selected" : ""} onClick={() => setEditorSection("events")}><span>◆</span> Events <small>{placement.events.length}</small></button>
        </nav>
        <div className="placement-heading-actions"><button type="button" onClick={onDuplicate}>Duplicate object</button><button ref={deleteButtonRef} type="button" className="danger" onClick={() => setConfirmDelete(true)}>Delete object</button><button type="button" aria-label="Close object inspector" onClick={onClose}>×</button></div>
      </header>
      {confirmDelete && (
        <section className="placement-delete-confirmation" role="alertdialog" aria-labelledby="delete-placement-title" aria-describedby="delete-placement-description" onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          cancelDelete();
        }}>
          <span aria-hidden="true">!</span>
          <div>
            <strong id="delete-placement-title">Remove “{placementLabel}” from this map?</strong>
            <small id="delete-placement-description">{placement.events.length} event {placement.events.length === 1 ? "page" : "pages"} will leave the map draft. The source file is unchanged until Save changes.</small>
          </div>
          <button ref={cancelDeleteRef} type="button" onClick={cancelDelete}>Cancel <kbd>Esc</kbd></button>
          <button type="button" className="danger" onClick={onDelete}>Remove object</button>
        </section>
      )}
      {editorSection === "object" && <div className="placement-editor-grid" role="tabpanel" aria-label="Object properties">
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
          <div className="placement-graphic-fields">
            <span className={`placement-graphic-preview${graphicPath ? " authored" : ""}`} style={graphicPath ? { backgroundImage: `url(${JSON.stringify(sourceImageUrl(graphicPath))})` } : undefined} aria-hidden="true">{graphicPath ? "" : "◇"}</span>
            <label>Map graphic<select value={placement.asset ?? ""} onChange={(event) => onChange((current) => ({ ...current, asset: event.target.value || undefined }))}>
              <option value="">{inheritedGraphic ? "Character default" : "System marker"}</option>
              {assets.some((asset) => asset.kind === "sprite") && <optgroup label="Map sprites">{assets.filter((asset) => asset.kind === "sprite").map((asset) => <option value={asset.path} key={asset.path}>{asset.placeholder}</option>)}</optgroup>}
              <optgroup label="Scene and design assets">{assets.filter((asset) => asset.kind !== "sprite").map((asset) => <option value={asset.path} key={asset.path}>{asset.placeholder} · {asset.kind}</option>)}</optgroup>
            </select></label>
            <small>{placement.asset ?? (inheritedGraphic ? `Inherited · ${inheritedGraphic}` : "Renderer-owned marker · Headless ignores the visual")}</small>
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
            <label>Layer<select value={placement.layer ?? ""} onChange={(event) => onChange((current) => ({ ...current, layer: event.target.value || undefined }))}><option value="">none · z 0</option>{layers.map((layer) => <option key={layer.id} value={layer.id}>{layer.name ?? layer.id} · z {layer.z}</option>)}</select></label>
            <label>Collision<select value={placement.collision} onChange={(event) => onChange((current) => ({ ...current, collision: event.target.value as MapPlacementDef["collision"] }))}><option>none</option><option>block</option><option>trigger</option></select></label>
            <label>Facing<select value={placement.facing ?? ""} onChange={(event) => onChange((current) => ({ ...current, facing: (event.target.value || undefined) as MapPlacementDef["facing"] }))}><option value="">none</option><option>north</option><option>east</option><option>south</option><option>west</option></select></label>
            <label className="checkbox-field"><input type="checkbox" checked={placement.visible} onChange={(event) => onChange((current) => ({ ...current, visible: event.target.checked }))} />Visible</label>
          </div>
          <div className="placement-display-order" title="Authored layer and object Z sort first; footprint bottom Y sorts actors within that depth.">
            <span>RENDER ORDER</span>
            <code>{placementLayer?.name ?? placement.layer ?? "default"} z {placementLayer?.z ?? 0}</code>
            <i>+</i>
            <code>object z {placement.z}</code>
            <i>+</i>
            <code>feet y {feetY}</code>
            <strong>{displayOrder}</strong>
          </div>
          <ConditionBuilder label="Placement condition" value={placement.requires} resources={resources} switches={switches} variables={variables} onChange={(requires) => onChange((current) => ({ ...current, requires }))} />
        </section>
      </div>}
      {editorSection === "events" && <div role="tabpanel" aria-label="Object event pages">
        <EventPagesEditor
          placement={placement}
          resources={resources}
          switches={switches}
          variables={variables}
          onChange={onChange}
        />
      </div>}
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
  const [deletePendingId, setDeletePendingId] = useState<string | null>(null);
  const deletePageButtonRef = useRef<HTMLButtonElement>(null);
  const cancelDeletePageRef = useRef<HTMLButtonElement>(null);
  const eventIndexRef = useRef<HTMLElement>(null);
  const selectedIndex = Math.max(0, placement.events.findIndex((event) => event.id === selectedEventId));
  const selected = placement.events[selectedIndex];

  useEffect(() => {
    if (selectedEventId && placement.events.some((event) => event.id === selectedEventId)) return;
    setSelectedEventId(placement.events[0]?.id ?? null);
  }, [placement.id, placement.events, selectedEventId]);

  useEffect(() => setDeletePendingId(null), [placement.id, selectedEventId]);
  useEffect(() => {
    if (deletePendingId) cancelDeletePageRef.current?.focus();
  }, [deletePendingId]);

  useEffect(() => {
    const index = eventIndexRef.current;
    if (!index) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
      const buttons = Array.from(index.querySelectorAll<HTMLButtonElement>(".event-page-select"));
      if (buttons.length === 0) return;
      event.preventDefault();
      const focused = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const current = focused >= 0 ? focused : selectedIndex;
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : nextProjectTreeIndex(current, buttons.length, ["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1);
      const button = buttons[next];
      if (!button) return;
      setSelectedEventId(button.dataset.eventId ?? null);
      button.focus();
    };
    index.addEventListener("keydown", onKeyDown);
    return () => index.removeEventListener("keydown", onKeyDown);
  }, [selectedIndex, placement.events.length]);

  const cancelDeletePage = () => {
    setDeletePendingId(null);
    requestAnimationFrame(() => deletePageButtonRef.current?.focus());
  };

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
    setDeletePendingId(null);
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
  const commandSummary = selected
    ? mapEventCommandSummary(selected, placement, resources)
    : "No target selected";
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
          <nav ref={eventIndexRef} className="event-page-index" aria-label="Event pages">
            <header><span>PAGES</span><small>{placement.events.length} · ↑↓</small></header>
            {placement.events.map((event, index) => {
              const meta = eventTriggerMeta(event.trigger);
              return (
                <button type="button" className={`event-page-select${index === selectedIndex ? " selected" : ""}`} data-event-id={event.id} aria-current={index === selectedIndex ? "page" : undefined} key={`${event.id}-${index}`} onClick={() => setSelectedEventId(event.id)}>
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
                <button ref={deletePageButtonRef} type="button" className="danger" aria-label={`Delete event ${selected.id}`} onClick={() => setDeletePendingId(selected.id)}>Delete</button>
              </div>
            </header>

            {deletePendingId === selected.id && (
              <section className="event-page-delete-confirmation" role="alertdialog" aria-labelledby="delete-event-page-title" aria-describedby="delete-event-page-description" onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                cancelDeletePage();
              }}>
                <div>
                  <strong id="delete-event-page-title">Remove event page “{selected.label || trigger?.label}”?</strong>
                  <small id="delete-event-page-description">Its condition and resource command will leave this map draft. The source file is unchanged until Save changes.</small>
                </div>
                <button ref={cancelDeletePageRef} type="button" onClick={cancelDeletePage}>Cancel <kbd>Esc</kbd></button>
                <button type="button" className="danger" onClick={deletePage}>Remove page</button>
              </section>
            )}

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
                <div><strong>Activate resource</strong><small title={commandSummary}>{commandSummary}</small></div>
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
  manual: { icon: "◇", label: "Action / Explicit Call", description: "Runs when the player or another system explicitly dispatches this page." },
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

export function mapPlacementEventSummary(placement: MapPlacementDef): {
  count: number;
  icons: string;
  gated: boolean;
  automatic: boolean;
  hidden: boolean;
  title: string;
} {
  const triggers = [...new Set(placement.events.map((event) => event.trigger))];
  const metas = triggers.map(eventTriggerMeta);
  const gatedPages = placement.events.filter((event) => event.requires || event.chance !== undefined && event.chance < 1).length;
  const gated = Boolean(placement.requires) || gatedPages > 0;
  const automatic = placement.events.some((event) => ["map_enter", "autorun", "parallel"].includes(event.trigger));
  const pageLabel = `${placement.events.length} event page${placement.events.length === 1 ? "" : "s"}`;
  const triggerLabel = metas.length > 0 ? metas.map((meta) => meta.label).join(" · ") : "No trigger";
  const states = [gated ? `${gatedPages + (placement.requires ? 1 : 0)} gated` : "", !placement.visible ? "hidden placement" : ""].filter(Boolean);
  return {
    count: placement.events.length,
    icons: metas.slice(0, 3).map((meta) => meta.icon).join(""),
    gated,
    automatic,
    hidden: !placement.visible,
    title: [pageLabel, triggerLabel, ...states].join(" · "),
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

export function filterPlacementPaletteResources(
  resources: ProjectResourceNode[],
  query: string,
): ProjectResourceNode[] {
  const normalized = query.trim().toLowerCase();
  return resources
    .filter((resource) => {
      if (!PLACEABLE_KINDS.has(resource.kind)) return false;
      if (!normalized) return true;
      const kindLabel = KIND_META[resource.kind]?.label ?? resource.kind;
      return [resource.label, resource.id, resource.key, resource.kind, kindLabel]
        .some((value) => value.toLowerCase().includes(normalized));
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function mapPlacementResourceLabel(
  placement: MapPlacementDef,
  resources: ProjectResourceNode[],
): string {
  if (!placement.resource) return placement.id;
  const key = `${placement.resource.kind}:${placement.resource.id}`;
  return resources.find((resource) => resource.key === key)?.label ?? placement.resource.id;
}

export function mapPlacementGraphicPath(
  placement: MapPlacementDef,
  resources: ProjectResourceNode[],
  assets: ProjectAssetPreview[],
): string | undefined {
  if (placement.asset) return placement.asset;
  if (placement.resource?.kind !== "character") return undefined;
  const character = resources.find((resource) => resource.key === `character:${placement.resource!.id}`);
  return assets.find((asset) =>
    asset.kind === "sprite" && character?.refs.includes(`asset:${asset.path}`)
  )?.path;
}

export function mapPaletteResourceGraphicPath(
  resource: ProjectResourceNode,
  assets: ProjectAssetPreview[],
): string | undefined {
  const referencedPaths = resource.refs
    .filter((ref) => ref.startsWith("asset:"))
    .map((ref) => ref.slice("asset:".length));
  if (resource.kind === "asset") referencedPaths.unshift(resource.id);
  const kindPriority: Record<string, number> = { sprite: 0, bg: 1, portrait: 2, cg: 3, sheet: 4, tileset: 5 };
  return assets
    .filter((asset) => referencedPaths.includes(asset.path))
    .sort((left, right) => (kindPriority[left.kind] ?? 9) - (kindPriority[right.kind] ?? 9))[0]?.path;
}

export function nextProjectTreeIndex(currentIndex: number, total: number, delta: 1 | -1): number {
  if (total <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= total) return delta > 0 ? 0 : total - 1;
  return (currentIndex + delta + total) % total;
}

export function adjacentResourceKeys(
  resources: ProjectResourceNode[],
  selectedKey: string,
): {
  previous: ProjectResourceNode | null;
  next: ProjectResourceNode | null;
  position: number;
  total: number;
} {
  const selected = resources.find((resource) => resource.key === selectedKey);
  if (!selected) return { previous: null, next: null, position: -1, total: 0 };
  const siblings = resources.filter((resource) => resource.kind === selected.kind);
  const position = siblings.findIndex((resource) => resource.key === selectedKey);
  return {
    previous: position > 0 ? siblings[position - 1]! : null,
    next: position >= 0 && position < siblings.length - 1 ? siblings[position + 1]! : null,
    position,
    total: siblings.length,
  };
}

export function resolveProjectReference(
  resources: ProjectResourceNode[],
  key: string,
): ProjectResourceNode | null {
  return resources.find((resource) => resource.key === key) ?? null;
}

export function mapEventCommandSummary(
  event: MapPlacementEventDef,
  placement: MapPlacementDef,
  resources: ProjectResourceNode[],
): string {
  const target = event.run ?? placement.resource;
  if (!target) return "No target selected";
  const label = resources.find((resource) => resource.key === `${target.kind}:${target.id}`)?.label ?? target.id;
  const operation = target.kind === "map"
    ? "Transfer player"
    : target.kind === "script"
      ? "Run script"
      : target.kind === "action"
        ? "Dispatch action"
        : "Activate resource";
  return `${operation} → ${label}${event.run ? "" : " · placement resource"}`;
}

function cloneMap(map: MapDef): MapDef {
  return structuredClone(map);
}

export function hasMapDraftChanges(saved: MapDef, draft: MapDef): boolean {
  return JSON.stringify({ layout: saved.layout, placements: saved.placements ?? [] }) !==
    JSON.stringify({ layout: draft.layout, placements: draft.placements ?? [] });
}

export function summarizeMapTreeResource(
  map: Pick<MapDef, "layout" | "placements"> | undefined,
): { spatial: boolean; label: string } | null {
  if (!map) return null;
  const placements = map.placements?.length ?? 0;
  if (!map.layout) {
    return {
      spatial: false,
      label: `NODE MAP · ${placements} RESOURCE${placements === 1 ? "" : "S"}`,
    };
  }
  const regions = map.layout.regions.length;
  return {
    spatial: true,
    label: `${map.layout.width}×${map.layout.height} GRID · ${placements} OBJECT${placements === 1 ? "" : "S"} · ${regions} REGION${regions === 1 ? "" : "S"}`,
  };
}

export function normalizeMapTileMatrix(
  tiles: number[][] | undefined,
  width: number,
  height: number,
): number[][] {
  return Array.from({ length: Math.max(1, height) }, (_, y) =>
    Array.from({ length: Math.max(1, width) }, (_, x) => tiles?.[y]?.[x] ?? 0)
  );
}

export function paintMapLayerTile(
  layout: MapLayoutDef,
  layerId: string,
  x: number,
  y: number,
  tile: number,
): MapLayoutDef {
  if (x < 0 || y < 0 || x >= layout.width || y >= layout.height || !Number.isInteger(tile)) return layout;
  return {
    ...layout,
    layers: layout.layers.map((layer) => {
      if (layer.id !== layerId || (layer.kind !== "tile" && layer.kind !== "collision")) return layer;
      const tiles = normalizeMapTileMatrix(layer.tiles, layout.width, layout.height);
      tiles[y]![x] = tile;
      return { ...layer, tiles };
    }),
  };
}

export function fillMapLayerTiles(
  layout: MapLayoutDef,
  layerId: string,
  tile: number,
): MapLayoutDef {
  if (!Number.isInteger(tile)) return layout;
  return {
    ...layout,
    layers: layout.layers.map((layer) =>
      layer.id === layerId && (layer.kind === "tile" || layer.kind === "collision")
        ? { ...layer, tiles: Array.from({ length: layout.height }, () => Array(layout.width).fill(tile)) }
        : layer
    ),
  };
}

export function moveMapLayer(
  layout: MapLayoutDef,
  index: number,
  delta: -1 | 1,
): MapLayoutDef {
  if (index < 0 || index >= layout.layers.length) return layout;
  const orderedIndices = layout.layers
    .map((layer, sourceIndex) => ({ sourceIndex, z: layer.z }))
    .sort((left, right) => right.z - left.z || left.sourceIndex - right.sourceIndex)
    .map(({ sourceIndex }) => sourceIndex);
  const displayIndex = orderedIndices.indexOf(index);
  const targetIndex = orderedIndices[displayIndex + delta];
  if (targetIndex === undefined) return layout;
  const currentZ = layout.layers[index]!.z;
  const targetZ = layout.layers[targetIndex]!.z;
  return {
    ...layout,
    layers: layout.layers.map((layer, sourceIndex) => sourceIndex === index
      ? { ...layer, z: targetZ }
      : sourceIndex === targetIndex ? { ...layer, z: currentZ } : layer),
  };
}

export function resizeMapLayout(
  layout: MapLayoutDef,
  patch: Partial<Pick<MapLayoutDef, "width" | "height">>,
): MapLayoutDef {
  const width = Math.max(1, Math.floor(patch.width ?? layout.width));
  const height = Math.max(1, Math.floor(patch.height ?? layout.height));
  return {
    ...layout,
    width,
    height,
    playerStart: layout.playerStart ? {
      x: clamp(layout.playerStart.x, 0, width - 1),
      y: clamp(layout.playerStart.y, 0, height - 1),
    } : undefined,
    layers: layout.layers.map((layer) => layer.tiles
      ? { ...layer, tiles: normalizeMapTileMatrix(layer.tiles, width, height) }
      : layer),
  };
}

export function collectMapEditorTiles(layout: MapLayoutDef): Array<{
  layerId: string;
  kind: "tile" | "collision";
  tile: number;
  x: number;
  y: number;
  z: number;
}> {
  return layout.layers.flatMap((layer) => {
    if (!layer.visible || (layer.kind !== "tile" && layer.kind !== "collision") || !layer.tiles) return [];
    const kind: "tile" | "collision" = layer.kind;
    return layer.tiles.flatMap((row, y) => row.flatMap((tile, x) => tile === 0 ? [] : [{
      layerId: layer.id,
      kind,
      tile,
      x,
      y,
      z: layer.z,
    }]));
  });
}

export function studioTileAtlasStyle(
  tile: number,
  tileset?: Pick<ProjectAssetPreview, "path" | "tileGrid" | "renderings">,
): React.CSSProperties | undefined {
  const grid = tileset?.tileGrid;
  const hasImage = tileset && Object.values(tileset.renderings).some(Boolean);
  if (!grid || !hasImage) return undefined;
  const index = tile - grid.firstId;
  if (index < 0 || index >= grid.columns * grid.rows) return undefined;
  const column = index % grid.columns;
  const row = Math.floor(index / grid.columns);
  return {
    backgroundImage: `url(${JSON.stringify(sourceImageUrl(tileset.path))})`,
    backgroundPosition: `${grid.columns === 1 ? 0 : column / (grid.columns - 1) * 100}% ${grid.rows === 1 ? 0 : row / (grid.rows - 1) * 100}%`,
    backgroundRepeat: "no-repeat",
    backgroundSize: `${grid.columns * 100}% ${grid.rows * 100}%`,
  };
}

export function summarizeMapValidation(map: Pick<MapDef, "layout" | "placements">): string {
  const placements = map.placements ?? [];
  const events = placements.reduce((total, placement) => total + placement.events.length, 0);
  const grid = map.layout ? `${map.layout.width} × ${map.layout.height} grid` : "semantic node map";
  return `${grid} · ${placements.length} placement${placements.length === 1 ? "" : "s"} · ${events} event page${events === 1 ? "" : "s"}`;
}

export function nudgeMapPlayerStart(
  layout: MapLayoutDef,
  current: { x: number; y: number } | undefined,
  key: string,
): { x: number; y: number } {
  const delta = ({
    ArrowUp: { x: 0, y: -1 },
    ArrowRight: { x: 1, y: 0 },
    ArrowDown: { x: 0, y: 1 },
    ArrowLeft: { x: -1, y: 0 },
  } as Record<string, { x: number; y: number }>)[key] ?? { x: 0, y: 0 };
  const start = current ?? { x: 0, y: 0 };
  return {
    x: clamp(start.x + delta.x, 0, Math.max(0, layout.width - 1)),
    y: clamp(start.y + delta.y, 0, Math.max(0, layout.height - 1)),
  };
}

export function nextAvailableMapCell(
  layout: MapLayoutDef,
  placements: MapPlacementDef[],
): { x: number; y: number } {
  const width = Math.max(1, layout.width);
  const height = Math.max(1, layout.height);
  const start = {
    x: clamp(layout.playerStart?.x ?? 0, 0, width - 1),
    y: clamp(layout.playerStart?.y ?? 0, 0, height - 1),
  };
  const occupied = (x: number, y: number) => placements.some((placement) =>
    x >= placement.at.x &&
    x < placement.at.x + placement.footprint.width &&
    y >= placement.at.y &&
    y < placement.at.y + placement.footprint.height
  );
  if (!occupied(start.x, start.y)) return start;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!occupied(x, y)) return { x, y };
    }
  }
  return start;
}

export function createMapPlacementDraft(
  resource: ProjectResourceNode | undefined,
  placements: MapPlacementDef[],
  at: { x: number; y: number },
  layer?: string,
): MapPlacementDef {
  const eventDriven = !resource || resource.kind === "map" || resource.kind === "script" || resource.kind === "action";
  return {
    id: uniquePlacementId(resource?.id ?? "event", placements),
    at,
    ...(resource ? { resource: { kind: resource.kind, id: resource.id } } : {}),
    ...(layer ? { layer } : {}),
    z: 0,
    footprint: { width: 1, height: 1 },
    collision: !resource || resource.kind === "map" ? "trigger" : "none",
    visible: true,
    events: eventDriven
      ? [{
          id: resource ? "activate" : "page_1",
          trigger: "interact",
          label: resource?.label ?? "Event",
          order: 0,
        }]
      : [],
  };
}

export function duplicateMapPlacementDraft(
  layout: MapLayoutDef,
  placements: MapPlacementDef[],
  source: MapPlacementDef,
): MapPlacementDef {
  const duplicate = structuredClone(source);
  return {
    ...duplicate,
    id: uniquePlacementId(`${source.id}_copy`, placements),
    at: nearestAvailablePlacementPoint(layout, placements, source.at, source.footprint),
  };
}

function nearestAvailablePlacementPoint(
  layout: MapLayoutDef,
  placements: MapPlacementDef[],
  origin: { x: number; y: number },
  footprint: { width: number; height: number },
): { x: number; y: number } {
  const maxX = Math.max(0, layout.width - footprint.width);
  const maxY = Math.max(0, layout.height - footprint.height);
  const candidates = Array.from({ length: (maxX + 1) * (maxY + 1) }, (_, index) => ({
    x: index % (maxX + 1),
    y: Math.floor(index / (maxX + 1)),
  })).sort((left, right) => {
    const leftDistance = Math.abs(left.x - origin.x) + Math.abs(left.y - origin.y);
    const rightDistance = Math.abs(right.x - origin.x) + Math.abs(right.y - origin.y);
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    if (left.y !== right.y) return left.y - right.y;
    return left.x - right.x;
  });
  const open = candidates.find((candidate) => placements.every((placement) => (
    candidate.x + footprint.width <= placement.at.x ||
    candidate.x >= placement.at.x + placement.footprint.width ||
    candidate.y + footprint.height <= placement.at.y ||
    candidate.y >= placement.at.y + placement.footprint.height
  )));
  return open ?? {
    x: clamp(origin.x, 0, maxX),
    y: clamp(origin.y, 0, maxY),
  };
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

export function groupedStacks(placements: MapPlacementDef[]): Array<{ key: string; x: number; y: number; ids: string[] }> {
  const groups = new Map<string, string[]>();
  for (const placement of placements) {
    const key = `${placement.at.x},${placement.at.y}`;
    groups.set(key, [...(groups.get(key) ?? []), placement.id]);
  }
  return [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => {
      const [x, y] = key.split(",").map(Number);
      return { key, x: x ?? 0, y: y ?? 0, ids };
    });
}

export function nextStackPlacementId(ids: string[], current: string | null): string | null {
  if (ids.length === 0) return null;
  const index = current ? ids.indexOf(current) : -1;
  return ids[(index + 1) % ids.length] ?? null;
}
