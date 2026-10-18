// 私信（专属通道）—— 2026-10-18 主人定：**三条写死在代码里**
//   ① 一天只发 1 条
//   ② 只发给配置里的 owner.mid（同一个用户，别处发不出去）
//   ③ 必须互关（relation.attribute === 6），否则拒发
//
// 为什么写死：私信是 B站 风控最凶的接口（判营销/骚扰），而我们要的只是
// "把一条分享私密地送到主人手里"，不是群发工具 ✗ 所以能力越窄越安全 ✓
//
// 用法:
//   node dm.mjs --msg "…" --dry
//   node dm.mjs --msg "…" --go
//   node dm.mjs --status            （看今天额度 + 互关状态）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../lib/config.mjs'

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
    else { opt[argv[i].slice(2)] = v; i += 1 }
  }
}
const DRY = !!opt.dry
const GO = !!opt.go
const STATUS = !!opt.status
const MSG = String(opt.msg ?? '').trim()

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const CRED = path.join(HOME, '.bili-ai', 'credentials.json')
const QUOTA = path.join(HOME, '.bili-ai', 'dm-quota.json')
const cred = JSON.parse(fs.readFileSync(CRED, 'utf8'))
const cfg = config()
const OWNER = String(cfg.owner?.mid ?? '').trim()
const OWNER_NAME = String(cfg.owner?.name ?? '主人')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const H = {
  'user-agent': UA,
  referer: 'https://www.bilibili.com/',
  cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`,
}
const jget = async (u) => (await fetch(u, { headers: H })).json()
const loadQ = () => { try { return JSON.parse(fs.readFileSync(QUOTA, 'utf8')) } catch { return {} } }
const saveQ = (o) => { fs.mkdirSync(path.dirname(QUOTA), { recursive: true }); fs.writeFileSync(QUOTA, JSON.stringify(o, null, 2) + '\n') }
const today = () => new Date().toLocaleDateString('sv-SE')

// ── 写死的三条 ───────────────────────────────────────────────────────
const LIMIT_PER_DAY = 1
const ONLY_TO = OWNER            // ② 只发给主人
const REQUIRE_MUTUAL = true      // ③ 必须互关

async function me() {
  const nav = await jget('https://api.bilibili.com/x/web-interface/nav')
  if (!nav.data?.isLogin) { console.error('✗ 未登录（cookie 失效 ✗）'); process.exit(3) }
  return { mid: String(nav.data.mid), uname: nav.data.uname }
}

async function relation(toMid) {
  const j = await jget(`https://api.bilibili.com/x/relation?fid=${toMid}`)
  if (j.code !== 0) return { ok: false, attribute: -1, why: `关系接口 code=${j.code}` }
  return { ok: true, attribute: Number(j.data?.attribute ?? -1) }
}

async function send(toMid, text) {
  const body = new URLSearchParams()
  body.set('msg[sender_uid]', String((await me()).mid))
  body.set('msg[receiver_id]', String(toMid))
  body.set('msg[receiver_type]', '1')
  body.set('msg[msg_type]', '1')
  body.set('msg[msg_status]', '0')
  body.set('msg[timestamp]', String(Math.floor(Date.now() / 1000)))
  body.set('msg[dev_id]', 'WEB-' + crypto.randomUUID().toUpperCase())
  body.set('msg[content]', JSON.stringify({ content: text }))
  body.set('csrf', String(cred.bili_jct))
  const r = await fetch('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const j = await r.json().catch(() => ({}))
  return { http: r.status, code: j.code, message: j.message, data: j.data }
}

if (STATUS) {
  const q = loadQ()
  const used = q.date === today() ? Number(q.count ?? 0) : 0
  const rel = await relation(ONLY_TO)
  const meInfo = await me()
  console.log(`账号: ${meInfo.uname}（mid ${meInfo.mid}）`)
  console.log(`专属对象: ${OWNER_NAME}（mid ${ONLY_TO || '未配置'}）`)
  console.log(`今天已发: ${used}/${LIMIT_PER_DAY}`)
  console.log(`互关状态: attribute=${rel.attribute} ${rel.attribute === 6 ? '（✓ 互关，可以发）' : '（✗ 不是互关，发不出去）'}`)
  process.exit(0)
}

if (!MSG) { console.error('用法: node dm.mjs --msg "…" --dry|--go   |   --status'); process.exit(2) }

// ── 闸门（写死，不接受参数覆盖）──────────────────────────────────────
if (!OWNER) { console.error('✗ 配置里 owner.mid 为空 —— 私信只发给主人，没配就不发'); process.exit(2) }
if (MSG.length > 300) { console.error(`✗ 私信太长（${MSG.length} > 300 字），退化成刷屏了 ✗`); process.exit(2) }

const meInfo = await me()
if (String(meInfo.mid) === ONLY_TO) { console.error('✗ 不能给自己发私信'); process.exit(2) }

const rel = await relation(ONLY_TO)
if (!rel.ok) { console.error(`✗ ${rel.why}`); process.exit(3) }
if (REQUIRE_MUTUAL && rel.attribute !== 6) {
  console.error(`✗ 未互关（attribute=${rel.attribute}）—— 私信通道要求双方互相关注 ✓`)
  console.error(`   解决：用她这个号去关注 ${OWNER_NAME}（mid ${ONLY_TO}），再跑一次 ✓`)
  process.exit(4)
}

const q = loadQ()
const used = q.date === today() ? Number(q.count ?? 0) : 0
if (used >= LIMIT_PER_DAY) {
  console.error(`✗ 今天已经发过 ${used} 条（上限 ${LIMIT_PER_DAY} 条/天，写死在代码里 ✗）`)
  process.exit(4)
}

console.log(`[dm] ${meInfo.uname} → ${OWNER_NAME}（mid ${ONLY_TO}）`)
console.log(`  正文 ${MSG.length} 字：${MSG.slice(0, 80)}${MSG.length > 80 ? '…' : ''}`)
console.log(`  互关 ✓  ·  今天 ${used}/${LIMIT_PER_DAY}`)

if (DRY) { console.log('  [dry] 未发送 ✓ 确认后把 --dry 换成 --go'); process.exit(0) }
if (!GO) { console.error('✗ 必须给 --dry 或 --go'); process.exit(2) }

const r = await send(ONLY_TO, MSG)
if (r.code === 0) {
  saveQ({ date: today(), count: used + 1, mid: ONLY_TO, at: new Date().toISOString() })
  console.log(`  ✓ 已发送（HTTP ${r.http}）`)
  process.exit(0)
}
console.error(`  ✗ 发送失败：HTTP ${r.http} code=${r.code} ${r.message ?? ''}`)
process.exit(1)
