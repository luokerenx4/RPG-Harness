import { describe, expect, test } from "bun:test";
import { buildPlaytestUrl } from "./App";

describe("Studio playtest handoff", () => {
  test("opens the matching project in an isolated web session", () => {
    expect(buildPlaytestUrl(
      "sengoku-raid",
      "http://127.0.0.1:4175/assets?tab=gallery#preview",
      "studio-playtest-1234",
    )).toBe(
      "http://127.0.0.1:5188/?game=sengoku-raid&session=studio-playtest-1234",
    );
  });
});
