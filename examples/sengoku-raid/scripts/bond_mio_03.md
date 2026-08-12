---
id: bond_mio_03
title: 鏡を見る
characters: [mio]
bg: assets/backgrounds/sumida-bank-sunset
requires:
  all:
    - { affection: { character: mio, min: 6 } }
    - { switch: { name: befriended_mio } }
---

:cg assets/cgs/bond-mio-03

夕暮れ。隅田河の岸辺。

@mio 一度、二人で水面を覗かせてもらえるか。

澪は水際に膝をついた。お主も並んで膝をつく。

二人の影が水に映る。澪の影は揺れず、澪自身よりずっと若く見える——お主の影は、半分が黒く滲んでいる。

@mio 私の家業——水鏡——は、自分を見るためのものでもある。

@mio 公儀の見立ては、結局、人間が人間を測る。誤る。

@mio だが、水鏡は——

@mio （澪は水面を指で乱した。お主の影の黒い部分が散る）

:cg assets/cgs/bond-mio-03

@mio 嘘をつかない。

? それでも、何か答えたかった。 {id: answer-before-the-water-mirror}
  - 「お前自身の影、若く見えるが」 {id: ask-about-her-younger-shadow} -> +mio | goto young_shadow
  - 「鏡が示すのは、未来か」 {id: ask-if-the-mirror-shows-future} -> +mio | goto future
  - 「黙って、隣にいてくれ」 {id: ask-her-to-stay-beside-him} -> +2mio | goto stay

# young_shadow

:hide-cg

@mio あれは、二人目を斬る前の私だ。水鏡は歳ではなく、見ないふりをして置き去りにした時を映すことがある。

:goto after_answer

# future

:hide-cg

@mio 未来は示さぬ。今ここにある歪みと、まだ選べる方角だけだ。未来にするのは、見る者の足だ。

:goto after_answer

# stay

:hide-cg

@mio ……ああ。沙汰が命じるからではない。私がここにいたい間は、隣にいる。

# after_answer

@mio 公儀の沙汰がどう下ろうと——私の鏡には、お主は未だ堕ちず。

@mio それを覚えておいてくれ。

:hide-cg

[end]
