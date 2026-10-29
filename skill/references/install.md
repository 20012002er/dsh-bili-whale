# 安装（Linux）

## 一条命令

```bash
node skill/install.mjs --host hermes
```

它做四件事：

1. 把仓库的 `tools/` 同步到 `skill/scripts/`（单一源码，不会双份漂移）
2. 把 `lib/credentials.js` 同步到 `skill/lib/`（`qr-auth.mjs` 依赖它）
3. 把整个 `skill/` 复制到宿主技能目录
4. 数据目录里没有配置时，从 `config.example.json` 生成一份

## 两个宿主放哪

| 宿主 | 默认目录 |
|---|---|
| Hermes | `~/.hermes/skills/bili-whale/` |
| OpenClaw | `~/.openclaw/skills/bili-whale/` |

> OpenClaw 的目录名按官方文档核对；`install.mjs --dest <路径>` 可以覆盖。
> 本机没有 OpenClaw 实例，Phase 4 才做真机验证。

常用参数：

```bash
node skill/install.mjs --host openclaw --dest ~/somewhere/bili-whale
node skill/install.mjs --data ~/.bili-whale --dry     # 只看会做什么
node skill/install.mjs --skip-sync                    # 不改 scripts/，只复制
```

## 装完之后

```bash
tail -f ~/.hermes/logs/*.log        # 宿主日志（路径以实际为准）
node ~/.hermes/skills/bili-whale/scripts/bili.mjs login
node ~/.hermes/skills/bili-whale/scripts/bili.mjs selftest
```

`selftest` 里这两项要自己确认：

- 数据目录：`~/.bili-whale`（不是 `~/.dsh`）
- Hermes API：`http://127.0.0.1:8642/v1/capabilities` 可达

## 不需要的东西

- 不需要 DSH，也不需要 DSH 的 node 运行时
- 不需要数据库；所有状态都是 JSON / Markdown
- `ffmpeg` 只在"抽帧看画面"时需要；没有就跳过 `debrief` 的抽帧步骤
- `qrcode` 只是终端二维码好看用的；没装也能用 `--cookie` 登录

## 卸载

```bash
rm -rf ~/.hermes/skills/bili-whale
# 数据与凭据保留，确认不要了再删：
# rm -rf ~/.bili-whale ~/.bili-ai
```
