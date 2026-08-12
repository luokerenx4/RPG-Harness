---
id: ending_mundane_seal
title: 祠の封印
characters: [kagari, kasumi, mio]
requires:
  all:
    - { switch: { name: chose_court_silent } }
    - { variable: { name: pulse_mundane, min: 5 } }
---

:bg assets/backgrounds/mountain-path-afternoon

:cg assets/cgs/ending-mundane-seal

お主は黙して公儀から退き、家伝の妖刀を山中の祠に納めた。

神主が一人、封の祝詞を上げる。お主の名は、どの記録にも残らない。

「お主は、お主の代でこの刀を止めた。次の代に、渡さなかった。」

「四百年の家伝に、初めて起きたことだ。終わらせるのも、家業のうちだったのかもしれんな。」

祠を出る。山道を下りる背に、刀の重さがもうない。

:hide-cg

```yaml
type: choice
id: sealed-blade-coda
prompt: 麓の辻に、人影がある。
options:
  - id: meet-kagari
    text: 槍を担いだ影
    ai_tags: [social, loyal]
    requires: { switch: { name: befriended_kagari } }
    locked_hint: 篝と共に戦場を生き延びていない。
    goto: seeoff_kagari
  - id: meet-kasumi
    text: 弓を背負った影
    ai_tags: [social, loyal]
    requires: { switch: { name: befriended_kasumi } }
    locked_hint: 霞と共に戦場を生き延びていない。
    goto: seeoff_kasumi
  - id: meet-mio
    text: 藍の打掛の影
    ai_tags: [social, loyal]
    requires: { switch: { name: befriended_mio } }
    locked_hint: 澪と共に戦場を生き延びていない。
    goto: seeoff_mio
  - id: walk-alone
    text: 誰もいない。それでいい
    ai_tags: [independent]
    goto: seeoff_none
```

# seeoff_kagari

篝は槍を担いだまま、道の真ん中に立っていた。

@kagari 刀を捨てた奴の顔を、見に来た。

@kagari ……いい顔だ。伯母に、最後まで見せてやりたかった顔だよ。

@kagari あたしはまだ斬る側だ。だが、疲れたら——刀のない家に、寄ってもいいか。

お主は頷いた。篝の槍の石突きが、土を一度、軽く打った。いつもの拍だった。

（これが、お主と篝の選んだ結末）

[end]

# seeoff_kasumi

霞は辻の石に腰掛けて、手を振っていた。

@kasumi あんたの足音、変わったね。「連れて帰る」音でも「逃げる」音でもない。

@kasumi ただ歩いてる音。……いちばん、いい音だ。

@kasumi 猟師はさ、何も追ってない奴と歩くの、けっこう好きなんだよね。麓まで、一緒に行こ。

二つの足音が、ゆっくりと山を下りていった。どちらも、もう何も追っていなかった。

（これが、お主と霞の選んだ結末）

[end]

# seeoff_mio

澪は辻の水場の縁にいた。水面を見ていない。お主を待っていた。

@mio 上申は済んだ。「松本家当主、刀を封じ、向後の憂いなし」。私の、最後の役目だ。

@mio 役目は終わった。だからここから先は——監察ではなく、ただの澪として訊く。

@mio 刀のない暮らしに、水鏡は要らぬか。……読むものが、もう何もなくとも。

水面に二つの影。どちらも揺れず、どちらも、もうどこへも急いでいなかった。

（これが、お主と澪の選んだ結末）

[end]

# seeoff_none

辻には誰もいない。風が、山の方へ抜けていくだけだ。

何かが消えた——だが、何かが、まだ続いている。

夕餉の匂いのする方へ、お主は歩き出した。刀の代わりに持つものを、これから探す。

（これが、お主が選んだ結末）

[end]
