import { describe, expect, test } from "bun:test";
import {
  parseResourceScalarFields,
  patchResourceScalarFields,
  resourceChoices,
} from "./pages/Project";
import type { ProjectResourceNode } from "@rpg-harness/engine";

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
});
