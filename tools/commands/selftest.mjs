// 启动测试（2026-10-20 加 —— 装完先跑这个，一步确认能不能用）
//
//   node bili.mjs selftest
//
// 为什么需要它：很多人装完卡在两件事上 ——
//   ① DSH 里新开的会话在「工作区 → 未分组」里，不点开那个文件夹看不见
//   ② 那个新会话默认没有完全权限，agent 起来后什么都干不了
// 这个命令把"该确认的事"列成一张表，缺哪项就直说缺哪项。
//
// 2026-10-29（通用 skill 移植）：不再假定 DSH 在场 ——
//   · 数据目录按 BILI_WHALE_HOME → DSH_HOME → ~/.dsh 解析（label 跟着环境变量走）
//   · 新增 Node 运行时、宿主适配（Hermes API Server）、skill 包装三项
//   · 结尾的建议按是否检测到 DSH 分流
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { execFileSync } from '../lib/capture.mjs'
import { fileURLToPath } from 'node:url'
import { BILI_WHALE_HOME, DSH_HOME, HOME, configPath, credentialsPath } from '../lib/paths.mjs'
import { config } from '../lib/config.mjs'   // 用合并后的有效值判断，别拿裸 JSON 判 ✓
import { NODE_EXE } from '../lib/nodebin.mjs'   // 2026-10-21：别用 process.execPath（Electron 里它是主程序 ✗）


const CFG = configPath
const CRED = credentialsPath
const DATA_LABEL = process.env.BILI_WHALE_HOME ? 'BILI_WHALE_HOME' : (process.env.DSH_HOME ? 'DSH_HOME' : '数据目录')
const DSH_PRESENT = Boolean(process.env.DSH_HOME) || fs.existsSync(path.join(HOME, '.dsh'))
const OK = '✓'
const NO = '✗'
const WARN = '!'

let bad = 0
const line = (mark, label, detail) => {
  if (mark === NO) bad += 1
  console.log(`  ${mark} ${label}${detail ? '  —— ' + detail : ''}`)
}

console.log('\n══════════ 启动测试（装完跑这一条）══════════\n')

// ① Node 运行时（2026-10-29 加：脱离 DSH 后运行时可能来自 PATH / BILI_WHALE_NODE）
try {
  const major = Number(String(process.versions.node).split('.')[0])
  line(major >= 18 ? OK : NO, 'Node 运行时', `${process.versions.node}（${NODE_EXE}）${major >= 18 ? '' : '—— 需要 18 及以上'}`)
} catch (e) {
  line(NO, 'Node 运行时', String(e.message).slice(0, 80))
}

// ② 配置文件
let cfg = null
try {
  JSON.parse(fs.readFileSync(CFG, 'utf8'))
  cfg = config()   // 合并默认值后的有效配置：字段没写但默认有值 → 算通过 ✓
  line(OK, '配置文件', CFG)
  line(cfg.self?.mid ? OK : NO, '她的身份', cfg.self?.name ? `${cfg.self.name}（${cfg.self.mid}）` : (DSH_PRESENT ? '设置页 →「她是谁」还没填' : 'config 里 self.mid / self.name 还没填'))
  line(cfg.owner?.mid ? OK : NO, '主人的身份', cfg.owner?.name ? `${cfg.owner.name}（${cfg.owner.mid}）` : (DSH_PRESENT ? '设置页 →「她是谁」里填主人 mid' : 'config 里 owner.mid / owner.name 还没填'))
  line(cfg.share?.via ? OK : NO, '分享方式', cfg.share?.via === 'dm' ? '私信（不发公开评论）' : '评论区 @')
  line(cfg.notify?.type ? OK : NO, '消息推送', String(cfg.notify?.type ?? '未设置') + (cfg.agent?.deliver ? '（通用模式走宿主 --deliver）' : ''))
} catch {
  line(NO, '配置文件', '没有 ' + CFG + (DSH_PRESENT ? ' —— 先去设置页保存一次' : ' —— 先照 config.example.json 建一份'))
}

// ③ 凭据
try {
  const cred = JSON.parse(fs.readFileSync(CRED, 'utf8'))
  const has = !!cred.sessdata && !!cred.bili_jct
  line(has ? OK : NO, 'B站凭据', has ? '已保存（cookie）' : '缺 sessdata / bili_jct')
  line(cred.buvid3 ? OK : WARN, 'buvid3', cred.buvid3 ? '有' : '缺 —— 不影响评论/私信；个别接口可能被风控。想要就 F12 → Cookies 复制 buvid3 再写入')
  // 2026-10-21：bili_jct 是"能不能发东西"的关键 —— 只读全绿但一发就 code=-111，最常见就是它 ✗
  const jct = String(cred.bili_jct ?? '')
  if (!jct) line(NO, 'bili_jct（写操作）', '空着 —— 发私信/评论/收藏都会失败（code=-111）' + (DSH_PRESENT ? ' → 设置页重新粘贴一次' : ' → 跑一次 `node bili.mjs login`'))
  else if (!/^[0-9a-fA-F]{32}$/.test(jct)) line(WARN, 'bili_jct（写操作）', '格式不像（长度 ' + jct.length + '，正常 32 位十六进制）—— 可能复制时截断了')
  else line(OK, 'bili_jct（写操作）', '格式正常（和 SESSDATA 是否同一账号，只能靠一次真实写入验证）')
} catch {
  line(NO, 'B站凭据', '没有 ' + CRED + (DSH_PRESENT ? ' —— 设置页粘贴 cookie 后保存' : ' —— 跑一次 `node bili.mjs login`'))
}

// ④ 登录态
try {
  const BILI0 = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bili.mjs')
  const out = execFileSync(NODE_EXE, [BILI0, 'session'], { encoding: 'utf8', timeout: 30000 })
  const who = out.match(/账号\s*:\s*(.+)/) ?? []
  const midM = out.match(/mid\s*:\s*(\d+)/) ?? []
  line(who[1] ? OK : NO, '登录态', who[1] ? `${who[1].trim()}（mid ${midM[1] ?? '?'}）` : String(out).trim().slice(0, 80))
} catch (e) {
  line(NO, '登录态', '查不到（cookie 可能过期）—— ' + String(e.message).slice(0, 60))
}

// ⑤ 数据目录
// 2026-10-23 修（issue #27）：'.dsh' 那条要看 DSH_HOME ✗ 不能写死 HOME/.dsh
for (const [label, p] of [['.bili-ai', path.join(HOME, '.bili-ai')], ['目录 ' + DATA_LABEL, DSH_HOME]]) {
  line(fs.existsSync(p) ? OK : NO, label, p)
}
const DIARY = path.join(BILI_WHALE_HOME, 'whale-diary.md')
line(fs.existsSync(DIARY) ? OK : WARN, '日记', fs.existsSync(DIARY) ? '已存在' : '还没建（她第一次醒来会写）')

// ⑥ 宿主适配（2026-10-29 加）：通用 skill 靠宿主 agent 执行，这里只确认配置与连通性
//   用 node:http 直连本机，不走 guardedFetch —— 这不是 B 站流量，不该占请求额度。
const probeLocal = (url, headers = {}) => new Promise(resolve => {
  let target
  try { target = new URL(url) } catch { resolve({ ok: false }); return }
  const mod = target.protocol === 'https:' ? https : http
  const req = mod.get(target, { timeout: 1500, headers }, res => { res.resume(); resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }) })
  req.on('timeout', () => req.destroy(new Error('timeout')))
  req.on('error', () => resolve({ ok: false }))
})
const AGENT = cfg?.agent ?? {}
const host = String(AGENT.host ?? 'hermes')
line(['hermes', 'openclaw'].includes(host) ? OK : NO, '宿主适配', host + (AGENT.deliver ? '（分享走 --deliver）' : ''))
if (host === 'hermes') {
  const base = String(AGENT.baseUrl ?? 'http://127.0.0.1:8642').replace(/\/+$/, '')
  const key = process.env.BILI_WHALE_HERMES_KEY || process.env.HERMES_API_KEY || process.env.API_SERVER_KEY || ''
  const res = await probeLocal(base + '/v1/capabilities', key ? { authorization: 'Bearer ' + key } : {})
  if (res.ok) line(OK, 'Hermes API', base)
  else if (res.status) line(WARN, 'Hermes API', `${base} 回了 HTTP ${res.status}${res.status === 401 ? '（API key 不对）' : ''}`)
  else line(WARN, 'Hermes API', `${base} 连不上 —— 先启动 Hermes gateway / API Server；Phase 3 需要它`)
}

// ⑦ 依赖体检（直接调现成的 deps，别在这里重复实现 ✗）
try {
  const BILI2 = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bili.mjs')
  const out = execFileSync(NODE_EXE, [BILI2, 'deps'], { encoding: 'utf8', timeout: 60000 })
  const reds = (String(out).match(/✗/g) ?? []).length
  line(reds === 0 ? OK : NO, '依赖体检（deps）', reds === 0 ? '全绿' : `${reds} 项红 —— 详见 \`node bili.mjs deps\``)
} catch (e) {
  // deps 有红线时退出码非 0，但 stdout 仍然可读 —— 别把"有红线"说成"没跑起来" ✗
  const text = e?.stdout ? String(e.stdout) : ''
  const reds = (text.match(/✗/g) ?? []).length
  if (text) line(reds === 0 ? OK : NO, '依赖体检（deps）', `${reds} 项红 —— 详见 \`node bili.mjs deps\``)
  else line(WARN, '依赖体检（deps）', '没跑起来：' + String(e.message).slice(0, 60))
}

// ⑧ skill 包装：仓库里在 <root>/skill/SKILL.md，装好后在 <技能目录>/SKILL.md —— 两边都认
const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SKILL = fs.existsSync(path.join(ROOT_DIR, 'SKILL.md')) ? path.join(ROOT_DIR, 'SKILL.md') : path.join(ROOT_DIR, 'skill', 'SKILL.md')
line(fs.existsSync(SKILL) ? OK : WARN, 'skill 包装', fs.existsSync(SKILL) ? SKILL : '没找到 SKILL.md（仓库里应有 skill/SKILL.md）')

// ⑨ 告诉她/他 下一步该做什么（这一步是很多人卡住的地方）
if (DSH_PRESENT) {
  console.log('\n────────── 接下来要做的两件事（很多人卡在这）──────────\n')
  console.log('  ① 【找到她的会话】')
  console.log('     插件启动时会自动开一个会话，位置在：')
  console.log('       左侧「工作区」→ 展开「未分组」文件夹 → 里面那个 bili-whale')
  console.log('     ⚠️ 不点开「未分组」是看不见它的 —— 这一步最容易漏 ✗')
  console.log('')
  console.log('  ② 【给她完全权限】')
  console.log('     打开那个会话 → 权限设置 → 选「完全访问 / danger-full-access」')
  console.log('     否则她起来后跑不了命令、发不了评论、写不了日记 ✗')
  console.log('')
} else {
  console.log('\n────────── 通用 skill 模式 ──────────\n')
  console.log('  ① 登录 B 站：node bili.mjs login')
  console.log('  ② 配好宿主：config 里的 agent.host / baseUrl / API key')
  console.log('  ③ 看她的能力：node bili.mjs help')
  console.log('')
}
// 2026-10-20：全绿时落个标记 —— 设置页和她的唤醒提示会用它在"还没测过"时提醒
if (bad === 0) {
  try {
    fs.mkdirSync(path.join(HOME, '.bili-ai'), { recursive: true })
    fs.writeFileSync(path.join(HOME, '.bili-ai', 'selftest-passed.json'), JSON.stringify({ at: new Date().toISOString() }, null, 2))
  } catch {}
  console.log('══════════ 全部通过 ✓ 可以用了 ══════════')
  if (DSH_PRESENT) console.log('  想立刻看她跑一轮：设置页 →「生物钟」→ 把窗口改成现在之后 2 分钟 → 等她自己醒\n')
  else console.log('  想立刻看她跑一轮：Phase 3 的 `bili agent wake` 接好后可用\n')
} else {
  console.log(`══════════ ${bad} 项没通过 ✗ 按上面的提示补一下 ══════════\n`)
}
process.exit(bad === 0 ? 0 : 1)
