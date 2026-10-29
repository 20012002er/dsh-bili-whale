// 测试用的假 openclaw CLI：把参数记进 MOCK_OPENCLAW_LOG，再按消息内容演几种结局。
//
// 为什么用真脚本而不是 mock spawn：适配器要验证的是“怎么起进程、怎么解析 stdout”，
// 注入一个假 spawn 只能测到一半；真脚本连超时/退出码/多行输出都一起覆盖了。
import fs from 'node:fs'
import path from 'node:path'

const SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs')
const argv = process.argv.slice(2)
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const message = arg('--message') || ''
const sid = arg('--session-id') || ''
const log = process.env.MOCK_OPENCLAW_LOG
if (log) fs.appendFileSync(log, JSON.stringify({ argv, message, sessionId: sid, agent: arg('--agent') }) + '\\n')

if (message.includes('SLOW')) {
  setTimeout(() => { process.stdout.write('{"reply":{"text":"late"}}') }, 5000)
} else if (message.includes('GONE') && /-g1$/.test(sid)) {
  process.stderr.write('Error: session not found\\n')
  process.exit(1)
} else if (message.includes('BOOM')) {
  process.stderr.write('Error: model unavailable\\n')
  process.exit(1)
} else {
  process.stdout.write('[openclaw] turn done\\n' + JSON.stringify({ reply: { text: 'OK ' + (sid || 'agent') } }) + '\\n')
}
`

/** 在 dir 下写一个可执行的假 openclaw，返回它的路径。 */
export function writeMockCli(dir) {
  const file = path.join(dir, 'openclaw-mock.cjs')
  fs.writeFileSync(file, SCRIPT)
  fs.chmodSync(file, 0o755)
  return file
}
