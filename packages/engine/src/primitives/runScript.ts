import { evaluateCondition } from "../condition";
import type {
  Beat,
  Input,
  Output,
  PresetContext,
  RenderedChoice,
  Script,
} from "../types";
import { END_LABEL } from "../types";
import { drainNarrations } from "./drainNarrations";
import {
  fireOnBeatAfter,
  fireOnBeatBefore,
  fireOnChoicePresented,
  fireOnChoiceResolved,
  fireOnLabelEnter,
  fireOnScriptStart,
} from "./hooks";
import { mutateState } from "./mutateState";

// Run a single script's beats from state.baseline.beatIndex forward.
// Yields per beat; returns true when the script reaches [end] or its
// last beat, false on a quit input.
//
// Hooks fired inside:
//   - onScriptStart (observer, once at entry)
//   - onBeatBefore (reducer, per beat; may skip or replace)
//   - onBeatAfter (observer, per beat after input)
//   - onChoicePresented (reducer, before choice yield)
//   - onChoiceResolved (observer, after choose input)
//   - onLabelEnter (observer, when goto enters a label)
// onScriptComplete fires from the caller after a true return.
export async function* runScript(
  ctx: PresetContext,
  script: Script,
): AsyncGenerator<Output, boolean, Input> {
  const labelMap = buildLabelMap(script);
  const { state } = ctx;

  reconcileScriptCursor(ctx, script, labelMap);

  fireOnScriptStart(ctx, script.id);

  // Drain any narrations the onScriptStart hooks pushed BEFORE we yield
  // the first beat. Without this, step()'s prime/input pattern can
  // re-yield beat 0: the prime of the next step would yield the queued
  // narration (discarded by step), and only the subsequent input would
  // re-enter runScript at the still-unadvanced beatIndex, yielding the
  // first beat a second time. See drainNarrations.ts for the broader
  // peek/step protocol this guards against.
  yield* drainNarrations(ctx);

  while (state.baseline.beatIndex < script.beats.length) {
    const beatIdx = state.baseline.beatIndex;
    const original = script.beats[beatIdx];
    if (!original) break;
    setScriptCursor(ctx, script, original);

    // Let modules pre-process / skip / replace the beat.
    const reduced = fireOnBeatBefore(ctx, script.id, beatIdx, original);
    if ("skip" in reduced) {
      state.baseline.beatIndex++;
      fireOnBeatAfter(ctx, script.id, beatIdx, original);
      continue;
    }
    const beat: Beat = reduced as Beat;

    switch (beat.type) {
      case "narration": {
        const input = yield {
          type: "narration",
          text: beat.text,
          visualState: state.baseline.visuals,
        };
        if (input.type === "quit") return false;
        // Only `next` advances. Other input types (choose / doActivity
        // / select) sent against a narration are an input-order mistake
        // by the caller — re-yield same beat so they see what happened
        // instead of silently swallowing the input. Matches the
        // `choice` case's protocol below.
        if (input.type !== "next") continue;
        clearConsumedChoiceFallback(ctx, script.id);
        break;
      }
      case "dialogue": {
        const speakerName =
          ctx.characterNameMap.get(beat.speaker) ?? beat.speaker;
        // Resolve a candidate emotion against the character's
        // portraits map. Hit → swap the slot the speaker already
        // occupies (any slot currently showing one of their portrait
        // paths — multi-portrait scenes seed left/right etc.), or the
        // conventional "center" slot when they're not on stage. Miss →
        // restore the candidate token to the front of the dialogue
        // text (it was not actually an emotion, just the first word
        // of dialogue).
        let dialogueText = beat.text;
        if (beat.candidateEmotion !== undefined) {
          const ch = ctx.game.characters.find((c) => c.id === beat.speaker);
          const path = ch?.portraits?.[beat.candidateEmotion];
          if (path) {
            const ownPaths = new Set(Object.values(ch?.portraits ?? {}));
            const slot =
              Object.entries(state.baseline.visuals.portraits).find(
                ([, p]) => p !== null && ownPaths.has(p),
              )?.[0] ?? "center";
            state.baseline.visuals.portraits[slot] = path;
          } else {
            // Restore the candidate to the dialogue text. Preserve the
            // space iff there was any text after; otherwise the token
            // becomes the entire dialogue.
            dialogueText =
              beat.text.length > 0
                ? `${beat.candidateEmotion} ${beat.text}`
                : beat.candidateEmotion;
          }
        }
        const input = yield {
          type: "dialogue",
          speakerId: beat.speaker,
          speakerName,
          text: dialogueText,
          visualState: state.baseline.visuals,
        };
        if (input.type === "quit") return false;
        if (input.type !== "next") continue;
        clearConsumedChoiceFallback(ctx, script.id);
        break;
      }
      case "choice": {
        const baseRendered: RenderedChoice[] = beat.options.map((opt) => {
          const r =
            opt.requires === undefined
              ? { ok: true }
              : evaluateCondition(opt.requires, state);
          return {
            text: opt.text,
            available: r.ok,
            ...(r.ok ? {} : { lockedReason: r.reason }),
            ...(opt.effects !== undefined || opt.goto !== undefined
              ? {
                  consequence: {
                    ...(opt.effects !== undefined
                      ? { effects: opt.effects }
                      : {}),
                    ...(opt.goto !== undefined ? { goto: opt.goto } : {}),
                  },
                }
              : {}),
          };
        });
        const rendered = fireOnChoicePresented(
          ctx,
          script.id,
          beatIdx,
          baseRendered,
        );
        const input = yield {
          type: "choice",
          prompt: beat.prompt,
          options: rendered,
          ...(beat.view !== undefined ? { view: beat.view } : {}),
          visualState: state.baseline.visuals,
        };
        if (input.type === "quit") return false;
        if (input.type !== "choose") continue;
        const chosen = beat.options[input.index];
        if (!chosen) continue;
        if (rendered[input.index]?.available === false) continue;
        state.baseline.scriptCursor = {
          scriptId: script.id,
          beatAnchor: anchorBeat(beat),
          choice: {
            prompt: beat.prompt ?? null,
            optionText: chosen.text,
          },
        };
        fireOnChoiceResolved(ctx, script.id, beatIdx, input.index);
        if (chosen.effects) mutateState(ctx, chosen.effects, "choice");
        if (chosen.goto !== undefined) {
          if (chosen.goto === END_LABEL) {
            fireOnBeatAfter(ctx, script.id, beatIdx, beat);
            return true;
          }
          const target = labelMap.get(chosen.goto);
          if (target === undefined) {
            throw new Error(
              `runScript: choice goto target not found in script "${script.id}": ${chosen.goto}`,
            );
          }
          state.baseline.beatIndex = target;
          fireOnLabelEnter(ctx, script.id, chosen.goto);
          fireOnBeatAfter(ctx, script.id, beatIdx, beat);
          continue;
        }
        break;
      }
      case "effects": {
        mutateState(ctx, beat.effects, "beat");
        break;
      }
      case "label": {
        fireOnLabelEnter(ctx, script.id, beat.name);
        break;
      }
      case "endScript": {
        fireOnBeatAfter(ctx, script.id, beatIdx, beat);
        clearStageOnScriptEnd(ctx);
        return true;
      }
      case "clear": {
        const input = yield {
          type: "clear",
          visualState: state.baseline.visuals,
        };
        if (input.type === "quit") return false;
        clearConsumedChoiceFallback(ctx, script.id);
        break;
      }
      // Silent visual mutators — no yield, fall through to
      // beatAfter + beatIndex++ at the bottom.
      case "setBg":
      case "setPortrait":
      case "clearVisuals":
      case "showCg":
      case "hideCg": {
        applySilentVisualBeat(ctx, beat);
        break;
      }
    }

    fireOnBeatAfter(ctx, script.id, beatIdx, beat);
    state.baseline.beatIndex++;
  }
  clearStageOnScriptEnd(ctx);
  return true;
}

function isSilentVisualBeat(beat: Beat): boolean {
  return (
    beat.type === "setBg" ||
    beat.type === "setPortrait" ||
    beat.type === "clearVisuals" ||
    beat.type === "showCg" ||
    beat.type === "hideCg"
  );
}

function applySilentVisualBeat(ctx: PresetContext, beat: Beat): void {
  const visuals = ctx.state.baseline.visuals;
  switch (beat.type) {
    case "setBg":
      visuals.bg = beat.assetPath;
      return;
    case "setPortrait": {
      let resolved: string | null = beat.assetPath ?? null;
      if (
        resolved === null &&
        beat.assetPath === undefined &&
        beat.characterId &&
        beat.emotion
      ) {
        const ch = ctx.game.characters.find((c) => c.id === beat.characterId);
        resolved = ch?.portraits?.[beat.emotion] ?? null;
      }
      visuals.portraits[beat.slot] = resolved;
      return;
    }
    case "clearVisuals":
      // bg is the slowest-changing slot and stays through scene resets.
      visuals.portraits = {};
      visuals.cg = null;
      return;
    case "showCg":
      visuals.cg = beat.assetPath;
      return;
    case "hideCg":
      visuals.cg = null;
      return;
    default:
      return;
  }
}

// When hot editing inserts scene setup immediately before the currently
// visible beat, semantic relocation must replay that setup. Otherwise the
// cursor finds the right line but skips the new bg/portrait/CG directives,
// leaving GUI shells on the old stage until the next scene transition.
function replayVisualSetupBefore(
  ctx: PresetContext,
  script: Script,
  targetIndex: number,
): void {
  let start = targetIndex;
  while (start > 0) {
    const previous = script.beats[start - 1];
    if (!previous || !isSilentVisualBeat(previous)) break;
    start--;
  }
  for (let i = start; i < targetIndex; i++) {
    const beat = script.beats[i];
    if (beat) applySilentVisualBeat(ctx, beat);
  }
}

// Scene teardown: a finished script clears its cast off the stage —
// portraits and any active cg go, bg stays (slowest-changing layer,
// same rule as the `:clear-visuals` directive). Runs on both finish
// paths ([end] and last-beat fall-through) but NOT on quit, which is
// a pause: the script resumes at the same beat next step. Builds a
// fresh visuals object instead of mutating in place so outputs already
// yielded keep the stage they were rendered with.
function clearStageOnScriptEnd(ctx: PresetContext): void {
  const v = ctx.state.baseline.visuals;
  ctx.state.baseline.visuals = { bg: v.bg, portraits: {}, cg: null };
  ctx.state.baseline.scriptCursor = null;
}

function buildLabelMap(script: Script): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < script.beats.length; i++) {
    const beat = script.beats[i];
    if (beat?.type === "label") map.set(beat.name, i);
  }
  return map;
}

function anchorBeat(beat: Beat): string {
  return JSON.stringify(beat);
}

function setScriptCursor(
  ctx: PresetContext,
  script: Script,
  beat: Beat,
): void {
  const previous = ctx.state.baseline.scriptCursor;
  ctx.state.baseline.scriptCursor = {
    scriptId: script.id,
    beatAnchor: anchorBeat(beat),
    ...(beat.type !== "choice" &&
    previous?.scriptId === script.id &&
    previous.choice
      ? { choice: previous.choice }
      : {}),
  };
}

function clearConsumedChoiceFallback(ctx: PresetContext, scriptId: string): void {
  const cursor = ctx.state.baseline.scriptCursor;
  if (cursor?.scriptId !== scriptId || cursor.choice === undefined) return;
  ctx.state.baseline.scriptCursor = {
    scriptId,
    beatAnchor: cursor.beatAnchor,
  };
}

function reconcileScriptCursor(
  ctx: PresetContext,
  script: Script,
  labelMap: Map<string, number>,
): void {
  const baseline = ctx.state.baseline;
  const current = script.beats[baseline.beatIndex];
  const cursor = baseline.scriptCursor;
  if (!current) return;
  if (!cursor || cursor.scriptId !== script.id) {
    baseline.scriptCursor = {
      scriptId: script.id,
      beatAnchor: anchorBeat(current),
    };
    return;
  }
  if (anchorBeat(current) === cursor.beatAnchor) return;

  const anchoredIndexes = script.beats.flatMap((beat, index) =>
    anchorBeat(beat) === cursor.beatAnchor ? [index] : [],
  );
  if (anchoredIndexes.length === 1) {
    const target = anchoredIndexes[0]!;
    baseline.beatIndex = target;
    replayVisualSetupBefore(ctx, script, target);
    return;
  }

  if (cursor.choice) {
    const matchingOptions = script.beats.flatMap((beat) => {
      if (beat.type !== "choice") return [];
      if ((beat.prompt ?? null) !== cursor.choice!.prompt) return [];
      return beat.options.filter(
        (option) => option.text === cursor.choice!.optionText,
      );
    });
    if (matchingOptions.length === 1) {
      const targetName = matchingOptions[0]!.goto;
      const target = targetName ? labelMap.get(targetName) : undefined;
      if (target !== undefined) {
        baseline.beatIndex = target;
        baseline.scriptCursor = {
          ...cursor,
          beatAnchor: anchorBeat(script.beats[target]!),
        };
        return;
      }
    }
  }

  throw new Error(
    `runScript: script migration required for "${script.id}" at persisted ` +
      `beatIndex ${baseline.beatIndex}; the anchored beat changed and could ` +
      `not be relocated safely`,
  );
}
