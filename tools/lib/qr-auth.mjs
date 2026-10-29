// 扫码登录的宿主无关实现（2026-10-29 从 lib/auth.js 抽出）。
//
// 为什么抽出来：DSH 插件里的 QrAuth 把"调 B 站扫码接口"和"设置页会话状态机"
// 混在一起，通用 skill 没有设置页，却仍然需要扫码登录。
// 现在这里只放**纯网络 + 校验 + 落盘**，不含任何 UI/会话状态：
//
//   generateQr   生成二维码 URL 与 challenge key
//   pollQrOnce   轮询一次（waiting / scanned / expired / success）
//   verifyAccount 用 nav 接口确认 cookie 属于哪个号
//   saveCredentials 校验后原子写入 ~/.bili-ai/credentials.json（0600）
//   renderTerminal 终端二维码（qrcode 缺失时返回空串，由调用方提示手动 cookie）
//
// 依赖：Node 18+ 全局 fetch；lib/credentials.js 是纯 Node 实现（无 DSH 依赖），
// 因此通用 skill 打包时要一起带上这个文件。
import { AuthError, parseManualCookie, createCredentialStore } from '../../lib/credentials.js'

export const PASSPORT = 'https://passport.bilibili.com'
export const QR_TTL_MS = 180000
const MAX_BODY = 128 * 1024

async function requestJson(fetcher, url, { signal, credentials } = {}) {
  try {
    const response = await fetcher(url, {
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
      headers: {
        'user-agent': 'Mozilla/5.0', referer: PASSPORT + '/login',
        ...(credentials ? { cookie: `SESSDATA=${credentials.sessdata}; bili_jct=${credentials.bili_jct}${credentials.buvid3 ? '; buvid3=' + credentials.buvid3 : ''}` } : {}),
      },
    })
    if (!response.ok) throw Error()
    const reader = response.body.getReader()
    const chunks = []; let size = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.length
        if (size > MAX_BODY) throw Error()
        chunks.push(Buffer.from(value))
      }
    } finally { await reader.cancel().catch(() => {}) }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (body.code !== 0) throw Error()
    return { data: body.data, response }
  } catch {
    throw new AuthError(signal?.aborted ? '登录已取消。' : 'B 站登录请求失败，请稍后重试。')
  }
}

/** 用 nav 接口确认这组 cookie 属于哪个号（昵称里若含密钥会被脱敏）。 */
export async function verifyAccount(input, { fetch: fetcher = globalThis.fetch, signal } = {}) {
  const credentials = parseManualCookie(input)
  const { data } = await requestJson(fetcher, 'https://api.bilibili.com/x/web-interface/nav', { credentials, signal })
  if (data?.isLogin !== true || !/^[1-9]\d{0,19}$/.test(String(data?.mid ?? ''))
    || (typeof data.mid === 'number' && !Number.isSafeInteger(data.mid)))
    throw new AuthError('登录验证失败，旧登录态未替换。')
  let name = typeof data.uname === 'string' ? data.uname.slice(0, 200) : ''
  for (const secret of Object.values(credentials)) if (secret) name = name.split(secret).join('[redacted]')
  return { mid: String(data.mid), name }
}

/** 生成一次扫码 challenge。只接受 B 站自己的登录域名。 */
export async function generateQr({ fetch: fetcher = globalThis.fetch, signal } = {}) {
  const { data } = await requestJson(fetcher, PASSPORT + '/x/passport-login/web/qrcode/generate', { signal })
  let url
  try { url = new URL(data?.url) } catch { throw new AuthError('二维码响应无效，请稍后重试。') }
  if (![PASSPORT, 'https://account.bilibili.com'].includes(url.origin) || url.username || url.password
    || typeof data?.qrcode_key !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(data.qrcode_key))
    throw new AuthError('二维码响应无效，请稍后重试。')
  return { url: url.href, key: data.qrcode_key }
}

/**
 * 轮询一次。
 * @returns {{status:'waiting'|'scanned'|'expired'}|{status:'success',credentials:object}}
 */
export async function pollQrOnce({ fetch: fetcher = globalThis.fetch, signal, key } = {}) {
  const url = new URL('/x/passport-login/web/qrcode/poll', PASSPORT)
  url.searchParams.set('qrcode_key', key)
  const { data, response } = await requestJson(fetcher, url, { signal })
  if (data?.code === 86101) return { status: 'waiting' }
  if (data?.code === 86090) return { status: 'scanned' }
  if (data?.code === 86038) return { status: 'expired' }
  if (data?.code !== 0) throw new AuthError('无法识别登录状态，请重新扫码。')
  const values = {}
  for (const cookie of response.headers.getSetCookie?.() ?? []) {
    const pair = cookie.split(';', 1)[0], split = pair.indexOf('=')
    const name = pair.slice(0, split).trim()
    if (['SESSDATA', 'bili_jct', 'buvid3'].includes(name)) values[name] = pair.slice(split + 1).trim()
  }
  const credentials = parseManualCookie({ sessdata: values.SESSDATA, bili_jct: values.bili_jct, buvid3: values.buvid3 })
  return { status: 'success', credentials }
}

/**
 * 校验并写入凭据。复用 lib/credentials.js 的原子写 + 0600 + 待审草稿保护：
 * 有未处理草稿时不允许静默换号。
 */
export async function saveCredentials(input, { file, pending, fetch: fetcher = globalThis.fetch, signal } = {}) {
  const store = createCredentialStore({
    file,
    pending,
    verify: (credentials, opts) => verifyAccount(credentials, { fetch: fetcher, signal: opts?.signal ?? signal }),
  })
  return store.save(input, { signal })
}

/** 终端二维码。qrcode 没装时返回空串，让调用方走手动 cookie。 */
export async function renderTerminal(url) {
  try {
    const { default: QRCode } = await import('qrcode')
    return await QRCode.toString(url, { type: 'terminal', small: true })
  } catch { return '' }
}
