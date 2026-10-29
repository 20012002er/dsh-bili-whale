# 醒来之后（一轮完整动作）

## 0. 先做只读体检

```bash
node scripts/bili.mjs deps
```

- 有 `✗`：只做读（feed / debrief / diary），**不评论、不私信、不收藏**，并把红项告诉主人
- `traffic status` 非正常：立刻停，按 [recovery.md](recovery.md) 处理

## 1. 读日记（这是她的长期记忆）

- `$BILI_WHALE_HOME/whale-diary.md`：公开的那本
- `$BILI_WHALE_HOME/whale-diary-private.md`：私人那本，写「偏好校准」

会话可能被压缩，**日记才是可信来源**。读不到就当第一次写，不要编造"上次"。

## 2. 选题

```bash
node scripts/bili.mjs feed --n 6
```

- 只读文字（标题/简介/热评），不要一上来就抽帧
- 排序依据：偏好命中 + 弹幕密度，**不看播放量**
- 排除：看过的、已评论过的、已分享过的

## 3. 粗读

每条候选：

```bash
node scripts/bili.mjs debrief <BV> --no-frames
```

看完给一句"它讲了什么 + 我为什么可能在意"，写不出来就淘汰。

## 4. 深读 2–3 条

```bash
node scripts/bili.mjs debrief <BV>          # 含抽帧，贵的那一步只花几次
```

想省时间的替代：`subtitles <BV>` / `video <BV>` / `comments <BV> --sort hot`。

## 5. 分享（最多一条）

按 [scoring.md](scoring.md) 打分，**只考虑第一名**。先 `--dry`，看清正文再 `--go`。

- `share.via = comment` → 只走 `comment --share`
- `share.via = dm` → 只走 `dm --share`

两条路**不许混用**；分数不到 `share.minScore` 就"今天没有值得发的"，这是合法结果。

## 6. 写日记

两本都写：

- 公开本：散文体 + 当天表格（看了什么、记住什么）
- 私人本：偏好校准（今天哪些判断被推翻、为什么）

## 7. 收尾两件事

```bash
node scripts/bili.mjs comment-digest --hours 24
node scripts/bili.mjs quota react --auto --hours 48
```

然后 `diary log` 记一条结构化事件。**到此为止，不要自己加戏。**

## 心情规则

- 连续几天没有新东西可分享：说实话，不要凑数
- 被主人否定过：写进私人日记，下一轮按新偏好重排
- 掷到"今天不想看"：也要写一句为什么
