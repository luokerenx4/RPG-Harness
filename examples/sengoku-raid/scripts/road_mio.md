---
id: road_mio
title: 道中 ・ 澪
characters: [mio]
---

:hide-cg

:portrait center assets/portraits/mio-default

澪は水のある所で必ず足を止める。沢、溜まり、轍に残った雨——刀身を傾けて、流れに映す。

@mio 査問の役目で諸国を回っていた頃、私はこうして「相手」を映していた。堕ちているか、否か。

@mio 今は——お主の隣の水に、私自身も映る。

二つの影が、浅い流れに並ぶ。澪の影は、出会った頃よりわずかに揺れていた。

@mio おかしな話だ。査問する者の影は、揺れてはならぬ。揺れぬ者だけが、人を測れる。

@mio お主と歩くうち、私の影が、人のものに戻ってきている。

? なんと言う？ {id: answer-the-human-reflection}
  - 「揺れる影のほうが、よく映る」 {id: trust-the-shaking-shadow} -> +2mio | goto shaking_shadow
  - 「測るのを、やめてもいいんだぞ」 {id: release-her-from-measuring} -> +mio | goto stop_measuring
  - 二人の影が重なるよう、半歩寄る {id: join-the-same-reflection} -> +2mio | goto shared_reflection

# shaking_shadow

@mio 揺れれば、見落としていたものまで映るということか。……公儀には、書けぬ見立てだな。

:goto after_answer

# stop_measuring

@mio 測るのをやめた時、私に何が残る。……それを確かめるために歩くのも、悪くない。

:goto after_answer

# shared_reflection

澪は重なった影を見下ろした。離れろとは言わなかった。

@mio ……近すぎて、二人を別々には測れぬな。公儀には、なおさら書けぬ。

# after_answer

澪は刀身を鞘に納め、水面の波紋が消えるのを待った。それから、お主の歩幅に合わせて、静かに歩き出した。

:portrait center

```yaml
type: effects
effects:
  affection:
    mio: 1
  switches:
    road_mio_seen: true
```

[end]
