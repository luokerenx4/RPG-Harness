---
id: bond_kasumi_02
title: 霞が伝授する——「早駆け」
characters: [kasumi]
bg: assets/backgrounds/inn-garden-dawn
requires:
  affection: { character: kasumi, min: 4 }
---

夜明け前。霞が裏庭で何かを巻物に書いている。

@kasumi これ、持ってけ。

巻物には、足運びの図が描かれていた。

@kasumi 猟師の足だ。鹿を追うときの。

@kasumi 鬼が振り返る前の半秒——あの半秒を使えば、どんな間合いからでも離脱できる。

@kasumi 父から教わった、最後の一手。

お主は巻物を受け取った。

@kasumi 一つだけ条件。あんたが折れそうになったら、これを使え。手柄を立てるためじゃない。

@kasumi 約束だ。

```yaml
type: effects
effects:
  skills:
    learn: [hayagake]
  affection:
    kasumi: 1
  switches:
    learnedHayagake: true
```

[end]
