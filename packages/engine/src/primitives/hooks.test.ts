import { describe, expect, test } from "bun:test";
import { makeCtx, makeGame } from "../test-utils";
import type { Module } from "../types";
import { fireOnHubBuild } from "./hooks";

describe("fireOnHubBuild", () => {
  test("adds authoritative visuals to custom hub outputs", () => {
    const customHub: Module = {
      id: "custom-hub",
      onHubBuild: () => ({
        type: "hubMenu",
        snapshot: {
          day: 0,
          maxDay: 0,
          slot: 0,
          slotName: "",
          slotsPerDay: 0,
          stats: [],
          affections: [],
          activities: [],
        },
      }),
    };
    const ctx = makeCtx(makeGame({ modules: [customHub] }));
    ctx.state.baseline.visuals = {
      bg: "assets/backgrounds/mountain",
      portraits: {},
      cg: null,
    };

    expect(fireOnHubBuild(ctx)).toMatchObject({
      type: "hubMenu",
      visualState: {
        bg: "assets/backgrounds/mountain",
        portraits: {},
        cg: null,
      },
    });
  });
});
