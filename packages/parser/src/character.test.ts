import { describe, expect, test } from "bun:test";
import { CharacterParseError, parseCharacter } from "./character";

const front = (extra: string) =>
  `---\nid: kagari\nname: 篝\n${extra}---\n\nbio body\n`;

describe("parseCharacter — portraits", () => {
  test("portraits map preserved verbatim", () => {
    const c = parseCharacter(
      front(
        [
          "portraits:",
          "  default: assets/portraits/kagari-normal",
          "  smile: assets/portraits/kagari-smile",
          "  angry: assets/portraits/kagari-angry",
        ].join("\n") + "\n",
      ),
    );
    expect(c.portraits).toEqual({
      default: "assets/portraits/kagari-normal",
      smile: "assets/portraits/kagari-smile",
      angry: "assets/portraits/kagari-angry",
    });
  });

  test("defaultPortrait string preserved", () => {
    const c = parseCharacter(front("defaultPortrait: normal\n"));
    expect(c.defaultPortrait).toBe("normal");
  });

  test("map_sprite is a first-class character graphic", () => {
    const c = parseCharacter(front("map_sprite: assets/sprites/kagari-field\n"));
    expect(c.mapSprite).toBe("assets/sprites/kagari-field");
    expect(c.custom).toBeUndefined();
    expect(() => parseCharacter(front("map_sprite: \"\"\n"))).toThrow(/non-empty asset path/);
  });

  test("non-string portrait value throws", () => {
    expect(() =>
      parseCharacter(front("portraits:\n  default: 5\n")),
    ).toThrow(CharacterParseError);
  });

  test("portraits array form rejected", () => {
    expect(() =>
      parseCharacter(front("portraits: [a, b]\n")),
    ).toThrow(CharacterParseError);
  });

  test("character without portraits unchanged", () => {
    const c = parseCharacter(front(""));
    expect(c.portraits).toBeUndefined();
    expect(c.defaultPortrait).toBeUndefined();
  });
});

describe("parseCharacter — author-facing stat metadata", () => {
  test("preserves labels used to explain machine gates to players", () => {
    const c = parseCharacter(front([
      "stats:",
      "  affection:",
      "    initial: 0",
      "    label: 親密度",
      "    description: 篝との距離",
    ].join("\n") + "\n"));
    expect(c.stats?.affection).toEqual({
      initial: 0,
      label: "親密度",
      description: "篝との距離",
    });
  });
});
