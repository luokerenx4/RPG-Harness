---
id: three_flowers_alliance
title: 三花の盟
characters: [kagari, kasumi, mio]
requires:
  all:
    - { switch: { name: befriended_kagari } }
    - { switch: { name: befriended_kasumi } }
    - { switch: { name: befriended_mio } }
defaultPortraits:
  - { characterId: kagari, emotion: default }
  - { characterId: mio, emotion: default }
  - { characterId: kasumi, emotion: default }
---

:cg assets/cgs/three-flowers-alliance

深夜。大名府の中庭。三人の女が、それぞれ別の方角から現れて、月の下で鉢合わせた。

@kagari 召されたのは私一人ではないらしいな。

@kasumi あたしは、月見だって聞いて来たんだけど。……酒、ないの？

@mio 私は——公儀の沙汰ではなく、個人の用で。

@kagari ほう。監察殿の「個人の用」とは。お役目より重いものを、いつの間に拵えた。

:cg assets/cgs/three-flowers-alliance

@mio ……槍の者。お主とは一度、ゆっくり話さねばと思っていたところだ。

@kasumi ねえ、これ、あたし帰ったほうがいい流れ？　弓は槍と刀の喧嘩には混ざらないよ。

三人の視線が、ほとんど同時に、中庭の入り口へ向いた。お主が立っている。手には、何も持っていない。

「三度、お主たちと出帰った。三度とも、生きて戻った。」

「一人で歩いていた頃は、生きて戻ることを、戻ってから数えていた。今は違う。出る前から、戻る方を向いて歩いている。」

「鬼を狩る生き方が、いつ終わるか、私には見えない。だが、終わるその日まで——」

:hide-cg

? それでも、口にしたかった。 {id: three-flowers-vow}
  - 「三人とも、隣にいてくれ」 {id: ask-all-to-stay, ai: social collective compassionate loyal hopeful} -> +kagari +kasumi +mio | goto vow_stay
  - 「お主たちと共に死ぬ覚悟を、私は持っている」 {id: vow-to-die-together, ai: defiant blunt loyal fatalistic self-sacrificial} -> +2kagari +2kasumi +2mio | goto vow_death

# vow_stay

```yaml
type: effects
effects:
  switches:
    three_flowers_stay_pledge: true
```

@kagari 残れと言われて、背を向けるほど薄情ではない。

@kasumi じゃあ、生きて帰る場所を三人分、ちゃんと空けといて。

@mio ……個人の願いとして受理する。公儀の期限は付けぬ。

:goto vow_answer

# vow_death

```yaml
type: effects
effects:
  switches:
    three_flowers_death_pledge: true
```

@kagari 覚悟を、先に死ぬ許しと取り違えるな。私たちは許さん。

@kasumi 共に死ぬ、じゃなくて、共に帰る。そこは言い直してもらうよ。

@mio ……供述を訂正する。四名とも生還する覚悟を持つ、と。

# vow_answer

短い沈黙。最初に動いたのは、槍の石突きだった。土を一度、強く打った。

@kagari 私の槍は、お主の刀の後ろを守る。

@kasumi 私の弓は、お主の刀の届かぬ間合いを撃つ。

@mio 私の鏡は、お主の刀が映す影を読む。

三人の声が一度に降りる。中庭の月が、いつもより低く見えた。

@kasumi ——で、いまの、誰の口上がいちばん良かった？

@kagari 比べるな。盟が緩む。

@mio ……記録には「三名連署」とだけ残す。順位は、書かぬ。

@kasumi 監察殿、それ、いちばんずるい答えだ。

笑い声が一つ、二つ、三つ。揃いはしない。揃わないまま、同じ月の下にある。それでよかった。

```yaml
type: effects
effects:
  switches:
    three_flowers_pledged: true
```

[end]
