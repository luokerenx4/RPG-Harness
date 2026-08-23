import { describe, expect, test } from "bun:test";
import {
  conditionEditorMode,
  createConditionDraft,
  eventTriggerMeta,
  hasMapDraftChanges,
  parseResourceScalarFields,
  patchResourceScalarFields,
  resourceChoices,
} from "./pages/Project";
import type { MapDef, ProjectResourceNode } from "@rpg-harness/engine";

describe("Studio database record fields", () => {
  const source = [
    "---",
    "id: soul_shard",
    "name: 魂石の欠片",
    "sell_value: 30 # economy note",
    "stack: true",
    "stats:",
    "  affection: { initial: 0 }",
    "characters: [kagari]",
    "---",
    "",
    "Body remains untouched.",
    "",
  ].join("\n");

  test("projects safe top-level scalars as editable database fields", () => {
    expect(parseResourceScalarFields(source)).toEqual([
      { key: "id", kind: "text", value: "soul_shard", displayValue: "soul_shard", editable: false },
      { key: "name", kind: "text", value: "魂石の欠片", displayValue: "魂石の欠片", editable: true },
      { key: "sell_value", kind: "number", value: "30", displayValue: "30", editable: true },
      { key: "stack", kind: "boolean", value: true, displayValue: "true", editable: true },
      { key: "stats", kind: "complex", value: "", displayValue: "{…}", editable: false },
      { key: "characters", kind: "complex", value: "[kagari]", displayValue: "[kagari]", editable: false },
    ]);
  });

  test("patches only selected metadata scalars and preserves comments and body", () => {
    expect(patchResourceScalarFields(source, {
      name: "封じた欠片 # 試作",
      sell_value: "45",
      stack: false,
      id: "must_not_change",
    })).toBe([
      "---",
      "id: soul_shard",
      'name: "封じた欠片 # 試作"',
      "sell_value: 45 # economy note",
      "stack: false",
      "stats:",
      "  affection: { initial: 0 }",
      "characters: [kagari]",
      "---",
      "",
      "Body remains untouched.",
      "",
    ].join("\n"));
  });
});

describe("Studio map event resource picker", () => {
  test("filters and alphabetizes records for the selected resource kind", () => {
    const resources = [
      { key: "script:z", kind: "script", id: "z", label: "Zulu", refs: [] },
      { key: "map:a", kind: "map", id: "a", label: "Alpha map", refs: [] },
      { key: "script:a", kind: "script", id: "a", label: "Alpha", refs: [] },
    ] as ProjectResourceNode[];
    expect(resourceChoices(resources, "script").map((resource) => resource.id)).toEqual(["a", "z"]);
    expect(resourceChoices(resources, undefined)).toEqual([]);
  });

  test("tracks only authoritative spatial map draft changes", () => {
    const saved = {
      id: "shrine",
      name: "Shrine",
      description: "saved copy",
      layout: undefined,
      placements: [],
    } as MapDef;
    expect(hasMapDraftChanges(saved, { ...saved, description: "project refresh" })).toBe(false);
    expect(hasMapDraftChanges(saved, {
      ...saved,
      placements: [{
        id: "gate",
        at: { x: 0, y: 0 },
        z: 0,
        footprint: { width: 1, height: 1 },
        collision: "trigger",
        visible: true,
        events: [],
      }],
    })).toBe(true);
  });

  test("creates resource-backed RPG Maker style condition drafts", () => {
    const resources = [
      { key: "character:kagari", kind: "character", id: "kagari", label: "Kagari", refs: [] },
      { key: "item:shard", kind: "item", id: "shard", label: "Shard", refs: [] },
      { key: "script:intro", kind: "script", id: "intro", label: "Intro", refs: [] },
      { key: "skill:dash", kind: "skill", id: "dash", label: "Dash", refs: [] },
    ] as ProjectResourceNode[];
    expect(createConditionDraft("affection", resources)).toEqual({ affection: { character: "kagari", min: 1 } });
    expect(createConditionDraft("scriptCompleted", resources)).toEqual({ scriptCompleted: "intro" });
    expect(createConditionDraft("inventory", resources)).toEqual({ inventory: { itemId: "shard", min: 1 } });
    expect(createConditionDraft("switch", resources, [
      { id: "chapter_open", initial: false, label: "Chapter open" },
    ])).toEqual({ switch: { name: "chapter_open", eq: true } });
    expect(createConditionDraft("variable", resources, [], [
      { id: "route", type: "string", initial: "north", label: "Route" },
    ])).toEqual({ variable: { name: "route", eq: "north" } });
    expect(conditionEditorMode({ all: [] })).toBe("advanced");
    expect(conditionEditorMode({ knowsSkill: "dash" })).toBe("knowsSkill");
    expect(conditionEditorMode(undefined)).toBe("none");
  });

  test("presents engine trigger ids as readable event-page controls", () => {
    expect(eventTriggerMeta("interact")).toEqual({
      icon: "◎",
      label: "Action Button",
      description: "Runs when the player deliberately interacts with this object.",
    });
    expect(eventTriggerMeta("quest:resolved")).toEqual({
      icon: "⌁",
      label: "quest · resolved",
      description: "Custom engine trigger: quest:resolved",
    });
  });
});
