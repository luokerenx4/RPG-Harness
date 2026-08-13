---
id: letter_02_rival
title: 「査問の使者」
characters: [mio]
requires:
  all:
    - { variable: { name: shogun_chapter, min: 1 } }
    - { variable: { name: raidsCompleted, min: 4 } }
    - { characterStat: { character: player, name: spectral, max: 49 } }
---

:cg assets/cgs/letter-02-rival

四度目の遠征。蔵を出ると、大名府の中庭に若い妖刀使いが一人、片膝をついている。

深い藍の打掛。腰には家伝の脇差。

顔を上げる。お主と同じくらいの歳——だが目の冷たさは、別の層から来ている。

:cg assets/cgs/letter-02-rival

@mio 京から参った。澪と申す。

@mio 公儀の沙汰を奉じ、諸国の妖刀使いの見立てに回っている。

@mio お主の番に当たった。怒らずに聞いてほしい——「鬼に堕ちていないか」を、確かめに来た。

澪はゆっくり立ち上がり、お主の右に並んで立つ。距離は刀一本分。

@mio 私の見立てが「未だ堕ちず」と判ぜられれば、公儀の懸念は晴れる。

@mio 「既に堕ちている」と見れば——その場で斬る、ということになる。

言葉に重さはあるが、声に怒りはない。仕事として言っている。

@mio 結論を出すまで、お主の遠征に同行する。隅田河の方面に出ると聞いた。

@mio 私の家伝の業は「水鏡」——水面に映る妖気を読む。隠れている鬼の位置を、おそらく見立てられる。

@mio 互いに身を守れ。それでよいか。

:hide-cg

? それでよい。 {id: inspection-companionship}
  - 「同行を頼む」 {id: ask-her-to-join, ai: social cooperative trusting} -> +1mio | goto accept_inspection
  - 「断る術はあるか」 {id: ask-if-refusal-is-possible, ai: defiant independent} -> goto question_inspection
  - （無言で頷く） {id: nod-in-silence, ai: restrained compliant} -> goto silent_inspection

# accept_inspection

@mio 頼まれずとも役目だ。……だが、頼まれたことは覚えておく。

:goto inspection_order

# question_inspection

@mio ない。これは公儀の査問だ。ただし、隣を歩く間、お主を罪人として扱うつもりもない。

:goto inspection_order

# silent_inspection

@mio その頷きで足りる。次の遠征から、私が右を歩く。

# inspection_order

:hide-cg

```yaml
type: effects
effects:
  variables:
    last_directive: "澪と共に遠征し、見立てを受けよ。"
  switches:
    mio_met: true
    mio_inspection_duty: true
```

[end]
