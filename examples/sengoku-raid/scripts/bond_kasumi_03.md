---
id: bond_kasumi_03
title: 鹿の道
characters: [kasumi]
requires:
  all:
    - { affection: { character: kasumi, min: 6 } }
    - { switch: { name: befriended_kasumi } }
    - { scriptCompleted: bond_kasumi_02 }
---

:bg assets/backgrounds/mountain-path-morning

:cg assets/cgs/bond-kasumi-03

朝。山際の道。

@kasumi あんた、戻り際の足音、私と合ってきた。

霞は弓を背負い直し、お主に並んで歩く。

@kasumi 猟師の足って、結局のところ「逃げる」ためじゃないんだ。

@kasumi 鹿の方が早い。だから、追わない。

@kasumi 鬼も同じ。追わない方が、長く生きる。

霞は地面を指差した——鹿の蹄の跡が三つ、鬼の足跡を避けて回り込んでいる。

@kasumi ほら、鹿が教えてくれる。鬼の通り道は、ここじゃない。

:cg assets/cgs/bond-kasumi-03

? それでも、聞きたかった。 {id: question-on-deer-path}
  - 「あんたは、なぜ私と歩く」 {id: ask-why-she-walks, ai: romantic vulnerable} -> +kasumi | goto why_walk
  - 「猟師は、いつ刀を持つ」 {id: ask-when-hunter-draws, ai: blunt protective} -> +kasumi | goto hunter_blade
  - 「鹿の道を、私にも教えてくれ」 {id: ask-to-learn-deer-path, ai: trusting disciplined} -> +2kasumi | goto learn_path

:hide-cg

# why_walk

@kasumi 最初は、あんたが死に急いでるように見えたから。今は——あたしが、隣を歩きたいから。

@kasumi あんたが鹿の道を歩けるようになっても、それは変わらない。

:goto after_answer

# hunter_blade

@kasumi 逃げ道に、自分以外の足跡が残った時。その人を逃がすために、猟師は刀を持つ。

@kasumi 今のあたしなら、あんたの足跡が残った時。

:goto after_answer

# learn_path

@kasumi あんたが鹿の道を歩けるようになったら、私の役目は終わる。

@kasumi それまでは——隣にいる。

# after_answer

:hide-cg

[end]
