// moon-dive: 月读潜行 module — EXE 风的 jack-in 子玩法骨架 + 隐性热度战。
//
// 责任:
//   - 一个 actionHandler (kind: dive) 处理所有 6 个 dive_* action,
//     按 action.id 分派到对应节点的掉落表。每次潜行 RNG 决定本次见闻。
//   - 私有状态 state["moon-dive"]: 每个节点的访问次数 + 是否已撞见 X / 八千代。
//   - 一组 once-only 触发器: 闺蜜、哥哥、目标提示、X、八千代试探、八千代删自己、
//     芦花的一瞬、X 移交、通电前夜。
//     都通过直接写 ctx.state.baseline.currentScriptId 来"插播"剧本——
//     训练 preset 的 run loop 下一轮会优先跑掉 current script，然后再回 hub。
//   - **隐性热度战**: onActionComplete 后每个 cost ≥ 1 的动作让 heat 衰减 2；
//     如果 heat < 40 触发"注意力虹吸"——随机一项已收集的 data_* -1。
//     这就是八千代"消极删自己数据"的玩法层面体现。彩叶 jacked in 时不知道
//     是八千代在主动放手，只看见数据在掉。
//
// 为什么不放在 yaml 里:
//   actions/*.yaml 的 effects 是确定的；潜行的核心趣味是 RNG。
//   而且 parser 会丢掉非标字段 (nodeId 之类)，所以分派必须靠 action.id。
//   热度衰减/虹吸是计算逻辑，不是单次 action 的 effects 能表达的。

import type {
  ActionContext,
  ActionHandler,
  ActionResult,
  Module,
  PresetContext,
  StateDelta,
  Trigger,
} from "@rpg-harness/engine";

const MODULE_ID = "moon-dive";

type NodeId = "konbini" | "hospital" | "idol" | "home" | "core" | "blackonyx";

interface DiveState {
  visits: Record<NodeId, number>;
  metX: boolean;
  yachiyoTested: boolean;
  // stream_collab 累计次数。triggers 用条件 DSL 读不到 module state，所以
  // 计数器在这里维护，当跨过阈值时把一个 switch 翻成 true，trigger 用
  // switch 条件触发。
  streamCollabCount: number;
  // Scripts queued by triggers that couldn't claim currentScriptId at fire
  // time. Drained FIFO in onScriptComplete / onActionComplete. Without
  // this, a trigger that fires while another script is running gets its
  // payload silently dropped (once: true means it won't re-fire).
  pendingScripts: string[];
  // Per-action visit counts for action-bound story chains. Currently
  // tracks `study` to fire 古川 教授 chain at visits 3 / 6 / 10. Add more
  // entries as we extend other actions (work, coffee, rest, …) with chains.
  studyVisits: number;
}

function initial(): DiveState {
  return {
    visits: { konbini: 0, hospital: 0, idol: 0, home: 0, core: 0, blackonyx: 0 },
    metX: false,
    yachiyoTested: false,
    streamCollabCount: 0,
    pendingScripts: [],
    studyVisits: 0,
  };
}

function moduleState(state: { [k: string]: unknown }): DiveState {
  const s = state[MODULE_ID];
  if (!s) throw new Error(`${MODULE_ID}: state missing — initialize hook didn't run?`);
  return s as DiveState;
}

// Pick one of `weights.length` indices, with the given probability weights.
function weightedPick(rng: () => number, weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

// ----------------------------------------------------------------------------
// Node-specific dive outcomes. Each returns the per-roll deltas + narration.
// Common cost: stamina -1 (subtracted by handler, not by per-node fn).
// ----------------------------------------------------------------------------

type Outcome = { deltas: StateDelta; narration: string };

function diveKonbini(rng: () => number): Outcome {
  // Mainly motor data. Tiny chance of x_intel bump (loitering data of
  // a similar-frame avatar).
  const roll = weightedPick(rng, [55, 30, 12, 3]);
  if (roll === 0)
    return {
      deltas: { stats: { data_motor: 5 } },
      narration: "POS 协议里翻出几段步态记录。+5 运动模型。",
    };
  if (roll === 1)
    return {
      deltas: { stats: { data_motor: 9, funds: -1 } },
      narration: "扫描枪固件被你重写了——找到一组完整的手部轨迹，但触发了报警，赔了一份盒饭。+9 运动 / -1 资金。",
    };
  if (roll === 2)
    return {
      deltas: { stats: { data_motor: 2, data_voice: 3 } },
      narration: "店员闲聊被录进 POS 日志。声纹意外加成。+2 运动 / +3 声纹。",
    };
  return {
    deltas: { stats: { data_motor: 7, x_intel: 8 } },
    narration: "凌晨三点的收银监控里有一个长得像你的女人路过。她没买东西。+7 运动 / +8 X 线索。",
  };
}

function diveHospital(rng: () => number): Outcome {
  // High-value neural, with bigger risk.
  const roll = weightedPick(rng, [40, 35, 20, 5]);
  if (roll === 0)
    return {
      deltas: { stats: { data_neural: 12, stamina: -1 } },
      narration: "脑机接口测试样本一整批被你拷走。+12 神经映射 / -1 心力。",
    };
  if (roll === 1)
    return {
      deltas: { stats: { data_neural: 18, data_motor: 4 } },
      narration: "运动皮层与小脑映射的全套基线。这正是辉夜缺的那块。+18 神经 / +4 运动。",
    };
  if (roll === 2)
    return {
      deltas: { stats: { data_neural: 6, funds: -8 } },
      narration: "防火墙抬头瞥了你一眼。你假装是 IT 部然后塞了点钱。+6 神经 / -8 资金。",
    };
  return {
    deltas: { stats: { data_neural: 3, engineering: -5 } },
    narration: "蜜罐。你被请去喝茶。本学期讲座资格丢了。+3 神经 / -5 工学。",
  };
}

function diveIdol(rng: () => number): Outcome {
  // Voice-focused; this is where X most often gets spotted.
  const roll = weightedPick(rng, [45, 25, 20, 10]);
  if (roll === 0)
    return {
      deltas: { stats: { data_voice: 10 } },
      narration: "顶流主播的喉部共振模型，自己往你手心里掉。+10 声纹。",
    };
  if (roll === 1)
    return {
      deltas: { stats: { data_voice: 6, x_intel: 12 } },
      narration: "X 的后台直播缓存。她唱歌时的共振模型和你高度相似——这绝不是巧合。+6 声纹 / +12 X 线索。",
    };
  if (roll === 2)
    return {
      deltas: { stats: { data_voice: 14, stamina: -1 } },
      narration: "整夜泡在虚拟混音棚里。你把那首没写完的歌补完了。+14 声纹 / -1 心力。",
    };
  return {
    deltas: { stats: { data_voice: 7, data_memory: 3, x_intel: 5 } },
    narration: "八千代直播的旧存档里夹了一段不属于她的旋律。是辉夜的。也是 X 的。+7 声纹 / +3 记忆 / +5 X 线索。",
  };
}

function diveHome(_rng: () => number): Outcome {
  // Safe, low-yield. Deterministic small all-around gain.
  return {
    deltas: { stats: { data_motor: 2, data_neural: 2, data_voice: 2, stamina: 1 } },
    narration: "扫地机器人和冰箱的固件被你彻底翻了一遍。安全节点，回了点心力。+2 各类 / +1 心力。",
  };
}

// 月読核心 dive。月读最深一层，唯一记忆碎片来源。每次见她都不太一样。
// 池子按访问轮次切：
//   - 第 1 次：决定性的初见，确定不随机
//   - kaguya_truth 撞破前：常规池 10 段，平均 ~3 记忆 / 次
//   - kaguya_truth 撞破后：递减池 5 段，平均 ~2 记忆 / 次（她在淡）
// 90 天版本 memory 阈值 50，意味着玩家需要约 15 次 core dive 才够 GOOD/TRUE 的
// 数据 — 配合 90 天预算很宽松，留出大量 slot 给其他事。
function diveCore(rng: () => number, visits: number, ctx: ActionContext): Outcome {
  // 决定性初见 —— 不走 RNG，让"第一次"有重量。
  if (visits === 1) {
    return {
      deltas: { stats: { data_memory: 3, bond: 2, funds: -3 } },
      narration:
        "白色空间。她坐在那里像在等。你不知道她等什么，但她抬头看到你，笑了一下。「你来了。」+3 记忆 / +2 心连 / -3 资金。",
    };
  }

  // kaguya_truth 之后她在淡 —— 不同情绪温度的池子。
  const truthSeen =
    ctx.state.baseline.scripts["evt_kaguya_truth"]?.completed === true;
  if (truthSeen) {
    const roll = weightedPick(rng, [25, 25, 20, 20, 10]);
    if (roll === 0)
      return {
        deltas: { stats: { data_memory: 2, bond: 2, funds: -3 } },
        narration:
          "她坐在你昨天发现被删的那个节点边上。「我没新东西给你了。」她又笑了一下。「但你来了我也开心。」+2 记忆 / +2 心连 / -3 资金。",
      };
    if (roll === 1)
      return {
        deltas: { stats: { data_memory: 1, bond: 3, funds: -3 } },
        narration:
          "她今天说了一段你录不下来的话 —— 你的录音笔自己关掉了。「不许录这种。」她说完，把那段又讲了一遍，更慢。+1 记忆 / +3 心连 / -3 资金。",
      };
    if (roll === 2)
      return {
        deltas: { stats: { data_memory: 0, bond: 1, funds: -3 } },
        narration:
          "她让你回去。「真的。今天我不想被你看见。」白色空间外面下雪。你的设备外面也下雪。+1 心连 / -3 资金。",
      };
    if (roll === 3)
      return {
        deltas: { stats: { data_memory: 5, bond: -2, funds: -3 } },
        narration:
          "你今天进核心比往常深。看见一些她明显不希望你看见的东西 —— 8000 年里某一段她独自走的路。她转过身。「出去。」+5 记忆 / -2 心连 / -3 资金。",
      };
    return {
      deltas: { stats: { data_memory: 3, bond: 1, data_voice: 3, funds: -3 } },
      narration:
        "她说「我把今天这段唱完，你就去做别的事行不行？」她唱完。你没动。她也没动。+3 记忆 / +1 心连 / +3 声纹 / -3 资金。",
    };
  }

  // 常规池 —— 撞破真相之前。10 段，权重略偏向常见日常。
  const roll = weightedPick(rng, [14, 14, 12, 12, 12, 10, 10, 8, 5, 3]);
  if (roll === 0)
    return {
      deltas: { stats: { data_memory: 3, bond: 1, funds: -3 } },
      narration:
        "她讲了一段你不记得的童年 —— 你五岁那年掉进神社水池，是你妈妈捞起来的。你确实不记得这件事。她说「不奇怪，你妈也没跟你讲。」+3 记忆 / +1 心连 / -3 资金。",
    };
  if (roll === 1)
    return {
      deltas: { stats: { data_memory: 4, funds: -3 } },
      narration:
        "她哼了一首很短的曲子。你打开录音笔。她哼完，看了一眼时间。「下次系统重启前我可能讲不完了。」+4 记忆 / -3 资金。",
    };
  if (roll === 2)
    return {
      deltas: { stats: { data_memory: 2, bond: 2, data_voice: 2, funds: -3 } },
      narration:
        "她说今天能不能多待一会。你陪她坐到下次系统例行重启。期间她说了三个名字 —— 都是你不认识的人。「8000 年里我认识的人。她们也都老了。」+2 记忆 / +2 心连 / +2 声纹 / -3 资金。",
    };
  if (roll === 3)
    return {
      deltas: { stats: { data_memory: 3, bond: 2, funds: -3 } },
      narration:
        "她在白色空间里画了一棵竹子。「这是我第一次见你那天的竹子。你忘了吗？」你没忘。你只是没料到 8000 年了她还记得那棵竹子的纹路。+3 记忆 / +2 心连 / -3 资金。",
    };
  if (roll === 4)
    return {
      deltas: { stats: { data_memory: 3, bond: 1, data_motor: 2, funds: -3 } },
      narration:
        "她在白色空间里跳了几下，转了个圈。「你看，我会跳了。」你说原来你不会？她说「8000 年总能学会一点东西吧。」+3 记忆 / +1 心连 / +2 运动模型 / -3 资金。",
    };
  if (roll === 5)
    return {
      deltas: { stats: { data_memory: 5, funds: -3 } },
      narration:
        "她拿出一本看起来很旧的纸本翻给你看。「这是我那时候自己写的。后来变成《竹取物语》了。」你说骗人。她说「真的。我妈妈是月亮 —— 这件事是我写进去的，因为我没别的方式跟你说。」+5 记忆 / -3 资金。",
    };
  if (roll === 6)
    return {
      deltas: { stats: { data_memory: 2, bond: 1, funds: -3 } },
      narration:
        "她让你回放她昨天的那段哼唱。「我自己不记得哼过这个。」你说要不要我帮你存下来。她说「不用了，反正你记得就行。」+2 记忆 / +1 心连 / -3 资金。",
    };
  if (roll === 7)
    return {
      deltas: { stats: { data_memory: 1, bond: 1, funds: -3 } },
      narration:
        "她什么都没说。你也什么都没说。系统例行重启。你下线时她朝你挥了一下手 —— 这是她第一次主动跟你做这个动作。+1 记忆 / +1 心连 / -3 资金。",
    };
  if (roll === 8)
    return {
      deltas: { stats: { data_memory: 5, bond: -1, funds: -3 } },
      narration:
        "她今天的色温不太对，比平时偏蓝。你问她怎么了。她说「数据稍微紧了一点。今天不要待太久。」她让你拷走了平常不会给的一段，然后让你走。+5 记忆 / -1 心连 / -3 资金。",
    };
  return {
    deltas: { stats: { data_memory: 8, bond: -2, funds: -3 } },
    narration:
      "她突然认不出你了。看着你的眼睛和看路灯一样。今天她吐出来很多记忆碎片 —— 全是 8000 年里某个你不知道的人的脸。但她没回来。+8 记忆 / -2 心连 / -3 资金。",
  };
}

function diveBlackonyx(rng: () => number): Outcome {
  // Brother's esports team servers — ceiling for motor data, side voice.
  const roll = weightedPick(rng, [50, 30, 15, 5]);
  if (roll === 0)
    return {
      deltas: { stats: { data_motor: 14 } },
      narration: "Black onyX 主力的手部抽帧。+14 运动模型。",
    };
  if (roll === 1)
    return {
      deltas: { stats: { data_motor: 20, data_neural: 6 } },
      narration: "队内复盘录像 + 实时反应基线。整套完整数据。+20 运动 / +6 神经。",
    };
  if (roll === 2)
    return {
      deltas: { stats: { data_motor: 10, data_voice: 8 } },
      narration: "团队语音的实战录音。骂队友的也算声纹。+10 运动 / +8 声纹。",
    };
  return {
    deltas: { stats: { data_motor: 8 }, affection: { asahi: -1 } },
    narration: "你在哥哥的私聊里翻到一句——她最近有点不对。+8 运动 / 哥哥心里有点数。",
  };
}

// Node fns share a signature so the handler can dispatch uniformly.
// Most ignore `visits` / `ctx` — diveCore uses both for visit-aware /
// truth-aware narration tiers.
type NodeFn = (
  rng: () => number,
  visits: number,
  ctx: ActionContext,
) => Outcome;
const NODE_TABLE: Record<NodeId, NodeFn> = {
  konbini: (rng) => diveKonbini(rng),
  hospital: (rng) => diveHospital(rng),
  idol: (rng) => diveIdol(rng),
  home: (rng) => diveHome(rng),
  core: diveCore,
  blackonyx: (rng) => diveBlackonyx(rng),
};

function nodeFromActionId(id: string): NodeId | undefined {
  if (!id.startsWith("dive_")) return undefined;
  const key = id.slice(5) as NodeId;
  return key in NODE_TABLE ? key : undefined;
}

// ----------------------------------------------------------------------------
// Handler
// ----------------------------------------------------------------------------

const diveHandler: ActionHandler = (ctx: ActionContext): ActionResult => {
  const node = nodeFromActionId(ctx.action.id);
  if (!node) {
    return { narrations: [`未知潜行节点：${ctx.action.id}`] };
  }
  const m = moduleState(ctx.state);
  m.visits[node] += 1;

  const outcome = NODE_TABLE[node](ctx.rng, m.visits[node], ctx);
  // Always charge 1 stamina (except home, which restores; net handled per-node).
  const stamCost = node === "home" ? 0 : -1;
  const baseStats: Record<string, number> = stamCost ? { stamina: stamCost } : {};
  const mergedStats = { ...baseStats, ...(outcome.deltas.stats ?? {}) };
  // Re-sum stamina if both base and per-outcome wrote it.
  if (stamCost && outcome.deltas.stats?.stamina !== undefined) {
    mergedStats.stamina = stamCost + outcome.deltas.stats.stamina;
  }

  return {
    deltas: { ...outcome.deltas, stats: mergedStats },
    narrations: [`[潜行 · ${nodeLabel(node)}] ${outcome.narration}`],
  };
};

function nodeLabel(node: NodeId): string {
  return {
    konbini: "便利店收银网",
    hospital: "医院神经科",
    idol: "偶像直播间",
    home: "自家家电",
    core: "月读核心",
    blackonyx: "Black onyX 战队后端",
  }[node];
}

// ----------------------------------------------------------------------------
// Triggers — fire scripts when story milestones cross.
// Hide the launched scripts from the hub menu by giving them an
// unreachable `requires:` in their .md frontmatter.
// ----------------------------------------------------------------------------

// Triggers fire on rising-edge once each. If currentScriptId is busy when
// we fire, the script can't start — and with once: true it never retries.
// So we promote-or-defer: take currentScriptId if free, otherwise queue
// to module state and let drainPending pick it up later.
function queueScript(ctx: PresetContext, scriptId: string): void {
  if (ctx.state.baseline.currentScriptId === null) {
    ctx.state.baseline.currentScriptId = scriptId;
    ctx.state.baseline.beatIndex = 0;
    return;
  }
  const m = moduleState(ctx.state);
  if (!m.pendingScripts.includes(scriptId)) {
    m.pendingScripts.push(scriptId);
  }
}

function drainPending(ctx: PresetContext): void {
  if (ctx.state.baseline.currentScriptId !== null) return;
  const m = moduleState(ctx.state);
  while (m.pendingScripts.length > 0) {
    const next = m.pendingScripts.shift()!;
    // Skip if already completed (could happen if seeded fixture marks done).
    if (ctx.state.baseline.scripts[next]?.completed === true) continue;
    if (!ctx.scriptMap.has(next)) continue;
    ctx.state.baseline.currentScriptId = next;
    ctx.state.baseline.beatIndex = 0;
    return;
  }
}

// ----------------------------------------------------------------------------
// Action-bound story chains.
// Pattern: each "chain" action tracks its own visit count in module state.
// On each visit, queue the next chain script if a milestone visit is hit.
// Also refresh the hub marker so the player sees "★ 上课" when the next
// visit will trigger new content. The marker auto-clears when there's no
// pending chain content.
// ----------------------------------------------------------------------------

const STUDY_CHAIN: Array<{ atVisit: number; scriptId: string }> = [
  { atVisit: 3, scriptId: "evt_study_synapse" },
  { atVisit: 6, scriptId: "evt_study_prof_notices" },
  { atVisit: 10, scriptId: "evt_study_prof_opens" },
];

function handleStudyVisit(ctx: PresetContext): void {
  const m = moduleState(ctx.state);
  m.studyVisits = (m.studyVisits ?? 0) + 1;
  const v = m.studyVisits;
  const scripts = ctx.state.baseline.scripts;
  for (const step of STUDY_CHAIN) {
    if (v === step.atVisit && scripts[step.scriptId]?.completed !== true) {
      queueScript(ctx, step.scriptId);
    }
  }
}

function refreshStudyMarker(ctx: PresetContext): void {
  const m = moduleState(ctx.state);
  const next = (m.studyVisits ?? 0) + 1;
  const scripts = ctx.state.baseline.scripts;
  const markers = (ctx.state.runtime.hubMarkers ??= {});
  const pendingChain = STUDY_CHAIN.find(
    (s) =>
      s.atVisit === next && scripts[s.scriptId]?.completed !== true,
  );
  if (pendingChain) markers["action:study"] = "★";
  else delete markers["action:study"];
}

const triggers: Trigger[] = [
  // ——— 第一年 ———
  // 闺蜜上线：开场结束后的第一次 hub iteration 就触发。
  {
    id: "friends_first",
    once: true,
    when: { scriptCompleted: "001_intro" },
    do: (ctx) => {
      queueScript(ctx, "evt_friends_first");
      return {};
    },
  },
  // 哥哥首联系：开学第一周末（day ≥ 5）。
  {
    id: "asahi_first",
    once: true,
    when: {
      all: [
        { scriptCompleted: "evt_friends_first" },
        { day: { min: 5 } },
      ],
    },
    do: (ctx) => {
      queueScript(ctx, "evt_asahi_first");
      return {};
    },
  },
  // 目标提示：哥哥电话挂完后，彩叶在笔记本上写下三年要达成的硬指标。
  // 把 endConditions 在剧情里露给玩家——避免靠翻 game.yaml 才知道要冲哪。
  {
    id: "goal_hint",
    once: true,
    when: { scriptCompleted: "evt_asahi_first" },
    do: (ctx) => {
      queueScript(ctx, "evt_goal_hint");
      return {};
    },
  },
  // ambient: 犬DOGE 早晨的一段小戏。day ≥ 3 + 闺蜜首场已完成 → 第一次正经的
  // 日常清晨。不耗 slot、不影响 stat —— 纯氛围。这是"走到哪都有东西看"的
  // 第一道证明。
  {
    id: "doge_morning",
    once: true,
    when: {
      all: [
        { day: { min: 3 } },
        { scriptCompleted: "evt_friends_first" },
      ],
    },
    do: (ctx) => {
      queueScript(ctx, "evt_doge_morning");
      return {};
    },
  },
  // ——— 第二年（约 day 30 起）———
  // X 浮出水面：x_intel 攒到 15。
  {
    id: "x_first_seen",
    once: true,
    when: { stat: { name: "x_intel", min: 15 } },
    do: (ctx) => {
      const m = moduleState(ctx.state);
      m.metX = true;
      queueScript(ctx, "evt_x_first_seen");
      return {};
    },
  },
  // 闺蜜察觉：进游戏一个月后（day ≥ 30）+ 闺蜜首场完成。
  {
    id: "friends_suspect",
    once: true,
    when: {
      all: [
        { day: { min: 30 } },
        { scriptCompleted: "evt_friends_first" },
      ],
    },
    do: (ctx) => {
      queueScript(ctx, "evt_friends_suspect");
      return {};
    },
  },
  // 八千代试探：核心去深了（memory ≥ 30，新尺度下约半程）+ bond 到位。
  {
    id: "yachiyo_test",
    once: true,
    when: {
      all: [
        { stat: { name: "data_memory", min: 30 } },
        { stat: { name: "bond", min: 5 } },
      ],
    },
    do: (ctx) => {
      const m = moduleState(ctx.state);
      m.yachiyoTested = true;
      queueScript(ctx, "evt_yachiyo_test");
      return {};
    },
  },
  // 顶流榜异动：八千代第一次承认看见 X，但她说"没事"。
  // 触发：哥哥首电话后 + heat 已经掉到 ≤ 45（玩家忽视过 stream 至少一次）。
  // 设计意图：让"装作没事"那场戏自然嵌进玩家自己造成的形势变化里。
  {
    id: "chart_notice",
    once: true,
    when: {
      all: [
        { scriptCompleted: "evt_asahi_first" },
        { stat: { name: "heat", max: 45 } },
      ],
    },
    do: (ctx) => {
      queueScript(ctx, "evt_chart_notice");
      return {};
    },
  },
  // 撞破八千代删自己数据：见过八千代试探 + 又积累出"可被删的东西"。
  // memory ≥ 35 = 比 yachiyo_test 的 30 多一点，留出"她又删了几次"的窗口。
  {
    id: "kaguya_truth",
    once: true,
    when: {
      all: [
        { scriptCompleted: "evt_yachiyo_test" },
        { stat: { name: "data_memory", min: 35 } },
      ],
    },
    do: (ctx) => {
      queueScript(ctx, "evt_kaguya_truth");
      return {};
    },
  },
  // 芦花的一瞬：仅对真的把芦花放在心上的玩家开放（好感 ≥ 8）。
  // day ≥ 40 = 进入第二年中段，已经过完一个完整的春夏轮替。
  // 不到位的玩家完全错过这条暗线，这是对他们道德的镜像 — 不是 bug。
  {
    id: "ashihana_glimpse",
    once: true,
    when: {
      all: [
        { day: { min: 40 } },
        { affection: { character: "ashihana", min: 8 } },
        { scriptCompleted: "evt_friends_suspect" },
      ],
    },
    do: (ctx) => {
      queueScript(ctx, "evt_ashihana_glimpse");
      return {};
    },
  },
  // ——— 友情线 · 喝咖啡奖励事件链 ———
  // 把原来 town 常驻的 coffee_with_friends action 拆成 4 段独立剧情。
  // 每段触发条件不同，避免"天天和闺蜜喝咖啡"的违和感。
  // 第一次：开学后第一周末，三人正经坐下来。
  {
    id: "coffee_first",
    once: true,
    when: {
      all: [
        { scriptCompleted: "evt_friends_first" },
        { day: { min: 7 } },
      ],
    },
    do: (ctx) => {
      queueScript(ctx, "evt_coffee_first");
      return {
        deltas: {
          stats: { stamina: 4 },
          characterStats: { ashihana: { affection: 1 }, mami: { affection: 1 } },
        },
      };
    },
  },
  // 真实察觉后的迟疑：单独跟真实坐，彩叶第一次想把芦花也拉进来。
  {
    id: "coffee_doubt",
    once: true,
    when: {
      all: [
        { scriptCompleted: "evt_friends_suspect" },
        { day: { min: 35 } },
      ],
    },
    do: (ctx) => {
      queueScript(ctx, "evt_coffee_doubt");
      return {
        deltas: {
          stats: { stamina: 3 },
          characterStats: { mami: { affection: 1 } },
        },
      };
    },
  },
  // 三人组成军后的第一次工作会：摊开笔记本规划八千代直播。
  {
    id: "coffee_planning",
    once: true,
    when: { scriptCompleted: "evt_team_meeting" },
    do: (ctx) => {
      queueScript(ctx, "evt_coffee_planning");
      return {
        deltas: {
          stats: { stamina: 4, heat: 5 },
          characterStats: { ashihana: { affection: 2 }, mami: { affection: 1 } },
        },
      };
    },
  },
  // 通电前最后一次咖啡：芦花已经哭过、再装作没哭。
  {
    id: "coffee_winter",
    once: true,
    when: {
      all: [
        { scriptCompleted: "evt_team_meeting" },
        { day: { min: 70 } },
      ],
    },
    do: (ctx) => {
      queueScript(ctx, "evt_coffee_winter");
      return {
        deltas: {
          stats: { stamina: 3, bond: 1 },
        },
      };
    },
  },
  // ——— 哥哥电话奖励事件 ———
  // 资金告急时哥哥主动出现（彩叶打过去）。day ≥ 20 避免太早压戏。
  {
    id: "asahi_money",
    once: true,
    when: {
      all: [
        { stat: { name: "funds", max: 5 } },
        { day: { min: 20 } },
        { scriptCompleted: "evt_asahi_first" },
      ],
    },
    do: (ctx) => {
      queueScript(ctx, "evt_asahi_money");
      return {
        deltas: {
          stats: { funds: 25, stamina: -1 },
          characterStats: { asahi: { affection: -1 } },
        },
      };
    },
  },
  // 三人组成军后哥哥也跟进：他看见妹妹身边多了人，主动追加资源。
  {
    id: "asahi_endgame",
    once: true,
    when: {
      all: [
        { scriptCompleted: "evt_team_meeting" },
        { day: { min: 60 } },
      ],
    },
    do: (ctx) => {
      queueScript(ctx, "evt_asahi_endgame");
      return {
        deltas: {
          stats: { funds: 10 },
          characterStats: { asahi: { affection: 2 } },
        },
      };
    },
  },
  // ——— "撑不住 → 求助闺蜜 → 三人组队" 主弧线 ———
  // 触发条件：stream_collab 计 5 次（switch 由 onActionComplete 设置）+
  // stamina/heat 同时低位 = 彩叶一个人扛不下来的具象时刻。
  {
    id: "iroha_burnout",
    once: true,
    when: {
      all: [
        { switch: { name: "burnout_eligible", eq: true } },
        { stat: { name: "stamina", max: 3 } },
        { stat: { name: "heat", max: 45 } },
      ],
    },
    do: (ctx) => {
      queueScript(ctx, "evt_iroha_burnout");
      return {
        // 撞墙的具象化：彩叶熬到天亮没睡。
        deltas: { stats: { stamina: -1 } },
      };
    },
  },
  // burnout 撞过墙之后，彩叶正式约闺蜜见面坦白八千代 = 辉夜。
  {
    id: "friends_join",
    once: true,
    when: { scriptCompleted: "evt_iroha_burnout" },
    do: (ctx) => {
      queueScript(ctx, "evt_friends_join");
      return {
        deltas: {
          characterStats: { ashihana: { affection: 1 }, mami: { affection: 1 } },
        },
      };
    },
  },
  // 三人开始分工。完成后开放 coffee_planning + asahi_endgame。
  {
    id: "team_meeting",
    once: true,
    when: { scriptCompleted: "evt_friends_join" },
    do: (ctx) => {
      queueScript(ctx, "evt_team_meeting");
      return {
        deltas: {
          stats: { stamina: 3, heat: 10 },
          characterStats: { ashihana: { affection: 2 }, mami: { affection: 2 } },
        },
      };
    },
  },
  // ——— 第三年（剧情高潮，约 day 60+）———
  // 通电前夜：4 类数据各自过 35（约 GOOD 阈值 50 的 2/3）。给一波 stat
  // 增益作为奖励，并把"通电前夜"这一刻郑重表达出来。
  {
    id: "body_almost_ready",
    once: true,
    when: {
      all: [
        { stat: { name: "data_neural", min: 35 } },
        { stat: { name: "data_motor",  min: 35 } },
        { stat: { name: "data_voice",  min: 35 } },
        { stat: { name: "data_memory", min: 35 } },
      ],
    },
    do: (ctx) => {
      queueScript(ctx, "evt_body_almost");
      return {
        // 闺蜜送来便当 + 哥哥给了一笔过冬费。
        deltas: { stats: { stamina: 5, funds: 15 } },
      };
    },
  },
  // X 移交（TRUE-end 的入口）：所有硬指标 + 撞破真相 + 顶住热度战。
  // 全跑到这一步意味着玩家：
  //   - 收齐了 4 类数据（4 × 50）→ 有义体的物理基础
  //   - bond ≥ 7 → 八千代真心想留下来
  //   - heat ≥ 50 → 顶住了注意力虹吸
  //   - 撞破了八千代消极删数据这件事 → 在最后一夜的选择里能说出"我要现在的你"
  // 触发后 evt_x_handoff 在结尾给玩家最后一个二选一；end_true 由 endConditions
  // 通过 scriptCompleted 检测兜底。
  {
    id: "x_handoff",
    once: true,
    when: {
      all: [
        { scriptCompleted: "evt_kaguya_truth" },
        { stat: { name: "data_neural", min: 50 } },
        { stat: { name: "data_motor",  min: 50 } },
        { stat: { name: "data_voice",  min: 50 } },
        { stat: { name: "data_memory", min: 50 } },
        { stat: { name: "bond",        min: 7 } },
        { stat: { name: "heat",        min: 50 } },
      ],
    },
    do: (ctx) => {
      queueScript(ctx, "evt_x_handoff");
      return {};
    },
  },
];

// ----------------------------------------------------------------------------
// Heat decay + 注意力虹吸 (data drift). Fires after every cost ≥ 1 action.
// ----------------------------------------------------------------------------

// 90 天版本：每个 cost ≥ 1 的 action（=一天）heat -1。
// 50 起步 / -1/天 → 不 stream 的话 50 天后归零。
// stream_collab 效果 +8，配合衰减 -1 净 +7，玩家约每 7-10 天 stream 一次能稳。
const HEAT_DECAY_PER_SLOT = 1;
const DRIFT_THRESHOLD = 40;
const DATA_KEYS = [
  "data_neural",
  "data_motor",
  "data_voice",
  "data_memory",
] as const;

function applyHeatDecay(ctx: PresetContext): void {
  const t = ctx.state.training;
  if (!t) return;
  const cur = t.stats.heat ?? 50;
  const next = Math.max(0, cur - HEAT_DECAY_PER_SLOT);
  t.stats.heat = next;

  // 注意力虹吸：热度跌破阈值 → 已收集的数据开始漂走。
  // 八千代消极删数据的世界外表达——彩叶看见数据掉，但不知道是谁在删。
  if (next < DRIFT_THRESHOLD) {
    const eligible = DATA_KEYS.filter((k) => (t.stats[k] ?? 0) > 0);
    if (eligible.length === 0) return;
    const idx = Math.floor(ctx.rng() * eligible.length);
    const pick = eligible[idx]!;
    t.stats[pick] = Math.max(0, (t.stats[pick] ?? 0) - 1);
  }
}

// ----------------------------------------------------------------------------
// Module
// ----------------------------------------------------------------------------

const moonDive: Module = {
  id: MODULE_ID,
  version: "0.1.0",
  initialize: () => initial(),
  provides: ["dive"],
  actionHandlers: { dive: diveHandler },
  triggers,
  onSessionStart: (ctx) => {
    // Establish the starting map. The hub builder scopes available
    // actions to the current map; without this the player would see no
    // actions at all on a fresh game. `town` is the everyday starting
    // location; lab/cyber are reachable via connections.
    if (ctx.state.baseline.currentMapId === null) {
      ctx.state.baseline.currentMapId = "town";
    }
    // Auto-queue the intro on first run, same pattern as sengoku-raid.
    if (
      ctx.state.baseline.scripts["001_intro"]?.completed !== true &&
      ctx.scriptMap.has("001_intro") &&
      ctx.state.baseline.currentScriptId === null
    ) {
      ctx.state.baseline.currentScriptId = "001_intro";
      ctx.state.baseline.beatIndex = 0;
    }
    // Recompute markers for resumed sessions (fixtures inject mid-game
    // state; the marker should reflect that state, not a fresh-game empty).
    refreshStudyMarker(ctx);
  },
  // Both hooks drain pending because either one can free currentScriptId:
  // onScriptComplete fires when a trigger-queued script finishes (chain
  // case), onActionComplete fires when a hub action finishes (the more
  // common "trigger fired during a script, deferred, now hub-time" case).
  // Refresh markers on every transition so the hub always reflects what's
  // pending.
  onScriptComplete: (ctx) => {
    drainPending(ctx);
    refreshStudyMarker(ctx);
  },
  // onActionComplete also drives the heat war: every cost ≥ 1 action
  // advances the calendar AND decays heat. move:* and cost:0 scripted
  // beats don't trigger decay.
  // 同时维护 stream_collab 计数器：到 5 时翻 burnout_eligible switch，让
  // iroha_burnout trigger 可以用纯条件 DSL 识别"扛不动"的时机。
  onActionComplete: (ctx, action) => {
    drainPending(ctx);
    if (action.cost > 0) applyHeatDecay(ctx);
    if (action.id === "stream_collab") {
      const m = moduleState(ctx.state);
      m.streamCollabCount += 1;
      if (
        m.streamCollabCount >= 5 &&
        ctx.state.baseline.switches["burnout_eligible"] !== true
      ) {
        ctx.state.baseline.switches["burnout_eligible"] = true;
      }
    }
    if (action.id === "study") handleStudyVisit(ctx);
    refreshStudyMarker(ctx);
  },
};

export default moonDive;
