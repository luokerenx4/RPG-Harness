---
id: evt_friends_first
title: 闺蜜上线
characters: [iroha, ashihana, mami]
cost: 0
requires:
  switch: { name: __trigger_only, eq: true }
---

入学第三天。学生食堂二楼。

@ashihana 喂彩叶！这边！

@ashihana 我跟真实说了，新学期开学第一顿必须三个人一起吃。不然就是背叛。

@mami ……她真的说了。

@iroha 抱歉抱歉。我刚从工学馆过来。

@ashihana 工学馆？你不是来学唱歌制作的吗？

@iroha 我换专业了。

芦花夹了一筷子菜的手停在半空。

@ashihana 你跟我说什么？

@iroha 转去机电一体化方向了。下学期还要补两门神经科学。

@mami ……

她没问"为什么"。

她看着你。她在等你自己说。

——你看着真实。真实知道你为什么转。

——三年前那艘船升起来的时候，她是哭得最厉害的那个。她为辉夜哭。她也为你哭——因为她比谁都清楚那个时刻你失去了什么。

——你不需要跟她解释"我在做跟那件事有关的研究"。她已经懂了。

——但芦花不一样。芦花会嚷嚷。芦花会问。芦花一旦知道你的方向，可能下周月読直播间一开口就把方向漏出去。

@iroha （——告诉她们多少？）

? 怎么说。
- "跟你们一起趴在着陆架下那天的事——我还想做点什么。" -> +2mami +ashihana | goto pick_anchor
- "学校的事。换个方向。先这样。" -> -ashihana | goto pick_deflect
- "我在搞一些研究，跟辉夜有关。具体的让我再想想怎么跟你们说。" -> +mami | goto pick_partial

# pick_anchor

——芦花把筷子放下了。

@ashihana ……

@ashihana 你是说——

@ashihana ——你要把她拼回来？

@iroha 不一定拼得回来。但有方向。

@ashihana ……我可以问细节吗？

@iroha 现在不行。

@iroha 不是不信你。

@iroha 是这事一旦传出去——会出乱子。

@ashihana 月読那边的乱子。

@iroha 嗯。

@ashihana ……我懂。

@ashihana 你不让我知道细节，是怕我嗓门大。

@iroha 不是怕你嗓门大。是怕你替我担心还得装作不担心。

@ashihana ……

她笑了一下。但她下嘴唇咬了一下。

@ashihana 行。

@ashihana 那我就当你在搞一个非常厉害的毕业设计。

@ashihana 你毕业那天我去看。

@mami 我也去。

@iroha 嗯。

@ashihana 但你得保证一个月至少出来吃一次饭。不然我月読直播间挂你头像，每天编你的黑料。

@iroha 知道了知道了。

[end]

# pick_deflect

@ashihana ……

@ashihana 行吧。

@ashihana 你跟我说"学校的事"——

@ashihana ——那一定不是学校的事。

@mami 芦花。

@ashihana 我没追问。

@ashihana 我就这么把这句记下来。

@ashihana 你哪天想跟我说"不是学校的事"的时候，我等着。

@iroha ……

@mami 彩叶。我也等着。

@iroha ……谢谢。

[end]

# pick_partial

@ashihana 等等。

@ashihana ——「跟辉夜有关」。

@ashihana 那个被带走的辉夜。

@iroha 嗯。

@ashihana ……

她坐着没动。她拿筷子那只手是抖的。

@mami 芦花。

@ashihana 我没事。

@ashihana 我没事我就是——

@ashihana ——三年了。我一直以为这事翻篇了。

@ashihana 你说"跟辉夜有关"我就知道翻不了篇。

@iroha 对不起。

@ashihana 不用对不起。

@ashihana 你不说就不说。

@ashihana 但你要做的事——你定下来跟我说一句。

@ashihana 不是要参与。我就是想知道你在哪。

@iroha 嗯。

@mami 我也是。

[end]
