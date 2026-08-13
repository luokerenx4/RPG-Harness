---
id: bond_kagari_03
title: 同道の槍
characters: [kagari]
bg: assets/backgrounds/inn-veranda-night
requires:
  all:
    - { affection: { character: kagari, min: 6 } }
    - { switch: { name: befriended_kagari } }
    - { scriptCompleted: bond_kagari_02 }
---

:cg assets/cgs/bond-kagari-03

宿。月。

@kagari 共に出立すると、刀の音が違って聞こえる。

@kagari 私一人で歩いていた頃、夜は静かすぎた。それを静かと感じていなかった——気づくのは、戻ってから。

@kagari お主の刀は——歌う。私の槍は、唸るだけだ。

篝は窓辺の床几に座り、長く息を吐いた。

@kagari 一つ、聞いていいか。

@kagari お主の妖刀が、私の槍の何倍も重そうな夜——どうやって寝ている。

:cg assets/cgs/bond-kagari-03

? それでも、答える。 {id: answer-how-the-blade-sleeps}
  - 「夢を見ないようにしている」 {id: avoid-dreams, ai: restrained introspective} -> +kagari | goto dreamless
  - 「鎮魂法で、毎晩二十押し返す」 {id: use-chinkonho-nightly, ai: loyal disciplined} -> +kagari | goto chinkonho
  - 「眠らない」 {id: do-not-sleep, ai: defiant independent} -> +2kagari | goto sleepless

:hide-cg

# dreamless

@kagari 「見ない」じゃなく、「見ないようにする」、か。……それでも、答えてくれたのが嬉しい。

:goto after_answer

# chinkonho

@kagari 毎晩二十。あたしが教えた数を、ちゃんと覚えていたんだな。今夜は十でいい。残りは、あたしの槍が押し返す。

:goto after_answer

# sleepless

@kagari それは答えじゃない。……今夜はあたしが起きている。お主は寝ろ。

# after_answer

篝はお主の隣に座り、肩を寄せた。距離は、刀一本分ではなくなった。

:hide-cg

[end]
