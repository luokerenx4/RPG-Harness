import { normalizeAuthoringSource } from "../authoring-source";
import {
  buildPresetContext,
  cloneState,
  evaluateCondition,
  fireOnBeatBefore,
  type Beat,
} from "@rpg-harness/engine";
import { assertSessionName } from "@rpg-harness/session-store";
import { loadGame } from "../loader";
import { loadSession } from "../session";

export interface InspectScriptArgs {
  gameDir: string;
  scriptId: string;
  session?: string;
  pretty: boolean;
}

export interface ScriptInspection {
  script: {
    id: string;
    title: string;
    source: string | null;
    characters: string[];
    cost: number | null;
    coverage: { ignore: true; reason?: string } | null;
    ai: { relatedActivityIds: string[] } | null;
    requires: unknown | null;
    beats: Array<{ index: number; beat: Beat }>;
  };
  hooks: {
    onBeatBefore: string[];
    note: string | null;
  };
  session: {
    name: string;
    currentScriptId: string | null;
    completed: boolean;
    availability: ReturnType<typeof evaluateCondition>;
    transforms: Array<{
      beatIndex: number;
      authored: Beat;
      resolved: Beat | null;
      action: "replace" | "skip";
    }>;
    evaluation: "isolated-read-only";
  } | null;
}

export async function inspectScriptCommand(args: InspectScriptArgs): Promise<void> {
  const inspection = await inspectScript(args);
  process.stdout.write(
    (args.pretty
      ? JSON.stringify(inspection, null, 2)
      : JSON.stringify(inspection)) + "\n",
  );
}

/** Inspect authored structure and optional live hook transforms without persisting state. */
export async function inspectScript(args: InspectScriptArgs): Promise<ScriptInspection> {
  const game = await loadGame(args.gameDir);
  const script = game.scripts.find((candidate) => candidate.id === args.scriptId);
  if (!script) {
    const available = game.scripts.map((candidate) => candidate.id).sort();
    throw new Error(
      `Unknown script: ${args.scriptId}. Available: ${available.join(", ") || "(none)"}`,
    );
  }

  const beatHookModules = (game.modules ?? [])
    .filter((mod) => mod.onBeatBefore !== undefined)
    .map((mod) => mod.id)
    .sort();
  const source = script.source
    ? normalizeAuthoringSource(args.gameDir, script.source)
    : null;
  let session: ScriptInspection["session"] = null;

  if (args.session !== undefined) {
    assertSessionName(args.session);
    const loaded = await loadSession(args.gameDir, args.session, game);
    const state = cloneState(loaded);
    const availability = script.requires === undefined
      ? { ok: true }
      : evaluateCondition(script.requires, state);
    const transforms: NonNullable<ScriptInspection["session"]>["transforms"] = [];

    for (const [beatIndex, authored] of script.beats.entries()) {
      // Each reducer sees an independent clone. Inspection cannot leak hook
      // mutations into later beats or into the persisted player session.
      const ctx = buildPresetContext(game, cloneState(state), () => 0.5);
      const resolved = fireOnBeatBefore(ctx, script.id, beatIndex, authored);
      if ("skip" in resolved) {
        transforms.push({ beatIndex, authored, resolved: null, action: "skip" });
      } else if (JSON.stringify(resolved) !== JSON.stringify(authored)) {
        transforms.push({ beatIndex, authored, resolved, action: "replace" });
      }
    }

    session = {
      name: args.session,
      currentScriptId: state.baseline.currentScriptId,
      completed:
        state.baseline.scripts[script.id]?.completed === true ||
        state.baseline.completionOrder.includes(script.id),
      availability,
      transforms,
      evaluation: "isolated-read-only",
    };
  }

  return {
    script: {
      id: script.id,
      title: script.title,
      source,
      characters: [...(script.characters ?? [])],
      cost: script.cost ?? null,
      coverage: script.coverage ?? null,
      ai: script.ai
        ? { relatedActivityIds: [...script.ai.relatedActivityIds] }
        : null,
      requires: script.requires ?? null,
      beats: script.beats.map((beat, index) => ({ index, beat })),
    },
    hooks: {
      onBeatBefore: beatHookModules,
      note: beatHookModules.length > 0 && session === null
        ? "Pass --session NAME to resolve state-dependent beat replacements without advancing the save."
        : null,
    },
    session,
  };
}
