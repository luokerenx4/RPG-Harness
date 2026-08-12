---
id: oni_lesser
name: 下級の鬼
hp: 8
attack_power: 3
stats:
  # 交渉 DC modifier — higher cunning = harder to coax lore / drops out.
  cunning: 1
narrations:
  intro: "風が途切れ、足元の影だけがこちらへ伸びる。物陰から這い出してきたのは——HP {hp} の{name}。"
  victory: "鬼は霧散した。妖力が刀に吸い込まれる——霊体化 {spectralBefore}→{spectralAfter}。"
  escape: "鬼の爪が掠めた。逃げ場のない傷——体力 -{damage}, 霊体化 +{spectralGain}。"
# 交渉「聞き出す」で語る一節。下級の鬼はまだ言葉を半分覚えている。
# Module reads this via enemy.custom.negotiate_lore (the engine's
# narrations schema only models intro/victory/escape).
negotiate_lore: "鬼は喉を鳴らす。「……井戸……母さん……まだ、井戸の底に……」言葉が崩れて、また唸りに戻った。"
negotiate_drop: soul_shard
---

低位の鬼。雑魚と呼ぶには俗だが、油断すれば人を殺める力はある。傷ついた魂や墓場、井戸の底から湧き出るのが常。

戦闘での扱い：
- 妖刀威力が 5 以上なら一撃で倒せる確率が高い
- 連戦すると霊体化が積もる
