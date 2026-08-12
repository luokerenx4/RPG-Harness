import { evaluateCondition } from "../condition";
import type {
  Beat,
  Input,
  Output,
  PresetContext,
  RenderedChoice,
  Script,
  ScriptCursor,
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

const scriptRevisionCache = new WeakMap<Script, string>();

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
    setScriptCursor(ctx, script, original, beatIdx);

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
            ...(opt.id !== undefined ? { id: opt.id } : {}),
            text: opt.text,
            available: r.ok,
            ...(opt.aiPriority !== undefined
              ? { aiPriority: opt.aiPriority }
              : {}),
            ...(r.ok
              ? {}
              : { lockedReason: opt.lockedHint ?? r.reason }),
            ...(opt.requires !== undefined ? { requires: opt.requires } : {}),
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
          scriptId: script.id,
          ...(beat.id !== undefined ? { choiceId: beat.id } : {}),
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
          scriptRevision: revisionOf(script),
          scriptBeatCount: script.beats.length,
          ...neighborAnchors(script, beatIdx),
          ...(state.baseline.scriptCursor?.entryVisuals
            ? { entryVisuals: state.baseline.scriptCursor.entryVisuals }
            : {}),
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
  beatIndex: number,
): void {
  const previous = ctx.state.baseline.scriptCursor;
  ctx.state.baseline.scriptCursor = {
    scriptId: script.id,
    beatAnchor: anchorBeat(beat),
    scriptRevision: revisionOf(script),
    scriptBeatCount: script.beats.length,
    ...neighborAnchors(script, beatIndex),
    ...(previous?.scriptId === script.id && previous.entryVisuals
      ? { entryVisuals: previous.entryVisuals }
      : {}),
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
    ...(cursor.scriptRevision !== undefined
      ? { scriptRevision: cursor.scriptRevision }
      : {}),
    ...(cursor.scriptBeatCount !== undefined
      ? { scriptBeatCount: cursor.scriptBeatCount }
      : {}),
    ...(cursor.previousBeatAnchor !== undefined
      ? { previousBeatAnchor: cursor.previousBeatAnchor }
      : {}),
    ...(cursor.nextBeatAnchor !== undefined
      ? { nextBeatAnchor: cursor.nextBeatAnchor }
      : {}),
    ...(cursor.entryVisuals !== undefined
      ? { entryVisuals: cursor.entryVisuals }
      : {}),
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
  const scriptRevision = revisionOf(script);
  if (!current) return;
  if (!cursor || cursor.scriptId !== script.id) {
    baseline.scriptCursor = {
      scriptId: script.id,
      beatAnchor: anchorBeat(current),
      scriptRevision,
      scriptBeatCount: script.beats.length,
      ...neighborAnchors(script, baseline.beatIndex),
      entryVisuals: cloneVisuals(baseline.visuals),
    };
    return;
  }
  const visualsNeedReplay = cursor.scriptRevision !== scriptRevision;

  const anchoredIndexes = script.beats.flatMap((beat, index) =>
    anchorBeat(beat) === cursor.beatAnchor ? [index] : [],
  );
  const choicePresentationAnchor = presentationStableChoiceAnchorFromSerialized(
    cursor.beatAnchor,
  );
  const presentationStableIndexes =
    choicePresentationAnchor === undefined
      ? []
      : script.beats.flatMap((beat, index) =>
          presentationStableChoiceAnchor(beat) === choicePresentationAnchor
            ? [index]
            : [],
        );

  // A hot edit may split a formerly shared reply into per-option branches
  // while retaining the old reply for one of the *other* options. In that
  // case the textual anchor still exists, but following it would contradict
  // the player's persisted choice. Validate branch membership first.
  const selectedBranchTarget = cursor.choice
    ? choiceBranchTarget(script, labelMap, cursor.choice)
    : undefined;
  const semanticIndex =
    anchoredIndexes.length === 1
      ? anchoredIndexes[0]!
      : baseline.beatIndex;
  if (
    selectedBranchTarget !== undefined &&
    !indexBelongsToChoiceBranch(
      script,
      labelMap,
      cursor.choice!,
      selectedBranchTarget,
      semanticIndex,
    )
  ) {
    baseline.beatIndex = selectedBranchTarget;
    if (visualsNeedReplay) {
      replayVisualStateBefore(
        ctx,
        script,
        labelMap,
        selectedBranchTarget,
        cursor,
      );
    }
    baseline.scriptCursor = {
      ...cursor,
      beatAnchor: anchorBeat(script.beats[selectedBranchTarget]!),
      scriptRevision,
    };
    return;
  }
  if (anchorBeat(current) === cursor.beatAnchor) {
    if (visualsNeedReplay) {
      replayVisualStateBefore(
        ctx,
        script,
        labelMap,
        baseline.beatIndex,
        cursor,
      );
      baseline.scriptCursor = { ...cursor, scriptRevision };
    }
    return;
  }

  if (anchoredIndexes.length === 1) {
    const target = anchoredIndexes[0]!;
    baseline.beatIndex = target;
    if (visualsNeedReplay) {
      replayVisualStateBefore(ctx, script, labelMap, target, cursor);
    } else {
      replayVisualSetupBefore(ctx, script, target);
    }
    baseline.scriptCursor = {
      ...cursor,
      beatAnchor: anchorBeat(script.beats[target]!),
      scriptRevision,
    };
    return;
  }

  // Player-facing lock copy is deliberately presentation metadata: authors
  // can improve it while a save is sitting on the choice without changing
  // the prompt, options, gates, effects or branches. Locate that same semantic
  // choice uniquely, then replay any newly inserted visual setup on its path.
  if (presentationStableIndexes.length === 1) {
    const target = presentationStableIndexes[0]!;
    baseline.beatIndex = target;
    if (visualsNeedReplay) {
      replayVisualStateBefore(ctx, script, labelMap, target, cursor);
    } else {
      replayVisualSetupBefore(ctx, script, target);
    }
    baseline.scriptCursor = {
      ...cursor,
      beatAnchor: anchorBeat(script.beats[target]!),
      scriptRevision,
      scriptBeatCount: script.beats.length,
      ...neighborAnchors(script, target),
    };
    return;
  }

  if (
    isSafeInPlaceContentEdit(cursor, current) &&
    cursor.scriptBeatCount === script.beats.length &&
    hasMatchingNeighborContext(cursor, script, baseline.beatIndex)
  ) {
    if (visualsNeedReplay) {
      replayVisualStateBefore(
        ctx,
        script,
        labelMap,
        baseline.beatIndex,
        cursor,
      );
    }
    baseline.scriptCursor = {
      ...cursor,
      beatAnchor: anchorBeat(current),
      scriptRevision,
      scriptBeatCount: script.beats.length,
      ...neighborAnchors(script, baseline.beatIndex),
    };
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
          scriptRevision,
        };
        if (visualsNeedReplay) {
          replayVisualStateBefore(ctx, script, labelMap, target, cursor);
        }
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

function presentationStableChoiceAnchorFromSerialized(
  serialized: string,
): string | undefined {
  try {
    return presentationStableChoiceAnchor(JSON.parse(serialized) as Beat);
  } catch {
    return undefined;
  }
}

function presentationStableChoiceAnchor(beat: Beat): string | undefined {
  if (!beat || beat.type !== "choice") return undefined;
  return JSON.stringify({
    ...beat,
    options: beat.options.map(({ lockedHint: _lockedHint, ...option }) => option),
  });
}

function isSafeInPlaceContentEdit(
  cursor: ScriptCursor,
  current: Beat,
): boolean {
  let previous: unknown;
  try {
    previous = JSON.parse(cursor.beatAnchor) as unknown;
  } catch {
    return false;
  }
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) {
    return false;
  }
  const oldBeat = previous as Record<string, unknown>;
  if (oldBeat.type === "narration" && current.type === "narration") return true;
  return (
    oldBeat.type === "dialogue" &&
    current.type === "dialogue" &&
    oldBeat.speaker === current.speaker &&
    oldBeat.candidateEmotion === current.candidateEmotion
  );
}

function neighborAnchors(
  script: Script,
  beatIndex: number,
): Pick<ScriptCursor, "previousBeatAnchor" | "nextBeatAnchor"> {
  const previous = script.beats[beatIndex - 1];
  const next = script.beats[beatIndex + 1];
  return {
    ...(previous ? { previousBeatAnchor: anchorBeat(previous) } : {}),
    ...(next ? { nextBeatAnchor: anchorBeat(next) } : {}),
  };
}

function hasMatchingNeighborContext(
  cursor: ScriptCursor,
  script: Script,
  beatIndex: number,
): boolean {
  const previous = script.beats[beatIndex - 1];
  const next = script.beats[beatIndex + 1];
  const previousMatches = cursor.previousBeatAnchor === undefined
    ? previous === undefined
    : previous !== undefined && anchorBeat(previous) === cursor.previousBeatAnchor;
  const nextMatches = cursor.nextBeatAnchor === undefined
    ? next === undefined
    : next !== undefined && anchorBeat(next) === cursor.nextBeatAnchor;
  return previousMatches && nextMatches;
}

function revisionOf(script: Script): string {
  const cached = scriptRevisionCache.get(script);
  if (cached !== undefined) return cached;
  const source = JSON.stringify(script.beats);
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const revision = (hash >>> 0).toString(36);
  scriptRevisionCache.set(script, revision);
  return revision;
}

// Rebuild only the silent visual state along the control-flow path that can
// reach the persisted target. This makes hot edits visible immediately while
// avoiding effects/dialogue replay and skipping unchosen response branches.
function replayVisualStateBefore(
  ctx: PresetContext,
  script: Script,
  labelMap: Map<string, number>,
  targetIndex: number,
  cursor: ScriptCursor,
): void {
  if (cursor.entryVisuals) {
    ctx.state.baseline.visuals = cloneVisuals(cursor.entryVisuals);
  }
  let index = 0;
  let remaining = script.beats.length + 1;
  while (index < targetIndex && remaining-- > 0) {
    const beat = script.beats[index];
    if (!beat) return;
    if (isSilentVisualBeat(beat)) applySilentVisualBeat(ctx, beat);

    if (beat.type === "choice") {
      let selected = choiceMatchesBeat(cursor.choice, beat)
        ? beat.options.find((option) => option.text === cursor.choice!.optionText)
        : undefined;
      if (!selected) {
        const targets = beat.options.flatMap((option) => {
          const target = option.goto ? labelMap.get(option.goto) : undefined;
          return target === undefined ? [] : [{ option, target }];
        });
        const candidates = targets.filter(({ target }) =>
          indexBelongsToBranch(
            script,
            targets.map((entry) => entry.target),
            target,
            targetIndex,
          ),
        );
        if (candidates.length === 1) selected = candidates[0]!.option;
      }
      if (selected?.goto && selected.goto !== END_LABEL) {
        const target = labelMap.get(selected.goto);
        if (target !== undefined && target <= targetIndex) {
          index = target;
          continue;
        }
      }
    }
    if (beat.type === "endScript") return;
    index++;
  }
}

function cloneVisuals(
  visuals: PresetContext["state"]["baseline"]["visuals"],
): PresetContext["state"]["baseline"]["visuals"] {
  return {
    bg: visuals.bg,
    cg: visuals.cg,
    portraits: { ...visuals.portraits },
  };
}

function choiceMatchesBeat(
  choice: NonNullable<
    PresetContext["state"]["baseline"]["scriptCursor"]
  >["choice"],
  beat: Extract<Beat, { type: "choice" }>,
): boolean {
  return (
    choice !== undefined &&
    (beat.prompt ?? null) === choice.prompt &&
    beat.options.some((option) => option.text === choice.optionText)
  );
}

function choiceBranchTarget(
  script: Script,
  labelMap: Map<string, number>,
  choice: NonNullable<NonNullable<PresetContext["state"]["baseline"]["scriptCursor"]>["choice"]>,
): number | undefined {
  const matchingOptions = script.beats.flatMap((beat) => {
    if (beat.type !== "choice") return [];
    if ((beat.prompt ?? null) !== choice.prompt) return [];
    return beat.options.filter((option) => option.text === choice.optionText);
  });
  if (matchingOptions.length !== 1) return undefined;
  const targetName = matchingOptions[0]!.goto;
  return targetName ? labelMap.get(targetName) : undefined;
}

function indexBelongsToChoiceBranch(
  script: Script,
  labelMap: Map<string, number>,
  choice: NonNullable<NonNullable<PresetContext["state"]["baseline"]["scriptCursor"]>["choice"]>,
  target: number,
  index: number,
): boolean {
  const siblingTargets = script.beats.flatMap((beat) => {
    if (beat.type !== "choice") return [];
    if ((beat.prompt ?? null) !== choice.prompt) return [];
    return beat.options.flatMap((option) => {
      const optionTarget = option.goto ? labelMap.get(option.goto) : undefined;
      return optionTarget === undefined ? [] : [optionTarget];
    });
  });
  return indexBelongsToBranch(script, siblingTargets, target, index);
}

function indexBelongsToBranch(
  script: Script,
  siblingTargets: number[],
  target: number,
  index: number,
): boolean {
  const nextSibling = siblingTargets
    .filter((candidate) => candidate > target)
    .sort((a, b) => a - b)[0];
  const endScript = script.beats.findIndex(
    (beat, beatIndex) => beatIndex >= target && beat.type === "endScript",
  );
  const exclusiveEnd = Math.min(
    nextSibling ?? script.beats.length,
    endScript >= 0 ? endScript + 1 : script.beats.length,
  );
  return index >= target && index < exclusiveEnd;
}
