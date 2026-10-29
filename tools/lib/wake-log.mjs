// 只记元数据：事件、状态、耗时、宿主。
// 绝不写提示词正文、B 站内容、私信原文或任何密钥 —— 日志会进 journald / 用户机器。
import fs from 'node:fs'
import path from 'node:path'
import { whalePath } from './paths.mjs'

export const wakeLogPath = () => whalePath('wake-log.jsonl')

export function logTurn({ source, host, event, status, code, durationMs, generation, usage } = {}) {
  const row = {
    at: new Date().toISOString(),
    source: source ?? null,
    host: host ?? null,
    event: event ?? null,
    status: status ?? null,
    code: code ?? null,
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    generation: generation ?? null,
    usage: usage ?? null,
  }
  const file = wakeLogPath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 })
  } catch { /* 记日志失败不能影响主流程 */ }
}
