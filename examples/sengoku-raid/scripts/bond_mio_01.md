---
id: bond_mio_01
title: 査問する者
characters: [mio]
bg: assets/backgrounds/sumida-bank-sunset
requires:
  affection: { character: mio, min: 2 }
---

隅田河の岸。日が傾き、水面が赤く伸びている。

澪は脇差を鞘ごと膝に横たえ、流れを見ていた。お主が隣に座っても、目は動かさない。

@mio お主、私を恨んでいるか。

@mio 「鬼に堕ちていないか確かめに来た」——そう言って横に立つ者を、好く道理はないだろう。

答えを待たず、澪は続けた。

@mio 京を発つ前、私は十一人を査問した。九人は「未だ堕ちず」と判じた。

@mio 残り二人は——その場で斬った。

水面の赤が、少し濃くなる。

@mio 一人は、確かに人をやめていた。迷いはなかった。

@mio もう一人は……まだ、引き返せたかもしれない。私の見立てが、半日早かった。

@mio 公儀の沙汰は「疑わしきは斬る」。私はそれを奉じている。奉じているが——

澪は初めてお主を見た。冷たい目の奥に、別の層があった。

@mio 査問する者の霊体化は、誰が見立てる。

? なんと答える？ {id: answer-who-judges-the-inquisitor}
  - 「お前の鏡に、お前を映せばいい」 {id: turn-the-mirror-on-herself} -> +2mio | goto mirror
  - 「斬った二人目を、まだ数えているのか」 {id: ask-about-the-second-death} -> +mio | goto second
  - 黙って、流れに小石を一つ落とす {id: cast-a-stone-in-silence} -> +mio | goto stone

# mirror

@mio ……私を、私の鏡で。考えたことがない、と言えば嘘になる。見るのを避けてきた。

:goto after_answer

# second

@mio 数えている。十一人ではない。あの一人だけを、夜ごと最初から数え直している。

:goto after_answer

# stone

小石の波紋が、澪とお主の影を同じように歪めた。

@mio ……答えないのか。いや、その波紋が答えか。測る側だけ、水の外には立てぬ。

# after_answer

@mio 私は、自分の影をいちばん長く見てきた者だ。だから分かる——お主は、まだ堕ちていない。

@mio それでも私は同行する。見立てを誤らぬために。

澪は脇差を握り直した。刀一本分あった距離が、半分になっていた。

[end]
