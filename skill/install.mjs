#!/usr/bin/env node
// 安装 / 升级 bili-whale skill（Linux）
//
//   node skill/install.mjs --host hermes
//   node skill/install.mjs --host openclaw --dest ~/skills/bili-whale
//   node skill/install.mjs --dry
//
// 为什么要这个脚本：skill/ 里的 scripts/ 不能手写 —— 它必须是仓库 tools/ 的副本，
// 否则两边很快会漂移。安装时先同步，再复制到宿主技能目录。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(SKILL)
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir()
const argv = process.argv.slice(2)
const option = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined }
const flag = (name) => argv.includes('--' + name)

const HOST_DIRS = {
  hermes: path.join(HOME, '.hermes', 'skills'),
  openclaw: path.join(HOME, '.openclaw', 'skills'),
}
const USAGE = [
  '用法: node skill/install.mjs [选项]',
  '',
  '  --host hermes|openclaw   宿主类型（默认 hermes）',
  '  --dest <路径>            覆盖技能安装目录',
  '  --data <路径>            数据目录（默认 ~/.bili-whale）',
  '  --dry                    只打印会做什么',
  '  --skip-sync              不重新同步 scripts/，只复制',
  '  --help',
].join('\n')

function fail(message) {
  console.error('✗ ' + message)
  process.exit(1)
}
function say(message) { console.log((flag('dry') ? '[dry] ' : '') + message) }

if (flag('help') || argv.includes('-h')) { console.log(USAGE); process.exit(0) }

const host = option('host') ?? 'hermes'
if (!HOST_DIRS[host]) fail(`--host 只能是 hermes 或 openclaw（收到 ${host}）`)
const dest = path.resolve(option('dest') ?? path.join(HOST_DIRS[host], 'bili-whale'))
const data = path.resolve(option('data') ?? (process.env.BILI_WHALE_HOME || path.join(HOME, '.bili-whale')))
const configFile = path.join(data, 'bili-whale.config.json')
const dry = flag('dry')

if (dest === SKILL || dest.startsWith(SKILL + path.sep)) fail('--dest 不能指向 skill/ 自己（会递归复制）')
if (!fs.existsSync(path.join(ROOT, 'tools', 'bili.mjs'))) fail('找不到 tools/bili.mjs —— 请在仓库里运行 install.mjs')

// ① 同步：tools/ → skill/scripts/，lib/credentials.js → skill/lib/
if (!flag('skip-sync')) {
  const scripts = path.join(SKILL, 'scripts')
  say(`同步 ${path.join(ROOT, 'tools')}/ → ${path.join(SKILL, 'scripts')}/`)
  if (!dry) {
    fs.rmSync(scripts, { recursive: true, force: true })
    fs.cpSync(path.join(ROOT, 'tools'), scripts, {
      recursive: true,
      filter: (src) => !src.includes('node_modules') && !src.endsWith('.test.mjs'),
    })
    fs.mkdirSync(path.join(SKILL, 'lib'), { recursive: true })
    fs.copyFileSync(path.join(ROOT, 'lib', 'credentials.js'), path.join(SKILL, 'lib', 'credentials.js'))
  }
}

// ② 复制整个 skill 到宿主技能目录
say(`安装到 ${dest}`)
if (!dry) {
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(SKILL, dest, {
    recursive: true,
    filter: (src) => !src.includes(path.sep + 'node_modules'),
  })
}

// ③ 配置（没有才生成，绝不覆盖已有配置）
if (fs.existsSync(configFile)) {
  say(`配置已存在，保持不动：${configFile}`)
} else {
  say(`生成配置：${configFile}`)
  if (!dry) {
    fs.mkdirSync(data, { recursive: true })
    fs.copyFileSync(path.join(SKILL, 'config.example.json'), configFile)
  }
}

// ④ 收尾提示
const bili = path.join(dest, 'scripts', 'bili.mjs')
console.log(`
──────────── 接下来 ────────────

1) 填配置（至少要 self.mid / owner.mid）：
   ${configFile}

2) 登录 B 站：
   node ${bili} login

3) 体检：
   node ${bili} selftest

4) 在 ${host} 里调用：
   /bili-day       醒一轮
   /bili-watch    看一条指定视频
   /bili-check    只体检

宿主技能目录：${dest}
数据目录：    ${data}
`)
