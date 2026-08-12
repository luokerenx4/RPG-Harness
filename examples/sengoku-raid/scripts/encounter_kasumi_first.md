---
id: encounter_kasumi_first
title: 石畳の道での出会い
characters: [kasumi]
---

:cg assets/cgs/encounter-kasumi-first

矢が一本、お主の鼻先を掠めて石に刺さった。

振り向く間もなく、樹の上から声が降ってくる。

@kasumi 動くな！　あんたの後ろに鬼がいる！

お主が振り向くのと、二の矢が放たれるのが同時だった。

矢は——背後の戦鬼の眉間を抜き、鬼は声もなく崩れた。

:cg assets/cgs/encounter-kasumi-first

樹の上から、若い女が音もなく下りてくる。

@kasumi はい、一人前。あんた、運がよかったね。

@kasumi あたしは霞。猟師だ。最近、鬼が獲物を奪うから、鬼の方を狩ってる。割がいい。

@kasumi あんた、妖刀使か？　奉行所が雇った口か。

:hide-cg

? どう答える？ {id: first-words-to-kasumi}
- 「将軍家から命を受けている」 {id: serve-the-shogunate, ai: dutiful formal} -> +kasumi
- 「いや、家業だ」 {id: name-it-family-trade, ai: blunt independent} -> +2kasumi
- 「お前、命を救ってくれたな。礼を言う」 {id: thank-kasumi, ai: compassionate grateful} -> +2kasumi | goto thanked

@kasumi 将軍家でも家業でも、鬼を斬る腕は同じか。——それより、あんたの妖刀、見せてもらっていいか？

霞はお主の刀の柄に指を這わせ、笑った。

@kasumi 飢えてるね、これ。あたしは弓だから関係ないけど、あんた、気をつけな。

@kasumi 山で見かけたら声かけるよ。

:hide-cg

[end]

# thanked

@kasumi 礼なんていい。背中ががら空きだったから射ただけだ。——それより、あんたの妖刀、見せてもらっていいか？

霞はお主の刀の柄に指を這わせ、笑った。

@kasumi 飢えてるね、これ。あたしは弓だから関係ないけど、あんた、気をつけな。

@kasumi 山で見かけたら声かけるよ。

:hide-cg

[end]
