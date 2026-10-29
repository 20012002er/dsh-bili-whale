import { randomUUID } from 'node:crypto'
import QRCode from 'qrcode'
import { AuthError } from './credentials.js'
// 扫码的网络/校验/落盘逻辑已抽到 tools/lib/qr-auth.mjs（通用 skill 与本插件共用一份）
import { generateQr, pollQrOnce, QR_TTL_MS } from '../tools/lib/qr-auth.mjs'

const INTERVAL = 2000
const TTL = QR_TTL_MS
const terminal = new Set(['success', 'expired', 'cancelled', 'error'])

export { verifyAccount } from '../tools/lib/qr-auth.mjs'

/** One short-lived challenge per plugin instance. No Cookie, key or refresh token reaches the UI. */
export class QrAuth {
  constructor({ save, fetch = globalThis.fetch, now = Date.now, render = url => QRCode.toDataURL(url, { width: 220, margin: 2 }) }) {
    this.save = save; this.fetch = fetch; this.now = now; this.render = render
    this.current = null; this.nextStart = 0; this.disposed = false
  }
  state(session) {
    return { id: session.id, status: session.status, expiresAt: session.expiresAt,
      ...(session.status === 'waiting' || session.status === 'scanned' ? { image: session.image } : {}),
      ...(session.account ? { account: session.account } : {}),
      ...(session.error ? { error: session.error } : {}) }
  }
  check(session) {
    if (this.disposed || this.current !== session || session.controller.signal.aborted)
      throw new AuthError('登录流程已失效，请重新扫码。')
    if (this.now() >= session.expiresAt) { session.status = 'expired'; throw new AuthError('二维码已过期，请重新生成。') }
  }
  async start() {
    if (this.disposed) throw new AuthError('登录服务已关闭。')
    if (this.now() < this.nextStart) throw new AuthError('请稍等两秒后再生成二维码。')
    this.nextStart = this.now() + INTERVAL
    this.cancel()
    const session = { id: randomUUID(), status: 'waiting', controller: new AbortController(), expiresAt: this.now() + TTL, nextPoll: this.now() + INTERVAL }
    this.current = session
    try {
      const { url, key } = await generateQr({ fetch: this.fetch, signal: session.controller.signal })
      this.check(session)
      session.key = key
      session.image = await this.render(url)
      this.check(session)
      return this.state(session)
    } catch (error) {
      session.status = session.controller.signal.aborted ? 'cancelled' : 'error'
      delete session.key; delete session.image
      throw error instanceof AuthError ? error : new AuthError('二维码生成失败，请重试。')
    }
  }
  async poll(id) {
    const session = this.current
    if (!session || session.id !== id) throw new AuthError('登录流程已失效，请重新扫码。')
    if (terminal.has(session.status)) return this.state(session)
    if (this.now() >= session.expiresAt) {
      session.status = 'expired'; session.controller.abort(); delete session.key; delete session.image
      return this.state(session)
    }
    if (session.flight) return session.flight
    if (this.now() < session.nextPoll) return this.state(session)
    session.nextPoll = this.now() + INTERVAL
    session.flight = this.pollOnce(session).finally(() => { session.flight = null })
    return session.flight
  }
  async pollOnce(session) {
    try {
      const result = await pollQrOnce({ fetch: this.fetch, signal: session.controller.signal, key: session.key })
      this.check(session)
      if (result.status === 'success') {
        session.account = await this.save(result.credentials, { signal: session.controller.signal, check: () => this.check(session) })
        session.status = 'success'
      } else session.status = result.status
    } catch (error) {
      if (!terminal.has(session.status)) {
        session.status = session.controller.signal.aborted ? 'cancelled' : 'error'
        session.error = error instanceof AuthError ? error.message : '登录未保存，请重新扫码。'
      }
    }
    if (terminal.has(session.status)) { delete session.key; delete session.image }
    return this.state(session)
  }
  cancel(id) {
    const session = this.current
    if (!session || (id && session.id !== id)) return { status: 'cancelled' }
    if (!terminal.has(session.status)) session.status = 'cancelled'
    session.controller.abort(); delete session.key; delete session.image
    return this.state(session)
  }
  dispose() { this.disposed = true; this.cancel() }
}
