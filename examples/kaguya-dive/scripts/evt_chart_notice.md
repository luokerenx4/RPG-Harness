---
id: evt_chart_notice
title: 顶流榜 · 第二格
characters: [iroha, kaguya]
cost: 0
requires:
  switch: { name: __trigger_only, eq: true }
---

你 dive 到月读核心边缘的某条数据流，瞥见今天的顶流榜。

—— 顶流榜 ——
1. 月見 八千代
2. X
3. 月見 八千代（小号？）
4. 忠犬宅公

八千代的第一是稳的。X 上来得不太正常。

@kaguya 你看见啦。

@iroha 嗯。

@kaguya 没事的。

@kaguya 她要是真的能赢我，那也是月读自己的选择。

@iroha ……

她笑了一下。你没看清她笑里有什么。

? 怎么回。
- "不会让她赢的。" -> +kaguya | goto pick_fight
- "你太轻巧了。" -> goto pick_press
- "……嗯。" -> -kaguya | goto pick_silent

# pick_fight

@kaguya 嗯。

@kaguya 那你保重。

[end]

# pick_press

@kaguya ……

@kaguya 你也不需要把所有事情都扛在肩上。

@iroha 我没扛。我只是知道你在演。

她停了很久。

@kaguya 你长大了。

[end]

# pick_silent

@kaguya 嗯。

@kaguya 那就这样。

[end]
