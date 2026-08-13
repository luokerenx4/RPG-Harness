import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Game } from "@rpg-harness/engine";
import { BranchHandoffBadge, DevelopmentBadge, StageView } from "../src/WebPlayScreen";
import { runWebQualitySurfaceCheck } from "./quality-surface-check";

describe("Web terminal handoff", () => {
  test("dispatches stable engine inputs from every interactive GUI surface", () => {
    expect(runWebQualitySurfaceCheck()).toMatchObject({
      schemaVersion: 1,
      id: "web-input-contract",
      status: "passed",
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      interactions: [
        { surface: "narration", input: { type: "next" } },
        { surface: "choice", input: { type: "choose", choiceId: "route", optionId: "friends" } },
        { surface: "hub-activity", input: { type: "doActivity", id: "invite:kasumi" } },
        { surface: "script-select", input: { type: "select", scriptId: "ending" } },
      ],
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
    }} />);

    expect(html).toContain("AI 分支 · P2 · Reach authored choice: Reply?");
    expect(html).toContain("Work: choice-authoring/scene/reply");
    expect(html).toContain("Source: player @ log 7 (checkpoint)");
    expect(html).toContain("Target: scripts/scene.md");
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
});
