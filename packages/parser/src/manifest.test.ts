import { describe, expect, test } from "bun:test";
import { ManifestParseError, parseManifest } from "./manifest";

describe("parseManifest — switches", () => {
  test("shorthand: { id: <bool> }", () => {
    const m = parseManifest(
      "title: t\nswitches:\n  unlocked: false\n  met_alice: true\n",
    );
    expect(m.switches).toEqual([
      { id: "unlocked", initial: false },
      { id: "met_alice", initial: true },
    ]);
  });

  test("verbose: { id: { initial, description } }", () => {
    const m = parseManifest(
      [
        "title: t",
        "switches:",
        "  met_alice:",
        "    initial: false",
        "    description: '已经见过樱'",
      ].join("\n"),
    );
    expect(m.switches).toEqual([
      {
        id: "met_alice",
        initial: false,
        description: "已经见过樱",
      },
    ]);
  });

  test("non-boolean initial throws", () => {
    expect(() =>
      parseManifest("title: t\nswitches:\n  foo: { initial: 5 }\n"),
    ).toThrow(/switches.foo.initial must be a boolean/);
  });

  test("array form rejected", () => {
    expect(() =>
      parseManifest("title: t\nswitches: [a, b]\n"),
    ).toThrow(ManifestParseError);
  });
});

describe("parseManifest — variables", () => {
  test("explicit type + initial", () => {
    const m = parseManifest(
      [
        "title: t",
        "variables:",
        "  route: { type: string, initial: '' }",
        "  gold:  { type: number, initial: 0 }",
      ].join("\n"),
    );
    expect(m.variables).toEqual([
      { id: "route", type: "string", initial: "" },
      { id: "gold", type: "number", initial: 0 },
    ]);
  });

  test("type defaults from initial when omitted", () => {
    const m = parseManifest(
      [
        "title: t",
        "variables:",
        "  count: { initial: 5 }",
        "  name: { initial: alice }",
      ].join("\n"),
    );
    expect(m.variables).toEqual([
      { id: "count", type: "number", initial: 5 },
      { id: "name", type: "string", initial: "alice" },
    ]);
  });

  test("type/initial mismatch throws", () => {
    expect(() =>
      parseManifest(
        "title: t\nvariables:\n  x: { type: number, initial: hello }\n",
      ),
    ).toThrow(/type mismatch/);
  });

  test("non-string/number initial throws", () => {
    expect(() =>
      parseManifest(
        "title: t\nvariables:\n  x: { initial: true }\n",
      ),
    ).toThrow(/initial must be a number or string/);
  });

  test("description is preserved", () => {
    const m = parseManifest(
      [
        "title: t",
        "variables:",
        "  route:",
        "    type: string",
        "    initial: ''",
        "    description: '剧情分支'",
      ].join("\n"),
    );
    expect(m.variables?.[0]?.description).toBe("剧情分支");
  });
});

describe("parseManifest — basic", () => {
  test("missing title throws", () => {
    expect(() => parseManifest("modules: []\n")).toThrow(/missing `title`/);
  });

  test("title-only minimal manifest is valid", () => {
    const m = parseManifest("title: x\n");
    expect(m.title).toBe("x");
    expect(m.switches).toBeUndefined();
    expect(m.variables).toBeUndefined();
  });

  test("hidden: true is parsed", () => {
    const m = parseManifest("title: t\nhidden: true\n");
    expect(m.hidden).toBe(true);
  });

  test("hidden: false is parsed", () => {
    const m = parseManifest("title: t\nhidden: false\n");
    expect(m.hidden).toBe(false);
  });

  test("hidden omitted is undefined (treated as not hidden)", () => {
    const m = parseManifest("title: t\n");
    expect(m.hidden).toBeUndefined();
  });

  test("hidden non-boolean throws", () => {
    expect(() => parseManifest("title: t\nhidden: yes\n")).toThrow(
      /`hidden` must be a boolean/,
    );
  });
});

describe("parseManifest — AI audit quality gate", () => {
  test("parses author-owned diversity thresholds", () => {
    const manifest = parseManifest([
      "title: t",
      "ai_audit:",
      "  personas: [objective, charmer, rude]",
      "  seeds: [1, 17, 38173]",
      "  min_unique_endings: 2",
      "  min_unique_decision_paths: 3",
      "  max_activity_repetitions: 30",
      "  required_activity_tags: [cautious, economic, aggressive]",
      "  required_scripts: [three_flowers_alliance]",
    ].join("\n"));

    expect(manifest.aiAudit).toEqual({
      personas: ["objective", "charmer", "rude"],
      seeds: [1, 17, 38173],
      minUniqueEndings: 2,
      minUniqueDecisionPaths: 3,
      maxActivityRepetitions: 30,
      requiredActivityTags: ["cautious", "economic", "aggressive"],
      requiredScripts: ["three_flowers_alliance"],
    });
  });

  test("rejects empty, non-positive, and unknown audit policy", () => {
    expect(() => parseManifest("title: t\nai_audit: {}\n"))
      .toThrow(/must declare/);
    expect(() => parseManifest(
      "title: t\nai_audit:\n  min_unique_endings: 0\n",
    )).toThrow(/positive integer/);
    expect(() => parseManifest(
      "title: t\nai_audit:\n  max_activity_repetitions: 0\n",
    )).toThrow(/positive integer/);
    expect(() => parseManifest(
      "title: t\nai_audit:\n  min_unique_endings: 1\n  seeds: []\n",
    )).toThrow(/non-empty array of uint32 integers/);
    expect(() => parseManifest(
      "title: t\nai_audit:\n  min_unique_endings: 1\n  seeds: [1, 1]\n",
    )).toThrow(/must not contain duplicates/);
    expect(() => parseManifest(
      "title: t\nai_audit:\n  mystery: 2\n",
    )).toThrow(/unknown field/);
    expect(() => parseManifest(
      "title: t\nai_audit:\n  personas: []\n  min_unique_endings: 2\n",
    )).toThrow(/non-empty array/);
    expect(() => parseManifest(
      "title: t\nai_audit:\n  personas: [rude, rude]\n  min_unique_endings: 2\n",
    )).toThrow(/duplicates/);
    expect(() => parseManifest(
      "title: t\nai_audit:\n  personas: [charmer, rude]\n  min_unique_decision_paths: 3\n",
    )).toThrow(/cannot exceed/);
    expect(() => parseManifest(
      "title: t\nai_audit:\n  required_activity_tags: ['not stable']\n",
    )).toThrow(/stable tag strings/);
    expect(() => parseManifest(
      "title: t\nai_audit:\n  required_activity_tags: [economic, economic]\n",
    )).toThrow(/duplicates/);
    expect(() => parseManifest(
      "title: t\nai_audit:\n  required_scripts: ['not stable']\n",
    )).toThrow(/stable script ids/);
    expect(() => parseManifest(
      "title: t\nai_audit:\n  required_scripts: [ending, ending]\n",
    )).toThrow(/duplicates/);
  });
});
