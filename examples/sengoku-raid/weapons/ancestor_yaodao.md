---
id: ancestor_yaodao
name: 祖伝妖刀
basePower: 4
kind: melee
# 脈絡 (pulse paths). Each rendered "absorb" after a victory feeds
# exactly one of these three counters. Runtime counters live in game
# variables (`pulse_pure` / `pulse_oni` / `pulse_mundane`); the
# `branches` here documents the schema + describes each path so AI
# authors and tooling can introspect what each pulse means without
# rummaging through code.
custom:
  pulse_paths:
    pure:
      label: 浄
      tagline: 鎮魂の脈
      effect: 霊体化触発率 -10% / 結界結局解放
    oni:
      label: 鬼
      tagline: 喰らう脈
      effect: 威力 +3 / 地獄門解放（BAD）
    mundane:
      label: 凡
      tagline: 整える脈
      effect: 威力 +2 / 安定終局解放
---

家伝の妖刀。先祖代々受け継がれてきた一振り。鋭く、しかし飢えている。鬼の魂を喰らうたびに威力を増すが、振るう者の血肉も少しずつ蝕んでゆく。

胸の奥に三つの脈がある——浄・鬼・凡。斬った鬼の妖力をどの脈に流すかで、刀の育ち方が変わる。

威力強化の手段：
- 神社の鍛冶師に魂石の欠片を奉納して鍛え直す（凡）
- 神主に鎮魂の儀を頼む（浄、要 oni_horn）
- 火炉に鬼の角を投じて鍛える（鬼、威力跳ね上がるが代償）
- 鬼との連戦で自然に成長する（pulse_pending → 脈絡選択）
