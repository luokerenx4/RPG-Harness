import React, {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  activityDecisionContext,
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
  applyChoiceSelection,
  appendChoiceBacklog,
  applyUiAction,
  buildHubView,
  formatForecastMetricValue,
  formatHubCalendar,
  formatObjectiveRequirement,
  initialModel,
  playerForecastMetrics,
  makeErrorModel,
  type BacklogEntry,
  type ScreenModel,
  type Stage,
  type UiAction,
} from "@rpg-harness/frontend-core";
import { ArtBook } from "./ArtBook";
import { VisualLayer } from "./VisualLayer";
import type {
  WebBranchContext,
  WebDevelopmentStatus,
  WebExplorationStatus,
  WebFeedbackArea,
  WebFeedbackFeed,
  WebFeedbackInput,
  WebFeedbackReceipt,
  WebStepEvent,
} from "./session";

// The browser twin of packages/cli/src/components/PlayScreen.tsx. Same
// engine pump (new Engine → run() → next(input)), same screen-model
// reducer from @rpg-harness/frontend-core — only the shell differs: DOM
// instead of ink, clicks instead of useInput, and no fs (hot-reload and
// disk saves are gone; persistence is injected via onState).
type ModelAction =
  | { kind: "reset"; model: ScreenModel }
  | { kind: "apply"; output: Output }
  | { kind: "choose"; input: Input; selectedBy: "player" | "ai" }
  | { kind: "ui"; action: UiAction };

function modelReducer(model: ScreenModel, action: ModelAction): ScreenModel {
  if (action.kind === "reset") return action.model;
  if (action.kind === "ui") return applyUiAction(model, action.action);
  if (action.kind === "choose") {
    return applyChoiceSelection(model, action.input, action.selectedBy);
  }
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
  branchContext?: WebBranchContext;
  developmentStatus?: WebDevelopmentStatus;
  feedbackEnabled?: boolean;
  onFeedback?: (input: WebFeedbackInput) => Promise<WebFeedbackReceipt>;
  feedbackFeed?: WebFeedbackFeed;
  explorationEnabled?: boolean;
  onLoadExploration?: () => Promise<WebExplorationStatus | null>;
  onExplore?: (key: string) => Promise<void>;
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
  branchContext,
  developmentStatus,
  feedbackEnabled = false,
  onFeedback,
  feedbackFeed,
  explorationEnabled = false,
  onLoadExploration,
  onExplore,
  onExit,
}: Props) {
  const [model, dispatch] = useReducer(
    modelReducer,
    branchContext,
    (context): ScreenModel => context?.handoff?.premiere
      ? appendChoiceBacklog(initialModel, {
          ...context.handoff.premiere,
          selectedBy: "ai",
        })
      : initialModel,
  );
  const engineRef = useRef<Engine | null>(null);
  const runnerRef = useRef<AsyncGenerator<Output, void, Input> | null>(null);
  const processingRef = useRef(false);
  const outputRef = useRef<Output | null>(null);
  const [showBacklog, setShowBacklog] = useState(false);
  const [showArtBook, setShowArtBook] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [inputNotice, setInputNotice] = useState<InputResult | null>(null);
  const [exploration, setExploration] = useState<WebExplorationStatus | null>(null);
  const [exploring, setExploring] = useState(false);
  const [explorationError, setExplorationError] = useState<string | null>(null);

  const assetMap = useRef(
    new Map((game.assets ?? []).map((a) => [a.path, a] as const)),
  ).current;

  useEffect(() => {
    if (model.stage.kind !== "ended" || !explorationEnabled || !onLoadExploration) {
      return;
    }
    let cancelled = false;
    setExplorationError(null);
    void onLoadExploration().then((status) => {
      if (!cancelled) setExploration(status);
    }).catch((cause) => {
      if (!cancelled) {
        setExplorationError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    return () => { cancelled = true; };
  }, [model.stage.kind, explorationEnabled, onLoadExploration]);

  const exploreNextBranch = useCallback(async () => {
    const next = exploration?.next;
    if (!next || !onExplore || exploring) return;
    setExploring(true);
    setExplorationError(null);
    try {
      await onExplore(next.key);
    } catch (cause) {
      setExplorationError(cause instanceof Error ? cause.message : String(cause));
      setExploring(false);
    }
  }, [exploration, exploring, onExplore]);

  const commit = useCallback(
    async (
      res: IteratorResult<Output, void>,
      input?: Input,
      inputResult?: InputResult,
      replayState?: ComposedState,
    ) => {
      const output: Output = res.done ? { type: "gameEnd" } : res.value;
      const decision = input
        ? choiceDecisionContext(outputRef.current, input)
        : undefined;
      const activityDecision = input
        ? activityDecisionContext(outputRef.current, input)
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
                ...(activityDecision ? { activityDecision } : {}),
                ...(replayState ? { replayState } : {}),
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
        const replayState = engineRef.current?.getState();
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
        dispatch({ kind: "choose", input, selectedBy: "player" });
        await commit(
          submitted.result!,
          input,
          submitted.inputResult,
          replayState,
        );
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
      if (showBacklog || showArtBook || showFeedback) return;
      const k = model.stage.kind;
      if ((e.key === " " || e.key === "Enter") && (k === "narration" || k === "dialogue")) {
        e.preventDefault();
        void sendInput({ type: "next" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [model.stage.kind, showBacklog, showArtBook, showFeedback, sendInput, onExit]);

  return (
    <div className="play-root">
      <VisualLayer visuals={model.visuals} assetMap={assetMap} assetUrls={assetUrls} />
      {model.stage.kind === "hubMenu" && (
        <StatusBar snapshot={model.stage.snapshot} />
      )}
      <div className="stage-area">
        <StageView
          stage={model.stage}
          game={game}
          onInput={sendInput}
          exploration={exploration}
          exploring={exploring}
          explorationError={explorationError}
          onExplore={onExplore ? () => void exploreNextBranch() : undefined}
        />
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
        {branchContext?.handoff && <BranchHandoffBadge branch={branchContext} />}
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
        {feedbackEnabled && onFeedback && (
          <button className="hud-btn hud-feedback-btn" onClick={() => setShowFeedback(true)}>
            AIへフィードバック{feedbackFeed?.open
              ? ` · ${feedbackFeed.open}件対応中`
              : feedbackFeed?.resolved
                ? ` · ${feedbackFeed.resolved}件対応済み`
                : ""}
          </button>
        )}
      </div>
      {showBacklog && (
        <BacklogOverlay entries={model.backlog} onClose={() => setShowBacklog(false)} />
      )}
      {showArtBook && (
        <ArtBook game={game} assetUrls={assetUrls} onClose={() => setShowArtBook(false)} />
      )}
      {showFeedback && onFeedback && (
        <FeedbackOverlay
          branchContext={branchContext}
          currentTarget={resolveFeedbackTarget(
            game,
            engineRef.current?.getState().baseline.currentScriptId ?? null,
            branchContext,
          )}
          feedbackFeed={feedbackFeed}
          onSubmit={onFeedback}
          onClose={() => setShowFeedback(false)}
        />
      )}
    </div>
  );
}

export function FeedbackOverlay({
  branchContext,
  currentTarget,
  feedbackFeed,
  onSubmit,
  onClose,
}: {
  branchContext?: WebBranchContext;
  currentTarget?: string;
  feedbackFeed?: WebFeedbackFeed;
  onSubmit: (input: WebFeedbackInput) => Promise<WebFeedbackReceipt>;
  onClose: () => void;
}) {
  const [area, setArea] = useState<WebFeedbackArea>("narrative");
  const [severity, setSeverity] = useState<WebFeedbackInput["severity"]>("minor");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<WebFeedbackReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const target = currentTarget ?? (
    branchContext?.playerControl ? undefined : branchContext?.handoff?.target
  );
  const targetApplies = area === "narrative" || area === "gameplay";
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      setReceipt(await onSubmit({
        area,
        severity,
        title,
        ...(details.trim() ? { details } : {}),
        ...(target && targetApplies ? { target } : {}),
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="backlog-overlay" role="dialog" aria-modal="true" aria-label="AIへのフィードバック">
      <div className="backlog-inner feedback-inner">
        <div className="backlog-head">
          <div>
            <strong>AIへフィードバック</strong>
            <div className="feedback-subtitle">今の画面・ログ・セーブを再現可能な coding issue にします。</div>
          </div>
          <button className="hud-btn" onClick={onClose}>閉じる</button>
        </div>
        {receipt ? (
          <div className="feedback-success" role="status">
            <strong>受け取りました · {receipt.id}</strong>
            <p>log {receipt.evidence.logEntry ?? "—"} · script {receipt.evidence.currentScriptId ?? "—"}</p>
            <p>{receipt.evidence.checkpoint ? "再現 checkpoint 付き。AI の worklist に追加済みです。" : "証拠の一部を取得できませんでした。issue 詳細を確認してください。"}</p>
            <button className="hud-btn" onClick={onClose}>ゲームへ戻る</button>
          </div>
        ) : (
          <form className="feedback-form" onSubmit={(event) => void submit(event)}>
            <div className="feedback-row">
              <label>領域
                <select value={area} onChange={(event) => setArea(event.target.value as WebFeedbackArea)}>
                  <option value="narrative">物語・台詞</option>
                  <option value="gameplay">遊び・バランス</option>
                  <option value="engine">エンジン</option>
                  <option value="ui">UI</option>
                  <option value="tooling">AI開発ツール</option>
                </select>
              </label>
              <label>重さ
                <select value={severity} onChange={(event) => setSeverity(event.target.value as WebFeedbackInput["severity"])}>
                  <option value="note">メモ</option>
                  <option value="minor">軽微</option>
                  <option value="major">重大</option>
                  <option value="blocker">進行不能</option>
                </select>
              </label>
            </div>
            <label>何が気になった？
              <input autoFocus required maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例：この返答は少し説明的すぎる" />
            </label>
            <label>補足（任意）
              <textarea rows={5} maxLength={2000} value={details} onChange={(event) => setDetails(event.target.value)} placeholder="期待した感触や、直してほしい方向を書けます。" />
            </label>
            {targetApplies && (
              <div className="feedback-target">
                {target ? `Target: ${target}` : "Routing: live checkpoint / current runtime"}
              </div>
            )}
            {error && <div className="feedback-error" role="alert">{error}</div>}
            <button className="feedback-submit" disabled={!title.trim() || submitting} type="submit">
              {submitting ? "記録中…" : "この瞬間を issue にする"}
            </button>
          </form>
        )}
        {feedbackFeed && feedbackFeed.items.length > 0 && (
          <div className="feedback-history">
            <strong>このセッションのフィードバック</strong>
            {feedbackFeed.items.map((item) => (
              <article className={`feedback-history-item ${item.status}`} key={item.id}>
                <div className="feedback-history-title">
                  <span>{item.title}</span>
                  <span>{item.status === "open" ? "AI対応中" : item.status === "resolved" ? "対応済み" : "見送り"}</span>
                </div>
                <div className="feedback-history-meta">
                  {item.area} · {item.severity} · log {item.evidence.logEntry ?? "—"} · {item.evidence.currentScriptId ?? "—"}
                </div>
                {item.resolution && <p><strong>AI:</strong> {item.resolution}</p>}
                {item.supersededReason && <p><strong>AI:</strong> {item.supersededReason}</p>}
                {item.verification && (
                  <div className="feedback-proof">
                    <strong>検証済み</strong>
                    <span>project {shortRevision(item.verification.originalInputRevision)} → {shortRevision(item.verification.fixedInputRevision)}</span>
                    <span>certificate {shortRevision(item.verification.certificateRevision)}</span>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function resolveFeedbackTarget(
  game: Game,
  currentScriptId: string | null,
  branchContext?: WebBranchContext,
): string | undefined {
  if (currentScriptId) {
    const source = game.scripts.find((script) => script.id === currentScriptId)?.source;
    if (source?.trim()) return source;
  }
  return branchContext?.playerControl
    ? undefined
    : branchContext?.handoff?.target;
}

function shortRevision(revision: string): string {
  return revision.slice(0, 10);
}

export function BranchHandoffBadge({ branch }: { branch: WebBranchContext }) {
  const handoff = branch.handoff;
  if (!handoff) return null;
  const outcome = branch.outcome;
  const playerControl = branch.playerControl;
  const state = handoff.state === "target-reached"
    ? "exact target reached"
    : handoff.state === "closest"
      ? "closest state"
      : handoff.state;
  const detail = [
    "AI prepared this isolated branch from structured coding work.",
    `Work: ${handoff.workKey}`,
    `Intent: ${handoff.title}`,
    `Source: ${branch.fromSession} @ log ${branch.sourceLogEntry} (${branch.mode})`,
    `Operation: ${handoff.operation}; state: ${state}.`,
    ...(handoff.target ? [`Target: ${handoff.target}`] : []),
    ...(outcome
      ? [`Outcome: selected ${outcome.optionId} via ${outcome.source ?? "unknown"} at log ${outcome.logEntry}.`]
      : []),
    ...(playerControl
      ? [`Control: handed to the player via ${playerControl.source} at log ${playerControl.logEntry}.`]
      : ["Control: awaiting the player's first accepted input."]),
  ].join("\n");
  const subject = outcome
    ? `已选择: ${outcome.optionText ?? outcome.optionId}`
    : handoff.title;
  const label = playerControl
    ? `玩家游玩 · AI 来源: ${subject}`
    : `AI 首映 · ${subject}`;
  return (
    <span
      className={`hud-handoff ${handoff.state}${playerControl ? " player-owned" : ""}`}
      role="status"
      title={detail}
    >
      {label} · {handoff.priority}
    </span>
  );
}

export function DevelopmentBadge({ status }: { status: WebDevelopmentStatus }) {
  const clean = status.worklist.total === 0;
  const certified = status.quality.status === "certified";
  const pacing = status.quality.maxActivityRepetition;
  const label = !clean
    ? `AI Dev · ${status.worklist.total} pending${status.worklist.highestPriority ? ` · ${status.worklist.highestPriority}` : ""}`
    : certified
      ? `AI Dev · certified · ${status.quality.endings} endings / ${status.quality.paths} paths · ${status.quality.seeds.length} seeds${status.quality.fuzzLanes ? ` · ${status.quality.fuzzLanes} fuzz` : ""}${pacing ? ` · loop ${pacing.count}/${pacing.limit}` : ""}`
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
          status.quality.fuzzLanes
            ? `Seeded fuzz survival: ${status.quality.fuzzLanes} lanes (${status.quality.fuzzPersonas.join(", ")}); slowest ${status.quality.fuzzMaxDecisions?.decisions ?? 0} decisions.`
            : undefined,
          pacing
            ? `Heaviest semantic loop: seed ${pacing.seed}, ${pacing.persona}/${pacing.activityKind} ×${pacing.count} (limit ${pacing.limit}).`
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
  exploration,
  exploring = false,
  explorationError,
  onExplore,
}: {
  stage: Stage;
  game: Game;
  onInput: (input: Input) => void;
  exploration?: WebExplorationStatus | null;
  exploring?: boolean;
  explorationError?: string | null;
  onExplore?: () => void;
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
              className={`objective-card objective-${objective.status} objective-scope-${objective.scope}${objective.focus === true ? " objective-focused" : ""}`}
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
                  {objective.focus === true ? " · NOW" : ""}
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
                  {formatObjectiveRequirement(req)}
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
                      {playerForecastMetrics(a).length > 0 && (
                        <div className="activity-forecast">
                          {playerForecastMetrics(a).map((metric) => (
                            <span
                              className={`forecast-chip forecast-${metric.polarity ?? "neutral"}`}
                              key={metric.id}
                            >
                              {metric.label} {formatForecastMetricValue(metric)}
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
          {exploration?.next && (
            <div className="ended-exploration">
              <div className="ended-exploration-kicker">AI BRANCH · {exploration.pendingOptions} PATHS</div>
              <div className="ended-exploration-title">別の選択から、物語を続ける</div>
              <div className="ended-exploration-next">次: {exploration.next.optionText}</div>
              <button
                className="ended-exploration-btn"
                disabled={exploring}
                onClick={onExplore}
              >
                {exploring ? "AI が分岐を探索中…" : "AI に別の分岐を探索させる"}
              </button>
              <div className="ended-exploration-note">この結末は残したまま、checkpoint から独立した共有セッションを作ります。</div>
            </div>
          )}
          {exploration && !exploration.next && (
            <div className="ended-exploration-complete">この lineage の選択分岐はすべて探索済みです。</div>
          )}
          {explorationError && <div className="ended-exploration-error" role="alert">{explorationError}</div>}
        </div>
      );
  }
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

export function BacklogOverlay({
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
            if (entry.kind === "choice")
              return (
                <div key={i} className="backlog-choice">
                  {entry.prompt && <div className="backlog-choice-prompt">{entry.prompt}</div>}
                  <div className="backlog-choice-answer">
                    <span>{entry.selectedBy === "ai" ? "AI 選択" : "選択"}</span>
                    {entry.optionText}
                  </div>
                </div>
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
