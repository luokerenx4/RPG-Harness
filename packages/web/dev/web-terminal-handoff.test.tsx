import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Game } from "@rpg-harness/engine";
import { BranchHandoffBadge, DevelopmentBadge, FeedbackOverlay, StageView } from "../src/WebPlayScreen";
import { runWebQualitySurfaceCheck } from "./quality-surface-check";

describe("Web terminal handoff", () => {
  test("dispatches stable engine inputs from every interactive GUI surface", () => {
    expect(runWebQualitySurfaceCheck()).toMatchObject({
      schemaVersion: 8,
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
      outcome: null,
    }} />);

    expect(html).toContain("AI 分支 · P2 · Reach authored choice: Reply?");
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
    }} />);

    expect(html).toContain("AI 分支 · P2 · 已选择: Stay together");
    expect(html).toContain("Outcome: selected stay via web at log 2.");
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
    expect(html).toContain("この瞬間を issue にする");
    expect(html).toContain("Target: scripts/scene.md");
    expect(html).toContain("このセッションのフィードバック");
    expect(html).toContain("対応済み");
    expect(html).toContain("Replaced exposition with a pause and replayed the scene.");
    expect(html).toContain("検証済み");
    expect(html).toContain("project aaaaaaaaaa → bbbbbbbbbb");
    expect(html).toContain("certificate cccccccccc");
  });
});
