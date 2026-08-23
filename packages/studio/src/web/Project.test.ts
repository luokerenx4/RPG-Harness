import { describe, expect, test } from "bun:test";
import {
  parseResourceScalarFields,
  patchResourceScalarFields,
} from "./pages/Project";

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
