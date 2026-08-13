import React, {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  choiceDecisionContext,
  classifyInput,
  Engine,
  createInitialState,
} from "@rpg-harness/engine";
import type {
  AssetSpec,
  ComposedState,
  Game,
  HubSnapshot,
  Input,
  InputResult,
  Output,
} from "@rpg-harness/engine";
import {
  applyOutput,
  applyUiAction,
  buildHubView,
  formatHubCalendar,
  initialModel,
  makeErrorModel,
  type BacklogEntry,
  type ScreenModel,
  type Stage,
  type UiAction,
} from "@rpg-harness/frontend-core";
import { ArtBook } from "./ArtBook";
import { VisualLayer } from "./VisualLayer";
import type { WebDevelopmentStatus, WebStepEvent } from "./session";

// The browser twin of packages/cli/src/components/PlayScreen.tsx. Same
// engine pump (new Engine → run() → next(input)), same screen-model
// reducer from @rpg-harness/frontend-core — only the shell differs: DOM
// instead of ink, clicks instead of useInput, and no fs (hot-reload and
// disk saves are gone; persistence is injected via onState).
type ModelAction =
  | { kind: "reset"; model: ScreenModel }
  | { kind: "apply"; output: Output }
  | { kind: "ui"; action: UiAction };

function modelReducer(model: ScreenModel, action: ModelAction): ScreenModel {
  if (action.kind === "reset") return action.model;
  if (action.kind === "ui") return applyUiAction(model, action.action);
  return applyOutput(model, action.output);
}

interface Props {
  game: Game;
  assetUrls: Record<string, string>;
  initialState?: ComposedState;
  onCommit?: (
    state: ComposedState,
    event?: WebStepEvent,
  ) => void | Promise<void>;
  sessionLabel?: string;
  developmentStatus?: WebDevelopmentStatus;
  onExit?: () => void;
}

export async function submitWebInput(
  currentOutput: Output,
  input: Input,
  runner: AsyncGenerator<Output, void, Input>,
): Promise<{
  inputResult: InputResult;
  result?: IteratorResult<Output, void>;
}> {
  const inputResult = classifyInput(currentOutput, input);
  return inputResult.accepted
    ? { inputResult, result: await runner.next(input) }
    : { inputResult };
}

export function WebPlayScreen({
  game,
  assetUrls,
  initialState,
  onCommit,
  sessionLabel,
  developmentStatus,
  onExit,
}: Props) {
  const [model, dispatch] = useReducer(modelReducer, initialModel);
  const engineRef = useRef<Engine | null>(null);
  const runnerRef = useRef<AsyncGenerator<Output, void, Input> | null>(null);
  const processingRef = useRef(false);
  const outputRef = useRef<Output | null>(null);
  const [showBacklog, setShowBacklog] = useState(false);
  const [showArtBook, setShowArtBook] = useState(false);
  const [inputNotice, setInputNotice] = useState<InputResult | null>(null);

  const assetMap = useRef(
    new Map((game.assets ?? []).map((a) => [a.path, a] as const)),
  ).current;

  const commit = useCallback(
    async (
      res: IteratorResult<Output, void>,
      input?: Input,
      inputResult?: InputResult,
    ) => {
      const output: Output = res.done ? { type: "gameEnd" } : res.value;
      const decision = input
        ? choiceDecisionContext(outputRef.current, input)
        : undefined;
      outputRef.current = output;
      dispatch({ kind: "apply", output });
      const engine = engineRef.current;
      if (engine && onCommit) {
        await onCommit(
          engine.getState(),
          ...(input
            ? [{
                input,
                output,
                ...(inputResult ? { inputResult } : {}),
                ...(decision ? { decision } : {}),
              } satisfies WebStepEvent]
            : []),
        );
      }
    },
    [onCommit],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const engine = new Engine(game, initialState ?? createInitialState(game));
        const runner = engine.run();
        engineRef.current = engine;
        runnerRef.current = runner;
        const res = await runner.next();
        if (cancelled) return;
        await commit(res);
      } catch (err) {
        if (cancelled) return;
        dispatch({ kind: "reset", model: makeErrorModel(err as Error) });
      }
    })();
    return () => {
      cancelled = true;
    };
    // Boot once per (game, initialState). commit is stable enough; the
    // engine is rebuilt only when the game identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, initialState]);

  const sendInput = useCallback(
    async (input: Input) => {
      if (processingRef.current) return;
      const runner = runnerRef.current;
      if (!runner) return;
      processingRef.current = true;
      try {
        const currentOutput = outputRef.current;
        if (!currentOutput) return;
        const submitted = await submitWebInput(currentOutput, input, runner);
        if (!submitted.inputResult.accepted) {
          setInputNotice(submitted.inputResult);
          const engine = engineRef.current;
          if (engine && onCommit) {
            await onCommit(engine.getState(), {
              input,
              output: currentOutput,
              inputResult: submitted.inputResult,
            });
          }
          return;
        }
        setInputNotice(null);
        await commit(submitted.result!, input, submitted.inputResult);
      } catch (err) {
        dispatch({ kind: "reset", model: makeErrorModel(err as Error) });
      } finally {
        processingRef.current = false;
      }
    },
    [commit, onCommit],
  );

  // Keyboard: Space/Enter advances text beats; Esc exits. Selection on
  // choice/hub/scriptComplete is click-driven (each option carries its
  // own index/id), so no cursor key-walking is needed here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onExit) {
        onExit();
        return;
      }
      if (showBacklog || showArtBook) return;
      const k = model.stage.kind;
      if ((e.key === " " || e.key === "Enter") && (k === "narration" || k === "dialogue")) {
        e.preventDefault();
        void sendInput({ type: "next" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [model.stage.kind, showBacklog, showArtBook, sendInput, onExit]);

  return (
    <div className="play-root">
      <VisualLayer visuals={model.visuals} assetMap={assetMap} assetUrls={assetUrls} />
      {model.stage.kind === "hubMenu" && (
        <StatusBar snapshot={model.stage.snapshot} />
      )}
      <div className="stage-area">
        <StageView stage={model.stage} game={game} onInput={sendInput} />
      </div>
      {inputNotice && !inputNotice.accepted && (
        <div className="input-notice" role="status">
          <strong>{inputNotice.code}</strong>
          <span>{inputNotice.message}</span>
          <button onClick={() => setInputNotice(null)} aria-label="入力通知を閉じる">×</button>
        </div>
      )}
      <div className="hud">
        {sessionLabel && (
          <span className="hud-session" title="Headless CLI と共有される保存先">
            ⛓ {sessionLabel}
          </span>
        )}
        {developmentStatus && <DevelopmentBadge status={developmentStatus} />}
        {onExit && (
          <button className="hud-btn" onClick={onExit}>
            ← 主菜单
          </button>
        )}
        {model.backlog.length > 0 && (
          <button className="hud-btn" onClick={() => setShowBacklog(true)}>
            回看
          </button>
        )}
        <button className="hud-btn" onClick={() => setShowArtBook(true)}>
          設定集
        </button>
      </div>
      {showBacklog && (
        <BacklogOverlay entries={model.backlog} onClose={() => setShowBacklog(false)} />
      )}
      {showArtBook && (
        <ArtBook game={game} assetUrls={assetUrls} onClose={() => setShowArtBook(false)} />
      )}
    </div>
  );
}

export function DevelopmentBadge({ status }: { status: WebDevelopmentStatus }) {
  const clean = status.worklist.total === 0;
  const certified = status.quality.status === "certified";
  const pacing = status.quality.maxActivityRepetition;
  const pacingLimit = status.quality.maxActivityRepetitions;
  const label = !clean
    ? `AI Dev · ${status.worklist.total} pending${status.worklist.highestPriority ? ` · ${status.worklist.highestPriority}` : ""}`
    : certified
      ? `AI Dev · certified · ${status.quality.endings} endings / ${status.quality.paths} paths · ${status.quality.seeds.length} seeds${pacing && pacingLimit ? ` · loop ${pacing.count}/${pacingLimit}` : ""}`
      : "AI Dev · clean · audit pending";
  const detail = !clean
    ? [
        `${status.worklist.executable} executable · ${status.worklist.diagnostic} diagnostic · ${status.worklist.authoring} authoring`,
        status.worklist.next
          ? `Next: ${status.worklist.next.title} (${status.worklist.next.key})`
          : undefined,
      ].filter(Boolean).join("\n")
    : certified
      ? [
          "Current game/runtime inputs passed AI audit.",
          `Fresh-world seeds: ${status.quality.seeds.join(", ")}.`,
          pacing && pacingLimit
            ? `Heaviest semantic loop: seed ${pacing.seed}, ${pacing.persona}/${pacing.activityKind} ×${pacing.count} (limit ${pacingLimit}).`
            : undefined,
          `Certificate: ${status.quality.certificateRevision}`,
        ].filter(Boolean).join("\n")
      : "No worklist items remain, but current game/runtime inputs have no matching AI audit certificate.";
  return (
    <span
      className={`hud-development ${!clean ? "pending" : certified ? "certified" : "uncertified"}`}
      title={detail}
      role="status"
    >
      {label}
    </span>
  );
}

export function StageView({
  stage,
  game,
  onInput,
}: {
  stage: Stage;
  game: Game;
  onInput: (input: Input) => void;
}) {
  switch (stage.kind) {
    case "loading":
      return <div className="dialogue-box">読み込み中…</div>;
    case "error":
      return (
        <div className="dialogue-box error">
          <strong>エラー</strong>
          <pre>{stage.message}</pre>
        </div>
      );
    case "narration":
      return (
        <div className="dialogue-box clickable" onClick={() => onInput({ type: "next" })}>
          <p className="narration-text">{stage.text}</p>
          <div className="advance-hint">▼ クリック / Space</div>
        </div>
      );
    case "dialogue":
      return (
        <div className="dialogue-box clickable" onClick={() => onInput({ type: "next" })}>
          <div className="speaker">{stage.speakerName}</div>
          <p className="dialogue-text">{stage.text}</p>
          <div className="advance-hint">▼ クリック / Space</div>
        </div>
      );
    case "choice":
      return (
        <div className="choice-panel">
          {stage.prompt && <div className="choice-prompt">{stage.prompt}</div>}
          <ul className="option-list">
            {stage.options.map((opt, i) => (
              <li key={i}>
                <button
                  className="option-btn"
                  disabled={!opt.available}
                  onClick={() => onInput(
                    stage.choiceId && opt.id
                      ? { type: "choose", choiceId: stage.choiceId, optionId: opt.id }
                      : { type: "choose", index: i },
                  )}
                  title={opt.lockedReason ?? ""}
                >
                  <span>{opt.text}</span>
                  {!opt.available && opt.lockedReason && (
                    <span className="locked-reason">🔒 {opt.lockedReason}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      );
    case "hubMenu": {
      const hubView = buildHubView(stage.snapshot);
      const opportunityByCategory = new Map(
        hubView.opportunityGroups.map((group) => [group.category, group]),
      );
      return (
        <div className="hub-panel">
          {hubView.strategyDecisionRequired && (
            <div className="hub-strategy">
              STRATEGY · {hubView.opportunityGroups.length} PATHS AVAILABLE
            </div>
          )}
          {(stage.snapshot.resourceGroups ?? []).map((group) => (
            <section className="resource-group" key={group.id}>
              <div className="resource-group-title">{group.title}</div>
              <div className="resource-group-items">
                {group.resources.map((resource) => (
                  <span className="resource-chip" key={resource.id}>
                    {resource.name} ×{resource.quantity}
                  </span>
                ))}
              </div>
              {group.description && (
                <div className="resource-group-description">{group.description}</div>
              )}
            </section>
          ))}
          {(stage.snapshot.objectives ?? []).map((objective) => (
            <section
              className={`objective-card objective-${objective.status} objective-scope-${objective.scope}`}
              key={objective.id}
            >
              <div className="objective-title">
                <span className="objective-badge">
                  {objective.scope === "main"
                    ? "MAIN"
                    : objective.scope === "side"
                      ? "SIDE"
                      : "MASTERY"}
                  {objective.terminal ? " · FINAL" : ""}
                </span>
                {objective.status === "completed" ? "✓" : "◆"} {objective.title}
              </div>
              {objective.description && (
                <div className="objective-description">{objective.description}</div>
              )}
              {(objective.requirements ?? []).map((req) => (
                <div
                  className={`objective-requirement${req.satisfied ? " satisfied" : ""}`}
                  key={req.id}
                >
                  {req.satisfied ? "✓" : "○"} {req.label}: {String(req.current)} / {String(req.target)}
                </div>
              ))}
            </section>
          ))}
          {hubView.sections.map((section) => (
            <section className="activity-section" key={section.category}>
              <div className="activity-section-head">
                <span>{section.label}</span>
                <span>
                  {opportunityByCategory.get(section.category)?.decisionRequired &&
                    "CHOICE · "}
                  {section.availableCount}/{section.activities.length}
                </span>
              </div>
              <ul className="activity-list">
                {section.activities.map(({ activity: a }) => (
                  <li key={a.id}>
                    <button
                      className={`activity-btn${
                        a.id === hubView.primaryActivityId
                          ? " activity-primary"
                          : ""
                      }`}
                      disabled={!a.available}
                      onClick={() => onInput({ type: "doActivity", id: a.id })}
                      title={a.lockedReason ?? ""}
                    >
                      <div className="activity-head">
                        <span className="activity-title">
                          {a.id === hubView.primaryActivityId && (
                            <span className="primary-mark">★</span>
                          )}
                          {a.title}
                        </span>
                        {a.cost > 0 && <span className="activity-cost">⏳{a.cost}</span>}
                      </div>
                      {a.description && (
                        <div className="activity-desc">{a.description}</div>
                      )}
                      {a.effectsHint && (
                        <div className="activity-hint">{a.effectsHint}</div>
                      )}
                      {a.forecast && a.forecast.metrics.length > 0 && (
                        <div className="activity-forecast">
                          {a.forecast.metrics.map((metric) => (
                            <span
                              className={`forecast-chip forecast-${metric.polarity ?? "neutral"}`}
                              key={metric.id}
                            >
                              {metric.label} {formatForecastMetric(metric)}
                            </span>
                          ))}
                        </div>
                      )}
                      {!a.available && a.lockedReason && (
                        <div className="locked-reason">🔒 {a.lockedReason}</div>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      );
    }
    case "scriptComplete":
      return (
        <div className="choice-panel">
          {stage.nextAvailable.length === 0 ? (
            <div className="choice-prompt">（次の物語はまだない）</div>
          ) : (
            <ul className="option-list">
              {stage.nextAvailable.map((s) => (
                <li key={s.id}>
                  <button
                    className="option-btn"
                    onClick={() => onInput({ type: "select", scriptId: s.id })}
                  >
                    {s.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    case "ended":
      const endingTitle = stage.endingId === undefined
        ? undefined
        : game.scripts.find((script) => script.id === stage.endingId)?.title;
      return (
        <div className="ended-panel">
          <div className="ended-title">― 終 ―</div>
          {endingTitle && <div className="ended-ending-title">{endingTitle}</div>}
          {stage.endingId && <code className="ended-ending-id">{stage.endingId}</code>}
          {stage.reason && <div className="ended-reason">{stage.reason}</div>}
        </div>
      );
  }
}

function formatForecastMetric(metric: {
  value?: number | string | boolean;
  min?: number;
  max?: number;
  unit?: string;
}): string {
  const suffix = metric.unit === "percent" ? "%" : metric.unit ? ` ${metric.unit}` : "";
  if (metric.value !== undefined) return `${String(metric.value)}${suffix}`;
  if (metric.min !== undefined && metric.max !== undefined) {
    return `${metric.min}–${metric.max}${suffix}`;
  }
  if (metric.min !== undefined) return `≥${metric.min}${suffix}`;
  if (metric.max !== undefined) return `≤${metric.max}${suffix}`;
  return "";
}

function StatusBar({ snapshot }: { snapshot: HubSnapshot }) {
  const calendar = formatHubCalendar(snapshot);
  return (
    <div className="status-bar">
      {calendar && <span className="status-day">{calendar}</span>}
      {snapshot.stats.map((s) => (
        <span key={s.id} className="status-stat">
          {s.name} {s.value}/{s.max}
        </span>
      ))}
      {snapshot.affections.map((a) => (
        <span key={a.id} className="status-affection">
          {a.name} ♥{a.value}
        </span>
      ))}
    </div>
  );
}

function BacklogOverlay({
  entries,
  onClose,
}: {
  entries: BacklogEntry[];
  onClose: () => void;
}) {
  return (
    <div className="backlog-overlay" onClick={onClose}>
      <div className="backlog-inner" onClick={(e) => e.stopPropagation()}>
        <div className="backlog-head">
          <span>回看</span>
          <button className="hud-btn" onClick={onClose}>
            閉じる
          </button>
        </div>
        <div className="backlog-scroll">
          {entries.map((entry, i) => {
            if (entry.kind === "sceneBreak") return <hr key={i} className="scene-break" />;
            if (entry.kind === "dialogue")
              return (
                <p key={i} className="backlog-dialogue">
                  <strong>{entry.speakerName}</strong>：{entry.text}
                </p>
              );
            return (
              <p key={i} className="backlog-narration">
                {entry.text}
              </p>
            );
          })}
        </div>
      </div>
    </div>
  );
}
