---
id: bond_kagari_02
title: 鎮魂法
characters: [kagari]
bg: assets/backgrounds/inn-garden-dawn
requires:
  affection: { character: kagari, min: 4 }
defaultPortraits:
  - { characterId: kagari, emotion: default }
---

明け方。篝はお主を裏庭に呼んだ。

@kagari これは、家伝のうちでも口伝で残った術だ。

@kagari 霊体化が暴れそうになった時——刀を逆手に持って、心臓の真上に置く。

@kagari そして、息を吐く。長く、一度。

篝はゆっくりと自分で実演してみせた。

@kagari これだけだ。鎮魂法。

@kagari 教える者と教えられる者が、互いに信頼してなきゃ伝わらない、って言われてる。だから、これまで誰にも教えなかった。

お主は刀の柄を握り直す。指先に、何かが宿った気がする。

@kagari あんたに渡しておきたかった。

```yaml
type: effects
effects:
  skills:
    learn: [chinkonho]
  affection:
    kagari: 1
  switches:
    learnedChinkonho: true
```

[end]
