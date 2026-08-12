---
id: road_kasumi
title: 道中 ・ 霞
characters: [kasumi]
---

:hide-cg

:portrait center assets/portraits/kasumi-smile

霞は途中で何度も立ち止まる。地面を見て、草の折れ方を見て、また歩く。

@kasumi ほら、ここ。鬼が通ったのは三日前。爪が土に深く入ってる——急いでた。

お主には、ただの掻き傷にしか見えない。

@kasumi 猟は、獲物より先に「気配の跡」を狩るんだ。本体に会う頃には、もう半分仕留めてる。

霞は弓を背に、振り向いて笑った。歩きながら笑う——刀の家系には、無い癖だ。

@kasumi あんた、いつも前ばっかり見てるね。鬼が来る方角だけ。

@kasumi 跡を読むなら、後ろも見な。鬼が「どこから来たか」は、「次どこへ行くか」と同じ顔してる。

? どうする？
  - 振り返って、来た道の跡を読んでみる -> +2kasumi | goto learn
  - 「お前が見ててくれ。俺は前を持つ」 -> +kasumi | goto split_roles
  - 「猟師の目は、借り物じゃ身につかないな」 -> +kasumi | goto honest

# learn

@kasumi そう、それ。踏んだ草じゃなくて、起き上がろうとしてる草を見な。時間まで読める。

霞は鼻歌を一つ。鹿の蹄の跡を辿るその足取りは、鬼の通り道を綺麗に避けていた。

:portrait center

```yaml
type: effects
effects:
  affection:
    kasumi: 1
  switches:
    road_kasumi_seen: true
```

[end]

# split_roles

@kasumi 役割分担か。悪くない。でも時々は振り返りな——あたしがまだいるか、確かめるくらいには。

霞は鼻歌を一つ。鹿の蹄の跡を辿るその足取りは、鬼の通り道を綺麗に避けていた。

:portrait center

```yaml
type: effects
effects:
  affection:
    kasumi: 1
  switches:
    road_kasumi_seen: true
```

[end]

# honest

@kasumi ははっ、正直でよろしい。まあ、隣で何度も見てりゃ、そのうち移る。

霞は鼻歌を一つ。鹿の蹄の跡を辿るその足取りは、鬼の通り道を綺麗に避けていた。

:portrait center

```yaml
type: effects
effects:
  affection:
    kasumi: 1
  switches:
    road_kasumi_seen: true
```

[end]
