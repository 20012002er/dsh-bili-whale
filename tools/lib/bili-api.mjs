import crypto from 'node:crypto'

const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = u => String(u).split('/').at(-1).split('.')[0]

export function signWbi(params, images, now = Date.now()) {
  const raw = keyOf(images?.img_url ?? '') + keyOf(images?.sub_url ?? '')
  if (raw.length !== 64) throw new Error('WBI 签名密钥缺失，请稍后重试或检查登录状态')
  const key = MIXIN.map(i => raw[i]).join('').slice(0, 32)
  const values = { ...params, wts: Math.floor(now / 1000) }
  delete values.w_rid
  const query = Object.keys(values).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(values[k]).replace(/[!'()*]/g, ''))}`).join('&')
  return `${query}&w_rid=${crypto.createHash('md5').update(query + key).digest('hex')}`
}

// Read failures retain the API's {code,message} shape so each caller can decide
// whether metadata is required or optional. Never include cookies or response bodies.
export async function apiGet(input, headers = {}) {
  const url = new URL(input)
  try {
    const signedPaths = {
      '/x/web-interface/view': '/x/web-interface/wbi/view',
      '/x/player/playurl': '/x/player/wbi/playurl',
    }
    if (url.hostname === 'api.bilibili.com' && signedPaths[url.pathname]) {
      const nav = await apiGet('https://api.bilibili.com/x/web-interface/nav', headers)
      if (!nav.data?.wbi_img) return { code: -1, message: `WBI 签名不可用：${nav.message || 'nav 未返回密钥'}` }
      url.pathname = signedPaths[url.pathname]
      url.search = signWbi(Object.fromEntries(url.searchParams), nav.data.wbi_img)
    }
    const response = await fetch(url.href, { headers, signal: AbortSignal.timeout(30000) })
    if (!response.ok) return { code: -1, message: `HTTP ${response.status}（B站风控或接口异常，请稍后重试；见 README 排障）` }
    const text = await response.text()
    try {
      const data = JSON.parse(text)
      if (!data || typeof data !== 'object') throw new Error('invalid JSON payload')
      return data
    } catch { return { code: -1, message: `非 JSON 响应（HTTP ${response.status}），可能是风控或接口变更；见 README 排障` } }
  } catch (error) {
    return { code: -1, message: error.name === 'TimeoutError' ? '请求超时（30 秒）' : '请求失败（网络异常或 WBI 签名密钥无效）' }
  }
}
