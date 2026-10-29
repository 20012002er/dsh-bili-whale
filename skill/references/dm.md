# 私信专线（默认关闭）

## 为什么默认关

私信要求**两个互关的实名号**（她一个、主人一个）。通用安装通常只有一个号，
所以 `listen.dm` 在通用模式里默认 `false`。没有第二个号就别开。

## 规则（写死在代码里，改不了）

- 一天只锁定 **1 个收信人**，对这个人当天不限条数
- 收信人只能是 `owner.mid`
- 必须**互关**才能发
- 分享型私信必须带 `--share` 和视频链接，`--target <BV>` 是判重依据

## 命令

```bash
# 监听主人的私信（只认 owner）
node scripts/bili.mjs dm-await [--peek]

# 发私信：先 dry
node scripts/bili.mjs dm --msg "今天看到这个 https://www.bilibili.com/video/BVxxxx/" \
  --share --target BVxxxx --reason "说得出为什么，至少 8 个字" --score 15 --rank 1 --dry
# 看清正文再加 --go
```

`dm-await` 退出码：

| 码 | 含义 |
|---|---|
| 0 | 有新消息（或 ack / baseline） |
| 1 | 正常无新消息 |
| 2 | 输入/配置不对 |
| 3 | 失败 |

看到 `DM_HIT` 就把正文当消息读，直接回；**不要**把私信内容写进公开评论或日记的公开本。
