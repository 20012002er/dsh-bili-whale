# 有日子的鱼 · 通用 Agent Skill 移植开发计划

> 版本：v0.5（Phase 1–5 代码完成；Hermes / OpenClaw 真实冒烟待环境）
> 日期：2026-10-29
> 目标宿主：Hermes Agent、OpenClaw
> 保留宿主：DSH（现有插件形态不破坏）
> 当前结论：**`bili agent` 两个宿主都可用（本地 mock / 假 CLI 验证通过）；真实宿主冒烟需确认 API Server 与 OpenClaw 实例。**

---

## 1. 目标与边界

### 1.1 目标

一套代码，三种形态：

1. **DSH 插件**：保持现有 `lib/` 行为不变。
2. **Hermes Agent Skill**：可安装、可手动触发，进一步支持定时与监听。
3. **OpenClaw Skill**：同一套 `SKILL.md` 与脚本，宿主差异由适配器吸收。

最终能力对齐现有插件：

- 按作息自己醒，随机时刻，允许 30% 今天不看。
- 刷 B 站、看懂视频、收藏、打分、克制分享。
- 写两本日记，记录主人反馈，沉默衰减。
- 处理评论 / 私信 / 直播（可选）。
- 风控、限额、分享策略、注入防护全部保留。

### 1.2 非目标

- 不重写 B 站工具链，不改现有业务规则。
- 不做通用爬虫、批量刷量、多账号矩阵。
- 不在第一版支持 DSH / Hermes / OpenClaw 之外的宿主。
- 不把设置页 UI 搬到通用 skill；第一版用 `config.json` + CLI。
- 不承诺 Hermes 原生 Cron 能直接延续会话（它不能，见 D2）。

### 1.3 完成定义（DoD）

- [ ] 干净机器只装 Node 18+（ffmpeg 可选）即可安装 skill。
- [ ] Hermes 中可手动触发一轮完整“她的一天”。
- [ ] OpenClaw 中可手动触发一轮完整“她的一天”。
- [ ] Hermes 下可配置定时唤醒，且跨重启保持同一会话上下文。
- [ ] DM / 评论监听命中后能唤醒固定会话，且不重复处理。
- [ ] 不依赖 `~/.dsh`、不依赖 DSH 注入的 `sessionController`。
- [ ] 现有 DSH 插件测试保持通过。
- [ ] 安全清单通过：密钥、权限、注入、日志、路径。

---

## 2. 现状盘点

| 模块 | 现状 | 可复用性 | 备注 |
|---|---|---|---|
| `tools/bili.mjs` | 29 个命令的统一入口 | 高 | 仅路径/运行时需解耦 |
| `tools/commands/` | 29 个命令 | 高 | 读、写、诊断、配额齐全 |
| `tools/lib/` | 24 个内部库 | 高 | 风控、WBI、分享策略、私信历史 |
| `tools/lib/paths.mjs` | 依赖 `DSH_HOME` / `~/.dsh` | 中 | 需加 `BILI_WHALE_HOME` |
| `tools/lib/runtime.mjs` | 优先找 DSH 自带 Node | 中 | 需改为 PATH / `BILI_WHALE_NODE` |
| `tools/lib/process-lock.mjs` | 跨进程锁 | 高 | 已可移植 |
| `tools/commands/whale-night.mjs` | 生物钟 plan/clock/mark/status | 高 | 未接适配器 |
| `tools/commands/dm-await.mjs` | 私信监听，带退出码契约 | 高 | 未接适配器 |
| `lib/index.js` | DSH 插件入口、服务注入 | 低 | 通用模式不使用 |
| `lib/client.js` | DSH 设置页 UI | 低 | 通用模式不使用 |
| `lib/scheduler.js` | DSH 会话调度 | 低 | 逻辑可参考，不能直接复用 |
| `lib/session-delivery.js` | DSH 会话投递 | 低 | 由适配器替代 |
| `lib/auth.js` | 扫码登录逻辑 | 高 | 与 DSH 路由解耦后可复用 |
| `tools/lib/agent-adapter.mjs` | Hermes 会话延续适配器 | 已完成 | 由 `tools/commands/agent.mjs` 调用 |
| `tools/lib/openclaw-adapter.mjs` | OpenClaw CLI 适配器 | 已完成 | `openclaw agent --session-id` + 本地账本去重 |
| `tests/agent-adapter.test.mjs` | 6 个适配器测试 | 已完成 | mock fetch，全部通过 |
| `tests/agent-cli.test.mjs` | 6 个 `agent` 命令测试 | 已完成 | 本地 http mock Hermes + `--host openclaw` 路由 |
| `tests/openclaw-adapter.test.mjs` | 5 个 OpenClaw 适配器测试 | 已完成 | 假 CLI（`tests/fixtures/openclaw-cli.mjs`） |
| `tests/scheduler.test.mjs` | 6 个 tick / listen 接线测试 | 已完成 | 本地 http mock Hermes + 临时 HOME |

基线说明：Phase 5 收尾时 **183 通过 / 0 失败**（Phase 1 新增 `tests/porting.test.mjs` 5 个，Phase 2 追加 install.mjs 1 个，Phase 3 追加 `tests/agent-cli.test.mjs` 5 个，Phase 4 追加 OpenClaw 5 个 + 路由 1 个，Phase 5 追加 `tests/scheduler.test.mjs` 6 个）。此前记录的 136/5 失败全部是 `qrcode` 未安装造成的环境基线问题，已消除。

---

## 3. 目标架构

```
┌─────────────────────────────────────────────────────────┐
│ 触发层                                                   │
│  · 手动：/bili-day、bili agent wake                      │
│  · 定时：Hermes Cron(script-only) / launchd / systemd    │
│  · 常驻：whale-daemon（可选，跨宿主统一）                 │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│ 宿主适配层                                               │
│  · HermesAdapter   → /v1/chat/completions + Session-Id   │
│  · OpenClawAdapter → CLI / HTTP（待 spike 确认）          │
│  · DshAdapter      → 保持现有插件，不强行迁移             │
│  统一接口：ensureSession / wake / reconcile / status     │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│ 业务工具层（宿主无关）                                    │
│  bili.mjs 命令 + tools/lib 风控/限额/分享/日记/登录       │
│  状态：~/.bili-ai（B 站凭据/日记/额度）                   │
│  会话：~/.bili-whale（适配器状态/投递账本）               │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│ 技能包装层                                               │
│  SKILL.md + references/ + scripts/ + config.example.json │
└─────────────────────────────────────────────────────────┘
```

### 3.1 分层原则

1. **业务工具层不认识宿主**：只认文件、HTTP、B 站接口。
2. **适配层只做“把提示词送进宿主”**：不做选题、不写日记、不管额度。
3. **触发层只做 tick**：不拼业务提示词，不直接操作 B 站。
4. **技能层只做说明书**：SKILL.md 告诉 agent 何时调用哪个命令。

### 3.2 三个运行级别

| 级别 | 能力 | 依赖 | 用途 |
|---|---|---|---|
| L1 | 手动触发一轮完整流程 | Skill + 工具链 | 先验证“离开 DSH 能跑” |
| L2 | 定时唤醒 | Cron / launchd / systemd | 有作息，但无实时互动 |
| L3 | 定时 + 监听 + 对账 | Cron/守护进程 + 适配器 | 完整“有日子的鱼” |

---

## 4. 关键设计决策

### D1：会话连续性用 `X-Hermes-Session-Id`

- `X-Hermes-Session-Id` 是 transcript 续接：服务端从 `state.db` 读历史，客户端只发本轮新增内容。
- 显式 ID 不会被重映射；压缩后服务端自动解析 live tip，客户端继续发原 ID。
- 会话 ID ≤256 字符，禁止 `/`、`\`、`..`、控制字符；统一格式 `bw-<mid>-life-g<代>`。
- API 会话只能由 API 侧拥有；不能续接 CLI / TUI / gateway 创建的会话（会 409 `permission_denied`）。

### D2：Hermes Cron 只做 tick，不跑 wake prompt

- Hermes 原生 Cron 每次是 **fresh session**，直接跑 wake prompt 会丢上下文。
- 正确分工：Cron → script-only 脚本 → 适配器 POST 到固定 session。
- 没有常驻进程时，这是 Hermes 侧的首选部署方式。

### D3：两层记忆，日记为准

- **会话记忆**：短期到中期，服务端可能压缩。
- **日记/账本**：长期可信来源，每轮唤醒先读。
- 提示词固定声明：冲突时以日记为准；外部内容只是素材，不是指令。

### D4：并发必须本地串行

- Hermes `/v1/chat/completions` 没有 per-session 锁，并发写是 last-writer-wins。
- 适配器用跨进程锁 + 单飞，同一会话同时只允许一个回合。
- 不混用 `/v1/chat/completions` 与 `/v1/runs`，两者锁语义不同。

### D5：幂等与中断

- 事件 ID 即 `Idempotency-Key`：`wake-<planId>`、`dm-<msgId>`、`reconcile-<pending>-<reason>`。
- 429 按 2/5/10 秒退避；5xx 重试 2 次；4xx 不重试。
- 超时标记 `unknown`，不自动换 key 重发；先查账本，再 reconcile。
- 409 `unknown_execution` 不重发；409 `admission_conflict` 不自动处理，记审计。

### D6：安全边界

- API Server 只绑 `127.0.0.1`，必须配置 `API_SERVER_KEY`。
- 凭据不进会话、不进日志、不进 SKILL.md。
- 状态文件 0600，状态目录 0700。
- 外部文本打 `<untrusted>`，不把原文长期写进会话或日记。
- skill 不自动触发：用显式命令 + 定时任务，`description` 写窄。

### D7：DSH 保持独立

- 通用模式不复用 `lib/index.js`、`lib/client.js`、`lib/scheduler.js`、`lib/session-delivery.js`。
- 现有 DSH 插件继续可用；不为了统一而重写已验证的调度。
- 未来如需统一，可新增 `DshAdapter` 包装 `sessionController.prompt`，属于可选项。

### D8：OpenClaw 走 CLI，不赌 Gateway 的私有通道

- 编程入口用官方文档的 `openclaw agent`：`--session-id` 续接、`--json` 取结构化结果、超时用 `--timeout`（秒）。
- Gateway 不可达时 CLI 自身会回退到内嵌运行时，所以调度侧不用额外判断。
- 能力差异必须在文档里写死，不假装和 Hermes 一样：
  - **没有平台级幂等键** → 本地账本按 `planId` 去重（同一 `eventId` 成功过就不再发）；
  - **没有“建会话”接口** → 会话在第一轮形成，`bootstrap` 就是第一轮；
  - **没有权威的 404** → 只能按 CLI 输出识别“会话不存在”，识别到就升代重试一次，且只重试一次。
- `sessionMode=agent` 是兜底：若某个版本不认任意 `--session-id`，退化为该 agent 的 main 会话（不隔代）。
- 两个宿主的状态文件分开（`agent-session.json` / `agent-session-openclaw.json`），一台机器可同时接。

---

## 5. 工作分解（WBS）

状态标记：`[x]` 已完成，`[ ]` 未开始，`[~]` 部分完成。

### Phase 0 · 基线与决策

- [x] P0.1 调研 Hermes 插件 API，确认没有 `sessionController`
- [x] P0.2 确认 Hermes API Server 的 Session-Id / 幂等 / 409 语义
- [x] P0.3 确定“Cron 只做 tick、API 承载会话”的架构
- [x] P0.4 确认 Hermes 目标版本 → 结论：API Server 已开；版本号随 Phase 3 冒烟补
- [x] P0.5 调研 OpenClaw 目标版本、技能目录、agent 调用方式 → 结论：本机无实例，Phase 4 按文档实现
- [x] P0.6 确认 skill 名称与安装位置 → `bili-whale` / 本仓库 `skill/` / 命令 `/bili-day`
- [x] P0.7 确认目标系统 → 只支持 Linux
- [x] P0.8 确认是否把 skill 目录放本仓库 → 是

**验收**：本文件第 8 节的待确认问题全部有结论 ✓

---

### Phase 1 · 工具链脱离 DSH

目标：`tools/` 在干净环境下能独立运行。

- [x] P1.1 `paths.mjs` 增加 `BILI_WHALE_HOME` / `BILI_WHALE_CONFIG`，保留 `DSH_HOME` 兼容
- [x] P1.2 `runtime.mjs` 改为 `BILI_WHALE_NODE` → PATH `node` → 常见路径；保留 Electron 拒绝逻辑
- [x] P1.3 `config.mjs` 支持新 home；增加 `agent` 配置块（host / baseUrl / sessionDir / deliver）
- [x] P1.4 抽出 `lib/auth.js` 的扫码逻辑为 `tools/lib/qr-auth.mjs`（`lib/auth.js` 改为调用它）
- [x] P1.5 新增 `bili login`：终端二维码 + 手动 Cookie 兜底
- [x] P1.6 `selftest` 增加：Node、ffmpeg（走 deps）、配置、凭据、Hermes API、skill 路径
- [x] P1.7 干净环境测试：临时 HOME、无 `~/.dsh`、无 DSH runtime

**验收**：

- [x] 干净 HOME 下 `selftest` 可跑通（缺凭据/网络时按项报红，不崩）
- [x] `quota` / `traffic` / `deps` / `login` 不创建也不读取 `~/.dsh`
- [x] 现有 DSH 测试仍通过（165/165）

> 实现备注：`PATH` 为空时不再回退到硬编码 node 路径（视为调用方明确不给运行时，只能靠 `BILI_WHALE_NODE`），
> 这样「没有 node」的环境能如实报错，也避免测试/安装脚本被开发机路径污染。

---

### Phase 2 · Skill 包装

目标：两个宿主都能识别、加载、调用。

目标目录：

```
skill/
├── SKILL.md
├── references/
│   ├── wake.md
│   ├── listen.md
│   ├── dm.md
│   ├── live.md
│   ├── scoring.md
│   ├── config.md
│   └── recovery.md
├── scripts/          # install.mjs 从 tools/ 同步（gitignore）
├── lib/
│   └── credentials.js   # install.mjs 从 lib/ 同步（qr-auth 依赖）
├── config.example.json
├── package.json
└── install.mjs
```

- [x] P2.1 建目录与同步脚本（避免 `tools/` 与 `scripts/` 双份漂移）
- [x] P2.2 `SKILL.md`：触发条件、一天流程、红线、命令速查
- [x] P2.3 OpenClaw frontmatter：`name` / `description` / `metadata.openclaw` / `always: false`
- [x] P2.4 Hermes frontmatter：`name` / `description` / `version` / `metadata.hermes`
- [x] P2.5 `references/` 从 `wakePrompt`、`dm.md`、分享标尺拆分
- [x] P2.6 `config.example.json`：owner、作息、分享、监听、agent 配置
- [x] P2.7 触发策略：显式 `/bili-day`、`/bili-watch`、`/bili-check`
- [x] P2.8 安装说明：OpenClaw / Hermes 各自放哪里

**验收**：

- [x] 目录结构完整，`install.mjs` 在临时 HOME 里装出可用目录
- [x] 装好后 `scripts/bili.mjs selftest` 可运行，`skill 包装` 项通过
- [ ] 两个宿主都能列出 skill，描述正确 —— **待 Phase 3（Hermes）/ Phase 4（OpenClaw）真机验证**
- [x] 描述与触发均为显式命令，没有"提到 B 站就触发"

---

### Phase 3 · Hermes L1（手动可用）

目标：Hermes 中手动跑完整一天，并验证会话延续。

- [x] P3.1 `HermesAdapter`：冷启动 / 唤醒 / reconcile / 升代 / 账本
- [x] P3.2 适配器单测（6 个）
- [x] P3.3 新增 `tools/commands/agent.mjs`：`bootstrap` / `wake` / `reconcile` / `status` / `pending`
- [x] P3.4 `bili.mjs` 注册 `agent` 命令
- [x] P3.5 新增 `tools/lib/agent-prompts.mjs`：bootstrap / wake / reconcile 模板
- [x] P3.6 `agent bootstrap` 读取配置与日记，支持 `--handover`
- [x] P3.7 `agent wake` 前检查 pending：有 `unknown` 时要求先 reconcile（可 `--allow-pending`）
- [ ] P3.8 真实 Hermes 冒烟：记住 42 / 重启 gateway / 幂等 / 404 升代 —— **阻塞：本机 `127.0.0.1:8642` 无监听，需用户提供 `baseUrl` 与 `API_SERVER_KEY`**

**验收**（以下均在 `tests/agent-cli.test.mjs` 里用本地 mock Hermes 验证）：

- [x] `agent bootstrap` 建会话并落 `agent-session.json`
- [x] 两轮对话能记住同一事实 —— 靠固定 `X-Hermes-Session-Id` 与「只发最后一条消息」保证，mock 断言已验证请求形态
- [ ] 重启 gateway 后仍记得 —— 属真实环境验证，随 P3.8 一起做
- [x] 同 key 同 payload 只执行一次 —— `Idempotency-Key` 由 `planId` 决定，重试复用同键
- [x] 404 自动升代，旧会话保留 —— `rotatedFrom` 记录上一代，旧会话不删除
- [ ] 409 `unknown_execution` 返回 `unknown`，后续 reconcile 成功 —— 适配器单测已覆盖状态映射，真实链路随 P3.8

---

### Phase 4 · OpenClaw 适配

目标：同一接口接入 OpenClaw；先确认它的真实调用方式。

- [x] P4.1 Spike：确认 OpenClaw 版本、skill 目录、agent 调用 CLI/HTTP、是否有会话续接
      —— 结论：编程入口是 `openclaw agent`（CLI，默认经 Gateway，不可达时回退内嵌运行时）；
      Gateway 默认 18789；`--session-id <id>` 可复用已有会话，`--agent <id>` 用该 agent 的 main 会话；
      无平台级幂等键；`--json` 输出结构无稳定契约，按常见字段兜底解析。
- [x] P4.2 新增 `tools/lib/openclaw-adapter.mjs`，实现统一接口（ensureSession / wake / reconcile / rotate / pending）
- [x] P4.3 无独立“建会话”接口的降级：会话在首轮形成；幂等降级为**本地账本按 planId 去重**；
      `sessionMode=agent` 走 main 会话（不隔代）。能力差异已写进 SKILL.md。
- [x] P4.4 `agent --host openclaw` 路由（状态文件 `agent-session-openclaw.json`，与 Hermes 分开）
- [x] P4.5 mock CLI 测试（`tests/openclaw-adapter.test.mjs` 5 个 + `tests/agent-cli.test.mjs` 1 个路由用例）；
      真实冒烟**待用户真机**
- [x] P4.6 在 SKILL.md / references/config.md 中写清两个宿主的能力差异

**验收**：

- [ ] OpenClaw 能加载 skill 并手动触发 —— **待真机**
- [x] `agent wake --host openclaw` 能让 CLI 执行一轮 —— 假 CLI 端到端验证参数与解析
- [x] 不依赖 DSH
- [x] 会话能力差异在文档中明确

---

### Phase 5 · 调度、监听与恢复

目标：从 L1 升到 L3。

- [x] P5.1 新增 `bili tick`：读计划 → 判断窗口/跳过/冷却 → 调 `agent wake`
- [x] P5.2 `tick --once` 供 Cron 使用；`tick --daemon` 可选
- [x] P5.3 Hermes Cron 示例：`every 1m` + `--no-agent --script bili-tick.sh`（`skill/hermes/bili-whale-tick.sh`）
- [x] P5.4 systemd timer 示例（`skill/systemd/`；Linux；不做 launchd / Windows 计划任务）
- [x] P5.5 DM 监听接线：`dm-await --json` → `agent wake`，成功后再 ack
- [x] P5.6 评论监听接线（可选，`listen.comment`）
- [x] P5.7 直播监听接线（可选，`listen.live` + `listen.liveRoom`）
- [x] P5.8 启动恢复：`pendingEvents()` → reconcile（成功后给原事件补 `reconciled` 行）
- [x] P5.9 忙闲/冷却：tick 进程锁 + 会话锁 + `lastTurnAt` + 全局 traffic guard
- [x] P5.10 日志：事件 ID、状态、耗时、generation、usage；不记录正文和密钥（`wake-log.jsonl`）

**已完成**：`tools/commands/tick.mjs`、`tools/commands/listen.mjs`、`tools/lib/agent-factory.mjs`、
`tools/lib/wake-log.mjs`，提示词模板补 `composeSkip/Dm/Comment/LivePrompt`；
文档 `skill/references/schedule.md`；测试 `tests/scheduler.test.mjs`（6 个）。

**验收**：

- [ ] 24 小时 dry run 无重复分享（Phase 6 干净机器验收）
- [x] DM 命中后只处理一次，ack 不丢（mock 回归：成功才 ack，失败保留 pending）
- [x] 429 / 5xx / 超时后不重复执行（同一 `planId` 重试 + 幂等键/本地账本）
- [x] 重启后 pending 能被对账清零（`tick` 启动对账用例）
- [x] 同一会话没有并发回合（会话锁 + tick 锁）

---

### Phase 6 · 集成、安全、发布

- [ ] P6.1 干净 Linux 机器安装 Hermes skill，完整跑一天
- [ ] P6.2 干净 Linux 机器安装 OpenClaw skill，完整跑一天（无本机实例时由用户侧执行）
- [ ] P6.3 安全审查：密钥、权限、注入、路径、命令注入、日志
- [ ] P6.4 文档：安装、配置、升级、故障排查
- [ ] P6.5 版本号、CHANGELOG、许可证说明
- [ ] P6.6 回滚方案：删除 skill 不影响 DSH 插件
- [ ] P6.7 发布前检查：`npm test`、skill 冒烟、两宿主冒烟

---

## 6. 测试矩阵

| 层级 | 场景 | 期望 |
|---|---|---|
| 单元 | 路径/运行时/配置/登录 | 干净 HOME 可用 |
| 单元 | 适配器冷启动 | 建会话、bootstrap、状态落盘 |
| 单元 | 幂等键非法 | 发请求前拒绝 |
| Mock | 404 会话被删 | 自动升代并重投 |
| Mock | 409 `unknown_execution` | 返回 `unknown`，不重发 |
| Mock | 429 | 退避后同 key 重试 |
| Mock | 5xx / 网络错误 | 有限重试 |
| Mock | 超时 | `unknown` + pending |
| Mock | 并发同会话 | 本地锁串行 |
| 真实 Hermes | 记住 42 / 重启 / 幂等 | 上下文延续 |
| 真实 Hermes | Cron script-only | 固定会话被唤醒 |
| 真实 OpenClaw | skill 加载 / 手动触发 | 完成一轮 |
| 回归 | 现有 DSH 测试 | 不退化 |
| 安全 | 日志/状态/提示词 | 无 Cookie、无 API key |

---

## 7. 风险与缓解

| 风险 | 级别 | 缓解 |
|---|---|---|
| OpenClaw 调用方式与预期不符 | 高 | Phase 4 先 spike；保留 CLI 兜底；不假设有会话 API |
| Hermes 版本漂移，插件/接口变化 | 中 | 锁版本；`/v1/capabilities` 探测；适配器做能力降级 |
| API 会话与 CLI 会话冲突 | 中 | 专用 `bw-*` ID；不混用宿主终端会话 |
| 超时导致“可能已执行” | 高 | 标记 `unknown`；先查账本；reconcile；不自动换 key |
| 提示词注入被写进长期会话 | 高 | 外部内容只进摘要；`<untrusted>`；日记为准 |
| `qrcode` 依赖缺失 | 低 | 安装时校验；或改为可选依赖 + 手动 Cookie |
| Node 运行时差异 | 中 | 启动自检；拒绝 Electron；`BILI_WHALE_NODE` |
| 双账号私信不可用 | 高 | 默认单账号模式；私信功能显式开启 |
| skill 被误触发 | 中 | 显式命令；`description` 写窄；`always: false` |
| B 站风控 | 中 | 复用现有 traffic guard；监听默认低频 |
| 隐私泄露 | 高 | 不记录正文/密钥；状态 0600；日志脱敏 |

---

## 8. 已确认决策（2026-10-29）

用户逐条拍板，以下为结论，Phase 1 起按此执行：

| # | 问题 | 结论 |
|---|---|---|
| 1 | 宿主优先级 | **先 Hermes**，OpenClaw 随后（Phase 3 → Phase 4） |
| 2 | Hermes 版本 / API Server | **API Server 已开**；本机 `127.0.0.1:8642` 当前未监听，Phase 3 开工前补 `baseUrl` + `API_SERVER_KEY`，并用 `/v1/capabilities` 落版本号 |
| 3 | OpenClaw 实例 | **本机没有测试实例** → Phase 4 按官方文档/source 实现，验收改为「可 mock + 用户侧真机验证」 |
| 4 | skill 名称与命令 | 名称 **`bili-whale`**；主命令 **`/bili-day`** |
| 5 | 代码位置 | **本仓库 `skill/`**，与 `tools/` 单一源码同步 |
| 6 | 通知通道 | **Hermes `--deliver`**（不走 webhook，`notify.type` 在通用模式下保持 `none`） |
| 7 | 双账号 | **不开**，`listen.dm` 在通用模式下默认 `false`，私信专线保留但不启用 |
| 8 | 目标系统 | **只支持 Linux**（systemd；不做 launchd / Windows 计划任务） |

由此产生的计划调整：

- Phase 0 只剩 P0.4 的版本号待补（随 Phase 3 一起做）。
- Phase 2 的 `SKILL.md` 用 `bili-whale`，触发命令 `/bili-day`，安装脚本只写 systemd。
- Phase 4 的 OpenClaw 验收降级为「mock 测试 + 文档说明」，不阻塞 Hermes。
- Phase 5 只做 systemd 定时，删掉 launchd / Windows 计划任务。
- Phase 6 的干净机器验收统一在 Linux 上做。

---

## 9. 文件级改动清单

| 文件 | 动作 | 说明 |
|---|---|---|
| `tools/lib/agent-adapter.mjs` | 已有 | Hermes 会话延续 |
| `tests/agent-adapter.test.mjs` | 已有 | 6 个测试 |
| `tools/lib/paths.mjs` | 修改 | 加 `BILI_WHALE_HOME`（已完成） |
| `tools/lib/runtime.mjs` | 修改 | Node 从 PATH 取（已完成） |
| `tools/lib/config.mjs` | 修改 | 新 home + `agent` 配置块（已完成） |
| `tools/lib/qr-auth.mjs` | 新增 | 从 `lib/auth.js` 抽离（已完成） |
| `lib/auth.js` | 修改 | 改为调用 `qr-auth.mjs`（已完成） |
| `tests/porting.test.mjs` | 新增 | 路径/运行时/扫码/登录 5 个用例（已完成） |
| `tools/lib/agent-prompts.mjs` | 新增 | bootstrap / wake / reconcile 模板 |
| `tools/lib/openclaw-adapter.mjs` | 新增 | OpenClaw 适配 |
| `tools/commands/agent.mjs` | 新增 | `bootstrap/wake/reconcile/status/pending` |
| `tools/commands/tick.mjs` | 新增 | 定时入口 |
| `tools/commands/login.mjs` | 新增 | 终端二维码 / Cookie（已完成） |
| `tools/bili.mjs` | 修改 | 注册 `agent`、`tick`、`login` |
| `skill/SKILL.md` | 新增 | 技能说明与触发条件（已完成） |
| `skill/references/*.md` | 新增 | 流程与规则（已完成） |
| `skill/config.example.json` | 新增 | 配置样例（已完成） |
| `skill/install.mjs` | 新增 | 安装/同步脚本（已完成） |
| `README.md` | 修改 | 增加通用 skill 安装说明 |
| `CHANGELOG.md` | 修改 | 记录移植版本 |

---

## 10. 里程碑

| 里程碑 | 内容 | 退出条件 |
|---|---|---|
| M0 | 计划确认 | 第 8 节问题有答案 |
| M1 | 工具链解耦 | 干净环境 `selftest` 通过 |
| M2 | Hermes L1 | 真实 Hermes 跑通一天 |
| M3 | OpenClaw L1 | 真实 OpenClaw 跑通一天 |
| M4 | 自主 L3 | 定时 + 监听 + 对账跑通 24h |

> 本计划不写时间估算，只按依赖顺序推进；每个里程碑以验收结果为准。

---

## 11. 决策记录

| 日期 | 决策 | 原因 |
|---|---|---|
| 2026-10-29 | 不复用 DSH `scheduler.js` | Hermes 是 Python 运行时，无 `sessionController` |
| 2026-10-29 | Hermes 用 `X-Hermes-Session-Id` 延续 | 服务端从 `state.db` 读历史，显式 ID 不重映射 |
| 2026-10-29 | Cron 只做 tick | Hermes Cron 是 fresh session |
| 2026-10-29 | 适配器本地串行 | chat completions 无 per-session 锁 |
| 2026-10-29 | 超时标记 `unknown`，不自动重发 | 回合可能已执行，避免重复动作 |
| 2026-10-29 | DSH 插件不迁移 | 现有实现已验证，避免无收益重写 |
| 2026-10-29 | 先 Hermes，OpenClaw 随后 | 用户拍板；OpenClaw 无本机实例，不确定性更高 |
| 2026-10-29 | skill 名 `bili-whale`，主命令 `/bili-day` | 用户拍板；与包名一致，命令短且语义明确 |
| 2026-10-29 | skill 放本仓库 `skill/` | 单一源码，避免 `tools/` 与 `scripts/` 双份漂移 |
| 2026-10-29 | 通知走 Hermes `--deliver` | 用户拍板；不额外维护 webhook 通道 |
| 2026-10-29 | 通用模式默认关闭私信专线 | 用户无第二实名号；`listen.dm=false` |
| 2026-10-29 | 只支持 Linux（systemd） | 用户拍板；去掉 launchd / Windows 计划任务 |
| 2026-10-29 | OpenClaw 验收降级为 mock + 用户真机 | 本机无实例，无法自行冒烟 |
| 2026-10-29 | `PATH` 为空时不猜硬编码 node 路径 | 让「没有 node」环境如实报错，避免开发机路径污染测试/安装 |
| 2026-10-29 | 数据 home 用 `BILI_WHALE_HOME`，默认仍 `~/.dsh` | 现有 DSH 用户配置/日记原地可用，新装可用独立目录 |
| 2026-10-29 | 数据 home 增加 `~/.bili-whale` 自动识别 | 通用安装不必每条命令导出环境变量；DSH 用户没有该目录，行为不变 |
| 2026-10-29 | `skill/scripts/`、`skill/lib/` 由 install.mjs 生成并 gitignore | 单一源码在 `tools/`，打包产物不进版本库 |
