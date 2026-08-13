import { describe, expect, test } from "bun:test";
import {
  requestedSharedSession,
  requestedWebGame,
  webGameRoute,
} from "../src/session";

describe("shared Web session selection", () => {
  test("accepts a named AI fork from the URL", () => {
    expect(requestedSharedSession("?session=gui-route-oni-ending")).toBe(
      "gui-route-oni-ending",
    );
  });

  test("decodes URL-safe session names", () => {
    expect(requestedSharedSession("?session=branch%20two")).toBe("branch two");
  });

  test("rejects path traversal and falls back to the bridge default", () => {
    expect(requestedSharedSession("?session=..%2Foutside")).toBeNull();
    expect(requestedSharedSession("?session=..")).toBeNull();
  });
});

describe("shareable Web game routing", () => {
  test("keeps the selected game beside the shared session", () => {
    expect(webGameRoute(
      "http://127.0.0.1:5188/?session=ai-random#turn",
      "sengoku-raid",
    )).toBe("/?session=ai-random&game=sengoku-raid#turn");
    expect(requestedWebGame("?session=ai-random&game=sengoku-raid")).toBe(
      "sengoku-raid",
    );
  });

  test("leaving for the game picker removes only the game route", () => {
    expect(webGameRoute(
      "http://127.0.0.1:5188/play?session=ai-random&game=sengoku-raid&future=1",
      null,
    )).toBe("/play?session=ai-random&future=1");
  });

  test("rejects path-shaped game ids from shared links", () => {
    expect(requestedWebGame("?game=..%2Foutside")).toBeNull();
    expect(requestedWebGame("?game=..")).toBeNull();
  });
});
