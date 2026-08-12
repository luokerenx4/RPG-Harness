import { describe, expect, test } from "bun:test";
import { requestedSharedSession } from "../src/session";

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
