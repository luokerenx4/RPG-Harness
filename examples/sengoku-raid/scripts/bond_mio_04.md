---
id: bond_mio_04
title: 見知らぬ家紋
characters: [mio]
bg: assets/backgrounds/inn-veranda-night
requires:
  all:
    - { affection: { character: mio, min: 8 } }
    - { scriptCompleted: bond_mio_03 }
    - { switch: { name: road_mio_2_seen } }
ai:
  relatedActivityIds:
    - bond:mio
    - invite:mio
    - depart:sumida_river
    - move:sumida_river_under_eaves
    - script:bond_mio_04
---

夜。宿の灯の下で、澪が文を書いていた。お主が入っても、珍しく筆を止めない。

書き終えた文の末尾に、澪は小さな印を押した。朱の家紋——見覚えがある。

思い出した。最初の文。「別の妖刀使が見立てに参る」と告げてきたあの文の末尾にあった、知らない家の紋。

@mio ……気づいたか。

@mio あの文を書いたのは、私だ。京を発つ前に。

@mio 公儀の沙汰書は別にある。あれは、私が名を伏せて勝手に出した——ただの、忠告だった。

? 灯の下で、何を訊く？ {id: letter-under-lamplight}
  - 「会ってもいない俺に、なぜ忠告を」 {id: why-warn-me, ai: probing vulnerable} -> +mio | goto letter_why
  - 「『気を確かに』——あれは役目の言葉ではなかったんだな」 {id: beyond-duty, ai: compassionate affirming} -> +2mio | goto letter_duty
  - 何も訊かず、家紋に指先で触れる {id: touch-crest, ai: restrained trusting intimate} -> +mio | goto letter_crest

# letter_why

@mio 会っていなかったからだ。沙汰書の名だけで、お主を二人目と同じにしたくなかった。

:goto letter_explanation

# letter_duty

@mio ……そうだ。役目なら、会って見立ててから書けば足りた。あれは、間に合ってほしいと願った私の言葉だ。

:goto letter_explanation

# letter_crest

指先の下で、朱の家紋は乾いていた。澪はその指を退けず、しばらく見つめた。

@mio 名を伏せても、紋だけは消せなかった。見つけてほしかったのかもしれない。

:goto letter_explanation

# letter_explanation

@mio 査問した十一人のうち、二人を斬った話はしたな。

@mio 二人目を斬ったあと——次の名簿に、お主の名があった。歳も、家の業も、刀を継いだ齢も、あの人と似すぎていた。

@mio だから、着く前に文を出した。「気を確かに」と。間に合ううちに、と。

澪は筆を置き、書き上げたばかりの文を、お主の方へ滑らせた。上申書だった。

「松本家当主、未だ堕ちず。向後の査問、不要と具申す」——日付は、ひと月前。

@mio ずっと、出せずにいた。出せば役目が終わる。終われば、隣にいる理由が消える。

@mio だが、もう出す。役目を口実に隣にいるのは——お主にも、私自身にも、嘘だ。

? 上申書を前に、なんと言う？ {id: end-of-duty}
  - 「出せ。明日からは、お前の勝手で隣にいろ」 {id: stay-by-choice, ai: romantic loyal blunt} -> +2mio | goto duty_stay
  - 「日付だけ今日に直せ。ひと月、隣にいた分は嘘じゃない」 {id: amend-the-date, ai: compassionate affirming pragmatic} -> +2mio | goto duty_date
  - 何も言わず、文箱の蓋を静かに閉じる {id: close-the-box, ai: restrained trusting respectful} -> +mio | goto duty_box

# duty_stay

@mio ……勝手でよいのか。

澪は上申書へ目を落とし、筆を取る。名を書きかけて、一度だけ止めた。

@mio ならば明日から——命令書ではなく、私自身の名で隣に立つ。

:goto duty_shared

# duty_date

@mio 嘘にはしない。ただ、終わった役目を今日までの真実として書き直す。それなら出せる。

:goto duty_shared

# duty_box

文箱の蓋に、澪の手が重なった。閉じたまま終わらせるためではない——自分の手で開け直すために。

@mio 今夜は預ける。明朝、私が開け、私の意志で出す。

:goto duty_shared

# duty_shared

澪は文を畳み、家紋の印をもう一度——今度は表に、はっきりと押した。

@mio 私の家の紋だ。覚えておいてくれ。

@mio 水鏡は嘘をつかぬ、と言ったな。……書くものも、今夜からそうする。

灯がひとつ揺れて、静まった。凪いだ水面のように。

```yaml
type: effects
effects:
  affection:
    mio: 1
  switches:
    mio_inspection_duty: false
```

[end]
