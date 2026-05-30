---
id: evt_ashihana_glimpse
title: 芦花的一瞬
characters: [iroha, ashihana]
cost: 0
requires:
  switch: { name: __trigger_only, eq: true }
---

涩谷那家老咖啡店。

真实临时被编辑部叫走了。芦花没走。她和你坐在窗边。

她拿着拿铁，没喝。

@ashihana 彩叶。

@iroha 嗯？

@ashihana 我昨晚做了个奇怪的梦。

@iroha 什么梦。

@ashihana 我老了。

@ashihana 我和你一起老的。我们住在一个有院子的房子里。

@ashihana 你在帮一个我不认识的人做研究。做了一辈子。

@ashihana 你做完那天，你坐在阳台上哭了一晚上。

@ashihana 我没敢过去。

她笑了一下。

@ashihana 怪不怪。我又不老。

@iroha ……

@ashihana 哎，你脸色不太好。

@ashihana 没事，就是个梦。

她终于喝了一口拿铁。

? 怎么回。
- "我会陪你一起老。" -> +ashihana | goto pick_lie_kindly
- "那个梦里的人是我吗。" -> goto pick_probe
- "梦而已。" -> -ashihana | goto pick_brush_off

# pick_lie_kindly

@ashihana 嗯。

她没接你的话，只是把拿铁握得紧了一点。

@ashihana ……那我先信着。

[end]

# pick_probe

@ashihana ……

@ashihana 我不知道。

@ashihana 但她哭的样子和你一模一样。

[end]

# pick_brush_off

@ashihana 嗯。

@ashihana 我知道。

她把拿铁喝完，没再说话。

[end]
