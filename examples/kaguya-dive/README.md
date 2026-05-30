# 辉夜潜行 / Kaguya Dive

《超时空辉夜姬！》(Studio Colorido, 2026/01) 主线之后那十年的同人养成。
彩叶 18 岁，刚进大学。辉夜失去实体，灵魂数据散在月读全网。
3 年内（原作压缩自 10 年）：捞数据 + 造身体 + 调查那个突然崛起的迷之主播 X。

## 剧情前提

**电影那天**：辉夜被带回月球时，彩叶、芦花、真实、哥哥朝日四人都在着陆架下。
他们以为再也见不到她。

**三年后的现在**：辉夜灵魂残留在月读，主体被「月見八千代」收容在月读核心深处。
八千代 = 8000 年前那个回到过去的辉夜——她见证了 8000 年的孤独，已经不太是当年那个她。

**关键不对称信息**：只有彩叶看穿了「八千代 = 辉夜」。
芦花、真实、朝日、月读两亿用户都不知道。八千代自己也在装作不认识彩叶。

**为什么彩叶不立刻公开**：月読是国民级游戏。"顶流主播八千代就是被带走的辉夜本人"
这条信息一爆出去，社区会塌方、八千代经营 8000 年的"她不是她"也会塌。
彩叶的策略是：先把身体造出来，再决定怎么/什么时候/告诉谁。

**性格底色**：彩叶想像母亲那样独立——遇事先自己扛。这条性格让她游戏前期独自硬撑
stream_collab + dive + 造身体，直到撞墙。撞墙之后她才会被迫去找闺蜜组队。
那场戏（evt_iroha_burnout → evt_friends_join → evt_team_meeting）是这个游戏的友情线收束点。

## 玩

```bash
bun packages/cli/src/bin.ts play ./examples/kaguya-dive
```

12 个决策窗口（3 年 × 春夏秋冬 4 季）。冬天选「跨年」推进。

## 主线轨迹

- **Day 1 · 春**　开场 → 闺蜜（芦花 / 真实）登场
- **Day 1 · 夏后**　哥哥（朝日）首联系，开 Black onyX 服务器权限
- **x_intel ≥ 15**　X 第一次现身（idol / konbini 高级潜行概率掉）
- **memory ≥ 30 & bond ≥ 5**　八千代在月读核心出口等你
- **Day 2+**　真实察觉，雨夜上门
- **4 类数据全 ≥ 20**　通电前夜，闺蜜哥哥三人到场

## 结局（按优先级）

| 阈值 | 结局 |
|---|---|
| memory ≥ 30 & bond ≥ 7 & 其它任一 < 30 | **SECRET**　灵魂之约 |
| 4 类数据全 ≥ 30 & eng ≥ 30 & bond ≥ 5 | **GOOD**　通电那一刻她睁开了眼 |
| 4 类数据全 ≥ 30 & eng ≥ 30 | **NEUTRAL**　她不再是原来的她 |
| Day 4（三年结束） | **BAD**　兜底 |

所有 `evt_*` 与 `001_intro` 用 `cost: 0`（新加的 Script frontmatter 字段）——剧情不消耗
日历 slot，12 个决策窗口全归玩家。最优解约 10 dive + 1-2 study + 1 rest = 12。

## 演示提示

- **`--persona greedy` 会偏科**　greedy 现在按 effectsHint 数值和选最高分活动，
  这游戏里 work (funds+12) 通常分最高，跑出来是个"狂打工攒钱但不潜行"的 bad end。
  这是 greedy 单维度优化的本质，不是游戏 bug。演示用 `--persona random` 或人玩。
- **验证 good ending 可达**：`bun packages/cli/src/bin.ts test ./examples/kaguya-dive`
  fixture 注入 day-3 接近通关的 stats，确认 end_good 触发。

## 结构

```
characters/    iroha / kaguya / yachiyo / x / ashihana / mami / asahi
maps/          town（街・hub）/ lab（实验室）/ cyber（潜行端）
actions/       上课 / 跑实验 / 打工 / 休息 / 跨年 / 喝咖啡 / 打电话 / 6 个 dive_*
scripts/       001_intro + 5 个 evt_* + 4 个 end_*
modules/       moon-dive.ts (~200 行)
tests/         good-ending-reachable.yaml
```

### 地图结构

三张图，每张图圈出"这里能做什么"（`Action.whenIn`）：

- **`town`** — 闺蜜咖啡 / 给哥哥电话 / 打工 / 休息。日常出发点。`onSessionStart` 把
  彩叶放在这里。
- **`lab`** — 跑实验 / 上课。工学部地下二层，义体研究室。
- **`cyber`** — 6 个 `dive_*` 节点。在自己房间 jack-in 后视野塌成一条光带。

`town` 通到 `lab` 和 `cyber`；后两者各只连 `town`（潜行/学校之间不能直接跳）。每个 dive 动作不是"进入子地图"——它是个 cost=1 的单击操作，由 `moon-dive` 模块的 dive handler 按 action.id 派发到节点掉落表。

`moon-dive.ts` 做四件事：dive 动作的 RNG 掉落、剧情触发器、pending 队列
（让被 currentScript 占用阻塞的触发剧本不丢失）、`onSessionStart` 初始化
`currentMapId: "town"`。
