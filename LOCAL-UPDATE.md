# GitHub 更新核对与本地修复（2026-10-22）

本包版本：**0.4.3**。在 0.4.2 的基础上继续修复（本轮来自社区的三条 issue + 一个 PR），保留新设备 ID、作息间隔、跳过只消耗一次机会、结构化回复检测等更新。下载的 76 个上游文件已逐个校验 Git blob SHA，与该提交完全一致后再修改。

此次只读取公开仓库、在本地修改和打包。没有推送代码、创建 PR、发表评论或改动 issue 状态；未使用用户提供的 token，交付物不包含凭据。

## Issue / PR 逐项落实情况

核对范围：GitHub API 返回的全部 17 条记录（10 个 issue、7 个 PR），包含已关闭记录及评论。状态为本次读取时的状态；“已关闭”不等于“已合并”。证据以当前源码为准。

| 编号 | GitHub 状态 | 核对结论与本包处理 |
|---|---|---|
| [#1 桌面通知转义](https://github.com/Alterssss/dsh-bili-whale/issues/1) | closed | 上游已修复 PowerShell XML 引号；本包补失败时清理 ps1/XML，输出捕获也改为文件方式。真实 Windows toast 尚未联调。 |
| [PR #2 Desktop 找不到 Node](https://github.com/Alterssss/dsh-bili-whale/pull/2) | merged | 曾合并，但当前插件侧仍只查 DSH_NODE/固定目录，缺 PATH 和可执行 Electron 兜底。本包补路径搜索、执行验证和环境传递。 |
| [PR #3 TEMP / 跨午夜 / 子进程](https://github.com/Alterssss/dsh-bili-whale/pull/3) | merged | 跨午夜修复保留；TEMP/icacls 方案已由专用工作目录替代。文件输出捕获在当前版本多处回退成管道，本包修复 comment/quota-gate/quota/debrief/bili-watch/ffmpeg/notify/selftest 等调用。 |
| [PR #4 comments 与布尔开关](https://github.com/Alterssss/dsh-bili-whale/pull/4) | merged | 当前存在 comments 命令、注册项及末尾布尔开关修复，保留。 |
| [#5 命名参数](https://github.com/Alterssss/dsh-bili-whale/issues/5) | closed | 已有位置参数翻译，但未知带值选项会被吞。本包保留这类选项，增加测试；保留原有位置参数调用方式。 |
| [#6 主目录作为工作区](https://github.com/Alterssss/dsh-bili-whale/issues/6) | closed | 默认改成 DSH_HOME/whale-work，已落实。本包保持默认目录，不恢复修改全局 TEMP/ACL 的旧方案。已有会话的旧 cwd 不自动迁移。 |
| [PR #7 macOS/Linux Node](https://github.com/Alterssss/dsh-bili-whale/pull/7) | closed，未直接 merge | 平台文件名已落实。本包进一步统一可执行探测，支持 PATH/macOS 常见目录。未在 macOS 真机验证。 |
| [#8 安装等待/启动/体检](https://github.com/Alterssss/dsh-bili-whale/issues/8) | closed | README 已解释 Web 宿主依赖，体检可显示调度器失败；原有缺运行时测试通过。本包补运行时发现能力。 |
| [PR #9 去重运行时解析](https://github.com/Alterssss/dsh-bili-whale/pull/9) | closed，未直接 merge | 当前已抽取 lib/node-runtime.js。本包继续去重，实际解析放在 tools/lib/runtime.mjs，插件与独立 tools 均可使用。 |
| [#10 @ 后总结并推送](https://github.com/Alterssss/dsh-bili-whale/issues/10) | open | **部分补齐**：增加默认关闭的主人 @ 总结请求选项；仅主人新 @ 中含“总结/摘要/概括”时进入总结流程，复用 notify 私信/Webhook/已有通道。**没有原生 SMTP 邮件实现**；总结质量和真实推送仍依赖宿主模型及通道配置，不算全部完成。 |
| [#11 会话目录可配置](https://github.com/Alterssss/dsh-bili-whale/issues/11) | open | 上游只有固定专用目录。本包新增 home 配置与设置页输入；必须为已存在目录的绝对路径，无效时警告并回退专用目录。 |
| [PR #12 macOS / Electron 兜底](https://github.com/Alterssss/dsh-bili-whale/pull/12) | open | 原分支基于旧代码，未直接套补丁。本包按当前架构实现：优先真 Node，最后只对 Electron 宿主尝试 ELECTRON_RUN_AS_NODE=1，必须写出探测结果文件才接受，防止“退出码 0 但没执行脚本”。环境传给设置页、调度器及工具子进程。 |
| [PR #13 home 配置](https://github.com/Alterssss/dsh-bili-whale/pull/13) | closed，未 merge | 上游明确尚未收配置字段。本包已重做，保留当前专用目录作为默认值；不会回退成用户主目录。 |
| [#14 主人回复误判](https://github.com/Alterssss/dsh-bili-whale/issues/14) | closed | 上游新增 JSON 精确匹配，但读取配置仍写死 ~/.dsh，且结果集合哈希会因旧消息移出而变化。本包统一配置路径、保持失败输出为可解析 JSON、按消息标识/时间判重，反馈时间使用实际事件时间，恢复沙箱兼容捕获。 |
| [#15 私信绕过分享开关](https://github.com/Alterssss/dsh-bili-whale/issues/15) | closed | share-policy 已统一检查开关、理由、评分、第一名；本包保留并回归：关闭/缺评分时不发网络请求。 |
| [#16 批准引用未声明 cfg](https://github.com/Alterssss/dsh-bili-whale/issues/16) | closed | 当前 cfgNow 已定义，发送失败重新放回草稿；成功/失败回归均通过。不能保证网络结果不明确时的恰好一次投递。 |
| [#17 凌晨排到晚上](https://github.com/Alterssss/dsh-bili-whale/issues/17) | closed | 当前按绝对截止时间排序已解决原复现。本包增加 02:38 回归；保留提前规划未来窗口的能力，确保 atMs 不早于 startsAt，不采纳会禁止提前规划的简单过滤建议。 |

## 额外确认并修复

- 最小唤醒间隔的 wokeAt 曾在 historyOf、设置重排、done 状态中丢失，下一次 tick 可绕过间隔。本包保留历史；非法间隔回退默认值，不生成 NaN 时间；设置页提供间隔字段，修改会触发重排。
- 私信设备 ID 保存失败时，上游仍返回新随机值继续发。本包停止发送并报错，避免每次换 ID。不能据此保证 B 站账号不会受风控。
- notify 的私信子进程失败时，上游仍返回成功退出码。本包返回失败，不让调用者误判“已送达”。

## 使用与升级

1. 退出 DSH，备份原插件目录及用户自己的 .bili-ai、bili-whale.config.json、whale-night.json。解压后通过原来的本地插件链接方式使用本包的 dsh-bili-whale 目录，再重启 DSH。
2. 本包不包含 node_modules，不增加第三方依赖；保留 package.json、cordis.patch.yml、lib、tools、examples 和测试。不要覆盖个人凭据或运行账本。
3. “专用会话目录”留空时仍是 DSH_HOME/whale-work。要自定义，请先创建目录，再填绝对路径，可在该目录放鲸鱼自己的 AGENTS.md。**目录改动仅在重启后创建新会话时生效；同名旧会话保留原 cwd**。先备份会话，再通过宿主正常会话管理重建；本包不会删除会话。
4. “主人 @ 请求总结”默认关闭。启用需同时开启评论监听，监听范围包含 @，配置 owner.mid，并设置可用推送通道。只处理建立监听基线后到达的新消息；原有作息/全天监听规则仍生效。notify=dm 仍要求与主人互关；Webhook 使用现有配置。原生 SMTP 邮件尚未实现，可继续通过已有自定义命令/Webhook 对接自己的邮件服务。
5. 作息最小间隔默认 10 分钟，最低 1 分钟。老的 DSH_HOME/whale-night.config.json 仍具有覆盖优先级；如配置不生效，检查该文件。
6. 如设置了 toolsPath 指向外部旧工具目录，要同时更新那里或清空使用随包工具，否则插件和工具版本可能不一致。

## 验证及边界

- 上游原有测试先通过，再修改。
- 本包 **57/57** 自动测试通过：原用例加配置目录、PATH 与 Electron 分支、文件捕获、命名参数、间隔状态保存、凌晨计划、结构化反馈/旧消息移出、设备 ID 保存失败、通知失败返回值，以及真实调度器的模拟 @ 总结投递与去重。
- 68 个 JavaScript/MJS 文件全部通过 node --check 语法检查。
- 命令：`node --test tests/planner.test.mjs tests/integration.test.mjs tests/updates.test.mjs tests/supplement.test.mjs`，或 `npm test`（需自行安装 npm）。
- 测试使用临时目录、虚构凭据和模拟网络，没有向 B 站发真实评论/私信，没有触发真实邮件/Webhook。Node v24.19.0 / Windows 上运行；Electron/macOS 分支采用受控探测测试，未完成真实 DSH Desktop/macOS 集成验证。
- 对历史条目的“落实”包含源码对照，不能将未覆盖的外部接口当作已实测可用。新增总结是宿主提示流程，不能承诺模型每次都成功总结或发送。源码与已知遗漏已明确区分。

