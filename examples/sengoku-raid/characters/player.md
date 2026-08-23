---
id: player
name: 妖刀使い
map_sprite: assets/sprites/player-field
stats:
  hp:        { initial: 30, min: 0, max: 30 }
  mental:    { initial: 10, min: 0, max: 10 }
  spectral:  { initial: 5,  min: 0, max: 100 }
  intellect: { initial: 0,  min: 0, max: 99 }
---

主角。代々妖刀を継ぐ家の末裔。江戸の大名府に仕官し、各地に出没する妖怪を討伐して回る。

- **HP**: 体力。0 になると討伐失敗。
- **mental**: 精神。戦闘 / 戦慄イベントで削れる。
- **spectral**: 霊体化。妖力を吸う度に上がる。100 で身体が完全に妖刀の依代になる（BAD END）。
- **intellect**: 学識。術式の精度に効く（fumble 救済、不意打ちの命中）。
