# 配置与数据目录

## 目录解析顺序

1. `$BILI_WHALE_HOME`（显式指定）
2. `~/.bili-whale`（存在就用，`install.mjs` 会创建）
3. `$DSH_HOME`（旧宿主）
4. `~/.dsh`（兜底，兼容旧版）

配置文件：`$BILI_WHALE_CONFIG`，否则 `<数据目录>/bili-whale.config.json`。
凭据：`~/.bili-ai/credentials.json`（跟用户走，不跟数据目录走；0600）。

## 数据目录里有什么

| 文件 | 内容 |
|---|---|
| `bili-whale.config.json` | 全部个人配置 |
| `whale-diary.md` | 公开日记 |
| `whale-diary-private.md` | 私人日记（偏好校准） |
| `whale-diary-events.jsonl` | 结构化事件 |
| `whale-night.json` | 生物钟状态 |
| `quota.json` | 额度与白名单 |
| `traffic.json` | 风控状态 |

会话与投递状态（Phase 3 起）：`~/.bili-whale/` 下
`agent-session.json` / `agent-delivery.jsonl` / `locks/`。
OpenClaw 用另一份：`agent-session-openclaw.json` / `agent-delivery-openclaw.jsonl`
（同机接两个宿主时互不覆盖）。

## 关键配置项

| 字段 | 说明 |
|---|---|
| `self.mid` / `self.name` | 她自己的账号 |
| `owner.mid` / `owner.name` | 主人（分享、私信、@ 的对象） |
| `share.via` | `comment` 或 `dm`，只能二选一 |
| `share.minScore` | 分享门槛，默认 13（0–20） |
| `share.enabled` | 关掉就只写日记不分享 |
| `quota.shareDaily` | 每天分享上限，默认 3 |
| `night.windows` | 允许醒来的时段，每段一次机会 |
| `night.maxVideos` | 每轮最多粗读几条 |
| `listen.dm` | 私信监听；配置里不写就当开，示例配置写 `false`（装完先不监听） |
| `listen.comment` / `listen.live` | 评论 / 直播监听，默认关；直播还要填 `listen.liveRoom` |
| `notify.type` | `none` / `desktop` / `webhook` / `command` |
| `agent.host` | `hermes` 或 `openclaw` |
| `agent.baseUrl` | Hermes API Server，只允许本机 |
| `agent.deliver` | 通用模式分享/报备走宿主 `--deliver` |
| `agent.openclaw.bin` | `openclaw` 命令路径（PATH 里没有就写绝对路径） |
| `agent.openclaw.sessionMode` | `session-id`（默认，隔代会话）或 `agent`（该 agent 的 main 会话，不隔代） |
| `agent.openclaw.agentId` | `sessionMode=agent` 时必填 |
| `agent.openclaw.local` | `true` 时加 `--local`，不经过 Gateway |
| `agent.openclaw.channel` | `deliver` 时用的渠道 |

## 环境变量

| 变量 | 用途 |
|---|---|
| `BILI_WHALE_HOME` | 数据目录 |
| `BILI_WHALE_CONFIG` | 配置文件路径 |
| `BILI_WHALE_NODE` | 指定 node 绝对路径（PATH 里没有 node 时） |
| `BILI_WHALE_STATE_DIR` | 会话/投递状态目录（默认 `~/.bili-whale`） |
| `BILI_WHALE_HERMES_BASE` | Hermes API Server 地址 |
| `BILI_WHALE_HERMES_KEY` | Hermes API key（也认 `HERMES_API_KEY` / `API_SERVER_KEY`） |
| `BILI_WHALE_OWNER_MID` | 覆盖 `owner.mid`（多主人/测试用） |

## 改完配置

不需要重启：脚本每次现读配置。下一轮醒来即生效。
