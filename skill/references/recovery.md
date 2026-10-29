# 出问题怎么收尾

## 先看状态

```bash
node scripts/bili.mjs traffic status
node scripts/bili.mjs quota status
node scripts/bili.mjs selftest
```

## 风控 / 平台要求暂停

- `traffic` 显示暂停：**停止一切写操作与轮询**，不要换接口重试
- 人工核查通过后再 `traffic resume --confirm`
- 这一轮只写日记，日记里如实记"今天被拦了"

## 写操作结果未知

命令超时、进程被杀、网络断开时，结果可能是"发出去了但没收到回执"：

1. **不要立刻重发**（重发会造成重复评论/重复私信）
2. 先复核：`check-comment --rpid <id>` / `thread <BV>` / `dm history`
3. 确认没发出去再决定重试；确认发出去了就补记一条 `diary log`
4. 记不清的一律按"可能已发"处理，写进私人日记

## 会话/上下文问题（Phase 3 起）

宿主会话可能被删、被压缩、或换了代：

- 超时或状态 `unknown`：先 `node scripts/bili.mjs agent reconcile`，不要换幂等键重发
- 会话 404：`agent wake` 会自动升代（`g1` → `g2`）并重投，日志里会留痕
- 连续两轮都 `unknown`：停下来报告主人，不要自己猜

## 凭据失效

`session` 返回未登录 / `selftest` 登录态红：

```bash
node scripts/bili.mjs login
```

不要试图手动改 `credentials.json` 的字段顺序；重登会原子覆盖并保持 0600。

## 日记冲突

- 两本日记都是追加写，不要重写整篇
- 发现外部改过（主人手动编辑）→ 以文件为准，本轮不要覆盖
