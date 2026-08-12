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

  test("restores the declared current-map background after a scene", () => {
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
    const ctx = makeCtx(
      makeGame({
        maps: [
          {
            id: "castle",
            name: "Castle",
            description: "",
            bg: "assets/backgrounds/castle",
          },
        ],
        modules: [customHub],
      }),
    );
    ctx.state.baseline.currentMapId = "castle";
    ctx.state.baseline.visuals.bg = "assets/backgrounds/temporary-scene";

    expect(fireOnHubBuild(ctx)).toMatchObject({
      type: "hubMenu",
      visualState: { bg: "assets/backgrounds/castle" },
    });
    expect(ctx.state.baseline.visuals.bg).toBe("assets/backgrounds/castle");
  });

  test("preserves inherited background when the current map has no bg", () => {
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
    const ctx = makeCtx(
      makeGame({
        maps: [{ id: "hall", name: "Hall", description: "" }],
        modules: [customHub],
      }),
    );
    ctx.state.baseline.currentMapId = "hall";
    ctx.state.baseline.visuals.bg = "assets/backgrounds/inherited";

    fireOnHubBuild(ctx);
    expect(ctx.state.baseline.visuals.bg).toBe("assets/backgrounds/inherited");
  });
});
