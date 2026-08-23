import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Game } from "@rpg-harness/engine";
import { AdventureRecordOverlay, BacklogOverlay, BranchHandoffBadge, DevelopmentBadge, FeedbackOverlay, formatAiTurnReceipt, formatExternalAdvanceNotice, inputNoticeSourceLabel, nextHubCommandIndex, resolveFeedbackTarget, StageView, systemMenuControlRows, SystemMenuOverlay } from "../src/WebPlayScreen";
import { isExternalSessionInputSource } from "../src/session";
import { runWebQualitySurfaceCheck } from "./quality-surface-check";

describe("Web terminal handoff", () => {
  test("renders a guarded RPG system menu before returning to title", () => {
    const html = renderToStaticMarkup(<SystemMenuOverlay
      gameTitle="妖刀奇譚"
      sceneLabel="潰れた社"
      sessionLabel="shared-session"
      backlogAvailable={false}
      controlMode="field"
      onResume={() => {}}
      onAdventureRecord={() => {}}
      onBacklog={() => {}}
      onArtBook={() => {}}
      onExit={() => {}}
    />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain("继续游戏");
    expect(html).toContain("冒险记录");
    expect(html).toContain("返回标题");
    expect(html).toContain("shared-session");
    expect(html).toContain("disabled");
    expect(html).toContain("E / Enter · 調べる");
    expect(systemMenuControlRows("hub")).toEqual([
      { label: "SELECT", value: "Arrow ↑↓ · 選択" },
      { label: "CONFIRM", value: "Enter · 決定" },
    ]);
  });

  test("renders standard engine state as an RPG adventure record", () => {
    const game = {
      title: "妖刀奇譚",
      maps: [{ id: "shrine", name: "潰れた社", description: "崩れた祭壇。" }],
      characters: [{ id: "kagari", name: "篝" }],
      items: [{ id: "shard", name: "魂石", kind: "key" }],
      weapons: [{ id: "katana", name: "妖刀", description: "封じられた刃。", basePower: 8 }],
      skills: [{ id: "flash", name: "閃", description: "一閃。" }],
      scripts: [{ id: "intro", title: "邂逅" }],
    } as unknown as Game;
    const html = renderToStaticMarkup(<AdventureRecordOverlay
      game={game}
      state={{
        baseline: {
          currentMapId: "shrine",
          characters: { kagari: { stats: { affection: 3 }, custom: {} } },
          inventory: { shard: 2 },
          equippedWeaponId: "katana",
          weapons: { katana: { power: 11 } },
          knownSkills: ["flash"],
          completionOrder: ["intro"],
        },
      } as never}
      onClose={() => {}}
    />);
    expect(html).toContain("ADVENTURE RECORD");
    expect(html).toContain("潰れた社");
    expect(html).toContain("篝");
    expect(html).toContain("Affection");
    expect(html).toContain("魂石");
    expect(html).toContain("× 2");
    expect(html).toContain("妖刀");
    expect(html).toContain("11");
    expect(html).toContain("邂逅");
  });

  test("labels cross-surface input diagnostics by their actual controller", () => {
    expect(inputNoticeSourceLabel("cli")).toBe("HEADLESS");
    expect(inputNoticeSourceLabel("autoplay:completionist")).toBe("HEADLESS");
    expect(inputNoticeSourceLabel("tui")).toBe("TUI");
    expect(formatExternalAdvanceNotice("cli")).toBe(
      "HEADLESS 已推进共享会话；GUI 已同步到最新画面。",
    );
    expect(isExternalSessionInputSource("web")).toBe(false);
    expect(isExternalSessionInputSource("web-ai:completionist")).toBe(false);
    expect(isExternalSessionInputSource("autoplay:completionist")).toBe(true);
    expect(isExternalSessionInputSource("cli")).toBe(true);
  });

  test("explains a bounded AI turn and returns control to the player", () => {
    expect(formatAiTurnReceipt({
      persona: "completionist",
      seed: 17,
      nextSeed: 18,
      reason: "max-steps",
      decisions: 1,
      rejectedInputs: 0,
      steps: 2,
      ending: null,
      lastAction: { type: "choose", choiceId: "route", optionId: "moon", text: "月影を追う" },
      decisionBasis: null,
      progress: {
        madeProgress: true,
        completedScripts: { count: 0, recent: [] },
        objectiveChanges: { count: 0, recent: [] },
        scriptProgress: {
          from: "intro",
          to: "intro",
          beatIndexFrom: 2,
          beatIndexTo: 3,
        },
      },
      advancedAfterTurn: false,
      state: {} as never,
    })).toBe("选择「月影を追う」；推进 intro：2 → 3。下一手归玩家。");
  });

  test("seals a terminal AI turn instead of promising another player input", () => {
    expect(formatAiTurnReceipt({
      persona: "completionist",
      seed: 17,
      nextSeed: null,
      reason: "completed",
      decisions: 1,
      rejectedInputs: 0,
      steps: 2,
      ending: "ending_oni_self",
      lastAction: { type: "next" },
      decisionBasis: null,
      progress: {
        madeProgress: true,
        completedScripts: { count: 1, recent: ["ending_oni_self"] },
        objectiveChanges: { count: 0, recent: [] },
      },
      advancedAfterTurn: false,
      state: {} as never,
    })).toBe(
      "推进文本；到达结局 ending_oni_self。当前存档已封存；可从 checkpoint 探索其他分支。",
    );
  });

  test("shows an auditable public objective basis for an AI activity", () => {
    expect(formatAiTurnReceipt({
      persona: "completionist",
      seed: 17,
      nextSeed: 18,
      reason: "max-steps",
      decisions: 1,
      rejectedInputs: 0,
      steps: 2,
      ending: null,
      lastAction: { type: "doActivity", id: "rest", title: "宿で休む" },
      decisionBasis: {
        kind: "activity-evidence",
        activityId: "rest",
        policyDescription: "深層検証：任意目標を完遂する",
        publicIntent: "体力を全回復して次の遠征を可能にする",
        objectives: [
          { id: "ending", title: "地獄門の底へ", scope: "main", terminal: true, focused: false },
          { id: "mastery", title: "地獄門を開く", scope: "mastery", terminal: false, focused: false },
        ],
        totalObjectives: 2,
        category: "rest",
        aiTags: [],
        recommended: false,
        availableActivities: 7,
        sameCategoryActivities: 1,
      },
      progress: {
        madeProgress: false,
        completedScripts: { count: 0, recent: [] },
        objectiveChanges: { count: 0, recent: [] },
      },
      advancedAfterTurn: false,
      state: {} as never,
    })).toBe("执行「宿で休む」（公开证据：当步规则：体力を全回復して次の遠征を可能にする；目标关联：「地獄門の底へ」、「地獄門を開く」；当前 7 项可选）。下一手归玩家。");
  });

  test("falls back to the public persona policy when no exact rule is authored", () => {
    expect(formatAiTurnReceipt({
      persona: "completionist",
      ending: null,
      lastAction: { type: "doActivity", id: "depart", title: "黒沼地へ出立" },
      decisionBasis: {
        kind: "activity-evidence",
        activityId: "depart",
        policyDescription: "任意目標を完遂してから終局へ進む",
        objectives: [],
        totalObjectives: 0,
        category: "raid",
        aiTags: ["cautious"],
        recommended: false,
        availableActivities: 3,
        sameCategoryActivities: 3,
      },
      progress: {
        madeProgress: false,
        completedScripts: [],
        objectiveChanges: [],
      },
      advancedAfterTurn: false,
      state: {} as never,
    })).toBe(
      "执行「黒沼地へ出立」（公开证据：策略：任意目標を完遂してから終局へ進む；行动意图：cautious；同类 3 项可选）。下一手归玩家。",
    );
  });

  test("explains a stable story choice with its authored semantics", () => {
    expect(formatAiTurnReceipt({
      persona: "completionist",
      ending: null,
      lastAction: {
        type: "choose",
        scriptId: "bond_kagari_03",
        choiceId: "answer-how-the-blade-sleeps",
        optionId: "use-chinkonho-nightly",
        text: "「鎮魂法で、毎晩二十押し返す」",
      },
      decisionBasis: {
        kind: "choice-evidence",
        scriptId: "bond_kagari_03",
        choiceId: "answer-how-the-blade-sleeps",
        optionId: "use-chinkonho-nightly",
        policyDescription: "任意目標を完遂してから終局へ進む",
        publicIntent: "公開方針に合う「loyal / disciplined」の応答を選ぶ",
        aiTags: ["loyal", "disciplined"],
        availableOptions: 3,
      },
      progress: {
        madeProgress: false,
        completedScripts: [],
        objectiveChanges: [],
      },
      advancedAfterTurn: false,
      state: {} as never,
    })).toBe(
      "选择「鎮魂法で、毎晩二十押し返す」（公开证据：当步规则：公開方針に合う「loyal / disciplined」の応答を選ぶ；回应意图：loyal / disciplined；同题 3 项可选）。下一手归玩家。",
    );
  });

  test("renders player and AI stable selections as story context in backlog", () => {
    const html = renderToStaticMarkup(
      <BacklogOverlay
        entries={[{
          kind: "choice",
          prompt: "それでも、答える。",
          optionText: "「眠らない」",
          selectedBy: "ai",
        }]}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("それでも、答える。");
    expect(html).toContain("AI 選択");
    expect(html).toContain("「眠らない」");
  });

  test("dispatches stable engine inputs from every interactive GUI surface", () => {
    expect(runWebQualitySurfaceCheck()).toMatchObject({
      schemaVersion: 20,
      id: "web-input-contract",
      status: "passed",
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      interactions: [
        { surface: "narration", input: { type: "next" } },
        { surface: "choice", input: { type: "choose", choiceId: "route", optionId: "friends" } },
        { surface: "hub-activity", input: { type: "doActivity", id: "invite:kasumi" } },
        { surface: "script-select", input: { type: "select", scriptId: "ending" } },
      ],
      projections: [{
        surface: "player-feedback-proof",
        text: "検証済みproject aaaaaaaaaa → bbbbbbbbbbcertificate cccccccccc",
      }, {
        surface: "objective-requirement",
        text: "○ Vow kept○ Pulse: Oni 0 / 6",
      }, {
        surface: "locked-condition",
        text: "🔒 Kagariの親密度 4 以上（現在 0）、先に「Moonlit promise」を完了",
      }, {
        surface: "machine-effect-hidden",
        text: "親密度 +1（50 両）",
      }, {
        surface: "forecast-unit-hidden",
        text: "両 +11",
      }, {
        surface: "forecast-detail-hidden",
        text: "ダメージ 14–21 HP",
      }, {
        surface: "terminal-ai-branch",
        text: "AI BRANCH · 3 PATHS次: Remember the others",
      }, {
        surface: "ai-choice-backlog",
        text: "What do you promise?AI 選択Stay until dawn",
      }, {
        surface: "branch-control-handoff",
        text: "AI 首映 · Explore Stay玩家游玩 · AI 来源: Explore Stay",
      }, {
        surface: "bounded-ai-coplay",
        text: "执行「宿で休む」（公开证据：当步规则：体力を全回復して次の遠征を可能にする；目标关联：「地獄門の底へ」；当前 7 项可选）。下一手归玩家。",
      }, {
        surface: "terminal-ai-coplay",
        text: "推进文本；到达结局 ending_oni_self。当前存档已封存；可从 checkpoint 探索其他分支。",
      }, {
        surface: "choice-ai-coplay",
        text: "选择「鎮魂法で、毎晩二十押し返す」（公开证据：当步规则：公開方針に合う「loyal」の応答を選ぶ；回应意图：loyal / disciplined；同题 3 项可选）。下一手归玩家。",
      }, {
        surface: "persistent-ai-coplay",
        text: "random@2718 · web · state 56e32233d741",
      }, {
        surface: "external-headless-sync",
        text: "HEADLESS 已推进共享会话；GUI 已同步到最新画面。",
      }, {
        surface: "local-web-ai-provenance",
        text: "web-ai:completionist · local / autoplay:completionist · external",
      }, {
        surface: "shareable-game-route",
        text: "/?session=ai-branch&game=sengoku-raid",
      }, {
        surface: "feedback-live-routing",
        text: "scripts/current.mdRouting: live checkpoint / current runtime",
      }],
    });
  });

  test("shows the authored title and stable ending id from Headless gameEnd", () => {
    const game = {
      scripts: [{ id: "ending_oni_self", title: "鬼の器" }],
    } as unknown as Game;

    const html = renderToStaticMarkup(
      <StageView
        stage={{ kind: "ended", endingId: "ending_oni_self" }}
        game={game}
        onInput={() => {}}
      />,
    );

    expect(html).toContain("鬼の器");
    expect(html).toContain("ending_oni_self");
  });

  test("keeps legacy gameEnd output renderable without an ending id", () => {
    const html = renderToStaticMarkup(
      <StageView
        stage={{ kind: "ended" }}
        game={{ scripts: [] } as unknown as Game}
        onInput={() => {}}
      />,
    );

    expect(html).toContain("― 終 ―");
    expect(html).not.toContain("ended-ending-id");
  });

  test("makes a focused side objective visible as the current concern", () => {
    const html = renderToStaticMarkup(
      <StageView
        stage={{
          kind: "hubMenu",
          cursor: 0,
          snapshot: {
            day: 0,
            maxDay: 0,
            slot: 0,
            slotName: "",
            slotsPerDay: 0,
            stats: [],
            affections: [],
            objectives: [{
              id: "memory",
              title: "Bring the memory home",
              scope: "side",
              terminal: false,
              focus: true,
              status: "active",
              relatedActivityIds: ["extract"],
            }],
            activities: [{
              id: "extract",
              kind: "action",
              title: "Return",
              cost: 0,
              available: true,
            }],
          },
        }}
        game={{ scripts: [] } as unknown as Game}
        onInput={() => {}}
      />,
    );

    expect(html).toContain("objective-focused");
    expect(html).toContain("SIDE · NOW");
    expect(html).toContain("Bring the memory home");
    expect(html).toContain("<kbd>↑↓</kbd> 选择");
    expect(nextHubCommandIndex(-1, 3, 1)).toBe(0);
    expect(nextHubCommandIndex(-1, 3, -1)).toBe(2);
    expect(nextHubCommandIndex(2, 3, 1)).toBe(0);
  });

  test("hands a recoverable choice branch back to the player after an ending", () => {
    let explored = false;
    const html = renderToStaticMarkup(
      <StageView
        stage={{ kind: "ended", endingId: "ending_oni_self" }}
        game={{ scripts: [{ id: "ending_oni_self", title: "鬼の器" }] } as unknown as Game}
        onInput={() => {}}
        exploration={{
          revision: "choices",
          pendingOptions: 17,
          next: {
            key: "ending_oni_self/final-tether/kagari",
            scriptId: "ending_oni_self",
            choiceId: "final-tether",
            optionId: "kagari",
            optionText: "篝の槍の拍を思い出す",
          },
        }}
        onExplore={() => { explored = true; }}
      />,
    );

    expect(html).toContain("AI BRANCH · 17 PATHS");
    expect(html).toContain("篝の槍の拍を思い出す");
    expect(html).toContain("この結末は残したまま");
    expect(explored).toBe(false);
  });

  test("explains why an AI-prepared branch was handed to the player", () => {
    const html = renderToStaticMarkup(<BranchHandoffBadge branch={{
      fromSession: "player",
      sourceLogEntry: 7,
      mode: "checkpoint",
      handoff: {
        schemaVersion: 1,
        workKey: "choice-authoring/scene/reply",
        priority: "P2",
        kind: "choice-authoring",
        title: "Reach authored choice: Reply?",
        operation: "reach",
        state: "target-reached",
        preparedAt: "2026-08-13T00:00:01.000Z",
        target: "scripts/scene.md",
      },
      playerControl: null,
      outcome: null,
    }} />);

    expect(html).toContain("AI 首映 · Reach authored choice: Reply? · P2");
    expect(html).toContain("Control: awaiting the player");
    expect(html).toContain("Work: choice-authoring/scene/reply");
    expect(html).toContain("Source: player @ log 7 (checkpoint)");
    expect(html).toContain("Target: scripts/scene.md");
  });

  test("surfaces the stable option selected by the player in an AI branch", () => {
    const html = renderToStaticMarkup(<BranchHandoffBadge branch={{
      fromSession: "player",
      sourceLogEntry: 7,
      mode: "checkpoint",
      handoff: {
        schemaVersion: 1,
        workKey: "choice-authoring/scene/reply",
        priority: "P2",
        kind: "choice-authoring",
        title: "Reach authored choice: Reply?",
        operation: "reach",
        state: "target-reached",
        preparedAt: "2026-08-13T00:00:01.000Z",
        coordinates: { scriptId: "scene", choiceId: "reply" },
      },
      outcome: {
        kind: "choice-selected",
        scriptId: "scene",
        choiceId: "reply",
        optionId: "stay",
        optionText: "Stay together",
        source: "web",
        logEntry: 2,
      },
      playerControl: { source: "web", logEntry: 2 },
    }} />);

    expect(html).toContain("玩家游玩 · AI 来源: 已选择: Stay together · P2");
    expect(html).toContain("Outcome: selected stay via web at log 2.");
    expect(html).toContain("Control: handed to the player via web at log 2.");
  });

  test("shows a certified project verdict next to the shared GUI session", () => {
    const html = renderToStaticMarkup(
      <DevelopmentBadge status={{
        revision: "status-revision",
        worklist: {
          total: 0,
          executable: 0,
          diagnostic: 0,
          authoring: 0,
          highestPriority: null,
          next: null,
        },
        quality: {
          status: "certified",
          inputRevision: "input-revision",
          certificateRevision: "certificate-revision",
          createdAt: "2026-08-13T00:00:00.000Z",
          endings: 3,
          paths: 7,
          seeds: [1, 17, 38173],
          fuzzPersonas: ["random"],
          fuzzLanes: 3,
          fuzzMaxDecisions: { seed: 17, persona: "random", decisions: 611 },
          maxActivityRepetitions: 30,
          maxActivityRepetitionsByKind: null,
          maxActivityRepetition: {
            seed: 17,
            persona: "greedy",
            activityKind: "attack",
            count: 27,
            limit: 30,
          },
        },
      }} />,
    );
    expect(html).toContain("AI Dev · certified · 3 endings / 7 paths · 3 seeds · 3 fuzz · loop 27/30");
    expect(html).toContain("Fresh-world seeds: 1, 17, 38173.");
    expect(html).toContain("Seeded fuzz survival: 3 lanes (random); slowest 611 decisions.");
    expect(html).toContain("seed 17, greedy/attack ×27 (limit 30)");
    expect(html).toContain("certificate-revision");
  });

  test("surfaces pending coding work before a stale green audit", () => {
    const html = renderToStaticMarkup(
      <DevelopmentBadge status={{
        revision: "status-revision",
        worklist: {
          total: 2,
          executable: 1,
          diagnostic: 1,
          authoring: 0,
          highestPriority: "P1",
          next: { key: "report/pt-1", title: "Route is stuck" },
        },
        quality: {
          status: "certified",
          inputRevision: "input-revision",
          certificateRevision: "certificate-revision",
          createdAt: "2026-08-13T00:00:00.000Z",
          endings: 3,
          paths: 7,
          seeds: [1, 17, 38173],
          fuzzPersonas: ["random"],
          fuzzLanes: 3,
          fuzzMaxDecisions: { seed: 17, persona: "random", decisions: 611 },
          maxActivityRepetitions: 30,
          maxActivityRepetitionsByKind: null,
          maxActivityRepetition: {
            seed: 17,
            persona: "greedy",
            activityKind: "attack",
            count: 27,
            limit: 30,
          },
        },
      }} />,
    );
    expect(html).toContain("AI Dev · 2 pending · P1");
    expect(html).toContain("Route is stuck");
    expect(html).not.toContain("AI Dev · certified");
  });

  test("offers a compact player-to-AI issue form with branch target context", () => {
    const html = renderToStaticMarkup(
      <FeedbackOverlay
        branchContext={{
          fromSession: "player",
          sourceLogEntry: 7,
          mode: "checkpoint",
          handoff: {
            schemaVersion: 1,
            workKey: "choice-authoring/scene/reply",
            priority: "P2",
            kind: "choice-authoring",
            title: "Reach Reply?",
            operation: "reach",
            state: "target-reached",
            preparedAt: "2026-08-13T00:00:01.000Z",
            target: "scripts/scene.md",
          },
          outcome: null,
        }}
        onSubmit={async () => ({
          id: "pt-1",
          session: "player",
          area: "narrative",
          severity: "minor",
          title: "Line is too explicit",
          evidence: { logEntry: 7, currentScriptId: "scene" },
        })}
        feedbackFeed={{
          revision: "feedback-revision",
          open: 0,
          resolved: 1,
          items: [{
            id: "pt-resolved",
            createdAt: "2026-08-13T00:00:00.000Z",
            status: "resolved",
            session: "player",
            area: "narrative",
            severity: "minor",
            title: "Line is too explicit",
            resolution: "Replaced exposition with a pause and replayed the scene.",
            verification: {
              kind: "player-feedback",
              verifiedAt: "2026-08-13T00:01:00.000Z",
              originalInputRevision: "a".repeat(64),
              fixedInputRevision: "b".repeat(64),
              certificateRevision: "c".repeat(64),
              certificateCreatedAt: "2026-08-13T00:00:30.000Z",
            },
            evidence: {
              logEntry: 7,
              currentScriptId: "scene",
              checkpoint: { revision: "a".repeat(64) },
            },
          }],
        }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("AIへフィードバック");
    expect(html).toContain("今の画面・ログ・セーブを再現可能な coding issue にします。");
    expect(html).toContain("FIELD REPORT · LIVE CHECKPOINT");
    expect(html).toContain("CAPTURED CHECKPOINT");
    expect(html).toContain("ADD TO AI WORKLIST");
    expect(html).toContain("Esc · ゲームへ戻る");
    expect(html).toContain("この瞬間を issue にする");
    expect(html).toContain("Target: scripts/scene.md");
    expect(html).toContain("このセッションのフィードバック");
    expect(html).toContain("対応済み");
    expect(html).toContain("Replaced exposition with a pause and replayed the scene.");
    expect(html).toContain("検証済み");
    expect(html).toContain("project aaaaaaaaaa → bbbbbbbbbb");
    expect(html).toContain("certificate cccccccccc");
  });

  test("routes feedback to live script source without reviving consumed handoff targets", () => {
    const game = {
      scripts: [{ id: "current", title: "Current", source: "scripts/current.md" }],
    } as unknown as Game;
    const branch = {
      fromSession: "proof",
      sourceLogEntry: 2,
      mode: "checkpoint",
      handoff: {
        schemaVersion: 1 as const,
        workKey: "choice-branch/old/reply/stay",
        priority: "P3" as const,
        kind: "choice-branch",
        title: "Old premiere",
        operation: "cover",
        state: "covered" as const,
        preparedAt: "2026-08-13T00:00:01.000Z",
        target: "scripts/old.md",
      },
      outcome: null,
    };

    expect(resolveFeedbackTarget(game, "current", {
      ...branch,
      playerControl: { source: "web", logEntry: 2 },
    })).toBe("scripts/current.md");
    expect(resolveFeedbackTarget(game, null, {
      ...branch,
      playerControl: null,
    })).toBe("scripts/old.md");
    expect(resolveFeedbackTarget(game, null, {
      ...branch,
      playerControl: { source: "web", logEntry: 2 },
    })).toBeUndefined();

    const html = renderToStaticMarkup(<FeedbackOverlay
      branchContext={{
        ...branch,
        playerControl: { source: "web", logEntry: 2 },
      }}
      onSubmit={async () => { throw new Error("not submitted"); }}
      onClose={() => {}}
    />);
    expect(html).toContain("Routing: live checkpoint / current runtime");
    expect(html).not.toContain("Target: scripts/old.md");
  });
});
