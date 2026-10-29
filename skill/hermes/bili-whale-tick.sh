#!/usr/bin/env bash
# Hermes Cron 的 no-agent 包装（复制到 ~/.hermes/scripts/ 再注册，见 references/schedule.md）
#
# 为什么需要它：Hermes Cron 的 --no-agent 模式会把脚本 stdout 原样投递给主人。
# tick 每分钟跑一次，正常时不该有任何输出 —— 只有出错（退出码非 0）才说话。
set -u

BILI="${BILI_WHALE_BIN:-$HOME/.hermes/skills/bili-whale/scripts/bili.mjs}"
out="$(node "$BILI" tick --once --json 2>&1)"
code=$?

if [ "$code" -ne 0 ]; then
  echo "[bili-whale] tick 退出码 $code"
  echo "$out"
fi

exit 0
