import { describe, expect, test } from "bun:test";
import { parseAction } from "./action";

describe("parseAction AI intent", () => {
  test("parses stable renderer-neutral activity tags", () => {
    expect(parseAction([
      "id: comfort",
      "title: Comfort",
      "category: social",
      "ai_tags: [social, story/companion]",
    ].join("\n"))).toMatchObject({
      id: "comfort",
      aiTags: ["social", "story/companion"],
    });
  });

  test("rejects empty, malformed, and duplicate activity tags", () => {
    expect(() => parseAction("id: x\ntitle: X\nai_tags: []\n"))
      .toThrow("must be a non-empty array");
    expect(() => parseAction("id: x\ntitle: X\nai_tags: [not stable]\n"))
      .toThrow("ai_tags[0]");
    expect(() => parseAction("id: x\ntitle: X\nai_tags: [social, social]\n"))
      .toThrow("must not contain duplicates");
  });

  test("parses placement-only exposure and rejects unknown exposure modes", () => {
    expect(parseAction("id: inspect\ntitle: Inspect\nexposure: placed\n"))
      .toMatchObject({ exposure: "placed" });
    expect(() => parseAction("id: inspect\ntitle: Inspect\nexposure: hidden\n"))
      .toThrow("must be ambient or placed");
  });
});
