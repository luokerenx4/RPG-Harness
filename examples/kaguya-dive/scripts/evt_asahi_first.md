---
id: evt_asahi_first
title: 哥哥打来的电话
characters: [iroha, asahi]
cost: 0
requires:
  switch: { name: __trigger_only, eq: true }
---

晚上十一点。哥哥的来电。

@asahi 听说你转专业了。

@iroha 嗯。

@asahi 跟我说说。

——你站在公寓厨房，手机贴着耳朵。

——你想了一下要不要说。

——你哥哥三年前在着陆架下面护着你后脑勺。

——他比谁都有资格知道。

@iroha 哥。

@iroha 八千代就是辉夜。

——电话那头沉默了大概五秒。

——你听见他战队后台的吵闹声远了一点——他走出了那个房间。

@asahi ……

@asahi 你怎么确定的。

@iroha 月読核心。我 dive 过几次。

@iroha 她记得我。她记得那些只有辉夜会记得的事。

@asahi ……

@asahi 你要造身体。

@iroha 嗯。

@asahi 你要给她造一具能装回来的身体。

@iroha 嗯。

@asahi 行。

——他就说了一个字。

——你松了一口气。

@asahi 我不问技术细节。技术细节你比我懂。

@asahi 我帮你两件事。

@asahi 第一，钱。缺钱跟我开口。别去借校园贷。别打三份工。

@asahi 第二，权限。战队下周给我搞了套新外设。旧的那套，反应速度抽帧数据全套备份留在战队服务器里。

@asahi 我把权限给你开了。你要看，自己去。

@iroha ……谢谢。

@asahi 不用谢。

@asahi 还有一件事。

@iroha ？

@asahi 妈。

——你停了一下。

? 怎么说。
- "暂时不要告诉她。" -> +asahi | goto pick_hide
- "她有权知道。但请你来告诉她——你比我说得轻。" -> +2asahi | goto pick_brother_tell

# pick_hide

@asahi 嗯。

@asahi 我知道。

@asahi 等你做出东西来再说。

@asahi 爸不在以后她操心多。这件事她现在听不动。

@iroha 嗯。

@asahi 但她要是自己看出来——

@asahi ——你别再瞒。

@iroha 嗯。

@asahi 挂了。

[end]

# pick_brother_tell

@asahi ……

@asahi 你长大了。

@iroha ？

@asahi 你以前不会想到"哥比我说得轻"这种话。

@asahi 行。我找个时间跟她说。

@asahi 不是说"八千代就是辉夜"——这话她也接不住。

@asahi 我跟她说"彩叶在做一个跟辉夜有关的研究，进展不错。" 这一句先。

@asahi 剩下的留给你将来自己说。

@iroha ……

@iroha 谢谢哥。

@asahi 嗯。

@asahi 挂了。

[end]
