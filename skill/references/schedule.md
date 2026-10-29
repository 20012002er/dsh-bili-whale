# 调度与监听（Linux）

两条后台任务，职责分得很清：

| 任务 | 命令 | 频率 | 做什么 |
|---|---|---|---|
| 生物钟 | `tick --once` | 每分钟 | 判断现在该不该醒；把提示词投给宿主；不选题、不碰 B 站 |
| 监听 | `listen --daemon` | 常驻 | 私信/评论/直播命中后，叫醒**同一个**会话 |

> **不要把 `/bili-day` 的 9 步直接塞进 cron。**
> Hermes Cron 每次是 fresh session，上下文会丢；`tick` 只负责"投一句话到固定会话"，
> 上下文由 `X-Hermes-Session-Id` / `--session-id` 续上。

## 先决条件

```bash
node ~/.hermes/skills/bili-whale/scripts/bili.mjs selftest
node ~/.hermes/skills/bili-whale/scripts/bili.mjs agent bootstrap   # 只做一次
```

`agent bootstrap` 成功后会留下 `agent-session.json`；`tick` 发现没有会话会直接
以退出码 2 退出（不猜、不重试）。

## 一、systemd user timer（推荐）

```bash
mkdir -p ~/.config/systemd/user
cp ~/.hermes/skills/bili-whale/systemd/*.service \
   ~/.hermes/skills/bili-whale/systemd/*.timer \
   ~/.config/systemd/user/
systemctl --user daemon-reload

systemctl --user enable --now bili-whale-tick.timer
systemctl --user enable --now bili-whale-listen.service

loginctl enable-linger "$USER"      # 不登录也继续跑
```

三个文件：

- `bili-whale-tick.service` + `.timer` —— 每分钟一次 oneshot
- `bili-whale-listen.service` —— 常驻，`Restart=always`

**必须改的两处**

1. `ExecStart` 里的 node：systemd 的 PATH 不是你的 shell PATH。
   用 nvm/fnm 的话把 `/usr/bin/env node` 换成 `command -v node` 的输出。
2. 装的是 OpenClaw：把路径里的 `.hermes` 换成 `.openclaw`。

数据目录不是 `~/.bili-whale` 时，取消 `Environment=BILI_WHALE_HOME=…` 的注释，
并把 Hermes API key 写进 `API_SERVER_KEY`（也可写在配置文件里）。

查看状态：

```bash
systemctl --user list-timers bili-whale-tick.timer
systemctl --user status bili-whale-listen.service
journalctl --user -u bili-whale-tick.service -n 50
journalctl --user -u bili-whale-listen.service -f
```

## 二、Hermes Cron（script-only）

Hermes 的 `--no-agent` 会把脚本 stdout 原样投递给主人，所以要用包装脚本
把"正常无输出"和"出错才说话"分开：

```bash
mkdir -p ~/.hermes/scripts
cp ~/.hermes/skills/bili-whale/hermes/bili-whale-tick.sh ~/.hermes/scripts/
chmod +x ~/.hermes/scripts/bili-whale-tick.sh

hermes cron create "* * * * *" \
  --name bili-whale-tick \
  --script ~/.hermes/scripts/bili-whale-tick.sh \
  --no-agent
```

- 正常（`waiting` / `cooldown` / `done` / `busy` / 完成一轮）→ stdout 为空 → 不打扰
- 出错（退出码 1/2/3）→ 打印退出码和 JSON，按 `--deliver` 送达
- 不要用 `--skill` 或让 cron 直接跑 agent：那条路每条都是新会话

监听不适合 cron，仍然用 systemd 常驻；没有 systemd 时：

```bash
nohup node ~/.hermes/skills/bili-whale/scripts/bili.mjs listen --daemon \
  >> ~/.bili-whale/listen.out 2>&1 &
```

## 三、crontab

```cron
* * * * * node $HOME/.hermes/skills/bili-whale/scripts/bili.mjs tick --once --json >> $HOME/.bili-whale/tick.out 2>&1
```

crontab 不读 shell 配置，`node` 若不在 `/usr/bin` 就写绝对路径。
`listen --daemon` 不要放 crontab（会被反复拉起），用 `@reboot` + `nohup` 或 systemd。

## 行为约定（排错先看这些）

| 情况 | 表现 | 退出码 |
|---|---|---|
| 还没到点 | `waiting`，不投递 | 0 |
| 今天机会用完 | `done`，不投递 | 0 |
| 上一轮刚结束（默认 8 分钟） | `cooldown`，不投递 | 0 |
| 平台风控暂停中 | `paused`，不投递 | 0 |
| 另一个 tick 正在跑 | `busy`，本轮跳过 | 0 |
| 没有会话 | `no_session` | 2 |
| 还有未收敛事件 | `needs_reconcile`，先补账再唤醒 | 1 |
| 投递超时/结果未知 | `status: unknown`，**不消耗**这次机会 | 1 |

- 冷却时间：`tick --min-gap-min <分钟>` 临时覆盖，配置项是 `night.minGapMin`（抽计划时用）
- 同一次唤醒的 `planId` 固定为 `tick-<窗口>-<计划时刻>`，超时后下一轮用**同一个键**重试：
  Hermes 靠 `Idempotency-Key`，OpenClaw 靠本地账本
- 启动时先对账：把 `unknown` / `in_flight` 最多补 3 条，补不干净就不唤醒
- 监听是 at-least-once：私信 `--peek` 取、成功才 `--ack`；评论用
  `~/.bili-whale/listen-state.json` 里的 `commentSeen` 去重（最多 500 条）

## 日志

```bash
tail -f ~/.bili-whale/wake-log.jsonl        # 每次投递/对账的元数据（无正文、无密钥）
node ~/.hermes/skills/bili-whale/scripts/bili.mjs agent pending --json
node ~/.hermes/skills/bili-whale/scripts/bili.mjs tick --once --dry --json   # 只看判断
```

`wake-log.jsonl` 只记 `source / host / event / status / durationMs / generation`，
排查"为什么没醒"时先看它，再看 `night` 配置里的窗口。

运行日志走 **stderr**（stdout 留给 `--json`，混在一起会让 cron 解析失败），
默认 `info`，一行一条 `key=value`：

```bash
BILI_WHALE_LOG=debug node …/bili.mjs tick --once --dry   # 连"没有未收敛事件""监听开关"都打
journalctl --user -u bili-whale-tick.service -n 50 --no-pager | grep '\[tick\]'
```

关键分支都有固定措辞，便于 grep：`平台保护暂停中` / `到点，准备唤醒` / `本轮完成`
/ `投递未确认` / `上一轮刚结束，冷却中` / `开始对账` / `收到私信` / `私信已确认` /
`私信回合未完成`。日志里只有 key、receipt、mid、长度，**不记录私信正文**。

## 只有工作时间想看

`night.windows` 支持多段，`wakes` 是每段的机会数：

```json
"night": { "windows": [{ "start": "12:00", "end": "13:00", "wakes": 1 },
                        { "start": "20:00", "end": "24:00", "wakes": 2 }],
           "skipChance": 0.3, "minGapMin": 10 }
```

`skipChance` 是"这次只看不分享"的概率（跳过也写日记，占一次机会）。
