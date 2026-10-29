// B 站登录（通用 skill 用）：终端二维码扫码，或 --cookie 手动兜底。
//
//    node bili.mjs login
//    node bili.mjs login --cookie "SESSDATA=…; bili_jct=…; buvid3=…"
//    node bili.mjs login --sessdata … --bili-jct … [--buvid3 …]
//
// 为什么要它：DSH 里登录靠设置页，通用 skill 没有设置页；
// 而 tools/ 下所有写操作都依赖 ~/.bili-ai/credentials.json。
//
// 退出码：0 成功；1 失败（含凭据格式不对 / 二维码过期）；2 缺必需参数。
import { credentialsPath, homePath } from '../lib/paths.mjs'
import { generateQr, pollQrOnce, renderTerminal, saveCredentials, QR_TTL_MS } from '../lib/qr-auth.mjs'

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const option = (name) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? argv[i + 1] : undefined
}
const PENDING = homePath('.bili-ai', 'pending-replies.json')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function out(message) { if (!json) console.log(message) }
function finish(code, payload) {
  if (json) console.log(JSON.stringify(payload))
  process.exit(code)
}
function fail(message, code = 1) {
  if (json) console.log(JSON.stringify({ ok: false, error: message }))
  else console.error('✗ ' + message)
  process.exit(code)
}

/** 从整串 cookie 里按名字取值（大小写不敏感）。 */
function fromCookieString(raw) {
  const picked = {}
  for (const part of String(raw).split(';')) {
    const pair = part.trim()
    if (!pair) continue
    const cut = pair.indexOf('=')
    if (cut < 0) continue
    const name = pair.slice(0, cut).trim().toLowerCase()
    if (name === 'sessdata' || name === 'bili_jct' || name === 'buvid3') picked[name] = pair.slice(cut + 1).trim()
  }
  return { sessdata: picked.sessdata, bili_jct: picked.bili_jct, buvid3: picked.buvid3 }
}

async function save(input, label) {
  const account = await saveCredentials(input, { file: credentialsPath, pending: PENDING })
  out(`✓ ${label}：${account.name}（mid ${account.mid}）`)
  out(`  凭据已写入 ${credentialsPath}（0600）`)
  finish(0, { ok: true, mid: account.mid, name: account.name })
}

async function main() {
  if (argv.includes('help') || argv.includes('--help') || argv.includes('-h')) {
    out([
      '用法:',
      '  node bili.mjs login                     终端二维码扫码登录',
      '  node bili.mjs login --cookie "..."      粘贴整串 cookie（SESSDATA/bili_jct 必填）',
      '  node bili.mjs login --sessdata ... --bili-jct ... [--buvid3 ...]',
      '  --json                                  机器可读输出',
    ].join('\n'))
    return finish(0, { ok: true, usage: true })
  }

  const raw = option('cookie')
  const sessdata = option('sessdata')
  const jct = option('bili-jct') ?? option('bili_jct')
  if (raw || sessdata) {
    const input = raw ? fromCookieString(raw) : { sessdata, bili_jct: jct, buvid3: option('buvid3') }
    if (!input.sessdata || !input.bili_jct) fail('缺 SESSDATA 或 bili_jct —— 两个都要，且必须来自同一个账号', 2)
    return save(input, '登录成功')
  }
  if (jct) fail('只给 bili_jct 不够，还需要 --sessdata（或直接用 --cookie 粘整串）', 2)

  // 二维码
  out('正在向 B 站申请登录二维码……')
  const { url, key } = await generateQr()
  const art = await renderTerminal(url)
  if (art) out('\n' + art)
  else {
    out('\n! 终端二维码不可用（qrcode 未安装）—— 用手机打开下面链接，或改用 --cookie 手动登录：')
    out(url)
  }
  out('\n用 B 站手机客户端扫码；二维码 3 分钟内有效。')

  const deadline = Date.now() + QR_TTL_MS
  let last = ''
  const labels = { waiting: '等待扫码……', scanned: '已扫码，请在手机上确认', expired: '二维码已过期' }
  while (Date.now() < deadline) {
    await sleep(2000)
    let result
    try { result = await pollQrOnce({ key }) } catch (e) { fail(e.message) }
    if (result.status === 'expired') return fail('二维码已过期 —— 重新跑一次 login')
    if (result.status !== last) { last = result.status; out(labels[result.status] ?? result.status) }
    if (result.status === 'success') return save(result.credentials, '扫码登录成功')
  }
  fail('等待超时（3 分钟）—— 重新跑一次 login')
}

try {
  await main()
} catch (e) {
  fail(e?.message ?? String(e))
}
