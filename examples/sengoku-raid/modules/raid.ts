// sengoku-raid: the headless extraction-shooter module. Reference
// implementation for "what an RPGMaker-native RPG-Harness module looks
// like" after Phase 6.
//
// Owns:
//   - mode flag (HUB / RAID), per-raid sub-state (current zone,
//     encounter, pending loot), and the metCharacters tracker — all
//     in the module's own state slice at state["sengoku-raid"]
//   - the hub menu (mode-dependent activities) via onHubBuild
//   - 12 raid/hub action handlers declared via module.actionHandlers
//     + provides. Dispatched by the engine's standard
//     actionHandlerRegistry; activities carry actionKind + payload
//     so the engine routes Input.doActivity through one code path.
//   - reactive triggers: death (player.hp ≤ 0), spectral overload
//     (player.spectral ≥ 100)
//
// Storage layout:
//   - Player stats (HP / mental / spectral / intellect) live on the
//     `player` character (characters/player.md) with declared
//     min/max. Engine clamps on every mutateState write.
//   - raidsCompleted / raidsFailed are declared variables (game.yaml).
//   - Maps load via the engine's parser as a first-class resource
//     (maps/*.yaml → ctx.game.maps / ctx.mapMap). The module reads
//     them; it no longer touches the filesystem.
//
// Why not the training preset?
//   We want raid/hub modes instead of day/slot calendar, and we want
//   our onHubBuild to win first-wins. Skipping game.training avoids
//   both.

import { enterMap, evaluateCondition } from "@rpg-harness/engine";
import type {
  ActionContext,
  ActionHandler,
  ActionResult,
  CharacterSpawnRule,
  ComposedState,
  Game,
  HubActivity,
  Input,
  MapDef,
  Module,
  Output,
  PresetContext,
  StateDelta,
  StatSnapshot,
  Trigger,
} from "@rpg-harness/engine";

// Most helpers take a minimal ctx (state + game + rng) so they work for
// both PresetContext callers (the preset / onHubBuild) and ActionContext
// callers (handler dispatch). RNG is optional because pure-read helpers
// don't need it.
type Ctx = {
  state: ComposedState;
  game: Game;
  rng: () => number;
};

const MODULE_ID = "sengoku-raid";

// ============================================================================
// Player stats live on the `player` character (characters/player.md)
// with declared min/max — the engine clamps automatically through
// mutateState. `playerStat` / `setPlayerStat` are thin readers/writers
// kept until R2 converts every site to ActionResult { deltas } returns.
// ============================================================================

type PlayerStat = "hp" | "mental" | "spectral" | "intellect";

function playerStat(ctx: Ctx, name: PlayerStat): number {
  return ctx.state.baseline.characters.player?.stats[name] ?? 0;
}

function playerStatMax(ctx: Ctx, name: PlayerStat): number {
  return (
    ctx.game.characters.find((c) => c.id === "player")?.stats?.[name]?.max ?? 0
  );
}

function setPlayerStat(
  ctx: Ctx,
  name: PlayerStat,
  value: number,
): void {
  const c = ctx.state.baseline.characters.player;
  if (!c) return;
  const def = ctx.game.characters.find((cd) => cd.id === "player")?.stats?.[
    name
  ];
  const min = def?.min ?? Number.NEGATIVE_INFINITY;
  const max = def?.max ?? Number.POSITIVE_INFINITY;
  c.stats[name] = Math.max(min, Math.min(max, value));
}

type GameVariable = "raidsCompleted" | "raidsFailed";

function getVar(ctx: Ctx, name: GameVariable): number {
  const v = ctx.state.baseline.variables[name];
  return typeof v === "number" ? v : 0;
}

function setVar(ctx: Ctx, name: GameVariable, value: number): void {
  ctx.state.baseline.variables[name] = value;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// ============================================================================
// Module sub-state
// ============================================================================

// Per-map runtime state for the *current* raid. Lazy-initialized when
// the player enters a map; lives only inside a RaidInstance and resets
// every raid. Static data (name, connections, encounter/loot tables) is
// not duplicated here — read it from `ctx.mapMap.get(<mapId>)` whenever
// needed.
interface MapInstance {
  visited: boolean;
  searched: boolean;
  encounter: null | {
    enemyId: string;
    enemyHp: number;
    enemyHpMax: number;
    // Set true when HP drops below 30% — unlocks negotiate options in
    // buildRaidMenu. Cleared automatically when the encounter resolves
    // (encounter goes null).
    negotiable?: boolean;
    // Set after the player listens once. A single encounter offers one
    // negotiation window; further attacks cannot reopen it and suppress
    // cannot become a zero-damage reroll exploit.
    negotiationConsumed?: boolean;
  };
  encounterCleared: boolean;
  pendingLoot: Record<string, number>;
  // Set once this zone's encounter has been rolled — either on first
  // arrival, or earlier by 澪's 水鏡 scry while still in a neighbouring
  // zone. The guard keeps a scouted enemy truthful: the actual arrival
  // must not re-roll and contradict what the player was shown.
  encounterRolled?: boolean;
}

function negotiationWindowConsumed(
  encounter: NonNullable<MapInstance["encounter"]>,
): boolean {
  if (encounter.negotiationConsumed === true) return true;
  // Legacy saves used explicit false only after negotiate_listen. An enemy
  // below the negotiation threshold cannot otherwise reach that state: normal
  // and suppress attacks mark it negotiable in the same transaction.
  return encounter.negotiable === false &&
    encounter.enemyHp > 0 &&
    encounter.enemyHp < encounter.enemyHpMax * 0.3;
}

// One raid (a single "expedition" from edo_castle through a chain of maps).
// `chain` matches MapDef.chain; entryMapId is the chain entry the player
// departed to. Per-map state lives in `visited`, keyed by map id —
// crucially, "what map am I on now" is not stored here, it lives in
// `state.baseline.currentMapId` (engine-canonical).
interface RaidInstance {
  chain: string;
  entryMapId: string;
  visited: Record<string, MapInstance>;
  pendingLoot: Record<string, number>; // gathered this raid (sum across maps)
  turnsTaken: number;
}

interface RaidModuleState {
  // "In a raid?" is equivalent to `raid !== null`. The previous explicit
  // `mode: "hub" | "raid"` flag was redundant with the raid sub-state
  // pointer; collapsed in the flat-map migration.
  raid: RaidInstance | null;
  metCharacters: string[];
  // Currently-invited companion. Cleared on raid end (success or
  // failure) regardless of HP. The companion's switch
  // `companion_<id>` is the player-facing source of truth — that
  // is what onChoicePresented / onBeatBefore key on.
  companion: string | null;
  // Companion HP for current raid. 10 cap. When this hits 0 the
  // companion is downed → affection -3, switch flipped off,
  // companion_downed variable += 1.
  companionHp: number;
  // 妖刀の業 — when set, the next time buildRaidMenu (or buildHubMenu
  // if mode flipped) runs, the menu shows only the three imbue
  // activities. Stores the absorb amount the victory queued so the
  // imbue handler can apply it via the chosen pulse's formula.
  pulsePending: null | { enemyId: string; absorb: number };
  // 業の鏡 — log of milestones the player has crossed. Pushed by the
  // onStateMutated observer when a watched stat crosses a threshold
  // for the first time, and by onLabelEnter for letter_03 endings.
  // Duplicates are filtered at append time.
  achievementLog: string[];
}

function moduleState(ctx: Ctx): RaidModuleState {
  const s = ctx.state[MODULE_ID] as RaidModuleState | undefined;
  if (!s) throw new Error(`${MODULE_ID}: module state missing`);
  return s;
}

// Engine-canonical reads. "Where am I right now" is `currentMapId`; the
// per-map runtime instance for the current raid lives at
// `m.raid.visited[currentMapId]`. These helpers consolidate the read so
// the rest of the file doesn't repeat the null-checks.
function currentMap(ctx: Ctx): MapDef | undefined {
  const id = ctx.state.baseline.currentMapId;
  if (id === null) return undefined;
  return ctx.game.maps?.find((m) => m.id === id);
}

function currentMapInstance(ctx: Ctx): MapInstance | undefined {
  const m = moduleState(ctx);
  if (!m.raid) return undefined;
  const id = ctx.state.baseline.currentMapId;
  if (id === null) return undefined;
  return m.raid.visited[id];
}

function ensureMapInstance(ctx: Ctx, mapId: string): MapInstance {
  const m = moduleState(ctx);
  if (!m.raid) throw new Error(`${MODULE_ID}: ensureMapInstance with no active raid`);
  let inst = m.raid.visited[mapId];
  if (!inst) {
    inst = {
      visited: false,
      searched: false,
      encounter: null,
      encounterCleared: false,
      pendingLoot: {},
    };
    m.raid.visited[mapId] = inst;
  }
  return inst;
}

function inRaid(ctx: Ctx): boolean {
  return moduleState(ctx).raid !== null;
}

// ============================================================================
// Maps — loaded by the engine's parser as a first-class resource type
// (packages/parser/src/map.ts). Module consumes them via ctx.game.maps
// or the per-id ctx.mapMap lookup that buildPresetContext exposes.
// ============================================================================

function getMap(ctx: Ctx, mapId: string): MapDef | undefined {
  return ctx.game.maps?.find((m) => m.id === mapId);
}

// Sorted list of (chain, entry-map) pairs the player can currently
// depart to. Hub menu uses this to emit depart activities.
function discoverableChains(ctx: Ctx): { chain: string; entry: MapDef }[] {
  const out: { chain: string; entry: MapDef; difficulty: number }[] = [];
  for (const m of ctx.game.maps ?? []) {
    if (!m.chain || m.isEntry !== true) continue;
    if (!chainUnlocked(ctx, m.chain)) continue;
    out.push({ chain: m.chain, entry: m, difficulty: m.difficulty ?? 1 });
  }
  out.sort((a, b) => a.difficulty - b.difficulty);
  return out.map(({ chain, entry }) => ({ chain, entry }));
}

// Chain availability gates. hell_gate stays locked behind the same
// composite (weapon power AND two skills AND pulse_oni).
function chainUnlocked(ctx: Ctx, chain: string): boolean {
  if (chain === "hell_gate") {
    const pulseOni = (ctx.state.baseline.variables.pulse_oni ?? 0) as number;
    const power = ctx.state.baseline.weapons.ancestor_yaodao?.power ?? 0;
    const knows = ctx.state.baseline.knownSkills;
    return (
      pulseOni >= 8 &&
      power >= 12 &&
      knows.includes("chinkonho") &&
      knows.includes("mizukagami")
    );
  }
  return true;
}

// ============================================================================
// Random helpers (use ctx.rng for determinism)
// ============================================================================

function pickWeighted<T extends { weight: number }>(
  rng: () => number,
  pool: T[],
): T {
  const total = pool.reduce((s, p) => s + p.weight, 0);
  let r = rng() * total;
  for (const p of pool) {
    r -= p.weight;
    if (r <= 0) return p;
  }
  return pool[pool.length - 1]!;
}

function rollIntInclusive(rng: () => number, lo: number, hi: number): number {
  if (hi <= lo) return lo;
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// ============================================================================
// Hub menu construction (mode-dependent)
// ============================================================================

function buildSnapshot(activities: HubActivity[], ctx: Ctx): Output {
  return {
    type: "hubMenu",
    snapshot: {
      day: 0,
      maxDay: 0,
      slot: 0,
      slotName: "",
      slotsPerDay: 0,
      stats: buildStatSnapshots(ctx),
      affections: buildAffectionSnapshots(ctx),
      resourceGroups: buildResourceGroups(ctx),
      objectives: buildObjectives(ctx, activities),
      activities,
    },
  };
}

function buildObjectives(ctx: Ctx, activities: HubActivity[]) {
  const variables = ctx.state.baseline.variables;
  const switches = ctx.state.baseline.switches;
  const raids = Number(variables.raidsCompleted ?? 0);
  const chapter = Number(variables.shogun_chapter ?? 0);
  const directive = String(variables.last_directive ?? "");
  const progressCategories = new Set(["raid", "combat", "spirit"]);
  const progressActivityIds = activities
    .filter((activity) => activity.available && progressCategories.has(activity.category))
    .map((activity) => activity.id);
  const restActivityId = activities.some(
    (activity) => activity.id === "rest" && activity.available,
  ) ? ["rest"] : [];
  const executableProgressActivityIds = progressActivityIds.length > 0
    ? progressActivityIds
    : restActivityId;
  const requirement = (
    id: string,
    label: string,
    current: string | number | boolean,
    target: string | number | boolean,
    satisfied: boolean,
  ) => ({ id, label, current, target, satisfied });
  const withThreeFlowers = <T>(main: T[]) => {
    const metAll = ["kagari", "kasumi", "mio"].every((id) =>
      moduleState(ctx).metCharacters.includes(id)
    );
    const completed =
      ctx.state.baseline.scripts.three_flowers_alliance?.completed === true;
    if (!metAll || completed) return main;
    const companions = [
      { id: "kagari", name: "篝" },
      { id: "kasumi", name: "霞" },
      { id: "mio", name: "澪" },
    ];
    const missing = companions.find(
      ({ id }) => switches[`befriended_${id}`] !== true,
    );
    let relatedActivityIds: string[] = [];
    if (missing) {
      const m = moduleState(ctx);
      const available = (id: string) => activities.some(
        (activity) => activity.id === id && activity.available,
      );
      if (m.companion === missing.id) {
        relatedActivityIds = executableProgressActivityIds;
      } else if (available(`invite:${missing.id}`)) {
        relatedActivityIds = [`invite:${missing.id}`];
      } else if (available(`bond:${missing.id}`)) {
        relatedActivityIds = [`bond:${missing.id}`];
      } else {
        relatedActivityIds = activities
          .filter((activity) =>
            activity.available &&
            (activity.id === "sell_all_loot" || activity.id.startsWith("sell_material:"))
          )
          .map((activity) => activity.id);
      }
    } else if (availableActivity(activities, "script:three_flowers_alliance")) {
      relatedActivityIds = ["script:three_flowers_alliance"];
    }
    return [{
      id: "three_flowers_alliance",
      title: missing ? `三花の盟 — ${missing.name}と生還する` : "三花の盟を結ぶ",
      description: "篝・霞・澪、それぞれと一度ずつ出帰りから生還する。",
      status: "active" as const,
      requirements: companions.map(({ id, name }) => requirement(
        `befriended_${id}`,
        `${name}と生還`,
        switches[`befriended_${id}`] === true,
        true,
        switches[`befriended_${id}`] === true,
      )),
      relatedActivityIds,
    }, ...main];
  };

  if (chapter < 1) {
    return withThreeFlowers([{
      id: "letter_01_dispatch",
      title: "最初の密書を待つ",
      description: `現在の御沙汰：${directive}`,
      status: "active" as const,
      requirements: [requirement("raidsCompleted", "成功撤退", raids, 3, raids >= 3)],
      relatedActivityIds: executableProgressActivityIds,
    }]);
  }
  if (chapter < 2) {
    const spectral = playerStat(ctx, "spectral");
    return withThreeFlowers([{
      id: "letter_02_dispatch",
      title: "公儀の見立てを待つ",
      description: `現在の御沙汰：${directive}`,
      status: "active" as const,
      requirements: [
        requirement("raidsCompleted", "成功撤退", raids, 7, raids >= 7),
        requirement("spectral", "霊体化上限", spectral, "49 以下", spectral <= 49),
      ],
      relatedActivityIds: executableProgressActivityIds,
    }]);
  }
  if (chapter < 3) {
    return withThreeFlowers([{
      id: "letter_03_dispatch",
      title: "最後の御沙汰を待つ",
      description: `現在の御沙汰：${directive}`,
      status: "active" as const,
      requirements: [requirement("raidsCompleted", "成功撤退", raids, 12, raids >= 12)],
      relatedActivityIds: executableProgressActivityIds,
    }]);
  }

  const route = switches.chose_court_loyal
    ? { id: "ending_pure_rite", title: "鎮魂結界の儀へ", variable: "pulse_pure", label: "脈絡: 浄", target: 5 }
    : switches.chose_court_defy
      ? { id: "ending_oni_self", title: "地獄門の底へ", variable: "pulse_oni", label: "脈絡: 鬼", target: 8 }
      : switches.chose_court_silent
        ? { id: "ending_mundane_seal", title: "妖刀を祠へ納める", variable: "pulse_mundane", label: "脈絡: 凡", target: 5 }
        : null;
  if (!route) return withThreeFlowers([]);
  const completed = ctx.state.baseline.scripts[route.id]?.completed === true;
  const current = Number(variables[route.variable] ?? 0);
  const endingActivityId = `script:${route.id}`;
  const endingAvailable = activities.some(
    (activity) => activity.id === endingActivityId && activity.available,
  );
  const routeImbueActivityId = `imbue:${route.variable.replace("pulse_", "")}`;
  const routeImbueAvailable = activities.some(
    (activity) => activity.id === routeImbueActivityId && activity.available,
  );
  return withThreeFlowers([{
    id: route.id,
    title: completed ? `${route.title} — 完遂` : route.title,
    description: directive,
    status: completed ? "completed" as const : "active" as const,
    requirements: [
      requirement(route.variable, route.label, current, route.target, current >= route.target),
    ],
    relatedActivityIds: completed
      ? []
      : endingAvailable
        ? [endingActivityId]
        : routeImbueAvailable
          ? [routeImbueActivityId]
          : executableProgressActivityIds,
  }]);
}

function availableActivity(activities: HubActivity[], id: string): boolean {
  return activities.some((activity) => activity.id === id && activity.available);
}

function buildResourceGroups(ctx: Ctx) {
  const raid = moduleState(ctx).raid;
  if (!raid) return [];
  const resources = Object.entries(raid.pendingLoot)
    .filter(([, quantity]) => quantity > 0)
    .map(([id, quantity]) => ({ id, name: itemName(ctx, id), quantity }));
  if (resources.length === 0) return [];
  return [
    {
      id: "carried-loot",
      title: "携行中の戦利品",
      description: "撤退して大名府へ戻ると確保される",
      resources,
    },
  ];
}

function buildStatSnapshots(ctx: Ctx) {
  const ryo = ctx.state.baseline.inventory.ryo ?? 0;
  const stats: StatSnapshot[] = [
    {
      id: "hp",
      name: "体力",
      value: playerStat(ctx, "hp"),
      min: 0,
      max: playerStatMax(ctx, "hp"),
      thresholds: [
        { min: 0, label: "瀕死", color: "red" as const },
        { min: 6, label: "負傷", color: "yellow" as const },
        { min: 15, label: "万全", color: "green" as const },
      ],
    },
    {
      id: "mental",
      name: "精神",
      value: playerStat(ctx, "mental"),
      min: 0,
      max: playerStatMax(ctx, "mental"),
      thresholds: [
        { min: 0, label: "崩壊", color: "red" as const },
        { min: 3, label: "安定", color: "green" as const },
      ],
    },
    {
      id: "spectral",
      name: "霊体化",
      value: playerStat(ctx, "spectral"),
      min: 0,
      max: 100,
      thresholds: [
        { min: 0, label: "平穏", color: "green" as const },
        { min: 20, label: "覚醒", color: "cyan" as const },
        { min: 50, label: "危険", color: "yellow" as const },
        { min: 80, label: "暴走寸前", color: "red" as const },
      ],
    },
    { id: "intellect", name: "学識", value: playerStat(ctx, "intellect"), min: 0, max: 99 },
    { id: "ryo", name: "両", value: ryo, min: 0, max: 99999 },
  ];

  // 三脈 — always shown; value 0 reads as "未流したことがない". These are
  // the variables that gate the endings (pure rite / 鬼ヶ門 / 凡道), so
  // putting them in the visible stat strip lets the player track where
  // their build is heading without grepping state JSON.
  const v = ctx.state.baseline.variables;
  stats.push({
    id: "pulse_pure",
    name: "脈絡: 浄",
    value: ((v.pulse_pure ?? 0) as number),
    min: 0,
    max: 99,
  });
  stats.push({
    id: "pulse_oni",
    name: "脈絡: 鬼",
    value: ((v.pulse_oni ?? 0) as number),
    min: 0,
    max: 99,
    thresholds: [
      { min: 0, label: "清", color: "green" as const },
      { min: 5, label: "傾", color: "yellow" as const },
      { min: 10, label: "堕", color: "red" as const },
    ],
  });
  stats.push({
    id: "pulse_mundane",
    name: "脈絡: 凡",
    value: ((v.pulse_mundane ?? 0) as number),
    min: 0,
    max: 99,
  });

  // Companion HP — surfaced only while a companion is in party. The
  // module already tracks companionHp on m, but it wasn't exposed to
  // the snapshot; without this row the player can't tell their tank
  // is bleeding out short of reading combat narration.
  const m = moduleState(ctx);
  if (m.companion) {
    const charName =
      ctx.game.characters.find((c) => c.id === m.companion)?.name ?? m.companion;
    stats.push({
      id: "companion_hp",
      name: `同伴 ${charName}`,
      value: m.companionHp,
      min: 0,
      max: 10,
      thresholds: [
        { min: 0, label: "倒", color: "red" as const },
        { min: 4, label: "傷", color: "yellow" as const },
        { min: 7, label: "万全", color: "green" as const },
      ],
    });
  }

  return stats;
}

function buildAffectionSnapshots(ctx: Ctx) {
  const m = moduleState(ctx);
  return ctx.game.characters
    .filter((c) => m.metCharacters.includes(c.id))
    .map((c) => ({
      id: c.id,
      name: c.name,
      value: ctx.state.baseline.characters[c.id]?.stats.affection ?? 0,
    }));
}

function buildHubMenu(ctx: Ctx): Output {
  const m = moduleState(ctx);
  const activities: HubActivity[] = [];

  // Per-character bonding: hub-side gift + scripted bond scenes.
  // The bond scripts are static files (scripts/bond_<id>_NN.md) with
  // affection-gated `requires:` clauses. They're surfaced here as
  // "script:" activities, dispatched through the engine's standard
  // dispatch (NOT the raid module's prefix), so script completion
  // hooks fire normally and the script gets logged to completionOrder.
  for (const charId of m.metCharacters) {
    const char = ctx.game.characters.find((c) => c.id === charId);
    if (!char) continue;
    const ryo = ctx.state.baseline.inventory.ryo ?? 0;
    activities.push({
      id: `bond:${charId}`,
      kind: "action",
      actionKind: "bond",
      payload: { characterId: charId },
      title: `${char.name}に贈り物をする`,
      description: "好感度 +1（50 両）",
      category: "social",
      cost: 0,
      effectsHint: `${char.name}+1 ryo-50`,
      available: ryo >= 50,
      lockedReason: ryo < 50 ? "両が足りない" : undefined,
    });
    // Surface bond scripts. Unlike zone_haunt / ending which we hide
    // until eligible (surprise content), bond_* scripts are surfaced
    // even when locked — with lockedReason — so the player can see
    // "送り物をもう一度すれば開放" instead of wondering whether the
    // scene exists at all.
    for (const script of ctx.game.scripts) {
      if (!script.id.startsWith(`bond_${charId}_`)) continue;
      if (ctx.state.baseline.scripts[script.id]?.completed === true) continue;
      const reqs = script.requires;
      const r =
        reqs === undefined ? { ok: true } : evaluateCondition(reqs, ctx.state);
      activities.push({
        id: `script:${script.id}`,
        kind: "script",
        title: `${char.name} — ${script.title}`,
        category: "social",
        cost: 0,
        available: r.ok,
        ...(r.ok ? {} : { lockedReason: r.reason }),
      });
    }
  }

  // zone_haunt_<enemy> — one-shot lore scripts that unlock when the
  // player has *released* (negotiated free) an enemy of that type
  // at least once. Selfswitch A on the script is the unlock gate;
  // script `requires:` reads it. Once played, script.completed is
  // true and it disappears from the hub.
  for (const script of ctx.game.scripts) {
    if (!script.id.startsWith("zone_haunt_")) continue;
    if (ctx.state.baseline.scripts[script.id]?.completed === true) continue;
    const reqs = script.requires;
    const eligible = reqs === undefined || evaluateCondition(reqs, ctx.state).ok;
    if (!eligible) continue;
    activities.push({
      id: `script:${script.id}`,
      kind: "script",
      title: `回想 — ${script.title}`,
      category: "social",
      cost: 0,
      available: true,
    });
  }

  // Ending scripts — gated on chose_court_* + the corresponding pulse
  // threshold. The same enumeration pattern as bond_* / zone_haunt_*;
  // the engine's evaluateCondition does all the gating work.
  for (const script of ctx.game.scripts) {
    if (!script.id.startsWith("ending_")) continue;
    if (ctx.state.baseline.scripts[script.id]?.completed === true) continue;
    const reqs = script.requires;
    const eligible = reqs === undefined || evaluateCondition(reqs, ctx.state).ok;
    if (!eligible) continue;
    activities.push({
      id: `script:${script.id}`,
      kind: "script",
      title: `終局 — ${script.title}`,
      category: "story",
      cost: 0,
      available: true,
    });
  }

  // Sell loot
  const lootIds = Object.entries(ctx.state.baseline.inventory).filter(
    ([id, n]) => n > 0 && isLoot(ctx, id),
  );
  if (lootIds.length > 0) {
    const total = lootIds.reduce((sum, [id, n]) => sum + n * sellValue(ctx, id), 0);
    activities.push({
      id: "sell_all_loot",
      kind: "action",
      actionKind: "sell_all_loot",
      title: `戦利品を炼器師に売る（${total} 両）`,
      description: lootIds.map(([id, n]) => `${itemName(ctx, id)} ×${n}`).join("、"),
      category: "shop",
      cost: 0,
      available: true,
    });
  }

  // Materials are deliberately excluded from the bulk-sale action because
  // they also fuel upgrades and intel.  Still honour their authored
  // sell_value one item at a time, so converting a spare never destroys the
  // player's whole crafting stockpile.
  for (const [id, count] of Object.entries(ctx.state.baseline.inventory)) {
    if (count <= 0 || !isMaterial(ctx, id)) continue;
    const value = sellValue(ctx, id);
    activities.push({
      id: `sell_material:${id}`,
      kind: "action",
      actionKind: "sell_material",
      payload: { itemId: id },
      title: `${itemName(ctx, id)}を一つ売る（${value} 両）`,
      description: `所持 ${count}。炼器師は一度に一つだけ買い取る`,
      category: "shop",
      cost: 0,
      available: true,
    });
  }

  // Upgrade weapon — three pulse-paths. Player picks which side to feed
  // based on resources at hand + intended build.
  const shards = ctx.state.baseline.inventory.soul_shard ?? 0;
  const horns = ctx.state.baseline.inventory.oni_horn ?? 0;
  const frags = ctx.state.baseline.inventory.cursed_blade_fragment ?? 0;
  const ryoNow = ctx.state.baseline.inventory.ryo ?? 0;
  const canMundane = shards >= 3 && ryoNow >= 100;
  activities.push({
    id: "upgrade_mundane",
    kind: "action",
    actionKind: "upgrade_mundane",
    title: "炼器師に整え直させる（威力 +2、脈絡: 凡 +1）",
    description: "魂石碎片 ×3 + 100 両",
    category: "shop",
    cost: 0,
    available: canMundane,
    lockedReason: canMundane
      ? undefined
      : `魂石碎片 ≥3（現在 ${shards}）、両 ≥100（現在 ${ryoNow}）`,
  });
  const canPure = horns >= 1 && ryoNow >= 80;
  activities.push({
    id: "upgrade_pure",
    kind: "action",
    actionKind: "upgrade_pure",
    title: "神社で鎮魂の儀を頼む（威力 +1、脈絡: 浄 +1）",
    description: "鬼の角 ×1 + 80 両。霊体化触発を緩める",
    category: "shop",
    cost: 0,
    available: canPure,
    lockedReason: canPure
      ? undefined
      : `鬼の角 ≥1（現在 ${horns}）、両 ≥80（現在 ${ryoNow}）`,
  });
  const canOni = horns >= 1 && frags >= 1 && ryoNow >= 120;
  activities.push({
    id: "upgrade_oni",
    kind: "action",
    actionKind: "upgrade_oni",
    title: "炉で鬼の脈に鍛える（威力 +4、霊体化 +5、脈絡: 鬼 +1）",
    description: "鬼の角 ×1 + 呪われし刃の欠片 ×1 + 120 両。後戻りはきかぬ",
    category: "shop",
    cost: 0,
    available: canOni,
    lockedReason: canOni
      ? undefined
      : `鬼の角 ≥1（現在 ${horns}）、欠片 ≥1（現在 ${frags}）、両 ≥120（現在 ${ryoNow}）`,
  });

  // Rest (recover HP/mental)
  const hp = playerStat(ctx, "hp");
  const hpMax = playerStatMax(ctx, "hp");
  if (hp < hpMax) {
    activities.push({
      id: "rest",
      kind: "action",
      actionKind: "rest",
      title: "宿で休む（体力・精神を全回復）",
      description: "霊体化は変わらない",
      category: "rest",
      cost: 0,
      available: true,
    });
  }

  // 両国橋の情報屋 — four-tier infoshop actions, each gated on
  // intellect + ryo. Selling intel sets `intel_active` (string var)
  // to a level key, which onScriptSelect later uses to redirect the
  // generic `intel_briefing` script to one of four variants.
  const ryo = ctx.state.baseline.inventory.ryo ?? 0;
  const intellect = playerStat(ctx, "intellect");
  const intelActive =
    typeof ctx.state.baseline.variables.intel_active === "string"
      ? (ctx.state.baseline.variables.intel_active as string)
      : "";
  const infoshopBands: Array<{
    id: string;
    title: string;
    desc: string;
    cost: number;
    intellectMin: number;
    requiresFrag: boolean;
  }> = [
    {
      id: "infoshop_basic",
      title: "情報屋：次回 raid のスポーン覚書（50 両）",
      desc: "次の出帰り先の鬼の出方を知る",
      cost: 50,
      intellectMin: 0,
      requiresFrag: false,
    },
    {
      id: "infoshop_loot",
      title: "情報屋：稀少な収穫地（100 両、学識 30+）",
      desc: "次の出帰り先の最良 loot zone を知る",
      cost: 100,
      intellectMin: 30,
      requiresFrag: false,
    },
    {
      id: "infoshop_yaodao",
      title: "情報屋：妖刀の声に耐える法（200 両、学識 50+）",
      desc: "霊体化触発率を永続 -10%",
      cost: 200,
      intellectMin: 50,
      requiresFrag: false,
    },
    {
      id: "infoshop_hidden",
      title: "情報屋：隠し zone の坐標（300 両、学識 80+、欠片 1）",
      desc: "宝峰山の隠し zone への足跡を知る",
      cost: 300,
      intellectMin: 80,
      requiresFrag: true,
    },
  ];
  // Only show infoshop band when player can afford the cheapest AND
  // hasn't already bought intel that's still unread.
  if (intelActive === "") {
    for (const band of infoshopBands) {
      if (ctx.state.baseline.scripts[`intel_briefing_${band.id.slice("infoshop_".length)}`]?.completed) {
        continue;
      }
      const ok =
        ryo >= band.cost &&
        intellect >= band.intellectMin &&
        (!band.requiresFrag ||
          (ctx.state.baseline.inventory.cursed_blade_fragment ?? 0) >= 1);
      activities.push({
        id: band.id,
        kind: "action",
        actionKind: band.id,
        title: band.title,
        description: band.desc,
        category: "shop",
        cost: 0,
        available: ok,
        lockedReason: ok
          ? undefined
          : `両 ≥${band.cost}、学識 ≥${band.intellectMin}${band.requiresFrag ? "、呪われし刃の欠片 ≥1" : ""} が要る`,
      });
    }
  } else {
    // Pending intel — surface a "read it" script entry. The actual
    // script that runs is decided by onScriptSelect first-wins.
    activities.push({
      id: "script:intel_briefing",
      kind: "script",
      title: "情報屋の覚書を読む",
      category: "story",
      cost: 0,
      available: true,
    });
  }

  // Use chinkonho (skill granted by篝 bond) — drops spectral by 20.
  // Only available in hub (combat is too tense per篝's teaching), and
  // only when player actually has the skill.
  if (ctx.state.baseline.knownSkills.includes("chinkonho")) {
    const spec = playerStat(ctx, "spectral");
    activities.push({
      id: "use_chinkonho",
      kind: "action",
      actionKind: "use_chinkonho",
      title: "鎮魂法を行う（霊体化 -20）",
      description: "篝伝授の口伝。集中して長く息を吐く",
      category: "spirit",
      cost: 0,
      available: spec >= 10,
      lockedReason: spec >= 10 ? undefined : "霊体化が低すぎて鎮める意味がない",
    });
  }

  // 同行者システム — invite a met character with affection >= 4.
  // 澪's official inspection duty is deliberately different: letter 02
  // promises she will accompany the player before intimacy is established,
  // so that authored contract exempts her from the social gate.
  // Only one companion at a time. Flipping a companion_<id> switch
  // is what onChoicePresented / onBeatBefore key on; m.companion is
  // the runtime mirror.
  for (const charId of m.metCharacters) {
    const char = ctx.game.characters.find((c) => c.id === charId);
    if (!char) continue;
    const affection =
      ctx.state.baseline.characters[charId]?.stats.affection ?? 0;
    const officialDuty =
      charId === "mio" &&
      ctx.state.baseline.switches.mio_inspection_duty === true;
    if (affection < 4 && !officialDuty) continue;
    const alreadyInvited = m.companion === charId;
    activities.push({
      id: `invite:${charId}`,
      kind: "action",
      actionKind: "invite",
      payload: { characterId: charId },
      title: alreadyInvited
        ? `${char.name}を同行から外す`
        : `${char.name}を次の出帰りに誘う`,
      description: alreadyInvited
        ? "同行を解く（次の出立では一人）"
        : officialDuty
          ? "公儀の見立てが済むまで同行可。他者を誘うと自動的に交代"
          : "親密度 4 以上で同行可。他者を誘うと自動的に交代",
      category: "social",
      cost: 0,
      available: true,
    });
  }

  // Depart on raid — one entry per unlocked chain, sorted by difficulty.
  // The silent court directive is a route commitment, not merely flavour:
  // the blade has been surrendered and raids are no longer a legal action.
  // Keep the entries visible-but-locked so GUI players can see why, while
  // Headless players receive the same available=false contract.
  const retiredFromRaids =
    ctx.state.baseline.switches.chose_court_silent === true;
  for (const { chain, entry } of discoverableChains(ctx)) {
    const hpFull = hp >= hpMax;
    const label = chainDisplayName(chain) ?? entry.name;
    activities.push({
      id: `depart:${chain}`,
      kind: "action",
      actionKind: "depart",
      payload: { chain, mapId: entry.id },
      title: `出立 — ${label}（難度 ${entry.difficulty ?? 1}）`,
      description: entry.description,
      category: "raid",
      cost: 0,
      available: !retiredFromRaids && hpFull,
      lockedReason: retiredFromRaids
        ? "刀を祠へ納めると決めた。もう出帰りには戻らない。"
        : hpFull
          ? undefined
          : "体力が満たぬ。先に休め。",
    });
  }

  return buildSnapshot(activities, ctx);
}

function buildRaidMenu(ctx: Ctx): Output {
  const m = moduleState(ctx);
  if (!m.raid) return buildHubMenu(ctx);

  const map = currentMap(ctx);
  if (!map) throw new Error(`${MODULE_ID}: currentMapId missing during raid`);
  const inst = currentMapInstance(ctx);
  if (!inst) throw new Error(`${MODULE_ID}: map instance missing for ${map.id}`);

  const activities: HubActivity[] = [];

  // 妖刀の業 — pulsePending takes over the menu after a victory.
  // Three exclusive imbue choices; each clears pulsePending.
  if (m.pulsePending) {
    const absorb = m.pulsePending.absorb;
    activities.push({
      id: "imbue:pure",
      kind: "action",
      actionKind: "imbue_pure",
      title: `浄の脈に流す（威力 +1、霊体化触発率 −0.2%）`,
      description: `「鎮魂」の脈絡。次の戦闘で霊体化暴走が起きにくくなる`,
      category: "spirit",
      cost: 0,
      available: true,
      forecast: {
        summary: "鎮魂寄り。刀を少し強め、現在の霊体化を鎮める",
        metrics: [
          {
            id: "weapon_power_delta",
            label: "妖刀威力",
            value: 1,
            polarity: "benefit",
          },
          {
            id: "spectral_delta",
            label: "霊体化",
            value: -1,
            polarity: "benefit",
          },
          {
            id: "pulse_pure_delta",
            label: "脈絡: 浄",
            value: 1,
            polarity: "benefit",
          },
        ],
      },
    });
    activities.push({
      id: "imbue:oni",
      kind: "action",
      actionKind: "imbue_oni",
      title: `鬼の脈に流す（威力 +${Math.max(3, Math.floor(absorb / 2))}、霊体化 +3）`,
      description: `「喰らう」の脈絡。刀が跳ね上がる代償に、お主の身体も鬼に近づく`,
      category: "spirit",
      cost: 0,
      available: true,
      forecast: {
        summary: "最大火力。刀と引き換えに身体を鬼へ近づける",
        metrics: [
          {
            id: "weapon_power_delta",
            label: "妖刀威力",
            value: Math.max(3, Math.floor(absorb / 2)),
            polarity: "benefit",
          },
          {
            id: "spectral_delta",
            label: "霊体化",
            value: 3,
            polarity: "risk",
          },
          {
            id: "pulse_oni_delta",
            label: "脈絡: 鬼",
            value: 1,
            polarity: "risk",
          },
        ],
      },
    });
    activities.push({
      id: "imbue:mundane",
      kind: "action",
      actionKind: "imbue_mundane",
      title: `凡の脈に流す（威力 +2、副作用なし）`,
      description: `「整える」の脈絡。穏当に育てる道`,
      category: "spirit",
      cost: 0,
      available: true,
      forecast: {
        summary: "副作用なし。中程度の威力を得る",
        metrics: [
          {
            id: "weapon_power_delta",
            label: "妖刀威力",
            value: 2,
            polarity: "benefit",
          },
          {
            id: "spectral_delta",
            label: "霊体化",
            value: 0,
            polarity: "neutral",
          },
          {
            id: "pulse_mundane_delta",
            label: "脈絡: 凡",
            value: 1,
            polarity: "neutral",
          },
        ],
      },
    });
    return buildSnapshot(activities, ctx);
  }

  if (inst.encounter) {
    const normalDamage = normalAttackDamageRange(ctx);
    const criticalDamage = criticalAttackDamageRange(ctx);
    const sneakDamage = sneakAttackDamageRange(ctx);
    const counterDamage = counterAttackDamageForecast(
      ctx,
      inst.encounter.enemyId,
    );
    const criticalChance = roundForecastPercent(playerStat(ctx, "spectral") * 0.7);
    const fumbleChance = fumbleChancePercent(ctx);
    const sneakChance = sneakStrikeChancePercent(ctx, inst.encounter.enemyId);
    const fleeChance = fleeSuccessChancePercent(ctx);
    const fleeFailureDamage = Math.max(
      2,
      enemyAttackPower(ctx, inst.encounter.enemyId) + 1,
    );
    activities.push({
      id: "attack",
      kind: "action",
      actionKind: "attack",
      title: `斬る — ${enemyName(ctx, inst.encounter.enemyId)}（HP ${inst.encounter.enemyHp}/${inst.encounter.enemyHpMax}）`,
      description: "妖刀威力 × (1 + 霊体化×0.04) × ばらつき",
      category: "combat",
      cost: 0,
      available: true,
      forecast: {
        summary: counterDamage.companion
          ? "敵が生き残れば反撃。同行者が一部を引き受ける"
          : "敵が生き残れば反撃を受ける",
        metrics: [
          {
            id: "damage",
            label: "ダメージ",
            ...normalDamage,
            unit: "HP",
            polarity: "benefit",
          },
          {
            id: "critical_chance",
            label: "会心率",
            value: criticalChance,
            unit: "percent",
            polarity: "benefit",
          },
          {
            id: "critical_damage",
            label: "会心ダメージ",
            ...criticalDamage,
            unit: "HP",
            polarity: "benefit",
          },
          {
            id: "counter_damage",
            label: "生存時反撃（合計）",
            ...counterDamage.total,
            unit: "HP",
            polarity: "risk",
          },
          {
            id: "fumble_chance",
            label: "妖刀暴発率（反撃 1.6 倍）",
            value: fumbleChance,
            unit: "percent",
            polarity: "risk",
          },
          ...(counterDamage.companion
            ? [
                {
                  id: "player_counter_damage",
                  label: "プレイヤー承傷",
                  ...counterDamage.player,
                  unit: "HP",
                  polarity: "risk" as const,
                },
                {
                  id: "companion_counter_damage",
                  label: `${counterDamage.companionName}承傷`,
                  ...counterDamage.companion,
                  unit: "HP",
                  polarity: "risk" as const,
                },
              ]
            : []),
        ],
      },
    });
    activities.push({
      id: "sneak_strike",
      kind: "action",
      actionKind: "sneak_strike",
      title: "不意打ちを狙う",
      description: "学識+霊体化と敵の狡知で判定。成功で大ダメージ、失敗で外す",
      category: "combat",
      cost: 0,
      available: true,
      forecast: {
        summary: counterDamage.companion
          ? "失敗時は反撃。同行者が一部を引き受ける"
          : "失敗時はダメージを与えず反撃を受ける",
        metrics: [
          {
            id: "success_chance",
            label: "成功率",
            value: sneakChance,
            unit: "percent",
            polarity: "benefit",
          },
          {
            id: "success_damage",
            label: "成功時ダメージ",
            ...sneakDamage,
            unit: "HP",
            polarity: "benefit",
          },
          {
            id: "failure_counter_damage",
            label: "失敗時反撃（合計）",
            ...counterDamage.total,
            unit: "HP",
            polarity: "risk",
          },
          {
            id: "fumble_chance",
            label: "妖刀暴発率（反撃 1.6 倍）",
            value: fumbleChance,
            unit: "percent",
            polarity: "risk",
          },
          ...(counterDamage.companion
            ? [
                {
                  id: "player_counter_damage",
                  label: "プレイヤー承傷",
                  ...counterDamage.player,
                  unit: "HP",
                  polarity: "risk" as const,
                },
                {
                  id: "companion_counter_damage",
                  label: `${counterDamage.companionName}承傷`,
                  ...counterDamage.companion,
                  unit: "HP",
                  polarity: "risk" as const,
                },
              ]
            : []),
        ],
      },
    });
    if (!inst.encounter.negotiable && !negotiationWindowConsumed(inst.encounter)) {
      const negotiationHp = Math.max(
        1,
        Math.ceil(inst.encounter.enemyHpMax * 0.3) - 1,
      );
      activities.push({
        id: "suppress_strike",
        kind: "action",
        actionKind: "suppress_strike",
        title: "峰を返して押さえ込む",
        description: "交渉できる体力まで留める。威力に関係なく敵の反撃を受ける",
        category: "combat",
        cost: 0,
        available: true,
        forecast: {
          summary: "非致死。敵を交渉可能にする代わり、必ず反撃を受ける",
          metrics: [
            {
              id: "damage",
              label: "抑制ダメージ",
              value: Math.max(0, inst.encounter.enemyHp - negotiationHp),
              unit: "HP",
              polarity: "benefit",
            },
            {
              id: "remaining_enemy_hp",
              label: "敵残存体力",
              value: negotiationHp,
              unit: "HP",
              polarity: "neutral",
            },
            {
              id: "counter_damage",
              label: "確定反撃（合計）",
              ...counterDamage.total,
              unit: "HP",
              polarity: "risk",
            },
            {
              id: "fumble_chance",
              label: "妖刀暴発率（反撃 1.6 倍）",
              value: fumbleChance,
              unit: "percent",
              polarity: "risk",
            },
          ],
        },
      });
    }
    activities.push({
      id: "flee",
      kind: "action",
      actionKind: "flee",
      title: "逃げる",
      description: "霊体化判定。失敗で一発被弾",
      category: "combat",
      cost: 0,
      available: true,
      forecast: {
        summary: "成功時は戦闘を離脱する",
        metrics: [
          {
            id: "success_chance",
            label: "成功率",
            value: fleeChance,
            unit: "percent",
            polarity: "benefit",
          },
          {
            id: "failure_damage",
            label: "失敗時ダメージ",
            value: fleeFailureDamage,
            unit: "HP",
            polarity: "risk",
          },
        ],
      },
    });
    if (inst.encounter.negotiable) {
      const cunning = enemyCunning(ctx, inst.encounter.enemyId);
      activities.push({
        id: "negotiate_listen",
        kind: "action",
        actionKind: "negotiate_listen",
        title: `聞き出す — ${enemyName(ctx, inst.encounter.enemyId)}`,
        description: `成功率 ${negotiateDropChance(cunning)}%（cunning ${cunning}）。失敗でも斬り直せる`,
        category: "combat",
        cost: 0,
        available: true,
      });
      activities.push({
        id: "negotiate_release",
        kind: "action",
        actionKind: "negotiate_release",
        title: `逃がす — ${enemyName(ctx, inst.encounter.enemyId)}`,
        description: "霊体化 -2、戦利品なし。撤退して大名府へ戻ると、その鬼種の回想が現れる",
        category: "combat",
        cost: 0,
        available: true,
      });
      const spec = playerStat(ctx, "spectral");
      const voiceAvailable = spec >= 50;
      activities.push({
        id: "yaodao_voice",
        kind: "action",
        actionKind: "yaodao_voice",
        title: voiceAvailable
          ? "妖刀の声に従う — 必殺の一閃（霊体化 +5、脈絡: 鬼 +1）"
          : "妖刀の声（霊体化が低くて聞こえない）",
        description: "4 倍の威力で必ず止め。脈絡選択は強制「鬼」",
        category: "combat",
        cost: 0,
        available: voiceAvailable,
        lockedReason: voiceAvailable
          ? undefined
          : `霊体化 ≥ 50 が要る（現在 ${spec}）`,
      });
    }
  } else {
    if (!inst.searched && Object.keys(inst.pendingLoot).length > 0) {
      activities.push({
        id: "search",
        kind: "action",
        actionKind: "search",
        title: "この区域を探る",
        category: "raid",
        cost: 0,
        available: true,
        recommended: true,
      });
    }
    if (map.isExtract) {
      activities.push({
        id: "extract",
        kind: "action",
        actionKind: "extract",
        title: `${map.name} から撤退して大名府に戻る`,
        description: "戦利品を蔵に納める",
        category: "raid",
        cost: 0,
        available: true,
      });
    }
    for (const conn of map.connections ?? []) {
      const targetMap = getMap(ctx, conn.target);
      const targetInst = m.raid.visited[conn.target];
      const visitedNote = targetInst?.visited ? "（既訪）" : "";
      const extractNote = targetMap?.isExtract ? "（撤退可）" : "";
      const direction = /[るうくぐすつぬぶむ]$/.test(conn.dir)
        ? conn.dir
        : `${conn.dir}へ進む`;
      activities.push({
        id: `move:${conn.target}`,
        kind: "action",
        actionKind: "move",
        payload: { mapId: conn.target },
        title: `${direction} — ${targetMap?.name ?? conn.target}${visitedNote}${extractNote}`,
        category: "raid",
        cost: 0,
        available: true,
      });
    }
  }

  return buildSnapshot(activities, ctx);
}

// ============================================================================
// Helpers
// ============================================================================

// "Loot" = any item whose .md frontmatter carries a numeric `sell_value`
// AND is not flagged `material: true`. Materials (oni_horn, soul_shard,
// cursed_blade_fragment) still have sell_value so they can be sold
// individually if a future action exposes them, but `sell_all_loot`
// skips them so a player who hits "sell" doesn't vend their upgrade
// stockpile.
function isLoot(ctx: Ctx, itemId: string): boolean {
  const item = ctx.game.items?.find((i) => i.id === itemId);
  if (item?.custom?.material === true) return false;
  return typeof sellValueOf(ctx, itemId) === "number";
}

function isMaterial(ctx: Ctx, itemId: string): boolean {
  const item = ctx.game.items?.find((i) => i.id === itemId);
  return item?.custom?.material === true && typeof sellValueOf(ctx, itemId) === "number";
}

function sellValue(ctx: Ctx, itemId: string): number {
  return sellValueOf(ctx, itemId) ?? 0;
}

function sellValueOf(ctx: Ctx, itemId: string): number | undefined {
  const item = ctx.game.items?.find((i) => i.id === itemId);
  const v = item?.custom?.sell_value;
  return typeof v === "number" ? v : undefined;
}

function itemName(ctx: Ctx, itemId: string): string {
  return ctx.game.items?.find((i) => i.id === itemId)?.name ?? itemId;
}

function enemyName(ctx: Ctx, enemyId: string): string {
  return ctx.game.enemies?.find((e) => e.id === enemyId)?.name ?? enemyId;
}

function enemyAttackPower(ctx: Ctx, enemyId: string): number {
  const e = ctx.game.enemies?.find((x) => x.id === enemyId);
  if (!e) return 1;
  const raw = e.custom?.attack_power;
  return typeof raw === "number" ? raw : 1;
}

function enemyHp(ctx: Ctx, enemyId: string): number {
  return ctx.game.enemies?.find((e) => e.id === enemyId)?.hp ?? 1;
}

// 鬼の交渉 — uses enemy.stats.cunning to modulate listen success.
function enemyCunning(ctx: Ctx, enemyId: string): number {
  const e = ctx.game.enemies?.find((x) => x.id === enemyId);
  return e?.stats?.cunning ?? 1;
}

function enemyNegotiateLore(ctx: Ctx, enemyId: string): string | undefined {
  const v = ctx.game.enemies?.find((x) => x.id === enemyId)?.custom?.negotiate_lore;
  return typeof v === "string" ? v : undefined;
}

function enemyNegotiateDrop(ctx: Ctx, enemyId: string): string | undefined {
  const v = ctx.game.enemies?.find((x) => x.id === enemyId)?.custom?.negotiate_drop;
  return typeof v === "string" ? v : undefined;
}

// Listen success chance: 60 - cunning*10, floored at 10%.
function negotiateDropChance(cunning: number): number {
  return Math.max(10, 60 - cunning * 10);
}

function getEnemyNarration(
  ctx: Ctx,
  enemyId: string,
  key: "intro" | "victory" | "escape",
): string | undefined {
  const e = ctx.game.enemies?.find((x) => x.id === enemyId);
  return e?.narrations?.[key];
}

function fillTemplate(tmpl: string, vars: Record<string, string | number>): string {
  let out = tmpl;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

function getSwordPower(ctx: Ctx): number {
  const id = ctx.state.baseline.equippedWeaponId;
  if (!id) return 1;
  return ctx.state.baseline.weapons[id]?.power ?? 1;
}

interface NumericRange {
  min: number;
  max: number;
}

function combatDamageBase(ctx: Ctx): number {
  return getSwordPower(ctx) * (1 + playerStat(ctx, "spectral") * 0.04);
}

function boundedFloorRange(
  base: number,
  lowerMultiplier: number,
  upperExclusiveMultiplier: number,
): NumericRange {
  return {
    min: Math.floor(base * lowerMultiplier),
    max: Math.max(
      Math.floor(base * lowerMultiplier),
      Math.ceil(base * upperExclusiveMultiplier) - 1,
    ),
  };
}

function normalAttackDamageRange(ctx: Ctx): NumericRange {
  return boundedFloorRange(combatDamageBase(ctx), 0.8, 1.2);
}

function criticalAttackDamageRange(ctx: Ctx): NumericRange {
  return boundedFloorRange(combatDamageBase(ctx) * 2, 0.8, 1.2);
}

function sneakAttackDamageRange(ctx: Ctx): NumericRange {
  return boundedFloorRange(combatDamageBase(ctx) * 2.2, 0.9, 1.1);
}

function sneakStrikeChancePercent(ctx: Ctx, enemyId: string): number {
  return Math.max(
    5,
    Math.min(
      95,
      roundForecastPercent(
        10 +
          playerStat(ctx, "intellect") * 2 +
          playerStat(ctx, "spectral") * 0.5 -
          enemyCunning(ctx, enemyId) * 8,
      ),
    ),
  );
}

function fleeSuccessChancePercent(ctx: Ctx): number {
  const m = moduleState(ctx);
  if (
    ctx.state.baseline.knownSkills.includes("hayagake") ||
    m.companion === "kasumi"
  ) {
    return 100;
  }
  return Math.max(0, Math.min(100, 80 - playerStat(ctx, "spectral")));
}

function counterAttackDamageRange(ctx: Ctx, enemyId: string): NumericRange {
  const power = enemyAttackPower(ctx, enemyId);
  const ordinary = boundedFloorRange(power, 0.8, 1.2);
  const spectral = playerStat(ctx, "spectral");
  return {
    min: Math.max(1, ordinary.min),
    max: Math.max(
      1,
      fumbleChancePercent(ctx) > 0
        ? Math.floor(Math.max(1, ordinary.max) * 1.6)
        : ordinary.max,
    ),
  };
}

function fumbleChancePercent(ctx: Ctx): number {
  const learnedReduction = ctx.state.baseline.scripts.intel_briefing_yaodao
    ?.completed
    ? 10
    : 0;
  return Math.max(
    0,
    roundForecastPercent(playerStat(ctx, "spectral") * 0.5 - learnedReduction),
  );
}

function counterAttackDamageForecast(ctx: Ctx, enemyId: string): {
  total: NumericRange;
  player: NumericRange;
  companion?: NumericRange;
  companionName?: string;
} {
  const total = counterAttackDamageRange(ctx, enemyId);
  const m = moduleState(ctx);
  if (!m.companion || m.companionHp <= 0 || !m.raid) {
    return { total, player: total };
  }
  const split = (raw: number) => {
    const companion = Math.min(m.companionHp, Math.ceil(raw / 2));
    return { player: raw - companion, companion };
  };
  const atMin = split(total.min);
  const atMax = split(total.max);
  return {
    total,
    player: { min: atMin.player, max: atMax.player },
    companion: { min: atMin.companion, max: atMax.companion },
    companionName:
      ctx.game.characters.find((character) => character.id === m.companion)
        ?.name ?? m.companion,
  };
}

function roundForecastPercent(value: number): number {
  return Math.round(value * 10) / 10;
}

// ============================================================================
// Dispatcher guards (issues #10 + #11)
// ============================================================================
// Returns a denial message if the current zone has an active encounter,
// or null when it's safe to do non-combat actions. Centralized so all
// three callers (move/search/extract) use the same invariant.
function combatBlock(ctx: Ctx): string | null {
  if (!inRaid(ctx)) return null;
  const inst = currentMapInstance(ctx);
  if (inst?.encounter) {
    return `${enemyName(ctx, inst.encounter.enemyId)}に背を向けるわけにはいかぬ。斬るか、抜けるかだ。`;
  }
  return null;
}

// ============================================================================
// Raid lifecycle
// ============================================================================

// Begin a raid on a chain. Enters the chain's entry map (engine
// updates currentMapId + bg via enterMap), initializes RaidInstance,
// rolls the entry map's loot (encounter table on entry maps is always
// trivial — null-only — so no encounter to roll).
function startRaid(ctx: Ctx, chain: string, entryId: string): void {
  const entry = getMap(ctx, entryId);
  if (!entry || entry.chain !== chain || entry.isEntry !== true) {
    throw new Error(`${MODULE_ID}: chain ${chain} entry "${entryId}" invalid`);
  }
  const m = moduleState(ctx);

  enterMap(ctx.state, ctx.game, entryId);
  m.raid = {
    chain,
    entryMapId: entryId,
    visited: {},
    pendingLoot: {},
    turnsTaken: 0,
  };
  // Mark the entry map visited + roll its loot. Encounter stays null
  // (entry maps' encounter tables are null-only by convention).
  const spawnInst = ensureMapInstance(ctx, entryId);
  spawnInst.visited = true;
  spawnInst.pendingLoot = rollLoot(ctx, entry);

  const flavor =
    typeof entry.custom?.entry_narration === "string"
      ? (entry.custom.entry_narration as string)
      : "霧が脛に絡みつく。";
  // Chain display name: take any chain map's "name" as a label — they
  // all share the same chain identity, but the entry map's name is the
  // most evocative ("沼の縁" works for narration as well as "黒沼地" did
  // pre-migration). Fall back to chain id when truly degenerate.
  const chainLabel = chainDisplayName(chain) ?? entry.name;
  ctx.state.runtime.pendingNarrations.push(
    `${chainLabel}に踏み入る。${flavor}`,
  );
}

// Human-facing label for a chain. We don't have an explicit "chain
// name" field on MapDef (chain is just a grouping id); instead, every
// chain has a canonical display name kept here. Module-side because
// it's purely a presentation concern.
function chainDisplayName(chain: string): string | undefined {
  return {
    kuro_swamp: "黒沼地",
    mt_houkyou: "砲響山",
    sumida_river: "隅田河",
    hell_gate: "地獄門",
  }[chain];
}

function rollEncounter(
  ctx: Ctx,
  map: MapDef,
): null | { enemyId: string; enemyHp: number; enemyHpMax: number } {
  const table = map.encounterTable ?? [];
  if (table.length === 0) return null;
  const pick = pickWeighted(ctx.rng, table);
  if (pick.enemyId === null) return null;
  const hp = enemyHp(ctx, pick.enemyId);
  return { enemyId: pick.enemyId, enemyHp: hp, enemyHpMax: hp };
}

// Roll the current map's character spawns. Skips characters the player
// has already met (one-shot encounters by convention).
function rollCharacterSpawn(
  ctx: Ctx,
  map: MapDef,
): CharacterSpawnRule | null {
  if (!map.characterSpawns) return null;
  const m = moduleState(ctx);
  for (const rule of map.characterSpawns) {
    if (m.metCharacters.includes(rule.characterId)) continue;
    if (ctx.rng() <= rule.chance) return rule;
  }
  return null;
}

function rollLoot(ctx: Ctx, map: MapDef): Record<string, number> {
  const table = map.lootTable ?? [];
  if (table.length === 0) return {};
  const pick = pickWeighted(ctx.rng, table);
  if (pick.itemId === null) return {};
  const count = rollIntInclusive(ctx.rng, pick.min, pick.max);
  return { [pick.itemId]: count };
}

// Clear companion state on raid end. Switches stay set (player kept
// the bond between raids); only the runtime "in party right now" flag
// resets so the player has to re-invite each raid (otherwise the
// system feels less like a deliberate decision).
function clearCompanionAfterRaid(ctx: Ctx): void {
  const m = moduleState(ctx);
  if (!m.companion) return;
  ctx.state.baseline.switches[`companion_${m.companion}`] = false;
  m.companion = null;
  m.companionHp = 0;
}

function endRaidExtract(ctx: Ctx): void {
  const m = moduleState(ctx);
  if (!m.raid) return;
  // Transfer pendingLoot to baseline.inventory.
  const lootSummary: string[] = [];
  for (const [itemId, count] of Object.entries(m.raid.pendingLoot)) {
    if (count <= 0) continue;
    ctx.state.baseline.inventory[itemId] =
      (ctx.state.baseline.inventory[itemId] ?? 0) + count;
    lootSummary.push(`${itemName(ctx, itemId)} ×${count}`);
  }
  const chainLabel = chainDisplayName(m.raid.chain) ?? m.raid.chain;

  // If companion survived the raid (HP > 0), mark the persistent
  // "befriended" switch and grant +1 affection. This is the loop:
  // invite → survive together → unlock deeper bond scenes.
  if (m.companion && m.companionHp > 0) {
    const companionId = m.companion;
    ctx.state.baseline.switches[`befriended_${companionId}`] = true;
    const c = ctx.state.baseline.characters[companionId];
    if (c) c.stats.affection = (c.stats.affection ?? 0) + 1;
    const charName =
      ctx.game.characters.find((x) => x.id === companionId)?.name ?? companionId;
    ctx.state.runtime.pendingNarrations.push(
      `${charName}は無事に大名府まで歩いた。一度共に出帰った仲——刀を握る手の重さが、少し変わる。親密度 +1。`,
    );
  }

  m.raid = null;
  enterMap(ctx.state, ctx.game, "edo_castle");
  setVar(ctx, "raidsCompleted", getVar(ctx, "raidsCompleted") + 1);
  clearCompanionAfterRaid(ctx);

  ctx.state.runtime.pendingNarrations.push(
    `${chainLabel}から撤退に成功。${lootSummary.length > 0 ? "持ち帰った戦利品：" + lootSummary.join("、") + "。" : "今回は手ぶら。"}`,
  );

  // 脈絡の話 — defer pulse_intro to the back-in-hub transition rather
  // than firing it mid-raid via a trigger on pulse_<x> rising edge.
  // The intro's prose ("屋敷の縁側で…") assumes hub setting; firing
  // it inside startRaid-zone breaks immersion.
  if (
    ctx.state.baseline.switches.pulse_intro_seen !== true &&
    ((ctx.state.baseline.variables.pulse_pure ?? 0) as number) +
      ((ctx.state.baseline.variables.pulse_oni ?? 0) as number) +
      ((ctx.state.baseline.variables.pulse_mundane ?? 0) as number) >
      0 &&
    ctx.state.baseline.currentScriptId === null &&
    ctx.game.scripts.some((s) => s.id === "pulse_intro")
  ) {
    ctx.state.baseline.currentScriptId = "pulse_intro";
    ctx.state.baseline.beatIndex = 0;
  }
}

function endRaidFailure(ctx: Ctx, reason: string): void {
  const m = moduleState(ctx);
  if (!m.raid) return;
  const chainLabel = chainDisplayName(m.raid.chain) ?? m.raid.chain;
  m.raid = null;
  enterMap(ctx.state, ctx.game, "edo_castle");
  setVar(ctx, "raidsFailed", getVar(ctx, "raidsFailed") + 1);
  clearCompanionAfterRaid(ctx);
  // Reset HP/mental/spectral to defaults (death/overload triggered).
  // hp = 1 so player has to rest; mental partial; spectral cut.
  setPlayerStat(ctx, "hp", 1);
  setPlayerStat(ctx, "mental", Math.max(1, Math.floor(playerStatMax(ctx, "mental") / 2)));
  setPlayerStat(ctx, "spectral", Math.max(5, Math.floor(playerStat(ctx, "spectral") / 2)));
  ctx.state.runtime.pendingNarrations.push(
    `${chainLabel}での討伐は失敗——${reason}。戦利品は全て失われた。気がついたら大名府の御殿医の枕元。`,
  );
}

// Companion damage redirect — called from the enemy counter-attack
// in doAttackRound. If a companion is in party, the companion absorbs
// part of the damage (offers tactical value at risk of downing them).
//
// Returns the residual damage that should still hit the player.
function tryCompanionAbsorb(ctx: Ctx, raw: number): number {
  const m = moduleState(ctx);
  if (!m.companion || m.companionHp <= 0 || !m.raid) return raw;
  const absorbed = Math.min(m.companionHp, Math.ceil(raw / 2));
  m.companionHp -= absorbed;
  const charName =
    ctx.game.characters.find((c) => c.id === m.companion!)?.name ?? m.companion!;
  ctx.state.runtime.pendingNarrations.push(
    `${charName}が割って入った——${absorbed} のダメージを彼女が引き受けた。残り HP ${m.companionHp}/10。`,
  );

  // Downed?
  if (m.companionHp <= 0) {
    const downedName = charName;
    const charId = m.companion;
    m.companion = null;
    m.companionHp = 0;
    ctx.state.baseline.switches[`companion_${charId}`] = false;
    ctx.state.baseline.variables.companion_downed =
      (typeof ctx.state.baseline.variables.companion_downed === "number"
        ? ctx.state.baseline.variables.companion_downed
        : 0) + 1;
    // -3 affection. Engine clamps to character's min if declared.
    const c = ctx.state.baseline.characters[charId!];
    if (c) c.stats.affection = Math.max(0, (c.stats.affection ?? 0) - 3);
    ctx.state.runtime.pendingNarrations.push(
      `${downedName}は倒れた。意識はある——だが、もう刀は握れぬ。お主の中で何かが折れた。親密度 -3。`,
    );
  }
  return raw - absorbed;
}

// ============================================================================
// Combat
// ============================================================================

function doAttackRound(ctx: Ctx, kind: "normal" | "sneak" | "suppress"): void {
  const m = moduleState(ctx);
  if (!m.raid) return;
  const zone = currentMapInstance(ctx)!;
  if (!zone.encounter) return;
  const negotiationAlreadyConsumed = negotiationWindowConsumed(zone.encounter);
  if (negotiationAlreadyConsumed) zone.encounter.negotiationConsumed = true;

  const spec = playerStat(ctx, "spectral");

  // Player strikes first.
  let damage: number;
  let hitLine: string;
  if (kind === "suppress") {
    const negotiationHp = Math.max(
      1,
      Math.ceil(zone.encounter.enemyHpMax * 0.3) - 1,
    );
    damage = Math.max(0, zone.encounter.enemyHp - negotiationHp);
    hitLine = `刃を返し、殺し切る力だけを逃がす——${damage} のダメージ。`;
  } else if (kind === "sneak") {
    // Opposed skill check: knowledge and spectral sensitivity against enemy cunning.
    const dc = sneakStrikeChancePercent(ctx, zone.encounter.enemyId);
    const roll = ctx.rng() * 100;
    if (roll < dc) {
      damage = Math.floor(combatDamageBase(ctx) * 2.2 * (0.9 + ctx.rng() * 0.2));
      hitLine = `不意打ちが入った。柄を掴み直す間もなく一刀で割く——${damage} のダメージ。`;
    } else {
      damage = 0;
      hitLine = `間合いを誤った——一閃外す。`;
    }
  } else {
    const variance = 0.8 + ctx.rng() * 0.4;
    const critRoll = ctx.rng() * 100;
    const isCrit = critRoll < spec * 0.7;
    damage = Math.floor(combatDamageBase(ctx) * variance * (isCrit ? 2 : 1));
    hitLine = isCrit
      ? `妖刀が震えた。倍の威力で斬り抜く——${damage} のダメージ。`
      : `刀を振るう。${damage} のダメージ。`;
  }

  ctx.state.runtime.pendingNarrations.push(hitLine);
  zone.encounter.enemyHp -= damage;

  // Spectral creep from striking
  setPlayerStat(ctx, "spectral", Math.min(100, spec + 1));

  // 鬼の交渉: when an enemy drops below 30% HP, the next raid menu
  // gains 3 conditional activities (listen / release / yaodao-voice).
  // This flag lives on the encounter object so it auto-clears when
  // the encounter resolves (victory / flee / release).
  if (
    zone.encounter.enemyHp > 0 &&
    zone.encounter.enemyHp < zone.encounter.enemyHpMax * 0.3 &&
    !negotiationAlreadyConsumed
  ) {
    zone.encounter.negotiable = true;
    ctx.state.runtime.pendingNarrations.push(
      `${enemyName(ctx, zone.encounter.enemyId)}の構えが崩れた——息は荒く、まだ斬れる。だが、聞き出すことも、放すこともできる。`,
    );
  }

  if (zone.encounter.enemyHp <= 0) {
    // Victory — spectral drops by absorb, but weapon power gain is
    // DEFERRED. The module queues pulsePending; next buildRaidMenu
    // shows only three imbue activities (浄/鬼/凡), and the chosen
    // one applies its specific power formula + counter increment.
    // This forces a build-path decision on every kill.
    const enemyId = zone.encounter.enemyId;
    const hpMax = zone.encounter.enemyHpMax;
    const absorb = Math.floor(hpMax / 2);
    const spectralBeforeAbsorb = playerStat(ctx, "spectral");
    const spectralAfterAbsorb = Math.max(0, spectralBeforeAbsorb - absorb);
    const absorbedSpectral = spectralBeforeAbsorb - spectralAfterAbsorb;
    const tmpl = getEnemyNarration(ctx, enemyId, "victory");
    if (tmpl) {
      ctx.state.runtime.pendingNarrations.push(
        fillTemplate(tmpl, {
          name: enemyName(ctx, enemyId),
          hp: hpMax,
          absorb: absorbedSpectral,
          spectralBefore: spectralBeforeAbsorb,
          spectralAfter: spectralAfterAbsorb,
          swordGain: 0, // placeholder; actual gain decided by imbue choice
          damage,
        }),
      );
    }
    setPlayerStat(ctx, "spectral", spectralAfterAbsorb);
    zone.encounter = null;
    zone.encounterCleared = true;
    // Queue the imbue choice. yaodao_voice already handled this
    // inline (forced oni path); normal victories go through the menu.
    moduleState(ctx).pulsePending = { enemyId, absorb };
    ctx.state.runtime.pendingNarrations.push(
      `刀が震えている——${enemyName(ctx, enemyId)}の妖力を、どの脈に流すか。`,
    );
    return;
  }

  // Enemy counter-attacks
  const enemyPow = enemyAttackPower(ctx, zone.encounter.enemyId);
  const enemyHit = Math.max(
    1,
    Math.floor(enemyPow * (0.8 + ctx.rng() * 0.4)),
  );
  const fumbleRoll = ctx.rng() * 100;
  const isFumble = fumbleRoll < fumbleChancePercent(ctx);
  // High spectral makes the player less coordinated defending.

  const finalEnemyDamage = isFumble ? Math.floor(enemyHit * 1.6) : enemyHit;
  // 同行者が割って入るかチェック。Companion soaks half (rounded up),
  // remainder hits player. Companion HP=0 → downed (handled inside).
  const residual = tryCompanionAbsorb(ctx, finalEnemyDamage);
  setPlayerStat(ctx, "hp", playerStat(ctx, "hp") - residual);
  ctx.state.runtime.pendingNarrations.push(
    isFumble
      ? `${enemyName(ctx, zone.encounter.enemyId)}の反撃。霊体化が暴れて体が思うように動かず——${residual} のダメージ。`
      : `${enemyName(ctx, zone.encounter.enemyId)}の反撃。${residual} のダメージ。`,
  );
  setPlayerStat(ctx, "mental", Math.max(0, playerStat(ctx, "mental") - 1));
}

function doFlee(ctx: Ctx): void {
  const m = moduleState(ctx);
  if (!m.raid) return;
  const zone = currentMapInstance(ctx)!;
  if (!zone.encounter) return;
  const enemyId = zone.encounter.enemyId;

  const m2 = moduleState(ctx);

  // Hayagake (taught by 霞) OR 霞 currently in party — flee always
  // succeeds with no damage/no mental cost.
  if (
    ctx.state.baseline.knownSkills.includes("hayagake") ||
    m2.companion === "kasumi"
  ) {
    const reason = m2.companion === "kasumi" ? "霞の手が手首を取った" : "霞に教わった足運び";
    ctx.state.runtime.pendingNarrations.push(
      `${reason}——${enemyName(ctx, enemyId)}が振り向く半秒前に、お主はもう間合いの外。`,
    );
    zone.encounter = null;
    zone.encounterCleared = true;
    return;
  }

  const successChance = fleeSuccessChancePercent(ctx);
  const roll = ctx.rng() * 100;
  if (roll > 100 - successChance) {
    ctx.state.runtime.pendingNarrations.push(
      `${enemyName(ctx, enemyId)}の隙を縫って退いた。`,
    );
    zone.encounter = null;
    zone.encounterCleared = true;
    setPlayerStat(ctx, "mental", Math.max(0, playerStat(ctx, "mental") - 1));
  } else {
    const dmg = Math.max(2, enemyAttackPower(ctx, enemyId) + 1);
    setPlayerStat(ctx, "hp", playerStat(ctx, "hp") - dmg);
    ctx.state.runtime.pendingNarrations.push(
      `背を見せた瞬間、${enemyName(ctx, enemyId)}に追いつかれた——${dmg} のダメージ。`,
    );
  }
}

// ============================================================================
// Action handlers — declared on the module's actionHandlers map below.
// Engine routes Input.doActivity through actionHandlerRegistry; each
// handler returns ActionResult { narrations? }. Module-private mutations
// (zone state, m.raid sub-state, m.metCharacters) stay in-place because
// they live on the module's own state slice that the engine doesn't
// model in StateDelta. After each handler the engine calls checkTriggers
// unconditionally (engine/src/primitives/applyActionResult.ts) so the
// HP=0 / spectral=100 triggers still fire even when mutations bypass
// StateDelta.
//
// Narrations are returned in the ActionResult so the engine queues
// them through pendingNarrations. The `denial` helper builds an
// ActionResult that carries just the rejection message.
// ============================================================================

function denial(message: string): ActionResult {
  return { narrations: [message] };
}

const departHandler: ActionHandler = (ctx) => {
  const chain = ctx.action.payload?.chain as string | undefined;
  const entryId = ctx.action.payload?.mapId as string | undefined;
  if (!chain) return denial(`出立先が指定されていない。`);
  if (playerStat(ctx, "hp") < playerStatMax(ctx, "hp")) {
    return denial("体力が満たぬ。先に宿で休め。");
  }
  const entry = entryId ? getMap(ctx, entryId) : undefined;
  if (!entry || entry.chain !== chain || entry.isEntry !== true) {
    return denial(`その地は地図にない（${chain}）。`);
  }
  if (!chainUnlocked(ctx, chain)) {
    return denial(`まだ${chainDisplayName(chain) ?? chain}には踏み入れない。`);
  }
  startRaid(ctx, chain, entryId!);
  return {};
};

const bondHandler: ActionHandler = (ctx) => {
  const charId = ctx.action.payload?.characterId as string | undefined;
  if (!charId) return denial("贈る相手が指定されていない。");
  const m = moduleState(ctx);
  const ryo = ctx.state.baseline.inventory.ryo ?? 0;
  if (ryo < 50) return denial(`両が足りない。あと ${50 - ryo} 両要る。`);
  if (!m.metCharacters.includes(charId)) {
    return denial("まだ会ったことのない相手だ。");
  }
  const charName =
    ctx.game.characters.find((x) => x.id === charId)?.name ?? charId;
  return {
    deltas: {
      inventory: { ryo: -50 },
      characterStats: { [charId]: { affection: 1 } },
    },
    narrations: [
      `${charName}に贈り物を渡した。受け取り際の目が、いつもより少しだけ柔らかい。`,
    ],
  };
};

const sellAllLootHandler: ActionHandler = (ctx) => {
  const sellable = Object.entries(ctx.state.baseline.inventory).filter(
    ([id, n]) => n > 0 && isLoot(ctx, id),
  );
  if (sellable.length === 0) return denial("売れる戦利品が手元にない。");

  let total = 0;
  const lines: string[] = [];
  const inventoryDelta: Record<string, number> = {};
  for (const [itemId, count] of sellable) {
    const val = sellValue(ctx, itemId) * count;
    total += val;
    lines.push(`${itemName(ctx, itemId)} ×${count} → ${val}両`);
    inventoryDelta[itemId] = -count;
  }
  inventoryDelta.ryo = (inventoryDelta.ryo ?? 0) + total;
  return {
    deltas: { inventory: inventoryDelta },
    narrations: [`炼器師に納めた：${lines.join("、")}。合計 ${total} 両。`],
  };
};

const sellMaterialHandler: ActionHandler = (ctx) => {
  const itemId = ctx.action.payload?.itemId as string | undefined;
  if (!itemId || !isMaterial(ctx, itemId)) {
    return denial("炼器師が買い取れる材料ではない。");
  }
  const count = ctx.state.baseline.inventory[itemId] ?? 0;
  if (count < 1) return denial(`${itemName(ctx, itemId)}は手元にない。`);
  const value = sellValue(ctx, itemId);
  return {
    deltas: { inventory: { [itemId]: -1, ryo: value } },
    narrations: [
      `炼器師に${itemName(ctx, itemId)}を一つ渡した。秤の分銅が沈む——${value} 両を受け取った（残り ${count - 1}）。`,
    ],
  };
};

// 妖刀の業 — three upgrade paths replace the single upgrade_weapon
// action. Each consumes different resources and feeds a different pulse
// counter, so the player's hub spending is the second axis of build
// decisions (the first being which pulse to imbue after each victory).
const upgradeMundaneHandler: ActionHandler = (ctx) => {
  const shards = ctx.state.baseline.inventory.soul_shard ?? 0;
  const ryo = ctx.state.baseline.inventory.ryo ?? 0;
  if (shards < 3) {
    return denial(`炼器師「魂石碎片が足りない。あと ${3 - shards} 枚要る。」`);
  }
  if (ryo < 100) {
    return denial(`炼器師「持ち合わせが ${ryo} 両か。あと ${100 - ryo} 両要る。」`);
  }
  const wid = ctx.state.baseline.equippedWeaponId;
  const deltas: StateDelta = {
    inventory: { soul_shard: -3, ryo: -100 },
    variables: { pulse_mundane: 1 },
  };
  if (wid) deltas.weapons = { [wid]: { power: 2 } };
  return {
    deltas,
    narrations: [
      `炼器師は無言で碎片を炉に投じた。一夜明け、妖刀の刃に新しい紋様が浮いている——威力 +2、脈絡: 凡 +1。`,
    ],
  };
};

const upgradePureHandler: ActionHandler = (ctx) => {
  const horns = ctx.state.baseline.inventory.oni_horn ?? 0;
  const ryo = ctx.state.baseline.inventory.ryo ?? 0;
  if (horns < 1) {
    return denial(`神主「鬼の角が要る。鎮魂の儀には必須」`);
  }
  if (ryo < 80) {
    return denial(`神主「奉納が ${ryo} 両か。80 両要る」`);
  }
  const wid = ctx.state.baseline.equippedWeaponId;
  const deltas: StateDelta = {
    inventory: { oni_horn: -1, ryo: -80 },
    variables: { pulse_pure: 1 },
  };
  if (wid) deltas.weapons = { [wid]: { power: 1 } };
  return {
    deltas,
    narrations: [
      `神社の祭壇で鎮魂の儀が行われる。鬼の角が浄火に灼かれ、刀の鞘が一瞬白く光る——威力 +1、脈絡: 浄 +1。`,
    ],
  };
};

const upgradeOniHandler: ActionHandler = (ctx) => {
  const horns = ctx.state.baseline.inventory.oni_horn ?? 0;
  const frags = ctx.state.baseline.inventory.cursed_blade_fragment ?? 0;
  const ryo = ctx.state.baseline.inventory.ryo ?? 0;
  if (horns < 1 || frags < 1) {
    return denial(
      `炼器師「鬼の角 1 + 呪われし刃の欠片 1 が要る。短期的に強くなる代わり、後戻りはできぬ」`,
    );
  }
  if (ryo < 120) {
    return denial(`炼器師「持ち合わせが ${ryo} 両か。120 両要る」`);
  }
  const wid = ctx.state.baseline.equippedWeaponId;
  const deltas: StateDelta = {
    inventory: { oni_horn: -1, cursed_blade_fragment: -1, ryo: -120 },
    variables: { pulse_oni: 1 },
    characterStats: { player: { spectral: 5 } },
  };
  if (wid) deltas.weapons = { [wid]: { power: 4 } };
  return {
    deltas,
    narrations: [
      `炼器師は炉に欠片を投じた。炎が黒く立ち上り、刀の刃に鬼の歯のような連紋が浮く——威力 +4、霊体化 +5、脈絡: 鬼 +1。`,
    ],
  };
};

// Pulse imbue handlers — invoked from buildRaidMenu after a victory.
// Each clears pulsePending, increments its pulse counter, and bumps
// weapon power on its own curve. The pulse_pure has a side effect of
// reducing future spectral creep; that's encoded by simply granting
// spectral -1 immediately as a small "rebate".
const imbueRequires = (ctx: ActionContext): string | null => {
  const m = moduleState(ctx);
  if (!m.pulsePending) return "脈絡選択の機会は今ない。";
  return null;
};

const imbuePureHandler: ActionHandler = (ctx) => {
  const blocker = imbueRequires(ctx);
  if (blocker) return denial(blocker);
  const m = moduleState(ctx);
  m.pulsePending = null;
  const wid = ctx.state.baseline.equippedWeaponId;
  const deltas: StateDelta = {
    variables: { pulse_pure: 1 },
    characterStats: { player: { spectral: -1 } },
  };
  if (wid) deltas.weapons = { [wid]: { power: 1 } };
  return {
    deltas,
    narrations: [
      `妖力が刀の中で透き通っていく——浄の脈に通った。威力 +1、霊体化 -1、脈絡: 浄 +1。`,
    ],
  };
};

const imbueOniHandler: ActionHandler = (ctx) => {
  const blocker = imbueRequires(ctx);
  if (blocker) return denial(blocker);
  const m = moduleState(ctx);
  const absorb = m.pulsePending!.absorb;
  m.pulsePending = null;
  const gain = Math.max(3, Math.floor(absorb / 2));
  const wid = ctx.state.baseline.equippedWeaponId;
  const deltas: StateDelta = {
    variables: { pulse_oni: 1 },
    characterStats: { player: { spectral: 3 } },
  };
  if (wid) deltas.weapons = { [wid]: { power: gain } };
  return {
    deltas,
    narrations: [
      `刀が悦んだ。鬼の脈に妖力が押し込められる——威力 +${gain}、霊体化 +3、脈絡: 鬼 +1。`,
    ],
  };
};

// 情報屋 handlers — each sets intel_active to a level key (string var)
// and increments intel_count. The actual briefing text is delivered
// via the corresponding intel_briefing_<level> script, which the
// player picks via the unified `script:intel_briefing` activity that
// onScriptSelect rewrites.
function infoshopHandler(
  level: "basic" | "loot" | "yaodao" | "hidden",
  cost: number,
  intellectMin: number,
  requiresFrag: boolean,
): ActionHandler {
  return (ctx) => {
    const ryo = ctx.state.baseline.inventory.ryo ?? 0;
    const intellect = playerStat(ctx, "intellect");
    if (ryo < cost) return denial(`情報屋「${cost} 両足りない」`);
    if (intellect < intellectMin) {
      return denial(`情報屋「お主の学識ではこの情報は活かせまい。学識 ${intellectMin} が要る」`);
    }
    if (requiresFrag) {
      const frags = ctx.state.baseline.inventory.cursed_blade_fragment ?? 0;
      if (frags < 1) {
        return denial(`情報屋「呪われし刃の欠片を寄越せ。それで奥の話が出来る」`);
      }
    }
    const intelActive =
      typeof ctx.state.baseline.variables.intel_active === "string"
        ? (ctx.state.baseline.variables.intel_active as string)
        : "";
    if (intelActive !== "") {
      return denial("先の覚書をまだ読んでいない。先に読め。");
    }
    const deltas: StateDelta = {
      inventory: { ryo: -cost },
      variables: { intel_active: level, intel_count: 1 },
    };
    if (requiresFrag) {
      deltas.inventory!.cursed_blade_fragment = -1;
    }
    return {
      deltas,
      narrations: [
        `情報屋は折り紙を差し出した。「読みなさい——大名府に戻ったら、すぐに」`,
      ],
    };
  };
}

const imbueMundaneHandler: ActionHandler = (ctx) => {
  const blocker = imbueRequires(ctx);
  if (blocker) return denial(blocker);
  const m = moduleState(ctx);
  m.pulsePending = null;
  const wid = ctx.state.baseline.equippedWeaponId;
  const deltas: StateDelta = {
    variables: { pulse_mundane: 1 },
  };
  if (wid) deltas.weapons = { [wid]: { power: 2 } };
  return {
    deltas,
    narrations: [
      `妖力は穏やかに刀身に馴染んだ——威力 +2、脈絡: 凡 +1。`,
    ],
  };
};

const restHandler: ActionHandler = (ctx) => {
  const hp = playerStat(ctx, "hp");
  const hpMax = playerStatMax(ctx, "hp");
  if (hp >= hpMax) {
    return denial("もう休む必要はない。体力は満たされている。");
  }
  return {
    deltas: {
      characterStats: {
        player: {
          hp: hpMax - hp,
          mental: playerStatMax(ctx, "mental") - playerStat(ctx, "mental"),
        },
      },
    },
    narrations: [
      `宿で一晩明かす。体力と精神を回復した。霊体化は鎮まらないが、刀は静かに鞘に収まっている。`,
    ],
  };
};

const useChinkonhoHandler: ActionHandler = (ctx) => {
  if (!ctx.state.baseline.knownSkills.includes("chinkonho")) {
    return denial("鎮魂法はまだ伝授されていない。");
  }
  const spec = playerStat(ctx, "spectral");
  if (spec < 10) {
    return denial("霊体化がまだ低い。今鎮める意味はない。");
  }
  return {
    deltas: {
      characterStats: { player: { spectral: -Math.min(20, spec) } },
    },
    narrations: [
      `刀を逆手に取り、心臓の真上に当てる。長く、一度息を吐く。胸の奥でうねっていたものが、二十、押し戻された。`,
    ],
  };
};

// 澪同行者 passive — 水鏡: standing in one zone she reads the water /
// blade-sheen and scouts whichever enemy waits in each connected,
// not-yet-entered zone. We roll + persist those encounters now (the
// MapInstance.encounterRolled guard keeps the preview truthful — the
// real arrival won't re-roll). Pushes a narration; returns nothing.
function mioScry(ctx: Ctx, fromMap: MapDef): void {
  const seen: string[] = [];
  for (const conn of fromMap.connections ?? []) {
    const nextMap = getMap(ctx, conn.target);
    if (!nextMap) continue;
    const inst = ensureMapInstance(ctx, conn.target);
    if (inst.visited) continue; // already walked — nothing to foretell
    if (!inst.encounterRolled) {
      inst.encounter = rollEncounter(ctx, nextMap);
      inst.encounterRolled = true;
    }
    seen.push(
      inst.encounter
        ? `${nextMap.name}に${enemyName(ctx, inst.encounter.enemyId)}が一匹`
        : `${nextMap.name}は澄んでいる`,
    );
  }
  if (seen.length > 0) {
    ctx.state.runtime.pendingNarrations.push(
      `澪が刀身を水平にし、流れに映す。「水鏡に問う——」${seen.join("、")}。`,
    );
  }
}

// 同行道中の一幕 — on reaching a quiet (no-encounter) new zone with a
// companion in party, play that companion's next unseen "on the road"
// scene. Two tiers, in order:
//   road_<id>    — first time out together (gate: !road_<id>_seen)
//   road_<id>_2  — deeper, after surviving a raid together
//                  (gate: befriended_<id> && !road_<id>_2_seen)
// Each scene's own effects block sets its `_seen` switch + grants
// affection, so neither re-fires. Returns true if a scene was launched
// (caller returns early, same contract as the character_spawns path).
function maybeLaunchRoadScene(ctx: Ctx): boolean {
  const m = moduleState(ctx);
  if (!m.companion) return false;
  const id = m.companion;
  const sw = ctx.state.baseline.switches;
  const launch = (scriptId: string): boolean => {
    if (!ctx.game.scripts.some((s) => s.id === scriptId)) return false;
    ctx.state.baseline.currentScriptId = scriptId;
    ctx.state.baseline.beatIndex = 0;
    return true;
  };
  if (sw[`road_${id}_seen`] !== true) return launch(`road_${id}`);
  if (sw[`befriended_${id}`] === true && sw[`road_${id}_2_seen`] !== true) {
    return launch(`road_${id}_2`);
  }
  return false;
}

const moveHandler: ActionHandler = (ctx) => {
  const blocker = combatBlock(ctx);
  if (blocker) return denial(blocker);
  const target = ctx.action.payload?.mapId as string | undefined;
  if (!target) return denial("行き先が指定されていない。");

  const m = moduleState(ctx);
  if (!m.raid) return {};
  const cur = currentMap(ctx);
  if (!cur) return denial("現在地が不明だ。");
  const conn = (cur.connections ?? []).find((c) => c.target === target);
  if (!conn) return denial(`${cur.name}からそちらへ通じる道はない。`);

  // enterMap writes currentMapId + visuals.bg; we layer raid-specific
  // side effects (turn count, companion passives, encounter roll) on
  // top. The engine doesn't model raid-instance state in StateDelta —
  // these writes live in the module's own slice.
  enterMap(ctx.state, ctx.game, target);
  m.raid.turnsTaken += 1;
  const targetMap = currentMap(ctx)!;

  // 篝同行者 passive: each new zone, spectral -1.
  if (m.companion === "kagari") {
    const spec = playerStat(ctx, "spectral");
    if (spec > 0) {
      setPlayerStat(ctx, "spectral", Math.max(0, spec - 1));
      ctx.state.runtime.pendingNarrations.push(
        `篝が刀を握り直す。歩を合わせるたび、胸の奥のものが一寸だけ静かになる——霊体化 -1。`,
      );
    }
  }

  const inst = ensureMapInstance(ctx, target);
  if (inst.visited) {
    return { narrations: [`${targetMap.name}に戻る。一度通った道。`] };
  }
  inst.visited = true;
  inst.pendingLoot = rollLoot(ctx, targetMap);
  // 澪's 水鏡 scry may already have rolled this zone's encounter from a
  // neighbouring zone — honour that roll so the scouted enemy is what
  // actually appears (see MapInstance.encounterRolled).
  if (!inst.encounterRolled) {
    inst.encounter = rollEncounter(ctx, targetMap);
    inst.encounterRolled = true;
  }

  // Character spawn check. If a rule fires, launch the encounter
  // script instead of narrating map entry.
  const spawnedChar = rollCharacterSpawn(ctx, targetMap);
  if (spawnedChar) {
    m.metCharacters.push(spawnedChar.characterId);
    ctx.state.baseline.currentScriptId = spawnedChar.encounterScriptId;
    ctx.state.baseline.beatIndex = 0;
    return {};
  }

  // 澪同行者 passive: scout the connected zones ahead (pushes narration).
  if (m.companion === "mio") mioScry(ctx, targetMap);

  if (inst.encounter) {
    const intro = getEnemyNarration(ctx, inst.encounter.enemyId, "intro");
    if (intro) {
      return {
        narrations: [
          fillTemplate(intro, {
            name: enemyName(ctx, inst.encounter.enemyId),
            hp: inst.encounter.enemyHpMax,
          }),
        ],
      };
    }
    return {};
  }

  // Quiet zone — chance for a one-time 同行 road scene before the player
  // moves on. Launching a script returns early (same as character_spawns).
  if (maybeLaunchRoadScene(ctx)) return {};

  return { narrations: [`${targetMap.name}に出る。静かだ。`] };
};

const searchHandler: ActionHandler = (ctx) => {
  const blocker = combatBlock(ctx);
  if (blocker) return denial(blocker);
  const m = moduleState(ctx);
  if (!m.raid) return {};
  const map = currentMap(ctx);
  if (!map) return {};
  const inst = currentMapInstance(ctx)!;
  if (inst.searched) return denial(`${map.name}はもう探った。`);

  inst.searched = true;
  const lines: string[] = [];
  for (const [itemId, count] of Object.entries(inst.pendingLoot)) {
    if (count <= 0) continue;
    m.raid.pendingLoot[itemId] = (m.raid.pendingLoot[itemId] ?? 0) + count;
    lines.push(`${itemName(ctx, itemId)} ×${count}`);
  }
  const intellectBefore = playerStat(ctx, "intellect");
  const intellectGain = Math.max(
    0,
    Math.min(
      playerStatMax(ctx, "intellect"),
      intellectBefore + Math.max(1, Math.floor(map.difficulty ?? 1)) * 5,
    ) - intellectBefore,
  );
  const discovery =
    lines.length > 0
      ? `${map.name}を探った。見つけたもの：${lines.join("、")}。`
      : `${map.name}は何もなかった。`;
  return {
    narrations: [
      intellectGain > 0
        ? `${discovery}地勢と痕跡を読み、学識 +${intellectGain}。`
        : `${discovery}学識は既に極みにある。`,
    ],
    ...(intellectGain > 0
      ? {
          deltas: {
            characterStats: { player: { intellect: intellectGain } },
          },
        }
      : {}),
  };
};

const attackHandler: ActionHandler = (ctx) => {
  doAttackRound(ctx, "normal");
  return {};
};

const sneakStrikeHandler: ActionHandler = (ctx) => {
  doAttackRound(ctx, "sneak");
  return {};
};

const suppressStrikeHandler: ActionHandler = (ctx) => {
  const zone = currentMapInstance(ctx);
  if (
    !zone?.encounter ||
    zone.encounter.negotiable ||
    negotiationWindowConsumed(zone.encounter)
  ) {
    return denial("今は押さえ込む相手がいない。");
  }
  doAttackRound(ctx, "suppress");
  return {};
};

const fleeHandler: ActionHandler = (ctx) => {
  doFlee(ctx);
  return {};
};

// 鬼の交渉 — three branches, all only valid when the encounter is
// marked negotiable (HP < 30%). Module guards check this; if the
// encounter isn't negotiable the handler returns a denial.

const negotiateListenHandler: ActionHandler = (ctx) => {
  const m = moduleState(ctx);
  if (!m.raid) return denial("交渉できる相手がいない。");
  const zone = currentMapInstance(ctx);
  if (!zone?.encounter?.negotiable) {
    return denial("まだ斬れるうちに聞き出すには弱らせろ。");
  }
  const enemyId = zone.encounter.enemyId;
  const cunning = enemyCunning(ctx, enemyId);
  const lore = enemyNegotiateLore(ctx, enemyId);
  const dropId = enemyNegotiateDrop(ctx, enemyId);
  const chance = negotiateDropChance(cunning);
  const success = ctx.rng() * 100 < chance;

  const narrations: string[] = [];
  if (lore) narrations.push(lore);

  const deltas: StateDelta = {};
  if (success && dropId) {
    deltas.inventory = { [dropId]: 1 };
    narrations.push(
      `${enemyName(ctx, enemyId)}は最後に何かを差し出して、霧に溶けた——${itemName(ctx, dropId)} ×1。`,
    );
  } else {
    narrations.push(
      `${enemyName(ctx, enemyId)}の声は途切れた。差し出されたものは何もない。`,
    );
  }

  // Listening consumes the encounter's one negotiation window. The enemy
  // remains alive, but neither attacking nor suppressing can reopen it.
  zone.encounter.negotiable = false;
  zone.encounter.negotiationConsumed = true;
  return { deltas, narrations };
};

const negotiateReleaseHandler: ActionHandler = (ctx) => {
  const m = moduleState(ctx);
  if (!m.raid) return denial("放す相手がいない。");
  const zone = currentMapInstance(ctx);
  if (!zone?.encounter?.negotiable) {
    return denial("斬れる距離まで弱らせろ。");
  }
  const enemyId = zone.encounter.enemyId;
  const enemyTitle = enemyName(ctx, enemyId);

  zone.encounter = null;
  zone.encounterCleared = true;

  // selfSwitch A on the zone_haunt_<enemy> script: persists across
  // raids, unlocks the haunt lore script in hub. This is what makes
  // selfSwitch meaningful — a one-time, script-scoped permanent flag
  // that's neither a global switch nor a variable.
  return {
    deltas: {
      characterStats: { player: { spectral: -2 } },
      selfSwitches: {
        [`zone_haunt_${enemyId}`]: { A: true },
      },
    },
    narrations: [
      `お主は刀を引いた。${enemyTitle}は霧に滲んでいく——その目に、礼に似たものが浮かんだ気がした。霊体化 -2。大名府へ戻れば、この鬼が残した記憶を辿れるだろう。`,
    ],
  };
};

const yaodaoVoiceHandler: ActionHandler = (ctx) => {
  const m = moduleState(ctx);
  if (!m.raid) return denial("ここでは聞こえぬ声だ。");
  const zone = currentMapInstance(ctx);
  if (!zone?.encounter?.negotiable) {
    return denial("妖刀が応える気配は無い——まだ早い。");
  }
  if (playerStat(ctx, "spectral") < 50) {
    return denial("霊体化が低くて、刀の声が聞こえない。");
  }
  const enemyId = zone.encounter.enemyId;
  const hpMax = zone.encounter.enemyHpMax;
  const swordGain = Math.max(2, Math.floor(hpMax / 2));

  // Finisher: no need to compute damage, the encounter is forced over.
  zone.encounter = null;
  zone.encounterCleared = true;

  const wid = ctx.state.baseline.equippedWeaponId;
  const deltas: StateDelta = {
    characterStats: { player: { spectral: 5 } },
    variables: { pulse_oni: 1 },
  };
  if (wid) deltas.weapons = { [wid]: { power: swordGain } };

  return {
    deltas,
    narrations: [
      `刀が鳴いた。胸の奥のものが舌を出した——${enemyName(ctx, enemyId)}は、一閃で四つに別れた。霊体化 +5、妖刀威力 +${swordGain}、脈絡: 鬼 +1。`,
    ],
  };
};

const extractHandler: ActionHandler = (ctx) => {
  const blocker = combatBlock(ctx);
  if (blocker) return denial(blocker);
  const m = moduleState(ctx);
  if (!m.raid) return {};
  const map = currentMap(ctx);
  if (!map) return {};
  if (!map.isExtract) {
    return denial(`${map.name}は撤退点ではない。社か杜まで戻れ。`);
  }
  endRaidExtract(ctx);
  return {};
};

// 同行者 invite/uninvite handler. Toggles companion + the public
// `companion_<id>` switch (hooks key off the switch since switches are
// in the engine-modeled state, not module-private).
const inviteHandler: ActionHandler = (ctx) => {
  const charId = ctx.action.payload?.characterId as string | undefined;
  if (!charId) return denial("誰を誘うか指定されていない。");
  const m = moduleState(ctx);
  if (!m.metCharacters.includes(charId)) {
    return denial("会ったことのない相手は誘えない。");
  }
  if (m.raid !== null) {
    return denial("出立後は誘えない。大名府に戻ってから。");
  }
  const affection =
    ctx.state.baseline.characters[charId]?.stats.affection ?? 0;
  const officialDuty =
    charId === "mio" &&
    ctx.state.baseline.switches.mio_inspection_duty === true;
  if (affection < 4 && !officialDuty && m.companion !== charId) {
    return denial("まだ同行を頼める仲ではない（親密度 4 が要る）。");
  }
  const charName =
    ctx.game.characters.find((c) => c.id === charId)?.name ?? charId;

  // Toggle off if already invited.
  if (m.companion === charId) {
    m.companion = null;
    m.companionHp = 0;
    return {
      deltas: { switches: { [`companion_${charId}`]: false } },
      narrations: [`${charName}に同行を解いた旨を伝えた。`],
    };
  }

  // Replace any prior companion, flip switches accordingly.
  const switches: Record<string, boolean> = {
    [`companion_${charId}`]: true,
  };
  if (m.companion) {
    switches[`companion_${m.companion}`] = false;
  }
  m.companion = charId;
  m.companionHp = 10;
  return {
    deltas: { switches },
    narrations: [
      `${charName}は頷いた。「次の出帰り、隣で歩く。」`,
    ],
  };
};

// ============================================================================
// Triggers: HP <= 0 or spectral >= 100 during a raid → failure
// ============================================================================

// Queue a letter script — but only when we're safely in the hub between
// scripts. If the player is mid-script (very rare; only if a trigger
// somehow fires during a script's effects block), the chapter advance
// still happens via the delta below, and onHubBuild can show a "未読の
// 文" hint until the next hub cycle. The next time `currentScriptId`
// becomes null in the run loop, the letter will queue.
function queueLetterIfHub(ctx: PresetContext, scriptId: string): void {
  if (ctx.state.baseline.currentScriptId === null) {
    ctx.state.baseline.currentScriptId = scriptId;
    ctx.state.baseline.beatIndex = 0;
  }
}

const triggers: Trigger[] = [
  {
    id: "raid_death_hp",
    when: { characterStat: { character: "player", name: "hp", max: 0 } },
    do: (ctx) => {
      const m = moduleState(ctx);
      if (m.raid !== null) {
        endRaidFailure(ctx, "体力が尽きた");
      }
      return {};
    },
  },
  {
    id: "raid_death_spectral",
    when: { characterStat: { character: "player", name: "spectral", min: 100 } },
    do: (ctx) => {
      const m = moduleState(ctx);
      if (m.raid !== null) {
        endRaidFailure(ctx, "霊体化が振り切れた");
      }
      return {};
    },
  },
  // ============== 主線：将軍家からの密書 milestones ==============
  // Each letter fires once per session (`once: true`); the engine
  // tracks fired ids in state.runtime.firedTriggers.
  //
  // Composite `when:` shows off how trigger conditions can mix:
  // - letter_02 requires both a raid count AND a spectral ceiling
  //   (player must be visibly *not* drowning before the inspector
  //   shows up — narrative beat, not just a counter).
  // - letter_03 chains on shogun_chapter, so the trigger order is
  //   guaranteed even if raidsCompleted accidentally jumps.
  {
    id: "letter_01_dispatch",
    once: true,
    when: { variable: { name: "raidsCompleted", min: 3 } },
    do: (ctx) => {
      queueLetterIfHub(ctx, "letter_01_suspicion");
      return {
        deltas: { variables: { shogun_chapter: 1 } },
      };
    },
  },
  {
    id: "letter_02_dispatch",
    once: true,
    when: {
      all: [
        { variable: { name: "shogun_chapter", min: 1 } },
        { variable: { name: "raidsCompleted", min: 7 } },
        { characterStat: { character: "player", name: "spectral", max: 49 } },
      ],
    },
    do: (ctx) => {
      queueLetterIfHub(ctx, "letter_02_rival");
      return {
        deltas: { variables: { shogun_chapter: 1 } },
      };
    },
  },
  {
    id: "letter_03_dispatch",
    once: true,
    when: {
      all: [
        { variable: { name: "shogun_chapter", min: 2 } },
        { variable: { name: "raidsCompleted", min: 12 } },
      ],
    },
    do: (ctx) => {
      queueLetterIfHub(ctx, "letter_03_choice");
      return {
        deltas: { variables: { shogun_chapter: 1 } },
      };
    },
  },
  // 三花の盟 — once-only trigger when all three companions have
  // survived at least one raid each. Composite of three switches via
  // the `all` connector. The reward is a special script that branches
  // the endings.
  {
    id: "three_flowers_alliance",
    once: true,
    when: {
      all: [
        { switch: { name: "befriended_kagari" } },
        { switch: { name: "befriended_kasumi" } },
        { switch: { name: "befriended_mio" } },
      ],
    },
    do: (ctx) => {
      queueLetterIfHub(ctx, "three_flowers_alliance");
      return {};
    },
  },
];

// ============================================================================
// Module declaration
// ============================================================================

const raidModule: Module = {
  id: MODULE_ID,
  version: "0.3.0",

  initialize: (_game: Game): RaidModuleState => ({
    raid: null,
    metCharacters: [],
    companion: null,
    companionHp: 0,
    pulsePending: null,
    achievementLog: [],
  }),

  // Action handler kinds the module supplies. Engine namespaces them as
  // "sengoku-raid:<kind>"; bare form resolves uniquely since no other
  // module claims these names. HubActivities built by onHubBuild
  // reference the bare form via HubActivity.actionKind.
  provides: [
    "depart",
    "bond",
    "sell_all_loot",
    "sell_material",
    "upgrade_mundane",
    "upgrade_pure",
    "upgrade_oni",
    "rest",
    "use_chinkonho",
    "move",
    "search",
    "attack",
    "sneak_strike",
    "suppress_strike",
    "flee",
    "extract",
    "negotiate_listen",
    "negotiate_release",
    "yaodao_voice",
    "invite",
    "imbue_pure",
    "imbue_oni",
    "imbue_mundane",
    "infoshop_basic",
    "infoshop_loot",
    "infoshop_yaodao",
    "infoshop_hidden",
  ],
  actionHandlers: {
    depart: departHandler,
    bond: bondHandler,
    sell_all_loot: sellAllLootHandler,
    sell_material: sellMaterialHandler,
    upgrade_mundane: upgradeMundaneHandler,
    upgrade_pure: upgradePureHandler,
    upgrade_oni: upgradeOniHandler,
    rest: restHandler,
    use_chinkonho: useChinkonhoHandler,
    move: moveHandler,
    search: searchHandler,
    attack: attackHandler,
    sneak_strike: sneakStrikeHandler,
    suppress_strike: suppressStrikeHandler,
    flee: fleeHandler,
    extract: extractHandler,
    negotiate_listen: negotiateListenHandler,
    negotiate_release: negotiateReleaseHandler,
    yaodao_voice: yaodaoVoiceHandler,
    invite: inviteHandler,
    imbue_pure: imbuePureHandler,
    imbue_oni: imbueOniHandler,
    imbue_mundane: imbueMundaneHandler,
    infoshop_basic: infoshopHandler("basic", 50, 0, false),
    infoshop_loot: infoshopHandler("loot", 100, 30, false),
    infoshop_yaodao: infoshopHandler("yaodao", 200, 50, false),
    infoshop_hidden: infoshopHandler("hidden", 300, 80, true),
  },

  onSessionStart: (ctx) => {
    // Player stats (hp/mental/spectral/intellect) are pre-populated from
    // characters/player.md's declared initials — no manual bootstrap
    // here. raidsCompleted/raidsFailed are declared variables — engine
    // pre-populates from game.yaml.
    if (ctx.state.baseline.inventory.ryo === undefined) {
      ctx.state.baseline.inventory.ryo = 100;
    }
    // Content may gain or change a map background while an AI is paused in
    // that zone. Reconcile the authoritative currentMapId on the next shared
    // Headless/GUI step, but never clobber an active script's own staging.
    // This turns map edits into live-save migrations instead of requiring the
    // player to walk away and back (or restart the game).
    if (ctx.state.baseline.currentScriptId === null) {
      const map = currentMap(ctx);
      if (map?.bg && ctx.state.baseline.visuals.bg !== map.bg) {
        ctx.state.baseline.visuals.bg = map.bg;
      }
    }
    // One-time migration for saves that completed letter 02 before the
    // inspection-duty contract existed. Option 0 was the only reply that
    // granted affection, so affection > 0 safely recovers an explicit
    // 「同行を頼む」 and schedules 澪 exactly once.
    if (ctx.state.baseline.scripts.bond_mio_04?.completed === true) {
      // Her final report explicitly ends the official inspection. This also
      // migrates live saves completed before the script carried the switch.
      ctx.state.baseline.switches.mio_inspection_duty = false;
      if (
        ctx.state.baseline.variables.shogun_chapter === 2 &&
        ctx.state.baseline.variables.last_directive ===
          "澪と共に出帰り、見立てを受けよ。"
      ) {
        ctx.state.baseline.variables.last_directive =
          "見立ては結審した。最後の御沙汰が下るまで、鬼を斬れ。";
      } else if (
        Number(ctx.state.baseline.variables.shogun_chapter ?? 0) >= 3 &&
        ctx.state.baseline.variables.last_directive ===
          "見立ては結審した。最後の御沙汰が下るまで、鬼を斬れ。"
      ) {
        // bond_mio_04 used to write the chapter-2 waiting directive
        // unconditionally, even after the player had already chosen the
        // final court order. Recover those live saves from the authoritative
        // mutually-exclusive choice switches.
        if (ctx.state.baseline.switches.chose_court_loyal === true) {
          ctx.state.baseline.variables.last_directive =
            "公儀の道。査問を受けつつ、刀を整えて老いる。";
        } else if (ctx.state.baseline.switches.chose_court_defy === true) {
          ctx.state.baseline.variables.last_directive =
            "公儀と袂を分かつ。刀の脈は、お主が選ぶ。";
        } else if (ctx.state.baseline.switches.chose_court_silent === true) {
          ctx.state.baseline.variables.last_directive =
            "遁世。刀は祠に納める。鬼は他者に任せる。";
        }
      }
    } else if (
      ctx.state.baseline.scripts.letter_02_rival?.completed === true &&
      ctx.state.baseline.switches.mio_inspection_duty !== true
    ) {
      ctx.state.baseline.switches.mio_inspection_duty = true;
      const mioAffection =
        ctx.state.baseline.characters.mio?.stats.affection ?? 0;
      const m = moduleState(ctx);
      if (mioAffection > 0 && m.raid === null && m.companion === null) {
        m.companion = "mio";
        m.companionHp = 10;
        ctx.state.baseline.switches.companion_mio = true;
      }
    }
    // Establish the starting location. Fresh sessions land in the hub
    // (大名府 / edo_castle); seeded fixtures that have already entered a
    // raid map keep their currentMapId. The hub menu / raid menu split
    // keys off `m.raid !== null`, but the bg / location semantics still
    // need currentMapId to be set.
    if (ctx.state.baseline.currentMapId === null) {
      enterMap(ctx.state, ctx.game, "edo_castle");
    }
    if (
      ctx.state.baseline.scripts["000_intro"]?.completed !== true &&
      ctx.scriptMap.has("000_intro") &&
      ctx.state.baseline.currentScriptId === null
    ) {
      ctx.state.baseline.currentScriptId = "000_intro";
      ctx.state.baseline.beatIndex = 0;
    }
  },

  triggers,

  // ============== Letter lifecycle observers ==============
  // onScriptStart fires before the first beat yields. We push a single
  // header narration ahead of the letter body so the player gets the
  // "公儀御沙汰" page-break visually, no matter how the script was queued
  // (trigger / hub / save-load).
  onScriptStart: (ctx, scriptId) => {
    if (scriptId.startsWith("letter_")) {
      ctx.state.runtime.pendingNarrations.unshift(
        `——— 公儀御沙汰 ———`,
      );
    }
  },

  // onScriptSelect (first-wins): when the player picks the generic
  // `intel_briefing` script from the hub, redirect to the level-specific
  // variant based on the `intel_active` variable. This is the cleanest
  // legitimate use of the hook — the player-facing menu has one entry
  // ("情報屋の覚書を読む") but the actual content depends on which
  // tier of intel they bought.
  onScriptSelect: (ctx, scriptId) => {
    if (scriptId !== "intel_briefing") return;
    const v = ctx.state.baseline.variables.intel_active;
    if (typeof v !== "string" || v === "") return;
    return `intel_briefing_${v}`;
  },

  // ============== Achievement observers ==============
  //
  // onStateMutated (observer): watch for rising-edge stat / variable
  // crossings and push achievement strings into module-state log.
  // Triggers don't do this naturally because they fire ActionResult
  // deltas — observers can read fresh values directly and append
  // strings without going through the delta surface.
  //
  // The dedup-on-append guard handles re-loads: the same crossing
  // doesn't double-log when state.baseline is restored from a save.
  onStateMutated: (ctx, _delta, source) => {
    // Ignore replays from the seed loader / hot-reload paths.
    if (source === "external") return;
    const m = moduleState(ctx);
    const log = (label: string) => {
      if (!m.achievementLog.includes(label)) m.achievementLog.push(label);
    };
    const spec = playerStat(ctx, "spectral");
    if (spec >= 50) log("鬼に近づく — 霊体化 50");
    if (spec >= 80) log("暴走寸前 — 霊体化 80");
    const pulsePure = (ctx.state.baseline.variables.pulse_pure ?? 0) as number;
    const pulseOni = (ctx.state.baseline.variables.pulse_oni ?? 0) as number;
    if (pulsePure >= 5) log("浄の極み — 浄脈 5");
    if (pulseOni >= 5) log("鬼の脈、深し — 鬼脈 5");
    if ((ctx.state.baseline.inventory.cursed_blade_fragment ?? 0) >= 1) {
      log("呪の片を握る — 鬼神を斬りし証");
    }
  },

  // onLabelEnter (observer): letter_03's three branches are implemented
  // as goto labels (end_loyal / end_defy / end_silent). Logging the
  // entry into one of those labels gives us a clean "the decision was
  // made HERE" anchor, separate from the switch flip which happens
  // earlier in the choice's effects block.
  onLabelEnter: (ctx, scriptId, labelName) => {
    if (scriptId !== "letter_03_choice") return;
    if (!labelName.startsWith("end_")) return;
    const m = moduleState(ctx);
    const tag = `御沙汰：${labelName.slice(4)}`;
    if (!m.achievementLog.includes(tag)) m.achievementLog.push(tag);
  },

  // onScriptComplete is the natural place to finalize a letter's
  // module-level side effects that can't go in the script's effects
  // block: pushing mio into metCharacters (a private module state
  // slice). The chapter advance already happened in the dispatch
  // trigger, so we don't touch shogun_chapter here.
  onScriptComplete: (ctx, scriptId) => {
    if (scriptId === "encounter_kasumi_first") {
      const zone = currentMapInstance(ctx);
      if (zone?.encounter) {
        // The authored encounter has Kasumi's arrow kill the oni before she
        // speaks. Honor that visible event in runtime state without granting
        // player kill rewards, spectral absorption, or an imbue decision.
        zone.encounter = null;
        zone.encounterCleared = true;
      }
    }
    if (scriptId === "letter_02_rival") {
      const m = moduleState(ctx);
      if (!m.metCharacters.includes("mio")) {
        m.metCharacters.push("mio");
      }
    }
    // After any intel briefing variant runs to completion, clear
    // intel_active so the hub stops surfacing it and the next infoshop
    // purchase is unblocked.
    if (scriptId.startsWith("intel_briefing_")) {
      ctx.state.baseline.variables.intel_active = "";
    }
  },

  // Letter 02 is an official inspection order, so every reply accepts the
  // same immediate companionship contract. The three options express the
  // player's attitude; only 「同行を頼む」 grants affection in the script.
  onChoiceResolved: (ctx, scriptId, _beatIdx, choiceIdx, resolution) => {
    if (scriptId === "encounter_kagari_first") {
      const replies: Record<string, string> = {
        "name-the-shared-curse": "shared-curse",
        "nod-to-kagari": "silent-nod",
        "warn-kagari-away": "wary",
      };
      const reply = resolution.optionId
        ? replies[resolution.optionId]
        : ["shared-curse", "silent-nod", "wary"][choiceIdx];
      if (reply) ctx.state.baseline.variables.kagari_first_reply = reply;
      return;
    }
    if (scriptId === "encounter_kasumi_first") {
      const replies: Record<string, string> = {
        "serve-the-shogunate": "shogunate",
        "name-it-family-trade": "family-trade",
        "thank-kasumi": "gratitude",
      };
      const reply = resolution.optionId
        ? replies[resolution.optionId]
        : ["shogunate", "family-trade", "gratitude"][choiceIdx];
      if (reply) ctx.state.baseline.variables.kasumi_first_reply = reply;
      return;
    }
    if (scriptId === "bond_kagari_01") {
      const replies: Record<string, string> = {
        "ask-about-regret": "asked-regret",
        "accept-the-flask": "accepted-flask",
      };
      const reply = resolution.optionId
        ? replies[resolution.optionId]
        : ["asked-regret", "accepted-flask"][choiceIdx];
      if (reply) ctx.state.baseline.variables.kagari_bond_reply = reply;
      return;
    }
    if (scriptId === "bond_kasumi_01") {
      const replies: Record<string, string> = {
        "deny-it-is-foolish": "not-foolish",
        "admit-the-same-loss": "same-loss",
        "sit-beside-her": "sat-beside",
      };
      const reply = resolution.optionId
        ? replies[resolution.optionId]
        : ["not-foolish", "same-loss", "sat-beside"][choiceIdx];
      if (reply) ctx.state.baseline.variables.kasumi_bond_reply = reply;
      return;
    }
    if (scriptId === "bond_kasumi_03") {
      const replies: Record<string, string> = {
        "ask-why-she-walks": "why-walk",
        "ask-when-hunter-draws": "hunter-blade",
        "ask-to-learn-deer-path": "learn-path",
      };
      const reply = resolution.optionId
        ? replies[resolution.optionId]
        : ["why-walk", "hunter-blade", "learn-path"][choiceIdx];
      if (reply) ctx.state.baseline.variables.kasumi_deer_reply = reply;
      return;
    }
    if (scriptId === "bond_kagari_03") {
      const replies: Record<string, string> = {
        "avoid-dreams": "avoid-dreams",
        "use-chinkonho-nightly": "chinkonho",
        "do-not-sleep": "sleepless",
      };
      const reply = resolution.optionId
        ? replies[resolution.optionId]
        : ["avoid-dreams", "chinkonho", "sleepless"][choiceIdx];
      if (reply) ctx.state.baseline.variables.kagari_sleep_reply = reply;
      return;
    }
    if (scriptId === "bond_kagari_04") {
      const replies: Record<string, string> = {
        "name-her-alive": "alive",
        "count-only-before-me": "count-before-me",
        "pour-back": "poured-back",
      };
      const reply = resolution.optionId
        ? replies[resolution.optionId]
        : ["alive", "count-before-me", "poured-back"][choiceIdx];
      if (reply) ctx.state.baseline.variables.kagari_rain_reply = reply;
      return;
    }
    if (scriptId === "bond_kasumi_04") {
      const replies: Record<string, string> = {
        "walk-without-a-reason": "without-reason",
        "read-only-her-footsteps": "her-footsteps",
        "step-back-beside-her": "half-step",
      };
      const reply = resolution.optionId
        ? replies[resolution.optionId]
        : ["without-reason", "her-footsteps", "half-step"][choiceIdx];
      if (reply) ctx.state.baseline.variables.kasumi_final_reply = reply;
      return;
    }
    if (scriptId === "bond_mio_01") {
      const replies: Record<string, string> = {
        "turn-the-mirror-on-herself": "self-mirror",
        "ask-about-the-second-death": "second-death",
        "cast-a-stone-in-silence": "silent-stone",
      };
      const reply = resolution.optionId
        ? replies[resolution.optionId]
        : ["self-mirror", "second-death", "silent-stone"][choiceIdx];
      if (reply) ctx.state.baseline.variables.mio_inquest_reply = reply;
      return;
    }
    if (scriptId === "bond_mio_03") {
      const replies: Record<string, string> = {
        "ask-about-her-younger-shadow": "younger-shadow",
        "ask-if-the-mirror-shows-future": "future-direction",
        "ask-her-to-stay-beside-him": "stay-beside",
      };
      const reply = resolution.optionId
        ? replies[resolution.optionId]
        : ["younger-shadow", "future-direction", "stay-beside"][choiceIdx];
      if (reply) ctx.state.baseline.variables.mio_mirror_reply = reply;
      return;
    }
    if (scriptId === "road_kagari_2") {
      const replies: Record<string, string> = {
        "promise-to-return-alone": "return-alone",
        "entrust-the-last-resort": "last-resort",
        "seal-the-spear-promise": "spear-promise",
      };
      const reply = resolution.optionId
        ? replies[resolution.optionId]
        : ["return-alone", "last-resort", "spear-promise"][choiceIdx];
      if (reply) ctx.state.baseline.variables.kagari_road_reply = reply;
      return;
    }
    if (scriptId === "road_kasumi_2") {
      const replies: Record<string, string> = {
        "vow-not-to-lose-kasumi": "no-loss",
        "remember-her-returning-step": "returning-step",
        "rest-her-bow-on-his-knees": "rested-bow",
      };
      const reply = resolution.optionId
        ? replies[resolution.optionId]
        : ["no-loss", "returning-step", "rested-bow"][choiceIdx];
      if (reply) ctx.state.baseline.variables.kasumi_road_reply = reply;
      return;
    }
    if (scriptId === "road_mio_2") {
      const replies: Record<string, string> = {
        "ask-her-never-to-conclude": "reject-false-duty",
        "ask-her-to-stay-without-duty": "stay-without-duty",
        "accept-her-private-feeling": "share-private-feeling",
      };
      const reply = resolution.optionId
        ? replies[resolution.optionId]
        : ["reject-false-duty", "stay-without-duty", "share-private-feeling"][choiceIdx];
      if (reply) ctx.state.baseline.variables.mio_road_reply = reply;
      return;
    }
    if (scriptId !== "letter_02_rival" || choiceIdx < 0 || choiceIdx > 2) return;
    const m = moduleState(ctx);
    if (m.companion) {
      ctx.state.baseline.switches[`companion_${m.companion}`] = false;
    }
    m.companion = "mio";
    m.companionHp = 10;
    ctx.state.baseline.switches.companion_mio = true;
  },

  // ============== Companion-aware reducers ==============
  //
  // onActionDispatch (first-wins): when a companion is in party at
  // critical HP, veto `attack` and `sneak_strike` dispatches. Player
  // must flee, use chinkonho, or let HP recover before re-engaging.
  // Returns "cancel" — engine still fires onActionComplete with
  // result=undefined, but the handler body doesn't run.
  onActionDispatch: (ctx, action) => {
    const m = moduleState(ctx);
    if (
      m.companion &&
      m.companionHp > 0 &&
      m.companionHp <= 3 &&
      (action.kind === "attack" || action.kind === "sneak_strike")
    ) {
      const charName =
        ctx.game.characters.find((c) => c.id === m.companion!)?.name ??
        m.companion!;
      ctx.state.runtime.pendingNarrations.push(
        `${charName}が刀を抑えた。「下がれ、深い」——その目に、お主が今日見たどの鬼より強い意志。攻撃は取り消された。`,
      );
      return "cancel";
    }
    return;
  },

  // onBeatBefore (reducer): in bond scripts, if the player's spectral
  // is already past the "危険" threshold (≥50), shadow specific dialogue
  // beats with an alternate text that acknowledges the change. Uses
  // the `{ replace: <beat> }` return form so the timeline still
  // advances one beat per drain.
  onBeatBefore: (ctx, scriptId, _beatIdx, beat) => {
    if (
      scriptId === "ending_oni_self" &&
      ctx.state.baseline.switches.three_flowers_death_pledge === true &&
      beat.type === "narration"
    ) {
      if (beat.text.startsWith("「三人とも、隣にいてくれ」。月下で口にした願いは")) {
        return {
          replace: {
            ...beat,
            text: "「お主たちと共に死ぬ覚悟を、私は持っている」。月下で口にした覚悟は、鬼の脈にも喰われず、三人に返した命の約束として残っている。",
          },
        };
      }
      if (beat.text.startsWith("門の先へ行けば、同じ隣には戻れない。それでも三名連署は")) {
        return {
          replace: {
            ...beat,
            text: "門の先へ行けば、同じ命では戻れない。それでも共に死ぬと口にした覚悟は、今ここで独りだけ先に死ぬことを許さなかった。",
          },
        };
      }
    }
    if (
      scriptId === "ending_oni_self" &&
      beat.type === "narration" &&
      beat.text.startsWith("「今は、数えなくていい。お主が隣で勝手に鳴らしてる」。")
    ) {
      const reply = ctx.state.baseline.variables.kagari_sleep_reply;
      const memory = reply === "avoid-dreams"
        ? "「夢を見ないようにしている」と答えた宿の月夜。"
        : reply === "chinkonho"
          ? "「鎮魂法で、毎晩二十押し返す」と答えた宿の月夜。"
          : reply === "sleepless"
            ? "「眠らない」と答え、それは答えじゃないと斬られた宿の月夜。"
            : null;
      if (memory) return { replace: { ...beat, text: `${memory}${beat.text}` } };
    }
    if (
      scriptId === "ending_oni_self" &&
      beat.type === "narration" &&
      beat.text.startsWith("門の先へ行けば、その隣へ同じ足では戻れない。")
    ) {
      const reply = ctx.state.baseline.variables.kagari_rain_reply;
      const memory = reply === "alive"
        ? "「死んでない」と言い切った雨夜。"
        : reply === "count-before-me"
          ? "数え直すなら自分の前だけにしろと告げた雨夜。"
          : reply === "poured-back"
            ? "言葉の代わりに篝の盃へ注ぎ返した雨夜。"
            : null;
      if (memory) return { replace: { ...beat, text: `${memory}${beat.text}` } };
    }
    if (
      scriptId === "ending_oni_self" &&
      beat.type === "narration" &&
      beat.text.startsWith("門の先へ行けば、同じ道では帰れない。")
    ) {
      const reply = ctx.state.baseline.variables.kasumi_final_reply;
      const memory = reply === "without-reason"
        ? "役目も理由もなく隣を歩けと告げた山道。"
        : reply === "her-footsteps"
          ? "迷った時は霞の足音を追って帰ると決めた山道。"
          : reply === "half-step"
            ? "霞の隣へ半歩戻り、二人分の足跡を並べた山道。"
            : null;
      if (memory) return { replace: { ...beat, text: `${memory}${beat.text}` } };
    }
    if (
      scriptId === "ending_oni_self" &&
      beat.type === "narration" &&
      beat.text.startsWith("「未だ堕ちず」。あの見立てを、")
    ) {
      const reply = ctx.state.baseline.variables.mio_mirror_reply;
      const memory = reply === "younger-shadow"
        ? "水鏡に置き去りの若い影まで並べた夕暮れ。"
        : reply === "future-direction"
          ? "鏡は未来でなく、まだ選べる方角を示すと聞いた夕暮れ。"
          : reply === "stay-beside"
            ? "沙汰ではなく自分の意志で隣にいると答えた夕暮れ。"
            : null;
      if (memory) return { replace: { ...beat, text: `${memory}${beat.text}` } };
    }
    if (
      scriptId === "bond_kagari_01" &&
      beat.type === "dialogue" &&
      beat.text === "いや、答えなくていい。顔色で大体わかる。"
    ) {
      const reply = ctx.state.baseline.variables.kagari_first_reply;
      const memory = reply === "shared-curse"
        ? "初めて会った時、お主はあたしを同類だと見抜いたな。"
        : reply === "silent-nod"
          ? "初めて会った時と同じ顔だ。黙っていても、大体わかる。"
          : reply === "wary"
            ? "初めて会った時は、面倒事だと言っていた顔だ。"
            : null;
      if (memory) return { replace: { ...beat, text: `${memory} ${beat.text}` } };
    }
    if (
      scriptId === "bond_kasumi_01" &&
      beat.type === "dialogue" &&
      beat.text === "いや、刀のこと。あんたが折れる、って言いかけて、刀って言い直した。同じことかと思って。"
    ) {
      const reply = ctx.state.baseline.variables.kasumi_first_reply;
      const memory = reply === "gratitude"
        ? "初めて会った時、命の礼を言った人だから、先に訊いておきたい。"
        : reply === "family-trade"
          ? "家業だって言ってたよね。だからこそ、先に訊いておきたい。"
          : reply === "shogunate"
            ? "将軍家の命でも、折れる時まで決めてはくれないでしょ。"
            : null;
      if (memory) return { replace: { ...beat, text: `${memory} ${beat.text}` } };
    }
    if (
      scriptId === "bond_kagari_01" &&
      beat.type === "dialogue" &&
      beat.text === "答えは——夜が長いから、いつかまた。"
    ) {
      const reply = ctx.state.baseline.variables.kagari_bond_reply;
      if (reply === "accepted-flask") {
        return {
          replace: {
            ...beat,
            text: "……訊かないんだな。それでも、夜が長いうちに、いつか話す。",
          },
        };
      }
    }
    if (
      scriptId === "bond_kasumi_01" &&
      beat.type === "dialogue" &&
      beat.text === "……ありがとう。"
    ) {
      const reply = ctx.state.baseline.variables.kasumi_bond_reply;
      const response = reply === "not-foolish"
        ? "……そう言ってくれるんだ。ありがとう。"
        : reply === "same-loss"
          ? "……同じ、か。じゃあ、馬鹿げてても一人じゃないね。"
          : reply === "sat-beside"
            ? "……そういう座り方、ずるいな。ありがとう。"
            : null;
      if (response) return { replace: { ...beat, text: response } };
    }
    if (
      scriptId === "bond_kagari_04" &&
      beat.type === "dialogue" &&
      beat.text === "答えるよ。今夜は、十分に長い。"
    ) {
      const reply = ctx.state.baseline.variables.kagari_road_reply;
      const memory = reply === "return-alone"
        ? "あの道で、自分の足で引き返すと言ったな。その一歩を見届ける約束は、まだ生きてる。"
        : reply === "last-resort"
          ? "間に合わなければ斬れと言った、あの道の約束も忘れてない。だから今夜は、間に合ううちに話す。"
          : reply === "spear-promise"
            ? "あの道で槍に重ねた手の意味を、あたしは忘れてない。言葉にしなかった分まで、今夜は話す。"
            : null;
      if (memory) return { replace: { ...beat, text: `${memory} ${beat.text}` } };
    }
    if (
      scriptId === "bond_kagari_04" &&
      beat.type === "dialogue" &&
      beat.text === "最初の夜、伯母を斬ったことを話したな。あのとき、あたしは答えを一つ、徳利の底に置いてきた。" &&
      ctx.state.baseline.variables.kagari_bond_reply === "accepted-flask"
    ) {
      return {
        replace: {
          ...beat,
          text: "最初の夜、伯母を斬ったことを話したな。お主は何も訊かず、徳利を受け取った。あの沈黙に、あたしは答えを一つ隠した。",
        },
      };
    }
    if (
      scriptId === "bond_kagari_04" &&
      beat.type === "dialogue" &&
      beat.text === "「夜が長いから、いつかまた」——そう言って逃げた。覚えてるか。" &&
      ctx.state.baseline.variables.kagari_bond_reply === "accepted-flask"
    ) {
      return {
        replace: {
          ...beat,
          text: "「夜が長いうちに、いつか話す」——そう言って逃げた。覚えてるか。",
        },
      };
    }
    if (
      scriptId === "bond_kasumi_04" &&
      beat.type === "dialogue" &&
      beat.text === "……今の、あたし、何も教えてないよ。"
    ) {
      const reply = ctx.state.baseline.variables.kasumi_road_reply;
      const memory = reply === "no-loss"
        ? "前に、あたしを失くすわけにはいかないって言ったよね。だから分かってた。"
        : reply === "returning-step"
          ? "あたしを連れて帰る足音を覚えたって、前に言ったよね。だから分かってた。"
          : reply === "rested-bow"
            ? "前に、父の弓を膝へ預けても、あんたは黙って一緒に持ってくれた。だから分かってた。"
            : null;
      if (memory) return { replace: { ...beat, text: `${memory} ${beat.text}` } };
    }
    if (
      scriptId === "bond_kasumi_04" &&
      beat.type === "dialogue" &&
      beat.text === "言ったよね、あたし。あんたが鹿の道を歩けるようになったら、役目は終わりだって。"
    ) {
      const reply = ctx.state.baseline.variables.kasumi_deer_reply;
      const memory = reply === "why-walk"
        ? "言ったよね。鹿の道を歩けるようになって、役目が終わっても、隣を歩きたいって。"
        : reply === "hunter-blade"
          ? "言ったよね。あんたの足跡が逃げ道に残った時、あたしは刀を持つって。"
          : null;
      if (memory) return { replace: { ...beat, text: memory } };
    }
    if (
      scriptId === "bond_kasumi_04" &&
      beat.type === "dialogue" &&
      beat.text === "終わっちゃった。たった今。" &&
      ctx.state.baseline.variables.kasumi_deer_reply === "hunter-blade"
    ) {
      return { replace: { ...beat, text: "教える役目は、終わっちゃった。たった今。" } };
    }
    if (
      scriptId === "bond_kasumi_04" &&
      beat.type === "dialogue" &&
      beat.text === "父の弓は「失くさないため」に引くんだって、ようやく分かったところなのに。"
    ) {
      const reply = ctx.state.baseline.variables.kasumi_bond_reply;
      const memory = reply === "not-foolish"
        ? "馬鹿げてないって言ってくれた、"
        : reply === "same-loss"
          ? "「俺も同じだ」って言った、"
          : reply === "sat-beside"
            ? "あの夜みたいに黙って隣へ来る、"
            : null;
      if (memory) return { replace: { ...beat, text: `${memory}${beat.text}` } };
    }
    if (
      scriptId === "bond_mio_03" &&
      beat.type === "dialogue" &&
      beat.text === "私の家業——水鏡——は、自分を見るためのものでもある。"
    ) {
      const reply = ctx.state.baseline.variables.mio_inquest_reply;
      const memory = reply === "self-mirror"
        ? "あの夕暮れ、お主は私の鏡に私を映せと言ったな。今夜、ようやく従う。"
        : reply === "second-death"
          ? "あの夕暮れ、お主は二人目をまだ数えているのかと訊いたな。答えは、今も同じだ。"
          : reply === "silent-stone"
            ? "あの夕暮れ、お主が落とした小石は、測る側の影も同じように歪めた。"
            : null;
      if (memory) return { replace: { ...beat, text: `${memory} ${beat.text}` } };
    }
    if (
      scriptId === "bond_mio_04" &&
      beat.type === "dialogue" &&
      beat.text === "ずっと、出せずにいた。出せば役目が終わる。終われば、隣にいる理由が消える。"
    ) {
      const mirrorReply = ctx.state.baseline.variables.mio_mirror_reply;
      const roadReply = ctx.state.baseline.variables.mio_road_reply;
      const memories = [
        mirrorReply === "stay-beside"
          ? "水鏡の前で、私は自分の意志で隣にいると答えた。"
          : null,
        roadReply === "reject-false-duty"
          ? "あの水辺では、役目を嘘にするなと言われた。"
          : roadReply === "stay-without-duty"
            ? "あの水辺では、役目が無くても隣にいろと言われた。"
            : roadReply === "share-private-feeling"
              ? "あの水辺では、この私情を共に持つと言われた。"
              : null,
      ].filter((memory): memory is string => memory !== null);
      if (memories.length > 0) {
        return {
          replace: {
            ...beat,
            text: `${memories.join("")}それでも、出せずにいた。出せば役目という最後の口実が消える。`,
          },
        };
      }
    }
    if (!scriptId.startsWith("bond_")) return;
    if (beat.type !== "dialogue") return;
    if (playerStat(ctx, "spectral") < 50) return;
    // Replace one specific tag — first dialogue beat where speaker is
    // the bond target — with a darker variant. We just append a
    // suffix to make it cheap & uniform.
    return {
      replace: {
        ...beat,
        text: `${beat.text}（——その目を、見つめ返せなかった。お主の瞳が、いつもと違うらしい。）`,
      },
    };
  },

  // onChoicePresented (reducer): in bond_*_03 scenes, when a *different*
  // companion is in party, lock the boldest option (the last one, which
  // is the +2-affection "I commit" choice). Player can still pick the
  // milder options. The lock represents "I won't say that in front of
  // her" social pressure.
  //
  // NOTE on the reducer surface: the engine's runScript resolves choices
  // by indexing back into the original `beat.options` (runScript.ts:105).
  // That means reducers can MARK options unavailable but cannot ADD new
  // ones meaningfully — extra options shown to the player don't have a
  // corresponding ChoiceOption to dispatch. So this hook is for
  // contextual locking only, matching hook-test's coverage.
  onChoicePresented: (ctx, scriptId, _beatIdx, options) => {
    if (!scriptId.match(/^bond_\w+_03$/)) return;
    let nextOptions = options;
    if (
      scriptId === "bond_kagari_03" &&
      !ctx.state.baseline.knownSkills.includes("chinkonho")
    ) {
      nextOptions = nextOptions.map((opt, idx) => idx === 1
        ? {
            ...opt,
            available: false,
            lockedReason: "鎮魂法をまだ伝授されていない。",
            requires: { switch: { name: "learnedChinkonho" } },
          }
        : opt);
    }
    const m = moduleState(ctx);
    if (!m.companion) return nextOptions === options ? undefined : nextOptions;
    const subjectMatch = scriptId.match(/^bond_(\w+)_03$/);
    if (!subjectMatch) return;
    const subject = subjectMatch[1];
    if (m.companion === subject) {
      return nextOptions === options ? undefined : nextOptions;
    }
    const sideName =
      ctx.game.characters.find((c) => c.id === m.companion!)?.name ??
      m.companion!;
    const lastIdx = options.length - 1;
    return nextOptions.map((opt, idx) =>
      idx === lastIdx
        ? {
            ...opt,
            available: false,
            lockedReason: `${sideName}が隣にいる。今ここで口にする言葉ではない。`,
          }
        : opt,
    );
  },

  onHubBuild: (ctx) => {
    // After any ending script completes, the game ends. Returning
    // undefined from onHubBuild signals the preset's run loop to
    // yield gameEnd. This is the engine-canonical way to terminate
    // from a module — no need for a special action or hook.
    const endings = ["ending_pure_rite", "ending_oni_self", "ending_mundane_seal"];
    for (const id of endings) {
      if (ctx.state.baseline.scripts[id]?.completed === true) return undefined;
    }
    const m = moduleState(ctx);
    return m.raid === null ? buildHubMenu(ctx) : buildRaidMenu(ctx);
  },
};

export default raidModule;
