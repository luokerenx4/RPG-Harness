---
id: evt_yachiyo_test
title: 八千代在出口
characters: [iroha, yachiyo]
cost: 0
requires:
  switch: { name: __trigger_only, eq: true }
---

你从核心退出来。出口的灯柱旁站着一个人。

@yachiyo 又来了。

@iroha 嗯。

@yachiyo 她今天还认得你吗？

@iroha 认得。

她沉默了一会。

@yachiyo 你知道吧。

@yachiyo 你成功的那一天，可能就没有月读了。

? 怎么回。
- "知道。" -> +2kaguya | goto pick_kaguya
- "我会留你。" -> +yachiyo +kaguya | goto pick_both
- "那是你的事。" -> -yachiyo | goto pick_cold

# pick_kaguya

@yachiyo ……

@yachiyo 那好。

[end]

# pick_both

@yachiyo 你以前也是这么讲话的。

[end]

# pick_cold

@yachiyo 嗯。

@yachiyo 那下次进核心，门票贵一点。

[end]
