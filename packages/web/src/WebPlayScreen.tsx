import React, {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  activityDecisionContext,
  buildProjectResourceRegistry,
  choiceDecisionContext,
  classifyInput,
  Engine,
  createInitialState,
  retargetAcceptedInputResult,
} from "@rpg-harness/engine";
import type {
  AssetSpec,
  ComposedState,
  Game,
  HubSnapshot,
  Input,
  InputResult,
  MapFacing,
  MapPoint,
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
import {
  collectSpatialPlacementActivityIds,
  SpatialMapSurface,
} from "./SpatialMapSurface";
import type {
  WebBranchContext,
  WebAiPersona,
  WebAiStatus,
  WebAiTurnReceipt,
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

const MAP_KEY_DIRECTIONS: Partial<Record<string, MapFacing>> = {
  ArrowUp: "north", w: "north", W: "north",
  ArrowRight: "east", d: "east", D: "east",
  ArrowDown: "south", s: "south", S: "south",
  ArrowLeft: "west", a: "west", A: "west",
};

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
  externalInputNotice?: {
    result: InputResult;
    source?: string;
  };
  externalAdvanceNotice?: {
    source?: string;
    logCursor: number;
  };
  aiControlEnabled?: boolean;
  aiTurnReceipt?: WebAiTurnReceipt;
  aiTurnPending?: boolean;
  initialAiPersona?: string;
  onLoadAiStatus?: () => Promise<WebAiStatus>;
  onAdvanceAiTurn?: (
    persona: string,
  ) => Promise<WebAiTurnReceipt>;
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
  if (!inputResult.accepted) return { inputResult };
  const result = await runner.next(input);
  return {
    inputResult: retargetAcceptedInputResult(
      inputResult,
      result.done ? null : result.value,
    ),
    result,
  };
}

export function inputNoticeSourceLabel(source: string): string {
  if (source === "cli" || source.startsWith("autoplay:")) return "HEADLESS";
  if (source === "tui") return "TUI";
  return source.toUpperCase();
}

export function formatExternalAdvanceNotice(source?: string): string {
  const controller = inputNoticeSourceLabel(source ?? "external");
  return `${controller} 已推进共享会话；GUI 已同步到最新画面。`;
}

export function formatAiTurnReceipt(receipt: WebAiTurnReceipt): string {
  const action = receipt.lastAction ? formatAiPublicAction(receipt.lastAction) : null;
  const basis = formatAiPublicDecisionBasis(receipt.decisionBasis);
  const explainedAction = action
    ? `${action}${basis ? `（${basis}）` : ""}`
    : null;
  if (receipt.advancedAfterTurn) {
    return `${explainedAction ? `${explainedAction}；` : ""}AI 落子后其他界面又推进了会话；已显示最新画面，下一手归玩家。`;
  }
  if (receipt.ending) {
    return `${explainedAction ? `${explainedAction}；` : ""}到达结局 ${receipt.ending}。当前存档已封存；可从 checkpoint 探索其他分支。`;
  }
  if (receipt.rejectedInputs > 0) {
    return `输入被拒绝 ${receipt.rejectedInputs} 次，剧情未被覆盖。下一手归玩家。`;
  }
  const progress = receipt.progress.scriptProgress;
  if (progress) {
    return `${explainedAction ? `${explainedAction}；` : ""}推进 ${progress.from ?? "场景"}：${progress.beatIndexFrom} → ${progress.beatIndexTo}。下一手归玩家。`;
  }
  if (receipt.progress.madeProgress) {
    return `${explainedAction ? `${explainedAction}；` : ""}推进了当前目标。下一手归玩家。`;
  }
  return `${explainedAction ?? `完成 ${receipt.decisions} 个决策（${receipt.reason}）`}。下一手归玩家。`;
}

function formatAiPublicDecisionBasis(
  basis: WebAiTurnReceipt["decisionBasis"],
): string | null {
  if (!basis) return null;
  const facts: string[] = [];
  if (basis.publicIntent) {
    facts.push(`当步规则：${basis.publicIntent}`);
  } else {
    facts.push(`策略：${basis.policyDescription}`);
  }
  if (basis.kind === "choice-evidence") {
    if (basis.aiTags.length > 0) {
      facts.push(`回应意图：${basis.aiTags.join(" / ")}`);
    }
    if (basis.aiPriority !== undefined) {
      facts.push(`作者优先级：${basis.aiPriority}`);
    }
    facts.push(
      basis.availableOptions > 1
        ? `同题 ${basis.availableOptions} 项可选`
        : "当前唯一可选回应",
    );
    return `公开证据：${facts.join("；")}`;
  }
  if (basis.objectives.length > 0) {
    const titles = basis.objectives.map(({ title }) => `「${title}」`).join("、");
    const omitted = basis.totalObjectives - basis.objectives.length;
    facts.push(
      `目标关联：${titles}${omitted > 0 ? ` 等 ${basis.totalObjectives} 项` : ""}`,
    );
  }
  if (basis.forecast) facts.push(`行动预测：${basis.forecast}`);
  if (basis.recommended) facts.push("作者推荐");
  if (basis.aiTags.length > 0) {
    facts.push(`行动意图：${basis.aiTags.join(" / ")}`);
  }
  const alternatives = basis.sameCategoryActivities > 1
    ? `同类 ${basis.sameCategoryActivities} 项可选`
    : basis.availableActivities > 1
      ? `当前 ${basis.availableActivities} 项可选`
      : "当前唯一可执行行动";
  facts.push(alternatives);
  return `公开证据：${facts.join("；")}`;
}

function formatAiPublicAction(
  action: NonNullable<WebAiTurnReceipt["lastAction"]>,
): string {
  switch (action.type) {
    case "next":
      return "推进文本";
    case "choose":
      return `选择${quotePublicLabel(action.text ?? action.optionId ?? "选项")}`;
    case "select":
      return `进入${quotePublicLabel(action.title ?? action.scriptId)}`;
    case "doActivity":
      return `执行${quotePublicLabel(action.title ?? action.id)}`;
    case "moveMap":
      return `在地图上向${({ north: "北", east: "东", south: "南", west: "西" } as const)[action.direction]}移动`;
    case "quit":
      return "选择退出";
  }
}

function quotePublicLabel(value: string): string {
  const normalized = value.trim();
  return normalized.startsWith("「") && normalized.endsWith("」")
    ? normalized
    : `「${normalized}」`;
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
  externalInputNotice,
  externalAdvanceNotice,
  aiControlEnabled = false,
  aiTurnReceipt,
  aiTurnPending = false,
  initialAiPersona,
  onLoadAiStatus,
  onAdvanceAiTurn,
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
  const [showAdventureRecord, setShowAdventureRecord] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showSystemMenu, setShowSystemMenu] = useState(false);
  const overlayReturnFocusRef = useRef<HTMLElement | null>(null);
  const [inputNotice, setInputNotice] = useState<InputResult | null>(null);
  const [inputNoticeSource, setInputNoticeSource] = useState<string | null>(null);
  const [externalAdvance, setExternalAdvance] = useState(
    externalAdvanceNotice ?? null,
  );
  const [exploration, setExploration] = useState<WebExplorationStatus | null>(null);
  const [exploring, setExploring] = useState(false);
  const [explorationError, setExplorationError] = useState<string | null>(null);
  const [aiPersonas, setAiPersonas] = useState<WebAiPersona[]>([]);
  // Empty on a fresh mount so the shared control ticket can choose the first
  // value. Once the player selects a valid persona, background status reloads
  // must not snap the pending choice back before they click hand-off.
  const [aiPersona, setAiPersona] = useState(initialAiPersona ?? "");
  const [aiThinking, setAiThinking] = useState(false);
  const [aiReceipt, setAiReceipt] = useState<WebAiTurnReceipt | null>(
    aiTurnReceipt ?? null,
  );
  const [aiError, setAiError] = useState<string | null>(null);

  const assetMap = useRef(
    new Map((game.assets ?? []).map((a) => [a.path, a] as const)),
  ).current;

  useEffect(() => {
    if (externalInputNotice?.result.accepted === false) {
      setInputNotice(externalInputNotice.result);
      setInputNoticeSource(externalInputNotice.source ?? "external");
      return;
    }
    setInputNotice(null);
    setInputNoticeSource(null);
  }, [externalInputNotice]);

  useEffect(() => {
    if (aiTurnReceipt) setAiReceipt(aiTurnReceipt);
  }, [aiTurnReceipt]);

  useEffect(() => {
    if (!externalAdvanceNotice) return;
    setExternalAdvance(externalAdvanceNotice);
    setAiReceipt(null);
  }, [externalAdvanceNotice]);

  useEffect(() => {
    if (!aiControlEnabled || !onLoadAiStatus) return;
    let cancelled = false;
    void onLoadAiStatus().then(({ personas, control }) => {
      if (cancelled) return;
      setAiPersonas(personas);
      setAiPersona((current) => {
        if (personas.some((persona) => persona.name === current)) return current;
        const persisted = control?.persona;
        if (persisted && personas.some((persona) => persona.name === persisted)) {
          return persisted;
        }
        return personas[0]?.name ?? "";
      });
    }).catch((cause) => {
      if (!cancelled) setAiError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, [aiControlEnabled, onLoadAiStatus]);

  const advanceAi = useCallback(async () => {
    if (!onAdvanceAiTurn || !aiPersona || aiThinking || processingRef.current) return;
    processingRef.current = true;
    setAiThinking(true);
    setAiError(null);
    try {
      const receipt = await onAdvanceAiTurn(aiPersona);
      setAiReceipt(receipt);
    } catch (cause) {
      setAiError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      processingRef.current = false;
      setAiThinking(false);
    }
  }, [aiPersona, aiThinking, onAdvanceAiTurn]);

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
      if (processingRef.current || aiTurnPending) return;
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
          setInputNoticeSource(null);
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
        setInputNoticeSource(null);
        setExternalAdvance(null);
        setAiReceipt(null);
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
    [aiTurnPending, commit, onCommit],
  );

  const openOverlay = useCallback((open: () => void) => {
    overlayReturnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    open();
  }, []);

  const closeOverlay = useCallback((close: () => void) => {
    close();
    requestAnimationFrame(() => overlayReturnFocusRef.current?.focus());
  }, []);

  const optionFocusKey = model.stage.kind === "choice"
    ? `choice:${model.stage.choiceId ?? model.stage.cursor}:${model.stage.options.map((option) => option.id ?? option.text).join("|")}`
    : model.stage.kind === "scriptComplete"
      ? `scripts:${model.stage.completedId}:${model.stage.nextAvailable.map((script) => script.id).join("|")}`
      : null;
  const storyFocusKey = model.stage.kind === "narration"
    ? `narration:${model.stage.text}`
    : model.stage.kind === "dialogue"
      ? `dialogue:${model.stage.speakerName}:${model.stage.text}`
      : null;
  const endingFocusKey = model.stage.kind === "ended"
    ? `ending:${model.stage.endingId ?? "unknown"}:${exploration?.next?.key ?? "settled"}`
    : null;

  useEffect(() => {
    if (!optionFocusKey) return;
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(".choice-panel .option-btn:not(:disabled)")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [optionFocusKey]);

  useEffect(() => {
    if (!storyFocusKey) return;
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(".dialogue-box.clickable")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [storyFocusKey]);

  useEffect(() => {
    if (!endingFocusKey) return;
    const frame = requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(".ended-exploration-btn:not(:disabled)")
        ?? document.querySelector<HTMLElement>(".ended-panel");
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [endingFocusKey]);

  // Keyboard: classic RPG field movement, Hub cursor navigation, confirm and cancel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (showFeedback) {
          closeOverlay(() => setShowFeedback(false));
        } else if (showArtBook) {
          closeOverlay(() => setShowArtBook(false));
        } else if (showAdventureRecord) {
          closeOverlay(() => setShowAdventureRecord(false));
        } else if (showBacklog) {
          closeOverlay(() => setShowBacklog(false));
        } else if (showSystemMenu) {
          closeOverlay(() => setShowSystemMenu(false));
        } else if (onExit) {
          openOverlay(() => setShowSystemMenu(true));
        }
        return;
      }
      if (showBacklog || showArtBook || showAdventureRecord || showFeedback || showSystemMenu) return;
      const tag = e.target instanceof HTMLElement ? e.target.tagName : "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const k = model.stage.kind;
      if (k === "choice" || k === "scriptComplete") {
        const options = Array.from(document.querySelectorAll<HTMLButtonElement>(
          ".choice-panel .option-btn:not(:disabled)",
        ));
        const focused = options.indexOf(document.activeElement as HTMLButtonElement);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) && options.length > 0) {
          e.preventDefault();
          const nextIndex = e.key === "Home"
            ? 0
            : e.key === "End"
              ? options.length - 1
              : nextHubCommandIndex(focused, options.length, e.key === "ArrowDown" ? 1 : -1);
          options[nextIndex]?.focus();
          return;
        }
        if ((e.key === "Enter" || e.key === " ") && focused >= 0) {
          e.preventDefault();
          options[focused]?.click();
          return;
        }
      }
      if (k === "hubMenu") {
        const currentMapId = engineRef.current?.getState().baseline.currentMapId;
        const spatial = (game.maps ?? []).some((map) =>
          map.id === currentMapId && map.layout !== undefined
        );
        const direction = MAP_KEY_DIRECTIONS[e.key];
        const commandTarget = tag === "BUTTON" || tag === "A";
        if (spatial && direction && !commandTarget) {
          e.preventDefault();
          void sendInput({ type: "moveMap", direction });
          return;
        }
        if (!spatial && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          const commands = Array.from(document.querySelectorAll<HTMLButtonElement>(
            ".hub-actions .activity-btn:not(:disabled)",
          ));
          if (commands.length > 0) {
            e.preventDefault();
            const currentIndex = commands.indexOf(document.activeElement as HTMLButtonElement);
            const nextIndex = e.key === "Home"
              ? 0
              : e.key === "End"
                ? commands.length - 1
                : nextHubCommandIndex(currentIndex, commands.length, e.key === "ArrowDown" ? 1 : -1);
            commands[nextIndex]?.focus();
          }
          return;
        }
      }
      if ((e.key === " " || e.key === "Enter") && (k === "narration" || k === "dialogue")) {
        e.preventDefault();
        void sendInput({ type: "next" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [game.maps, model.stage.kind, showBacklog, showArtBook, showAdventureRecord, showFeedback, showSystemMenu, sendInput, onExit, openOverlay, closeOverlay]);

  const currentMapId = engineRef.current?.getState().baseline.currentMapId ?? null;
  const currentMap = currentMapId
    ? (game.maps ?? []).find((map) => map.id === currentMapId)
    : undefined;
  const sceneLabel = currentMap?.name ?? stageContextLabel(model.stage.kind);
  const adventureState = engineRef.current?.getState() ?? initialState;

  return (
    <div className="play-root">
      <VisualLayer visuals={model.visuals} assetMap={assetMap} assetUrls={assetUrls} />
      <header className="game-chrome">
        <div className={`game-topbar${model.stage.kind === "hubMenu" ? " has-status" : ""}`}>
          <div className="game-identity">
            <span className="game-crest" aria-hidden="true">妖</span>
            <div>
              <strong>{game.title}</strong>
              <small>{sceneLabel}</small>
            </div>
          </div>
          {model.stage.kind === "hubMenu" && (
            <StatusBar snapshot={model.stage.snapshot} />
          )}
          <nav className="game-menu" aria-label="ゲームメニュー">
            {onExit && (
              <button className="hud-btn" onClick={() => openOverlay(() => setShowSystemMenu(true))}>
                <span aria-hidden="true">☰</span> 菜单
              </button>
            )}
            {model.backlog.length > 0 && (
              <button className="hud-btn" onClick={() => openOverlay(() => setShowBacklog(true))}>
                <span aria-hidden="true">≡</span> 回看
              </button>
            )}
            <button className="hud-btn" onClick={() => openOverlay(() => setShowArtBook(true))}>
              <span aria-hidden="true">◇</span> 設定集
            </button>
            {feedbackEnabled && onFeedback && (
              <button className="hud-btn hud-feedback-btn" onClick={() => openOverlay(() => setShowFeedback(true))}>
                <span aria-hidden="true">✦</span> AIへフィードバック{feedbackFeed?.open
                  ? ` · ${feedbackFeed.open}件対応中`
                  : feedbackFeed?.resolved
                    ? ` · ${feedbackFeed.resolved}件対応済み`
                    : ""}
              </button>
            )}
          </nav>
        </div>
        <div className="game-contextbar">
          <div className="game-context-status">
            {sessionLabel && (
              <span className="hud-session" title="Headless CLI と共有される保存先">
                <i aria-hidden="true" /> {sessionLabel}
              </span>
            )}
            {branchContext?.handoff && <BranchHandoffBadge branch={branchContext} />}
            {developmentStatus && <DevelopmentBadge status={developmentStatus} />}
          </div>
          {model.stage.kind !== "ended" && aiControlEnabled && onAdvanceAiTurn && (
            <span className="hud-ai-control" title={aiPersonas.find((entry) => entry.name === aiPersona)?.description}>
              <span className="ai-control-label">AI COPILOT</span>
              <select
                aria-label="AI人格"
                value={aiPersona}
                disabled={aiThinking || aiTurnPending || aiPersonas.length === 0}
                onChange={(event) => setAiPersona(event.target.value)}
              >
                {aiPersonas.map((persona) => (
                  <option value={persona.name} key={persona.name}>
                    {persona.source.startsWith("module:") ? "PROJECT · " : ""}{persona.name}
                  </option>
                ))}
              </select>
              <button
                className="hud-btn hud-ai-btn"
                disabled={aiThinking || aiTurnPending || !aiPersona}
                onClick={() => void advanceAi()}
              >
                {aiThinking || aiTurnPending ? "AI思考中…" : "一手交给 AI"}
              </button>
            </span>
          )}
        </div>
      </header>
      <div className="stage-area">
        <StageView
          stage={model.stage}
          game={game}
          currentMapId={currentMapId}
          currentMapPosition={engineRef.current?.getState().runtime.mapPosition}
          currentMapPositionMapId={engineRef.current?.getState().runtime.mapPositionMapId}
          assetUrls={assetUrls}
          onInput={sendInput}
          exploration={exploration}
          exploring={exploring}
          explorationError={explorationError}
          onExplore={onExplore ? () => void exploreNextBranch() : undefined}
        />
      </div>
      {inputNotice && !inputNotice.accepted && (
        <div className="input-notice" role="status">
          <strong>
            {inputNoticeSource ? `${inputNoticeSourceLabel(inputNoticeSource)} · ` : ""}
            {inputNotice.code}
          </strong>
          <span>{inputNotice.message}</span>
          <button
            onClick={() => {
              setInputNotice(null);
              setInputNoticeSource(null);
            }}
            aria-label="入力通知を閉じる"
          >×</button>
        </div>
      )}
      {!inputNotice && externalAdvance && (
        <div className="input-notice accepted" role="status">
          <strong>{inputNoticeSourceLabel(externalAdvance.source ?? "external")} · SYNCED</strong>
          <span>{formatExternalAdvanceNotice(externalAdvance.source)}</span>
          <button
            onClick={() => setExternalAdvance(null)}
            aria-label="外部操作通知を閉じる"
          >×</button>
        </div>
      )}
      {(aiReceipt || aiError) && (
        <div className={`ai-turn-receipt${aiError ? " error" : ""}`} role="status">
          {aiError
            ? (
              <>
                <span>AI 接管失败：{aiError}</span>
                <button onClick={() => setAiError(null)} aria-label="AI错误通知を閉じる">×</button>
              </>
            )
            : aiReceipt && (
              <>
                <strong>AI · {aiReceipt.persona}</strong>
                <span>{formatAiTurnReceipt(aiReceipt)}</span>
                <button onClick={() => setAiReceipt(null)} aria-label="AI操作通知を閉じる">×</button>
              </>
            )}
        </div>
      )}
      {showBacklog && (
        <BacklogOverlay entries={model.backlog} onClose={() => closeOverlay(() => setShowBacklog(false))} />
      )}
      {showSystemMenu && onExit && (
        <SystemMenuOverlay
          gameTitle={game.title}
          sceneLabel={sceneLabel}
          sessionLabel={sessionLabel}
          backlogAvailable={model.backlog.length > 0}
          controlMode={model.stage.kind === "hubMenu"
            ? currentMap?.layout ? "field" : "hub"
            : "story"}
          onResume={() => closeOverlay(() => setShowSystemMenu(false))}
          onAdventureRecord={() => { setShowSystemMenu(false); setShowAdventureRecord(true); }}
          onBacklog={() => { setShowSystemMenu(false); setShowBacklog(true); }}
          onArtBook={() => { setShowSystemMenu(false); setShowArtBook(true); }}
          onExit={onExit}
        />
      )}
      {showArtBook && (
        <ArtBook game={game} assetUrls={assetUrls} onClose={() => closeOverlay(() => setShowArtBook(false))} />
      )}
      {showAdventureRecord && adventureState && (
        <AdventureRecordOverlay game={game} state={adventureState} onClose={() => closeOverlay(() => setShowAdventureRecord(false))} />
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
          onClose={() => closeOverlay(() => setShowFeedback(false))}
        />
      )}
    </div>
  );
}

export function SystemMenuOverlay({
  gameTitle,
  sceneLabel,
  sessionLabel,
  backlogAvailable,
  controlMode = "story",
  onResume,
  onAdventureRecord,
  onBacklog,
  onArtBook,
  onExit,
}: {
  gameTitle: string;
  sceneLabel: string;
  sessionLabel?: string;
  backlogAvailable: boolean;
  controlMode?: "story" | "hub" | "field";
  onResume: () => void;
  onAdventureRecord: () => void;
  onBacklog: () => void;
  onArtBook: () => void;
  onExit: () => void;
}) {
  const actionsRef = useRef<HTMLElement>(null);
  const controlRows = systemMenuControlRows(controlMode);

  useEffect(() => {
    const actions = actionsRef.current;
    if (!actions) return;
    const enabledButtons = () => Array.from(actions.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    enabledButtons()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const buttons = enabledButtons();
      if (buttons.length === 0) return;
      event.preventDefault();
      const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : nextHubCommandIndex(currentIndex, buttons.length, event.key === "ArrowDown" ? 1 : -1);
      buttons[nextIndex]?.focus();
    };
    actions.addEventListener("keydown", onKeyDown);
    return () => actions.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="system-menu-overlay" role="dialog" aria-modal="true" aria-label="系统菜单" onClick={onResume}>
      <section className="system-menu-frame" onClick={(event) => event.stopPropagation()}>
        <header className="system-menu-heading">
          <div><span>SYSTEM</span><strong>システムメニュー</strong></div>
          <button type="button" onClick={onResume} aria-label="关闭系统菜单">×</button>
        </header>
        <div className="system-menu-body">
          <nav ref={actionsRef} className="system-menu-actions" aria-label="系统菜单操作">
            <button type="button" className="primary" onClick={onResume}><span>▶</span><strong>继续游戏</strong><small>物語へ戻る</small></button>
            <button type="button" onClick={onAdventureRecord}><span>◆</span><strong>冒险记录</strong><small>人物・装備・所持品</small></button>
            <button type="button" disabled={!backlogAvailable} onClick={onBacklog}><span>≡</span><strong>回看记录</strong><small>会話ログ</small></button>
            <button type="button" onClick={onArtBook}><span>◇</span><strong>設定集</strong><small>世界・人物・美術</small></button>
            <button type="button" className="exit" onClick={onExit}><span>⌂</span><strong>返回标题</strong><small>タイトル画面へ</small></button>
          </nav>
          <aside className="system-menu-status">
            <span className="system-menu-crest" aria-hidden="true">妖</span>
            <div className="system-menu-title"><small>NOW PLAYING</small><strong>{gameTitle}</strong><span>{sceneLabel}</span></div>
            <dl>
              <div><dt>SAVE</dt><dd><i /> AUTO · 同期済み</dd></div>
              <div><dt>SESSION</dt><dd>{sessionLabel ?? "local"}</dd></div>
              {controlRows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
            </dl>
            <p>ゲームの進行は共有セッションへ自動保存されます。</p>
          </aside>
        </div>
        <footer><span>↑↓ · 選択　 Enter · 決定　 Esc · 閉じる</span><span>RPG HARNESS PLAYER</span></footer>
      </section>
    </div>
  );
}

export function systemMenuControlRows(mode: "story" | "hub" | "field") {
  if (mode === "field") return [
    { label: "MOVE", value: "Arrow / WASD · 移動" },
    { label: "ACTION", value: "E / Enter · 調べる" },
    { label: "COMMAND", value: "Tab · 指令へ" },
  ];
  if (mode === "hub") return [
    { label: "SELECT", value: "Arrow ↑↓ · 選択" },
    { label: "CONFIRM", value: "Enter · 決定" },
  ];
  return [{ label: "CONTROL", value: "Space / Enter · 進む" }];
}

export function AdventureRecordOverlay({
  game,
  state,
  onClose,
}: {
  game: Game;
  state: ComposedState;
  onClose: () => void;
}) {
  const map = (game.maps ?? []).find((entry) => entry.id === state.baseline.currentMapId);
  const inventory = Object.entries(state.baseline.inventory)
    .filter(([, count]) => count > 0)
    .map(([id, count]) => ({
      id,
      count,
      item: (game.items ?? []).find((entry) => entry.id === id),
    }));
  const weapon = state.baseline.equippedWeaponId
    ? (game.weapons ?? []).find((entry) => entry.id === state.baseline.equippedWeaponId)
    : undefined;
  const weaponPower = weapon ? state.baseline.weapons[weapon.id]?.power ?? weapon.basePower : null;
  const skills = state.baseline.knownSkills.map((id) =>
    (game.skills ?? []).find((entry) => entry.id === id) ?? { id, name: recordLabel(id), description: "" }
  );
  const completed = state.baseline.completionOrder.slice(-6).reverse();

  return (
    <div className="adventure-record-overlay" role="dialog" aria-modal="true" aria-label="冒险记录" onClick={onClose}>
      <section className="adventure-record-frame" onClick={(event) => event.stopPropagation()}>
        <header className="adventure-record-heading">
          <div><span>ADVENTURE RECORD</span><strong>旅の記録</strong><small>角色、装备与旅程状态</small></div>
          <button type="button" autoFocus onClick={onClose} aria-label="关闭冒险记录">× <kbd>Esc</kbd></button>
        </header>

        <div className="adventure-record-hero">
          <span className="adventure-record-crest" aria-hidden="true">旅</span>
          <div><small>CURRENT LOCATION</small><strong>{map?.name ?? "旅の途中"}</strong><span>{map?.description ?? game.title}</span></div>
          <dl>
            <div><dt>EVENTS</dt><dd>{state.baseline.completionOrder.length}</dd></div>
            <div><dt>ITEMS</dt><dd>{inventory.reduce((total, entry) => total + entry.count, 0)}</dd></div>
            <div><dt>SKILLS</dt><dd>{skills.length}</dd></div>
          </dl>
        </div>

        <div className="adventure-record-body">
          <section className="adventure-record-section party-record">
            <header><div><span>01</span><strong>人物状态</strong></div><small>PARTY &amp; BONDS</small></header>
            <div className="adventure-character-list">
              {(game.characters ?? []).map((character, index) => {
                const stats = Object.entries(state.baseline.characters[character.id]?.stats ?? {});
                return (
                  <article key={character.id}>
                    <span className="adventure-character-number">{String(index + 1).padStart(2, "0")}</span>
                    <div><strong>{character.name}</strong><small>{character.id}</small></div>
                    <dl>{stats.length > 0 ? stats.map(([name, value]) => <div key={name}><dt>{recordLabel(name)}</dt><dd>{value}</dd></div>) : <div><dt>STATUS</dt><dd>—</dd></div>}</dl>
                  </article>
                );
              })}
              {(game.characters ?? []).length === 0 && <p className="adventure-record-empty">No character records in this project.</p>}
            </div>
          </section>

          <section className="adventure-record-section loadout-record">
            <header><div><span>02</span><strong>装备与能力</strong></div><small>LOADOUT</small></header>
            <div className="adventure-weapon-card">
              <span aria-hidden="true">†</span>
              <div><small>EQUIPPED WEAPON</small><strong>{weapon?.name ?? "未装备"}</strong><p>{weapon?.description || "当前没有装备武器。"}</p></div>
              {weaponPower !== null && <b><small>POWER</small>{weaponPower}</b>}
            </div>
            <div className="adventure-skill-list">
              <span>LEARNED SKILLS</span>
              {skills.length > 0 ? skills.map((skill) => <div key={skill.id}><i>✦</i><strong>{skill.name}</strong><small>{skill.description}</small></div>) : <p className="adventure-record-empty">まだ技を習得していません。</p>}
            </div>
          </section>

          <section className="adventure-record-section inventory-record">
            <header><div><span>03</span><strong>所持品</strong></div><small>INVENTORY</small></header>
            <div className="adventure-item-list">
              {inventory.length > 0 ? inventory.map(({ id, count, item }) => (
                <article key={id}><span>◇</span><div><strong>{item?.name ?? recordLabel(id)}</strong><small>{item?.kind ?? "item"}</small></div><b>× {count}</b></article>
              )) : <p className="adventure-record-empty">所持品はありません。</p>}
            </div>
          </section>

          <section className="adventure-record-section progress-record">
            <header><div><span>04</span><strong>旅程</strong></div><small>STORY PROGRESS</small></header>
            <ol>
              {completed.length > 0 ? completed.map((id, index) => {
                const script = (game.scripts ?? []).find((entry) => entry.id === id);
                return <li key={`${id}-${index}`}><span>✓</span><div><strong>{script?.title ?? recordLabel(id)}</strong><small>{id}</small></div></li>;
              }) : <li className="empty"><span>◇</span><div><strong>物語は始まったばかり</strong><small>Completed events will appear here.</small></div></li>}
            </ol>
          </section>
        </div>
        <footer><span>Auto Save · Shared Session</span><span>Esc · 戻る</span></footer>
      </section>
    </div>
  );
}

function recordLabel(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function stageContextLabel(kind: Stage["kind"]): string {
  switch (kind) {
    case "hubMenu": return "拠点行動";
    case "dialogue": return "会話";
    case "narration": return "物語";
    case "choice": return "選択";
    case "scriptComplete": return "次章選択";
    case "ended": return "終幕";
    case "error": return "異常";
    default: return "読込中";
  }
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
  const panelRef = useRef<HTMLDivElement>(null);
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
  const keepFocusInReport = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    if (focusable.length === 0) return;
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
    <div className="backlog-overlay" role="dialog" aria-modal="true" aria-label="AIへのフィードバック" onClick={onClose}>
      <div
        ref={panelRef}
        className="backlog-inner feedback-inner"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={keepFocusInReport}
      >
        <div className="backlog-head">
          <div>
            <span>FIELD REPORT · LIVE CHECKPOINT</span>
            <strong>AIへフィードバック</strong>
            <div className="feedback-subtitle">今の画面・ログ・セーブを再現可能な coding issue にします。</div>
          </div>
          <button className="hud-btn" onClick={onClose}>閉じる</button>
        </div>
        <div className="feedback-scroll">
          {receipt ? (
            <div className="feedback-success" role="status">
              <span className="feedback-success-seal" aria-hidden="true">✓</span>
              <div>
                <small>REPORT ACCEPTED</small>
                <strong>受け取りました · {receipt.id}</strong>
                <p>log {receipt.evidence.logEntry ?? "—"} · script {receipt.evidence.currentScriptId ?? "—"}</p>
                <p>{receipt.evidence.checkpoint ? "再現 checkpoint 付き。AI の worklist に追加済みです。" : "証拠の一部を取得できませんでした。issue 詳細を確認してください。"}</p>
                <button className="hud-btn" onClick={onClose}>ゲームへ戻る</button>
              </div>
            </div>
          ) : (
            <form className="feedback-form" onSubmit={(event) => void submit(event)}>
              <div className="feedback-checkpoint">
                <span className="feedback-checkpoint-mark" aria-hidden="true">⌖</span>
                <div>
                  <small>CAPTURED CHECKPOINT</small>
                  <strong>{targetApplies ? target ?? "CURRENT RUNTIME" : "GLOBAL ENGINE SURFACE"}</strong>
                  <p>現在の画面・共有ログ・セーブ状態を証拠として添付します。</p>
                </div>
                <span className="feedback-live"><i aria-hidden="true" /> LIVE</span>
              </div>
              <div className="feedback-row">
                <label><span className="feedback-field-label"><b>01</b> 領域</span>
                  <select value={area} onChange={(event) => setArea(event.target.value as WebFeedbackArea)}>
                    <option value="narrative">物語・台詞</option>
                    <option value="gameplay">遊び・バランス</option>
                    <option value="engine">エンジン</option>
                    <option value="ui">UI</option>
                    <option value="tooling">AI開発ツール</option>
                  </select>
                </label>
                <label><span className="feedback-field-label"><b>02</b> 重さ</span>
                  <select value={severity} onChange={(event) => setSeverity(event.target.value as WebFeedbackInput["severity"])}>
                    <option value="note">メモ</option>
                    <option value="minor">軽微</option>
                    <option value="major">重大</option>
                    <option value="blocker">進行不能</option>
                  </select>
                </label>
              </div>
              <label><span className="feedback-field-label"><b>03</b> 何が気になった？</span>
                <input autoFocus required maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例：この返答は少し説明的すぎる" />
              </label>
              <label><span className="feedback-field-label"><b>04</b> 補足（任意）</span>
                <textarea rows={5} maxLength={2000} value={details} onChange={(event) => setDetails(event.target.value)} placeholder="期待した感触や、直してほしい方向を書けます。" />
              </label>
              {targetApplies && (
                <div className="feedback-target">
                  {target ? `Target: ${target}` : "Routing: live checkpoint / current runtime"}
                </div>
              )}
              {error && <div className="feedback-error" role="alert">{error}</div>}
              <button className="feedback-submit" disabled={!title.trim() || submitting} type="submit">
                <span>{submitting ? "記録中…" : "この瞬間を issue にする"}</span>
                <small>{submitting ? "CAPTURING EVIDENCE" : "ADD TO AI WORKLIST"}</small>
                <i aria-hidden="true">›</i>
              </button>
            </form>
          )}
          {feedbackFeed && feedbackFeed.items.length > 0 && (
            <div className="feedback-history">
              <div className="feedback-history-head">
                <strong>このセッションのフィードバック</strong>
                <span>{feedbackFeed.items.length} REPORTS</span>
              </div>
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
        <footer className="backlog-footer">
          <span>FIELD REPORT · EVIDENCE ATTACHED</span>
          <span>Esc · ゲームへ戻る</span>
        </footer>
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
  currentMapId,
  currentMapPosition,
  currentMapPositionMapId,
  assetUrls,
  onInput,
  exploration,
  exploring = false,
  explorationError,
  onExplore,
}: {
  stage: Stage;
  game: Game;
  currentMapId: string | null;
  currentMapPosition?: MapPoint;
  currentMapPositionMapId?: string | null;
  assetUrls: Record<string, string>;
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
        <div className="dialogue-box clickable" role="button" tabIndex={0} aria-label={`旁白：${stage.text}`} aria-keyshortcuts="Enter Space" onClick={() => onInput({ type: "next" })}>
          <header className="message-window-heading"><span>NARRATION</span><small>AUTO SAVE · ON</small></header>
          <p className="narration-text">{stage.text}</p>
          <div className="advance-hint"><span aria-hidden="true">▼</span><kbd>Enter</kbd> / <kbd>Space</kbd> · 進む</div>
        </div>
      );
    case "dialogue":
      return (
        <div className="dialogue-box clickable" role="button" tabIndex={0} aria-label={`${stage.speakerName}：${stage.text}`} aria-keyshortcuts="Enter Space" onClick={() => onInput({ type: "next" })}>
          <header className="message-window-heading"><strong className="speaker">{stage.speakerName}</strong><small>DIALOGUE</small></header>
          <p className="dialogue-text">{stage.text}</p>
          <div className="advance-hint"><span aria-hidden="true">▼</span><kbd>Enter</kbd> / <kbd>Space</kbd> · 進む</div>
        </div>
      );
    case "choice":
      return (
        <div className="choice-panel">
          <header className="choice-heading">
            <div><span>DECISION · {stage.options.filter((option) => option.available).length}/{stage.options.length}</span><strong>{stage.prompt || "選択してください"}</strong></div>
            <small><kbd>↑↓</kbd> 選択　<kbd>Enter</kbd> 決定</small>
          </header>
          <ul className="option-list">
            {stage.options.map((opt, i) => (
              <li key={i}>
                <button
                  className="option-btn"
                  aria-label={`${opt.text}${!opt.available && opt.lockedReason ? ` · ${opt.lockedReason}` : ""}`}
                  disabled={!opt.available}
                  onClick={() => onInput(
                    stage.choiceId && opt.id
                      ? { type: "choose", choiceId: stage.choiceId, optionId: opt.id }
                      : { type: "choose", index: i },
                  )}
                  title={opt.lockedReason ?? ""}
                >
                  <span className="option-index">{String(i + 1).padStart(2, "0")}</span>
                  <span className="option-copy"><strong>{opt.text}</strong>{!opt.available && opt.lockedReason && <small className="locked-reason">🔒 {opt.lockedReason}</small>}</span>
                  <i className="option-cursor" aria-hidden="true">›</i>
                </button>
              </li>
            ))}
          </ul>
        </div>
      );
    case "hubMenu": {
      const hubView = buildHubView(stage.snapshot);
      const currentMap = currentMapId
        ? (game.maps ?? []).find((map) => map.id === currentMapId)
        : undefined;
      const spatialResourceLabels = currentMap?.layout
        ? new Map(
          [...buildProjectResourceRegistry(game).entries()].map(([key, resource]) => [key, resource.label]),
        )
        : undefined;
      const spatialResourceGraphics = currentMap?.layout
        ? new Map(game.characters.flatMap((character) => character.mapSprite
          ? [[`character:${character.id}`, character.mapSprite] as const]
          : []))
        : undefined;
      const opportunityByCategory = new Map(
        hubView.opportunityGroups.map((group) => [group.category, group]),
      );
      const spatialPlacementActivityIds = currentMap?.layout
        ? collectSpatialPlacementActivityIds(
          currentMap,
          new Map(stage.snapshot.activities.map((activity) => [activity.id, activity])),
        )
        : new Set<string>();
      const playerSections = hubView.sections
        .map((section) => {
          const activities = section.activities.filter(
            ({ activity }) => !spatialPlacementActivityIds.has(activity.id),
          );
          const availableCount = activities.filter(({ activity }) => activity.available).length;
          return {
            ...section,
            activities,
            availableCount,
            lockedCount: activities.length - availableCount,
          };
        })
        .filter((section) => section.activities.length > 0);
      return (
        <div className={`hub-stage-layout${currentMap?.layout ? " has-spatial-map" : ""}`}>
          {currentMap?.layout && (
            <SpatialMapSurface
              map={currentMap}
              activities={stage.snapshot.activities}
              playerPosition={currentMapPositionMapId === currentMapId
                ? currentMapPosition
                : currentMap.layout.playerStart}
              resourceLabels={spatialResourceLabels}
              resourceGraphics={spatialResourceGraphics}
              playerGraphicUrl={assetUrls[spatialResourceGraphics?.get("character:player") ?? ""]}
              backgroundUrl={currentMap.bg ? assetUrls[currentMap.bg] : undefined}
              tileset={currentMap.layout.tileset
                ? (game.assets ?? []).find((asset) => asset.path === currentMap.layout!.tileset)
                : undefined}
              tilesetUrl={currentMap.layout.tileset ? assetUrls[currentMap.layout.tileset] : undefined}
              assetUrls={assetUrls}
              onInput={onInput}
            />
          )}
          <div className="hub-panel">
            <aside className="hub-summary" aria-label="任務と所持品">
              <div className="hub-column-title"><span>STATUS</span><strong>任務と所持品</strong></div>
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
            </aside>
            <main className="hub-actions" aria-label="実行可能な行動">
              <div className="hub-column-title">
                <span>COMMAND</span>
                <strong>行動を選ぶ</strong>
                <small className="hub-keyboard-inline">
                  {currentMap?.layout ? (
                    <><kbd>Tab</kbd> 指令 <kbd>E</kbd> 调查 <kbd>Esc</kbd> 菜单</>
                  ) : (
                    <><kbd>↑↓</kbd> 选择 <kbd>Enter</kbd> 确认 <kbd>Esc</kbd> 菜单</>
                  )}
                </small>
              </div>
              {playerSections.map((section) => (
                <section className="activity-section" key={section.category}>
                  <div className="activity-section-head">
                    <span>{section.label}</span>
                    <span>
                      {opportunityByCategory.get(section.category)?.decisionRequired && section.availableCount > 1 &&
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
            </main>
          </div>
        </div>
      );
    }
    case "scriptComplete":
      return (
        <div className="choice-panel">
          {stage.nextAvailable.length === 0 ? (
            <div className="choice-prompt">（次の物語はまだない）</div>
          ) : (
            <>
              <header className="choice-heading">
                <div><span>NEXT CHAPTER · {stage.nextAvailable.length}</span><strong>次の物語を選ぶ</strong></div>
                <small><kbd>↑↓</kbd> 選択　<kbd>Enter</kbd> 決定</small>
              </header>
              <ul className="option-list">
              {stage.nextAvailable.map((s, index) => (
                <li key={s.id}>
                  <button
                    className="option-btn"
                    aria-label={s.title}
                    onClick={() => onInput({ type: "select", scriptId: s.id })}
                  >
                    <span className="option-index">{String(index + 1).padStart(2, "0")}</span>
                    <span className="option-copy"><strong>{s.title}</strong><small>{s.id}</small></span>
                    <i className="option-cursor" aria-hidden="true">›</i>
                  </button>
                </li>
              ))}
              </ul>
            </>
          )}
        </div>
      );
    case "ended":
      const endingTitle = stage.endingId === undefined
        ? undefined
        : game.scripts.find((script) => script.id === stage.endingId)?.title;
      return (
        <div className="ended-panel" tabIndex={-1} aria-label={`物語完了${endingTitle ? `：${endingTitle}` : ""}`}>
          <span className="visually-hidden">― 終 ―</span>
          <header className="ended-heading">
            <span>STORY RESULT</span>
            <small>CLEAR DATA · SAVED</small>
          </header>
          <div className="ended-summary">
            <div className="ended-seal" aria-hidden="true"><span>終</span><small>END</small></div>
            <div className="ended-copy">
              <div className="ended-title">物語完了</div>
              <div className="ended-ending-title">{endingTitle ?? "名もなき結末"}</div>
              {stage.endingId && <code className="ended-ending-id">ENDING · {stage.endingId}</code>}
              {stage.reason && <div className="ended-reason">{stage.reason}</div>}
            </div>
          </div>
          {exploration?.next && (
            <div className="ended-exploration">
              <div className="ended-exploration-copy">
                <div className="ended-exploration-kicker">AI BRANCH · {exploration.pendingOptions} PATHS REMAIN</div>
                <div className="ended-exploration-title">別の選択から、物語を続ける</div>
                <div className="ended-exploration-next"><span>NEXT</span>{exploration.next.optionText}</div>
                <div className="ended-exploration-note">この結末は残したまま、checkpoint から独立した共有セッションを作ります。</div>
              </div>
              <button
                className="ended-exploration-btn"
                disabled={exploring}
                onClick={onExplore}
              >
                <span>{exploring ? "AI が分岐を探索中…" : "AI に別の分岐を探索させる"}</span>
                <i aria-hidden="true">›</i>
              </button>
            </div>
          )}
          {exploration && !exploration.next && (
            <div className="ended-exploration-complete"><span>QUEST COMPLETE</span>この lineage の選択分岐はすべて探索済みです。</div>
          )}
          {explorationError && <div className="ended-exploration-error" role="alert">{explorationError}</div>}
        </div>
      );
  }
}

export function nextHubCommandIndex(currentIndex: number, total: number, delta: 1 | -1): number {
  if (total <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= total) return delta > 0 ? 0 : total - 1;
  return (currentIndex + delta + total) % total;
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
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const frame = requestAnimationFrame(() => {
      scroll.scrollTop = scroll.scrollHeight;
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (!["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Home") scroll.scrollTop = 0;
      else if (event.key === "End") scroll.scrollTop = scroll.scrollHeight;
      else {
        const direction = ["ArrowDown", "PageDown"].includes(event.key) ? 1 : -1;
        const distance = event.key.startsWith("Page") ? scroll.clientHeight * 0.82 : 72;
        scroll.scrollTop += direction * distance;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [entries.length]);

  return (
    <div className="backlog-overlay" role="dialog" aria-modal="true" aria-label="回看" onClick={onClose}>
      <div className="backlog-inner" onClick={(e) => e.stopPropagation()}>
        <header className="backlog-head">
          <div><span>BACKLOG · {entries.length} LOGS</span><strong>回想記録</strong></div>
          <button className="hud-btn" autoFocus onClick={onClose} aria-label="关闭回看记录">
            閉じる <kbd>Esc</kbd>
          </button>
        </header>
        <div ref={scrollRef} className="backlog-scroll" tabIndex={0} aria-label="对话记录">
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
        <footer className="backlog-footer"><span>↑↓ SCROLL · PGUP/PGDN PAGE · HOME/END JUMP</span><span>LATEST LOG · {String(entries.length).padStart(3, "0")}</span></footer>
      </div>
    </div>
  );
}
