---
id: bond_kasumi_01
title: 霞の弓を借りる夜
characters: [kasumi]
bg: assets/backgrounds/inn-garden-dawn
requires:
  affection: { character: kasumi, min: 2 }
---

宿の裏庭。霞が弓に油を塗っている。

@kasumi あんたさ、いつ折れるの？

妙な問い方だった。

@kasumi いや、刀のこと。あんたが折れる、って言いかけて、刀って言い直した。同じことかと思って。

お主は何も言わない。

@kasumi あたしの父はね、猟師仲間と山で行方知れずになった。鬼に喰われたんだろうって、皆そう言ってる。

@kasumi あたしは、その時から弓を握った。鬼を撃ち落とすたびに、父が少しずつ返ってくる気がする。

@kasumi 馬鹿げてる、って自分でも思うんだけど。

? なんと答える？ {id: answer-kasumi-lost-father}
- 「馬鹿げてはいない」 {id: deny-it-is-foolish, ai: compassionate affirming} -> +kasumi
- 「俺も同じだ」 {id: admit-the-same-loss, ai: blunt vulnerable solidarity} -> +2kasumi
- 黙って隣に座る {id: sit-beside-her, ai: social compassionate restrained} -> +kasumi

@kasumi ……ありがとう。

霞は弓に油を塗る手を止めなかった。

[end]
