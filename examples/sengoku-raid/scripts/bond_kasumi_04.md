---
id: bond_kasumi_04
title: 役目の終わった日
characters: [kasumi]
bg: assets/backgrounds/mountain-path-afternoon
requires:
  all:
    - { affection: { character: kasumi, min: 8 } }
    - { scriptCompleted: bond_kasumi_03 }
    - { switch: { name: road_kasumi_2_seen } }
---

昼下がり。山際の道。気づけば、霞より半歩先をお主が歩いていた。

足が勝手に止まる。地面に爪の跡——三日前。だが浅い。急いでいない鬼の足だ。

お主は来た道を振り返り、それから鹿の蹄が回り込んだ方角を目で追った。声に出す前に、答えが揃っていた。

「通り道は向こうだ。ここは、もう使われていない。」

振り向くと、霞が立ち止まってこちらを見ていた。弓に手も掛けず、ただ、見ていた。

@kasumi ……今の、あたし、何も教えてないよ。

@kasumi 跡を読んで、後ろを見て、鹿に訊いた。全部、あんたが自分でやった。

霞は笑おうとして——途中でやめた。笑い慣れた顔が、笑い方を見失っていた。

@kasumi 言ったよね、あたし。あんたが鹿の道を歩けるようになったら、役目は終わりだって。

@kasumi 終わっちゃった。たった今。

? 道の真ん中で、なんと言う？ {id: answer-after-the-role-ends}
  - 「役目が終わったなら、今度は理由なしで隣を歩け」 {id: walk-without-a-reason} -> +2kasumi | goto without_reason
  - 「嘘だ。俺はまだ、お前の足音しか読めていない」 {id: read-only-her-footsteps} -> +2kasumi | goto footsteps
  - 黙って、霞の隣まで半歩戻る {id: step-back-beside-her} -> +kasumi | goto half_step

# without_reason

@kasumi 理由なし、か。……じゃあ明日、あたしが勝手に隣にいても、追い返す理由もないね。

:goto after_answer

# footsteps

@kasumi あたしの足音だけ読めるなら、十分じゃない。……迷った時は、それを追って帰ってきな。

:goto after_answer

# half_step

霞は戻った半歩を見て、自分も半歩だけ寄った。道の真ん中に、二人分の足跡が並んだ。

@kasumi ……そういう答え方、覚えたんだ。

# after_answer

霞は俯いて、爪先で土を一度蹴った。猟師が獲物の前では決してやらない、音の出る仕草だった。

@kasumi ……ずるいなあ、あんた。

@kasumi 父の弓は「失くさないため」に引くんだって、ようやく分かったところなのに。

@kasumi 役目より先に、失くしたくない人ができてたら——世話ないよ、ほんと。

霞は顔を上げた。いつもの笑顔だった。目だけが、いつもより正直だった。

@kasumi 隣、空けといて。これからは役目じゃなくて、あたしの勝手で歩くから。

その日から、霞は跡を読んでも半分しか教えてくれない。残りの半分は「あんたの分」だそうだ。

```yaml
type: effects
effects:
  affection:
    kasumi: 1
```

[end]
