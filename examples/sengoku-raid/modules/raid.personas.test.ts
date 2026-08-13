import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ComposedState, Output } from "@rpg-harness/engine";
import { raidAiPersonas } from "./raid";

describe("sengoku-raid project personas", () => {
  test("extractor follows cautious choice tags", async () => {
    await expect(decide("extractor", routeChoice(), {})).resolves.toEqual({
      type: "choose",
      choiceId: "route",
      optionId: "silent",
    });
  });

  test("delver follows aggressive choice tags", async () => {
    await expect(decide("delver", routeChoice(), {})).resolves.toEqual({
      type: "choose",
      choiceId: "route",
      optionId: "defy",
    });
  });

  test("extractor honors the authored ending pulse", async () => {
    const output = hub([
      activity("imbue:mundane"),
      activity("imbue:pure"),
    ]);
    output.snapshot.objectives = [{
      id: "ending_pure",
      title: "Pure ending",
      scope: "main",
      terminal: true,
      status: "active",
      relatedActivityIds: ["imbue:pure"],
    }];
    await expect(decide("extractor", output, {})).resolves.toEqual({
      type: "doActivity",
      id: "imbue:pure",
    });
  });

  test("extractor finds an ending behind an optional deep objective", async () => {
    const output = hub([
      activity("depart:hell_gate"),
      activity("seal:blade"),
    ]);
    output.snapshot.objectives = [
      {
        id: "hell_gate_mastery",
        title: "Hell gate",
        scope: "mastery",
        terminal: false,
        status: "active",
        relatedActivityIds: ["depart:hell_gate"],
      },
      {
        id: "silent_resolution",
        title: "Ending",
        scope: "main",
        terminal: true,
        status: "active",
        relatedActivityIds: ["seal:blade"],
      },
    ];
    await expect(decide("extractor", output, {})).resolves.toEqual({
      type: "doActivity",
      id: "seal:blade",
    });
  });

  test("extractor understands bounded material batch sales", async () => {
    const output = hub([
      activity("sell_material:soul_shard"),
      activity("depart:kuro_swamp"),
    ]);
    await expect(decide("extractor", output, {})).resolves.toEqual({
      type: "doActivity",
      id: "sell_material:soul_shard",
    });
  });

  test("delver reads its module state and chooses an unvisited edge", async () => {
    const output = hub([activity("move:temple"), activity("move:vent")]);
    const state = {
      "sengoku-raid": {
        raid: {
          visited: {
            temple: { visited: true },
            vent: { visited: false },
          },
        },
      },
    };
    await expect(decide("delver", output, state)).resolves.toEqual({
      type: "doActivity",
      id: "move:vent",
    });
  });

  test("delver extracts only after every known zone is visited", async () => {
    const output = hub([activity("extract"), activity("move:temple")]);
    const state = {
      "sengoku-raid": {
        raid: { visited: { temple: { visited: true } } },
      },
    };
    await expect(decide("delver", output, state)).resolves.toEqual({
      type: "doActivity",
      id: "extract",
    });
  });

  test("delver finds an ending behind an optional deep objective", async () => {
    const output = hub([
      activity("depart:hell_gate"),
      activity("ascend:oni"),
    ]);
    output.snapshot.objectives = [
      {
        id: "hell_gate_mastery",
        title: "Hell gate",
        scope: "mastery",
        terminal: false,
        status: "active",
        relatedActivityIds: ["depart:hell_gate"],
      },
      {
        id: "defiant_resolution",
        title: "Ending",
        scope: "main",
        terminal: true,
        status: "active",
        relatedActivityIds: ["ascend:oni"],
      },
    ];
    await expect(decide("delver", output, {})).resolves.toEqual({
      type: "doActivity",
      id: "ascend:oni",
    });
  });

  test("completionist follows invite objective instead of dismissing its current companion", async () => {
    const output = hub([
      activity("dismiss:mio"),
      activity("script:ending_oni_self"),
      activity("invite:kagari"),
    ]);
    output.snapshot.objectives = [
      {
        id: "three_flowers_alliance",
        title: "Three flowers",
        scope: "mastery",
        terminal: false,
        status: "active",
        relatedActivityIds: ["invite:kagari"],
      },
      {
        id: "ending_oni_self",
        title: "Ending",
        scope: "main",
        terminal: true,
        status: "active",
        relatedActivityIds: ["script:ending_oni_self"],
      },
    ];
    await expect(decide("completionist", output, {
      baseline: { scripts: {} },
      "sengoku-raid": { companion: "mio", achievementLog: [] },
    })).resolves.toEqual({ type: "doActivity", id: "invite:kagari" });
  });

  test("extractor departs without choosing the new dismiss action", async () => {
    const output = hub([
      activity("dismiss:kagari"),
      activity("depart:kuro_swamp"),
    ]);
    await expect(decide("extractor", output, {})).resolves.toEqual({
      type: "doActivity",
      id: "depart:kuro_swamp",
    });
  });

  test("completionist also clears side objectives before a terminal main objective", async () => {
    const output = hub([
      activity("conclude"),
      activity("side:memory"),
    ]);
    output.snapshot.objectives = [
      {
        id: "campaign",
        title: "Campaign ending",
        scope: "main",
        terminal: true,
        status: "active",
        relatedActivityIds: ["conclude"],
      },
      {
        id: "memory",
        title: "Optional memory",
        scope: "side",
        terminal: false,
        status: "active",
        relatedActivityIds: ["side:memory"],
      },
    ];
    await expect(decide("completionist", output, {
      baseline: { scripts: {} },
      "sengoku-raid": { achievementLog: [] },
    })).resolves.toEqual({ type: "doActivity", id: "side:memory" });
  });

  test("completionist searches later mastery objectives for an executable link", async () => {
    const output = hub([
      activity("conclude"),
      activity("mastery:second"),
    ]);
    output.snapshot.objectives = [
      {
        id: "mastery_blocked_here",
        title: "Needs progress elsewhere",
        scope: "mastery",
        terminal: false,
        status: "active",
        relatedActivityIds: [],
      },
      {
        id: "mastery_ready",
        title: "Ready mastery",
        scope: "mastery",
        terminal: false,
        status: "active",
        relatedActivityIds: ["mastery:second"],
      },
      {
        id: "campaign",
        title: "Campaign ending",
        scope: "main",
        terminal: true,
        status: "active",
        relatedActivityIds: ["conclude"],
      },
    ];
    await expect(decide("completionist", output, {
      baseline: { scripts: {} },
      "sengoku-raid": { achievementLog: [] },
    })).resolves.toEqual({ type: "doActivity", id: "mastery:second" });
  });

  test("completionist preserves a companion by fleeing before exploring", async () => {
    const output = hub([
      activity("attack"),
      activity("flee"),
      activity("move:shrine"),
    ]);
    await expect(decide("completionist", output, {
      baseline: { scripts: {} },
      "sengoku-raid": {
        companion: "kagari",
        achievementLog: [],
        raid: { visited: { shrine: { visited: false } } },
      },
    })).resolves.toEqual({ type: "doActivity", id: "flee" });
  });

  test("completionist extracts a surviving companion before optional looting", async () => {
    const output = hub([
      activity("search:kuro_swamp_shrine"),
      activity("extract"),
      activity("move:kuro_swamp_crossroads"),
    ]);
    await expect(decide("completionist", output, {
      baseline: { scripts: {} },
      "sengoku-raid": {
        achievementLog: [],
        companion: "kagari",
        raid: { visited: { kuro_swamp_shrine: { visited: true } } },
      },
    })).resolves.toEqual({ type: "doActivity", id: "extract" });
  });

  test("completionist escorts a companion through the quiet Kuro extract", async () => {
    const output = hub([
      activity("move:kuro_swamp_deep_grove"),
      activity("move:kuro_swamp_shrine"),
    ]);
    await expect(decide("completionist", output, {
      baseline: { scripts: {} },
      "sengoku-raid": {
        achievementLog: [],
        companion: "mio",
        raid: { chain: "kuro_swamp", visited: {} },
      },
    })).resolves.toEqual({
      type: "doActivity",
      id: "move:kuro_swamp_shrine",
    });
  });

  test("completionist takes a guaranteed-combat depth instead of a quiet extract", async () => {
    const output = hub([
      activity("move:kuro_swamp_shrine"),
      activity("move:kuro_swamp_deep_grove"),
      activity("move:kuro_swamp_ruined_hut"),
    ]);
    await expect(decide("completionist", output, {
      baseline: { scripts: {} },
      "sengoku-raid": {
        achievementLog: [],
        companion: null,
        raid: { visited: {} },
      },
    })).resolves.toEqual({
      type: "doActivity",
      id: "move:kuro_swamp_deep_grove",
    });
  });

  test("completionist does not oscillate between visited guaranteed-combat zones", async () => {
    const output = hub([
      activity("extract"),
      activity("move:mt_houkyou_lava_vent"),
    ]);
    await expect(decide("completionist", output, {
      baseline: { scripts: {} },
      "sengoku-raid": {
        achievementLog: [],
        companion: null,
        raid: { visited: { mt_houkyou_lava_vent: { visited: true } } },
      },
    })).resolves.toEqual({ type: "doActivity", id: "extract" });
  });
});

describe("sengoku-raid authored language", () => {
  test("does not reintroduce the unnatural 出帰り coinage", async () => {
    const root = path.resolve(import.meta.dir, "..");
    const scriptFiles = (await readdir(path.join(root, "scripts")))
      .filter((file) => file.endsWith(".md"))
      .map((file) => path.join(root, "scripts", file));
    const authoredFiles = [
      path.join(root, "game.yaml"),
      path.join(root, "modules", "raid.ts"),
      ...scriptFiles,
    ];
    const offenders = (
      await Promise.all(authoredFiles.map(async (file) => ({
        file: path.relative(root, file),
        text: await readFile(file, "utf8"),
      })))
    ).filter(({ text }) => text.includes("出帰"));

    expect(offenders.map(({ file }) => file)).toEqual([]);
  });
});

function decide(
  name: "extractor" | "delver" | "completionist",
  output: Output,
  state: unknown,
) {
  return raidAiPersonas[name]!.decide(output, state as ComposedState, 0);
}

function activity(id: string) {
  return { id, kind: "action" as const, title: id, cost: 0, available: true };
}

function hub(
  activities: ReturnType<typeof activity>[],
): Extract<Output, { type: "hubMenu" }> {
  return {
    type: "hubMenu",
    snapshot: {
      day: 1,
      stats: [],
      affections: [],
      activities,
      objectives: [],
    },
  };
}

function routeChoice(): Extract<Output, { type: "choice" }> {
  return {
    type: "choice",
    scriptId: "route",
    choiceId: "route",
    options: [
      { id: "loyal", text: "Loyal", available: true, aiTags: ["loyal", "cautious"] },
      { id: "defy", text: "Defy", available: true, aiTags: ["defiant", "aggressive"] },
      { id: "silent", text: "Silent", available: true, aiTags: ["independent", "cautious"] },
    ],
  };
}
