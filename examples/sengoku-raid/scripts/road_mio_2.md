---
id: road_mio_2
title: 道中 ・ 澪 ・ 二
characters: [mio]
ai:
  relatedActivityIds:
    - invite:mio
    - depart:sumida_river
    - move:sumida_river_under_eaves
---

:hide-cg

:portrait center assets/portraits/mio-default

一度、共に生きて帰った後の水辺で、澪は刀身を水に重ねなかった。ただ、流れを見ていた。

@mio 査問の役目は、結論を出すまでと言った。覚えているか。

お主は頷く。澪は、初めて見せる迷いの顔をした。

@mio 私は、もう結論を出している。とうに。「未だ堕ちず」——いや、それより前から。

@mio だが公儀に上申すれば、私の役目は終わる。終われば、お主に同行する理由が、無くなる。

水面に、二つの影。澪の影はもう、ほとんど揺れていない——人のものに戻っていた。

@mio だから、上申を遅らせている。役目を口実に、隣にいる。……監察役にあるまじき、私情だ。

? なんと言う？ {id: answer-mios-private-feeling}
  - 「役目が要るなら、ずっと結論を出すな」 {id: ask-her-never-to-conclude, ai: selfish avoidant} -> +2mio | goto no_false_duty
  - 「役目が無くても、隣にいろ」 {id: ask-her-to-stay-without-duty, ai: romantic loyal affirming} -> +2mio | goto stay_without_duty
  - 「お前の私情を、俺が引き受ける」 {id: accept-her-private-feeling, ai: compassionate trusting cooperative} -> +mio | goto share_feeling

# no_false_duty

@mio それは聞けぬ。役目を嘘にして隣にいるなら、今までと同じだ。……結論は出す。その後も隣にいたいと、私の名で言う。

:goto after_answer

# stay_without_duty

@mio ……その一言を、沙汰より先に聞きたかった。ならば役目を終えた後は、私自身の理由で隣にいる。

:goto after_answer

# share_feeling

@mio 私情は引き受けさせるものではない。だが、共に持つというなら——預ける。

# after_answer

@mio ……公儀には、一生書けぬ供述だな。

澪は刀身を鞘に納め、今度は水を覗かなかった。覗かずとも、隣に誰がいるかは分かる、という顔だった。

:portrait center

```yaml
type: effects
effects:
  affection:
    mio: 1
  switches:
    road_mio_2_seen: true
```

[end]
