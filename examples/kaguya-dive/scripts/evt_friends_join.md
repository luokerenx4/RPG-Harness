---
id: evt_friends_join
title: 把名字说出来
characters: [iroha, ashihana, mami]
cost: 0
requires:
  switch: { name: __trigger_only, eq: true }
---

涩谷那家老咖啡店。芦花点的拿铁，真实点的奶茶，你点的美式。

跟之前几次不一样的是，今天是你约的。

@ashihana 你脸色不行哎。

@ashihana 比上次还不行。

@iroha 嗯。

@mami ……

@iroha 我有件事要跟你们说。

芦花夹着糖包的手停下来了。

@iroha 关于八千代。

@ashihana ……？

@iroha 八千代就是辉夜。

——咖啡店里有人在用磨豆机。

——你能听见磨豆机停下来又开始的整个循环。

@ashihana ……

@ashihana ……你是说，那个"被带回月球"的辉夜。

@iroha 嗯。

@ashihana 那个我们三个一起追到工地的辉夜。

@iroha 嗯。

@ashihana 那个我跟你和真实一起趴在飞船底下喊她名字的辉夜。

@iroha 嗯。

@ashihana ……

她没哭。她只是把糖包放回桌上，慢慢撕开，倒进咖啡里搅了搅。

@mami 我猜过。

@iroha ？

@mami 你转专业那天我就猜过。

@mami 但我猜你是怀疑。

@mami 我没想到你已经认定了。

@iroha ……

@ashihana 你怎么认定的。

@iroha 8000 年前的辉夜，回到过去那次。她那次跟我说过一些只有她知道的事。

@iroha 我在月読核心 dive 过几次。

@iroha 她记得。

@ashihana （你 dive 过……月読核心。）

@ashihana （那是要 SS 级权限的。）

@ashihana （你哪来的 SS 级权限。）

@iroha 哥的战队备份。还有些是我自己破的。

@mami 彩叶。

@iroha 嗯。

@mami 你这一年是怎么过的。

@iroha ……

@mami 你瘦了五公斤。

@mami 上次见你你说"研究进展顺利"。

@mami 我没拆穿你。是因为我以为你只是不想说细节。

@mami 现在我知道了——是因为你一个人扛不下来。

@iroha 嗯。

@iroha 我扛不下来。

——你说完这句话以后停了一下。

——这是你这一年第一次跟人说这五个字。

@iroha 所以——

? 怎么说。
- "我需要你们帮我。但这件事不能让别人知道八千代是谁。" -> +ashihana +mami | goto pick_full
- "真实，能不能你先帮我。芦花……让我慢慢跟她说。" -> -ashihana +mami | goto pick_mami_first
- "我把事情说完整，但接下来怎么做你们自己想。我不强求。" -> +ashihana | goto pick_open

# pick_full

@ashihana 行。

@ashihana 你把要做的事列出来。

@ashihana 月読那边我有十二万粉，弹幕监督和热度运营我熟。

@mami 歌词审校和访谈话术我来。我那个美食频道半年没更，咬咬牙断更也行。

@iroha 你们的频道——

@ashihana 闭嘴。

@ashihana 你哥的战队三个赛季没上顶流榜你跟他算账吗？

@iroha ……不算。

@ashihana 嗯。

@mami 我们明天开始。

[end]

# pick_mami_first

@mami ……好。

@mami 那我先帮你。

@mami 芦花那边——

@ashihana 我都听见了哦。

@iroha ……

@ashihana 我知道你怕我嗓门大说漏嘴。

@ashihana 你怕得对。我嗓门是大。

@ashihana 但你刚刚说"八千代就是辉夜"这句话的时候——我没尖叫。

@ashihana 你看我都没尖叫。

@iroha ……

@ashihana 我不催你。你想叫我帮的时候叫我。

@ashihana 我不主动凑过去。

@mami 芦花。

@ashihana （她抬手挡住真实。）

@ashihana 真实。让她按她节奏来。

@mami 嗯。

[end]

# pick_open

@ashihana 我帮。

@mami 我也帮。

@iroha ……我还没说要——

@ashihana 闭嘴。

@ashihana 你已经说完了。

@ashihana 你说"我不强求"四个字之前那个停顿——就是在求。

@ashihana 我们都听见了。

@mami 嗯。

[end]
