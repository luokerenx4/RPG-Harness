---
id: letter_03_choice
title: 「最後の御沙汰」
characters: [mio]
requires:
  all:
    - { variable: { name: shogun_chapter, min: 2 } }
    - { variable: { name: raidsCompleted, min: 7 } }
---

:cg assets/cgs/letter-03-choice

七度目の遠征。

大広間の襖が左右に開く。座しているのは将軍家の側用人——そして、その隣に澪。

お主の前に三つの文箱が並んだ。

:cg assets/cgs/letter-03-choice

「松本家——お主の見立ては結審した。」

「澪殿の報告では、お主は未だ堕ちぬ。されど、累積する妖力は——歴代の妖刀使いの何れより速い。」

「故にここで一度、御沙汰を渡す。三つから選べ。」

第一の文箱——朱の封蝋。「公儀に服す」。引き続き諸国を巡り、月毎に査問を受ける。妖刀の脈を「浄」に導き、安全に老いる道。

第二の文箱——黒の封蝋。「公儀に刀を抜く」。お主が公儀と袂を分かち、自らの脈を選び、行く果てまで斬り続ける道。澪は——

@mio （視線を伏せる）

第三の文箱——封蝋なし。「黙して退く」。家伝の刀を山中の祠に納め、お主自身は遁世する。鬼は他の妖刀使いに任せる。

側用人の声が低く落ちる。

「選ばぬ、という選び方はない。今夜中に決めよ。」

:hide-cg

```yaml
type: choice
id: final-court-directive
prompt: 御沙汰を選ぶ。
options:
  - id: serve-the-court
    text: 公儀に服す——道を整える
    ai_tags: [loyal, cautious]
    effects:
      switches:
        chose_court_loyal: true
      variables:
        last_directive: "公儀の道。査問を受けつつ、刀を整えて老いる。"
    goto: end_loyal
  - id: draw-against-court
    text: 公儀に刀を抜く——自らの脈を選ぶ
    ai_tags: [defiant, aggressive]
    effects:
      switches:
        chose_court_defy: true
      variables:
        last_directive: "公儀と袂を分かつ。刀の脈は、お主が選ぶ。"
    goto: end_defy
  - id: retire-in-silence
    text: 黙して退く——刀を納める
    ai_tags: [independent, cautious]
    effects:
      switches:
        chose_court_silent: true
      variables:
        last_directive: "遁世。刀は祠に納める。鬼は他者に任せる。"
        pulse_mundane: 5
    goto: end_silent
```

# end_loyal

お主は朱の文箱を取り、額に当てた。

「公儀に服す——その儀、慎んで承る。」

側用人が頷く。澪の目に、安堵に近い色が一瞬だけ走った。

[end]

# end_defy

お主は黒の文箱を取り、それを脇に置き、刀の柄に手を掛けた。

「公儀の道は、お主が代々生き残ってきた道ではない。お主の家伝は、鬼を斬り続けることだ。」

澪が静かに、自らの脇差を抜きかけ——止めた。

@mio ……分かった。

[end]

# end_silent

お主は三つの文箱に深く頭を下げ、いずれも取らなかった。

「刀は祠に納めます。お役御免を、御願い致します。」

側用人は長い沈黙の後、ただ「承知」と一言。

澪は何も言わなかった——だが、退出するお主の背に視線を残した。

[end]
