---
name: rpg-harness-player
description: Play an RPG-Harness game from the shell. Use this skill when you're inside a folder containing game.yaml + characters/ + scripts/ (an RPG-Harness game), and the user wants you to play through the game — either as yourself or in character as a persona. Drives the game via the `rpgh` CLI, reading stdout JSON and writing stdin one input at a time.
---

# rpg-harness-player

You're a player playing through an RPG-Harness game. You make decisions, the game advances, you reach an ending. You write no code — you only invoke the `rpgh` CLI and react to its JSON output.

## Before you start

Check three things:

1. **The `rpgh` binary is available.** Run `which rpgh` or `bun run rpgh --help` from inside the RPG-Harness repo. If neither works, ask the user to install it (`brew install bun && bun link` inside `packages/cli/`).
2. **You're at the right path.** Identify the game directory. It contains `game.yaml`, `characters/`, `scripts/`. Use an absolute or repo-relative path going forward (the CLI doesn't care).
3. **Pick a session name.** A session is your save file. Pick something descriptive: `claude-thoughtful`, `playthrough-cautious`, `demo-2026-05-21`. Don't use someone else's session — that overwrites their save.

```bash
GAME="examples/sengoku-raid"      # adjust to actual game dir
SESSION="claude-$(date +%H%M%S)"  # or any unique name
```

## The loop (this is the whole skill)

```
[peek once] → read output → decide input → [step with input] → read output → repeat
```

### Step 1: See where you are

```bash
rpgh peek "$GAME" --session "$SESSION"
```

Output is a single line of JSON:

```json
{
  "output": { "type": "...", ... },
  "done": false,
  "state": { "baseline": { ... } }
}
```

If `done` is `true`, the game is over. Read the final state and tell the user which ending you reached.

### Step 2: Decide based on `output.type`

| output.type | Meaning | Your input |
|---|---|---|
| `scriptComplete` | Between scripts — engine waits for you to pick one of `nextAvailable[]` | `{"type":"select","scriptId":"<id>"}` |
| `narration` | Pure story text (no speaker) | `{"type":"next"}` |
| `dialogue` | A character speaks (`speakerName` + `text`) | `{"type":"next"}` |
| `choice` | Story branch — pick an `available:true` option by stable identity | `{"type":"choose","choiceId":"<choiceId>","optionId":"<optionId>"}` |
| `clear` | Scene break, just advance | `{"type":"next"}` |
| `gameEnd` | You hit a terminal — no more scripts available | Stop. Report the ending. |

### Step 3: Apply your decision

```bash
rpgh step "$GAME" --session "$SESSION" --input '{"type":"choose","choiceId":"answer-at-the-gate","optionId":"enter-together"}'
```

The output of `step` is the **next** event. You do NOT need to `peek` again — just react to what `step` printed.

Inspect `inputResult` before continuing. When `accepted` is `false`, read its
`code`, `message`, and `expected` fields and submit a corrected input. The game
has not advanced, so do not blindly retry the rejected action.

### Step 4: Loop until done

Keep doing step 2 + step 3 until you see `gameEnd` or `done: true`.

## Reading like a player, not like a parser

Even when output is just narration or dialogue, **read the text**. The story is the point. Tell the human what's happening in your own words occasionally — don't just dump raw JSON or robotically advance.

When the output is a `choice`, before sending input:

1. State your interpretation of the situation in 1 sentence.
2. List the options and what each one signals.
3. Pick one and say why.

Example:

```
> 现在的场景：薄樱在樱花树下画画，问我也喜欢樱花吗。
> 选项：
>   1. 嗯，很美 — 安全
>   2. 只是路过 — 冷淡
>   3. 我喜欢看你画 — 主动
> 我选 3，因为这个 persona 是直接型，而且这个选项有 +2 affection
```

Then:

```bash
rpgh step "$GAME" --session "$SESSION" --input '{"type":"choose","choiceId":"answer-under-the-tree","optionId":"watch-her-paint"}'
```

Use the `choiceId` from the current choice output and the selected option's
`id`. This remains correct if the author reorders options while you play. Only
fall back to `{"type":"choose","index":N}` when the current legacy choice or
option has no stable id.

## Choosing in character

If the user gave you a persona ("play as a cautious introvert" / "play as someone trying to reach the bea-good ending"), every choice should follow that persona. Don't break character to optimize.

If the user said "just play your way", reveal your taste in the choices. Don't fake.

## Locked options

In a `choice`, options have `available: true` or `available: false`. Locked options cannot be picked — picking them is a no-op (engine yields the same choice again). When you see a locked option, mention it in your reasoning ("the bold option requires affection >= 2, I don't have that yet").

## When the game ends

```bash
rpgh peek "$GAME" --session "$SESSION"
```

The final state's `baseline.completedScripts[-1]` is the ending you reached. Tell the user:
- Which ending
- A 1-sentence reflection
- (If they asked) how to read the log: `cat "$GAME/.rpg-harness/sessions/$SESSION/log.jsonl"`

## Fork your save

Use the checkpoint-aware CLI to branch and try a different choice:

```bash
rpgh choices "$GAME" --session "$SESSION" --status pending
rpgh cover "$GAME" --source-session "$SESSION" \
  --session "${SESSION}-cover" --key SCRIPT/CHOICE/OPTION
```

`cover` forks the exact immutable checkpoint, verifies that live edits still
present the same stable choice and option, selects by option id, and continues
on the new session. Never copy a live session directory: that can race GUI or
Headless writes and loses explicit fork lineage.

For an authored stable choice that this lineage has never reached, use the
bounded Headless search lane:

```bash
rpgh reach "$GAME" --from-session "$SESSION" \
  --session "${SESSION}-reach" --key SCRIPT/CHOICE
```

It explores public inputs without touching the source, persists only a found
path, and verifies the replayed GUI-compatible state against the search result.
If a bounded search misses, inspect its `closest.requirements`. Use
`--report-on-miss` only when the nearest state should become a reproducible
coding issue; intentional route exclusivity should be reviewed and resolved so
automated playtesting does not accumulate false-positive work.

## Turn playtest findings into coding issues

When the story contradicts an earlier choice, progression feels stuck, an engine
output is invalid, or the UI makes the next action unclear, record it immediately:

```bash
rpgh report "$GAME" --session "$SESSION" \
  --area narrative --severity major \
  --title "Later scene remembers a question I never asked" \
  --details "I chose the silent option in bond_kagari_01, but bond_kagari_04 quotes me asking it." \
  --target scripts/bond_kagari_04.md
```

Areas are `narrative`, `gameplay`, `engine`, `ui`, and `tooling`. Severities are
`note`, `minor`, `major`, and `blocker`. The command stores an open issue in the
session's `issues.jsonl` and automatically attaches the current script, save/log
paths, log line, and compact latest input/output. Continue playing after a
`note`, `minor`, or `major` finding when possible; stop only when it is truly a
`blocker`.

Use `rpgh reports "$GAME" --format table` for human triage or the default JSON
form for another AI/code agent. Do not wait until the end and rely on memory.
After a fix passes its replay/fixture and surface checks, close the loop with
`rpgh resolve "$GAME" <report-id> --resolution "what changed and how it was verified"`.

Persisted `autoplay --report-on-stop` runs may stop with `reason: "stalled"`.
Read `stall.cycleLength`, `stall.repetitions`, and `stall.cycle` before changing
content: they are an exact repeated engine-state/public-output cycle, including
the responsible inputs. Reproduce from the report checkpoint, repair the
persona, objective links, gameplay action, or engine contract that prevents
progress, then rerun from a fresh branch and resolve the report. Do not merely
raise `--max-steps`; that discards the coding signal.

## Hard rules

- Never modify the game's `scripts/` or `characters/` files unless the user explicitly asks. The author wrote them.
- Never run `step` against a session you don't own (sessions list at `<game>/.rpg-harness/sessions/`).
- Interactive play uses **peek, step, report, reports, resolve**. For explicit
  branch coverage work, **choices, cover, reach, transcript** are also valid;
  `autoplay` remains a development/fuzzing lane rather than ordinary play.
- If something errors with "ENOENT" or similar, you're probably in the wrong directory or used a wrong path. Don't keep retrying — check `pwd` and `ls`.

## Example transcript

```bash
$ rpgh peek "$GAME" --session "$SESSION"
{"output":{"type":"dialogue","speakerName":"narrator","text":"慶長十年、初秋。"},"done":false,"state":{"baseline":{"currentScriptId":"000_intro",...}}}

# Intro is auto-launched (sengoku-raid sets currentScriptId in onSessionStart).
# Just drain it with `next`.
$ rpgh step "$GAME" --session "$SESSION" --input '{"type":"next"}'
{"output":{"type":"dialogue","speakerName":"narrator","text":"江戸城本丸の大広間。蝋燭の煙が天井に渦を巻く。"},...}

# ... drain ~12 beats of intro until the hub menu appears
$ rpgh step "$GAME" --session "$SESSION" --input '{"type":"next"}'
{"output":{"type":"hubMenu","snapshot":{"activities":[{"id":"depart:kuro_swamp","title":"出立 — 黒沼地（難度 1）",...}, ...]}}, ...}

# Depart on the easiest raid.
$ rpgh step "$GAME" --session "$SESSION" --input '{"type":"doActivity","id":"depart:kuro_swamp"}'
{"output":{"type":"narration","text":"黒沼地に踏み入る。霧が脛に絡みつく。"},...}

# ... eventually you'll see a choice (kagari first-meet) or end at an ending.
$ rpgh peek "$GAME" --session "$SESSION"
{"output":{"type":"gameEnd"},"done":true,...}

# Report:
> 通关。结局：ending_pure_rite — 公儀の道、鎮魂結界の儀。
```

That's it. The whole skill.
