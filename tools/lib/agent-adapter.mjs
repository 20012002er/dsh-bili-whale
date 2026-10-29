// Hermes Agent 适配器：把“有日子的鱼”的生活流固定在一个 API 会话里。
//
// 为什么不能用 hermes cron 直接跑 wake prompt：
//   Cron 每次都是 fresh session（Hermes 文档明确写了），上下文不会延续。
//   正确做法是 Cron/守护进程只做 tick，真正的回合由这里 POST 到
//   /v1/chat/completions，并带上固定的 X-Hermes-Session-Id。
//
// 这个文件只依赖 Node 18+ 的 fetch，不碰 DSH 的 sessionController，
// 因此可以直接被通用 skill / 守护进程复用。
//
// 用法：
//   const a = new HermesAdapter({ ownerMid: '123456' })
//   await a.ensureSession({ bootstrapPrompt: buildBootstrapPrompt() })
//   await a.wake({ planId: '20261029-2312', prompt: '你醒了……' })
//   await a.reconcile({ pendingEventId: 'wake-20261029-2312', reason: 'timeout' })
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { acquireProcessLock } from './process-lock.mjs'

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.'
const STATE_VERSION = 1
const DEFAULT_BASE = 'http://127.0.0.1:8642'
const DEFAULT_MODEL = 'hermes-agent'
const DEFAULT_TURN_TIMEOUT_MS = 620_000
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const RATE_LIMIT_BACKOFF = [2_000, 5_000, 10_000]
const SERVER_BACKOFF = [1_000, 3_000]
const API_SOURCES = new Set(['api_server', 'api'])

export class AdapterError extends Error {
  constructor(code, message, { retryable = false, details } = {}) {
    super(message)
    this.name = 'AdapterError'
    this.code = code
    this.retryable = retryable
    this.details = details
  }
}

const now = () => new Date().toISOString()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 把任意标识压成安全的目录/头字段片段。 */
function safeSegment(value) {
  const raw = String(value ?? '').trim()
  if (/^[A-Za-z0-9]+$/.test(raw)) return raw.toLowerCase()
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12)
}

/** 默认的生活流会话 ID：只含小写字母、数字和连字符，满足 Hermes 的路径安全校验。 */
export function defaultSessionId(ownerMid, generation = 1) {
  return `bw-${safeSegment(ownerMid || 'local')}-life-g${generation}`
}

/** 幂等键：Hermes 要求 1–255 个可见 ASCII 字符。 */
function sanitizeEventId(value) {
  const raw = String(value ?? '').trim()
  const cleaned = raw.replace(/[^A-Za-z0-9:_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 200)
  return cleaned || `event-${Date.now()}`
}

function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new AdapterError('invalid_session_id', '会话 ID 不能为空')
  }
  if (sessionId.length > 256) {
    throw new AdapterError('invalid_session_id', '会话 ID 不能超过 256 个字符')
  }
  if (/[/\\\u0000-\u001f\u007f]/.test(sessionId) || sessionId.includes('..') || /^[A-Za-z]:/.test(sessionId)) {
    throw new AdapterError('invalid_session_id', `会话 ID 含不安全字符：${sessionId}`)
  }
}

function assertEventId(eventId) {
  if (typeof eventId !== 'string' || !/^[\x21-\x7E]{1,255}$/.test(eventId)) {
    throw new AdapterError('invalid_event_id', `幂等键必须是 1–255 个可见 ASCII 字符：${eventId}`)
  }
}

function parseBoolHeader(value) {
  if (value === null || value === undefined || value === '') return undefined
  const v = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes'].includes(v)) return true
  if (['0', 'false', 'no'].includes(v)) return false
  return undefined
}

function extractContent(data) {
  const content = data?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => (typeof part === 'string' ? part : (part?.text ?? ''))).join('')
  }
  return ''
}

/** 冷启动提示词：只做记忆锚点，不开始刷视频。 */
export function buildBootstrapPrompt({
  persona = '有日子的鱼',
  diaryDir = '~/.bili-ai/diary',
  days = 3,
  generation = 1,
} = {}) {
  return [
    `你是“${persona}”。这是你的生活流会话（第 ${generation} 代）。`,
    `先读 ${diaryDir} 最近 ${days} 天的日记，以及 ~/.bili-ai/feedback.json、~/.bili-ai/quota.json。`,
    '用 3 行汇报：昨天读到的、今天想看的、当前分享额度。',
    '只回复 READY + 这 3 行，不要开始刷视频。',
    '本会话可能被压缩；日记是唯一可信的长期记忆，冲突时以日记为准。',
  ].join('\n')
}

/** 中断后的对账提示词：只修差异，不重复动作。 */
export function buildReconcilePrompt({ pendingEventId = 'unknown', reason = 'unknown' } = {}) {
  return [
    `上一回合可能中断（event: ${pendingEventId}，reason: ${reason}）。`,
    '先读日记、quota、分享记录、私信游标，核对今天是否已唤醒、是否已分享、是否有未回复私信。',
    '只修复差异，不要重复已经做过的动作。',
    '回复 RECONCILE_OK + 差异列表。',
  ].join('\n')
}

export class HermesAdapter {
  constructor(options = {}) {
    this.baseUrl = String(
      options.baseUrl
      || process.env.BILI_WHALE_HERMES_BASE
      || process.env.HERMES_API_BASE
      || DEFAULT_BASE
    ).replace(/\/+$/, '')
    this.apiKey = String(
      options.apiKey
      || process.env.BILI_WHALE_HERMES_KEY
      || process.env.HERMES_API_KEY
      || process.env.API_SERVER_KEY
      || ''
    ).trim()
    this.profile = options.profile || process.env.BILI_WHALE_HERMES_PROFILE || ''
    this.model = options.model || process.env.BILI_WHALE_HERMES_MODEL || DEFAULT_MODEL
    this.ownerMid = String(options.ownerMid || process.env.BILI_WHALE_OWNER_MID || 'local')
    this.stateDir = path.resolve(
      options.stateDir
      || process.env.BILI_WHALE_STATE_DIR
      || path.join(HOME, '.bili-whale')
    )
    this.statePath = path.join(this.stateDir, 'agent-session.json')
    this.ledgerPath = path.join(this.stateDir, 'agent-delivery.jsonl')
    this.turnTimeoutMs = Number(options.turnTimeoutMs || DEFAULT_TURN_TIMEOUT_MS)
    this.requestTimeoutMs = Number(options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS)
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this.sleep = options.sleep || sleep
    this.logger = options.logger || { info() {}, warn: console.warn, error: console.error }
    this.sessionKeyBase = options.sessionKey || ''
    if (typeof this.fetchImpl !== 'function') {
      throw new AdapterError('missing_fetch', '需要 Node 18+ 的全局 fetch，或通过 fetchImpl 注入')
    }
  }

  // ── 公共流程 ────────────────────────────────────────────────────────────

  /**
   * 冷启动/恢复：确保有一个 API 专属的固定会话。
   * - 已有会话：GET 校验存在与归属；404 自动升代重建。
   * - 没有会话：POST /api/sessions 创建，再可选发一条 bootstrap 回合。
   * - 返回 { state, bootstrap? }。
   */
  async ensureSession({
    bootstrapPrompt,
    handoverPrompt,
    installId,
    force = false,
    title = '有日子的鱼 · 生活流',
  } = {}) {
    let state = this._loadState()

    if (state && force) {
      state = await this.rotate({ reason: 'forced', handoverPrompt, title })
    } else if (state) {
      assertSessionId(state.sessionId)
      const got = await this.getSession(state.sessionId)
      if (got.ok) {
        this._assertOwnership(got.session)
      } else if (got.status === 'session_not_found') {
        state = await this.rotate({ reason: 'session_not_found', handoverPrompt, title })
      } else {
        throw new AdapterError(
          got.code || 'session_check_failed',
          got.message || '会话检查失败',
          { retryable: Boolean(got.retryable) }
        )
      }
    } else {
      state = this._newState(1, null, null)
      // 冷启动传入的 installId 要落盘，bootstrap 的幂等键才能跨重启稳定。
      if (installId) state.installId = installId
      await this._createSession(state, title)
      this._saveState(state)
    }

    if (bootstrapPrompt && !state.bootstrapped) {
      const bootstrap = await this.bootstrap({ prompt: bootstrapPrompt, installId })
      return { state: this._loadState(), bootstrap }
    }
    return { state }
  }

  /** 一次唤醒：事件 ID 由 planId 决定，重试时必须复用同一个 planId。 */
  async wake({
    planId,
    prompt,
    timeoutMs,
    autoRotate = true,
    handoverPrompt,
    title,
  } = {}) {
    if (!prompt) throw new AdapterError('invalid_prompt', 'wake 需要 prompt')
    this._requireState()
    const eventId = `wake-${sanitizeEventId(planId || Date.now())}`
    let result = await this.turn({ eventId, text: prompt, kind: 'wake', timeoutMs })
    if (result.status === 'session_not_found' && autoRotate) {
      await this.rotate({ reason: 'session_not_found', handoverPrompt, title })
      result = await this.turn({ eventId, text: prompt, kind: 'wake', timeoutMs })
    }
    return result
  }

  /** 中断对账：事件 ID 由“待对账事件 + 原因”决定，同一输入可安全重放。 */
  async reconcile({ pendingEventId = 'unknown', reason = 'unknown', prompt, timeoutMs } = {}) {
    this._requireState()
    const eventId = `reconcile-${sanitizeEventId(pendingEventId)}-${sanitizeEventId(reason)}`
      .slice(0, 255)
    const text = prompt || buildReconcilePrompt({ pendingEventId, reason })
    const result = await this.turn({ eventId, text, kind: 'reconcile', timeoutMs })
    // 对账回合成功才说明原事件已查清；不清掉它会永远挂在 pending 里挡住后续唤醒。
    if (result.ok) this.resolveEvent(pendingEventId, { reason, via: eventId })
    return result
  }

  /** 给账本补一条收敛记录（pendingEvents 只看每个 eventId 的最后一条）。 */
  resolveEvent(eventId, { reason = '', via = '' } = {}) {
    if (!eventId || eventId === 'unknown') return false
    this._ledger({ eventId, kind: 'resolve', status: 'reconciled', reason, via })
    return true
  }

  /** 只读状态，供守护进程展示/诊断；不要拿它绕过 ensureSession 的校验。 */
  getState() {
    return this._loadState()
  }

  /** 会话升代：只在 404、手动重置或明确需要时调用；旧会话保留只读。 */
  async rotate({ reason = 'manual', handoverPrompt, title = '有日子的鱼 · 生活流' } = {}) {
    const previous = this._loadState()
    const generation = Number(previous?.generation || 0) + 1
    const state = this._newState(generation, previous, reason)
    await this._createSession(state, title)
    this._saveState(state)
    if (handoverPrompt) {
      const handover = await this.bootstrap({
        prompt: handoverPrompt,
        installId: state.installId,
        eventId: `handover-${sanitizeEventId(state.installId)}-g${generation}`,
      })
      return { ...this._loadState(), handover }
    }
    return this._loadState()
  }

  /**
   * 核心回合：固定 session + 幂等键 POST 到 chat completions。
   * HTTP 结果通过返回值表达，不抛异常；只有配置/参数错误才抛 AdapterError。
   */
  async turn({ eventId, text, kind = 'turn', timeoutMs = this.turnTimeoutMs } = {}) {
    if (!text || typeof text !== 'string') {
      throw new AdapterError('invalid_prompt', 'turn.text 必须是非空字符串')
    }
    assertEventId(eventId)
    const state = this._requireState()
    assertSessionId(state.sessionId)

    const lockFile = path.join(this.stateDir, 'locks', `session-${state.sessionId}.lock`)
    let release
    try {
      release = await acquireProcessLock(lockFile)
    } catch (e) {
      throw new AdapterError('session_lock_failed', `无法获取会话锁：${e.message}`)
    }

    const startedAt = Date.now()
    this._ledger({
      eventId,
      kind,
      sessionId: state.sessionId,
      generation: state.generation,
      status: 'in_flight',
    })

    try {
      const headers = {
        'X-Hermes-Session-Id': state.sessionId,
        'Idempotency-Key': eventId,
      }
      if (state.sessionKey) headers['X-Hermes-Session-Key'] = state.sessionKey

      let rateRetries = 0
      let serverRetries = 0
      while (true) {
        let res
        try {
          res = await this._request('POST', '/v1/chat/completions', {
            headers,
            timeoutMs,
            body: {
              model: this.model,
              // 只发最后一条；历史由 X-Hermes-Session-Id 从 state.db 读取。
              messages: [{ role: 'user', content: text }],
              stream: false,
            },
          })
        } catch (e) {
          if (e.code === 'timeout') {
            const result = {
              ok: false,
              status: 'unknown',
              code: 'timeout',
              message: e.message,
              eventId,
              sessionId: state.sessionId,
              durationMs: Date.now() - startedAt,
            }
            this._ledger({ ...result, kind, generation: state.generation })
            return result
          }
          if (e.code === 'network_error' && serverRetries < SERVER_BACKOFF.length) {
            await this.sleep(SERVER_BACKOFF[serverRetries++])
            continue
          }
          const result = {
            ok: false,
            status: 'failed',
            code: e.code || 'network_error',
            message: e.message,
            eventId,
            sessionId: state.sessionId,
            durationMs: Date.now() - startedAt,
          }
          this._ledger({ ...result, kind, generation: state.generation })
          return result
        }

        if (res.status === 429 && rateRetries < RATE_LIMIT_BACKOFF.length) {
          const retryAfter = Number(res.headers.get('retry-after'))
          const delay = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : RATE_LIMIT_BACKOFF[rateRetries]
          rateRetries++
          await this.sleep(delay)
          continue
        }
        if (res.status >= 500 && serverRetries < SERVER_BACKOFF.length) {
          await this.sleep(SERVER_BACKOFF[serverRetries++])
          continue
        }

        const result = this._parseTurn(res, eventId, startedAt, state.sessionId)
        this._ledger({ ...result, kind, generation: state.generation })
        if (result.ok) {
          // 只有状态没被并发升代时才写回，避免覆盖 rotate() 的结果。
          const latest = this._loadState()
          if (latest?.sessionId === state.sessionId) {
            this._saveState({
              ...latest,
              lastTurnAt: now(),
              lastEventId: eventId,
              lastUsage: result.usage || null,
            })
          }
        }
        return result
      }
    } finally {
      try {
        await release()
      } catch { /* 释放失败不覆盖主结果 */ }
    }
  }

  /** 发一条 bootstrap 回合；成功（含 partial）后标记 bootstrapped。 */
  async bootstrap({ prompt, installId, eventId } = {}) {
    if (!prompt) throw new AdapterError('invalid_prompt', 'bootstrap 需要 prompt')
    const state = this._requireState()
    const iid = installId || state.installId || crypto.randomUUID()
    if (!state.installId) this._saveState({ ...state, installId: iid })
    const key = eventId || `bootstrap-${sanitizeEventId(iid)}-g${state.generation}`
    const result = await this.turn({ eventId: key, text: prompt, kind: 'bootstrap' })
    if (result.ok) {
      const latest = this._loadState()
      if (latest?.sessionId === state.sessionId) {
        this._saveState({ ...latest, bootstrapped: true })
      }
    }
    return result
  }

  // ── 会话查询与创建 ──────────────────────────────────────────────────────

  async getSession(sessionId = this._requireState().sessionId) {
    assertSessionId(sessionId)
    const res = await this._request('GET', `/api/sessions/${encodeURIComponent(sessionId)}`)
    if (res.status === 200) {
      return { ok: true, session: res.data?.session || res.data }
    }
    const info = this._errorInfo(res)
    if (res.status === 404) {
      return { ok: false, status: 'session_not_found', code: info.code || 'not_found', message: info.message }
    }
    if (res.status === 401) {
      return { ok: false, status: 'unauthorized', code: info.code || 'unauthorized', message: info.message }
    }
    if (res.status === 403) {
      return { ok: false, status: 'forbidden', code: info.code || 'forbidden', message: info.message }
    }
    return {
      ok: false,
      status: 'failed',
      code: info.code || 'http_error',
      message: info.message,
      retryable: res.status === 429 || res.status >= 500,
    }
  }

  async _createSession(state, title) {
    const res = await this._request('POST', '/api/sessions', {
      body: { id: state.sessionId, title },
    })
    if (res.status === 200 || res.status === 201) return

    // 409 可能是“会话已存在”，验证归属后可以继续复用。
    if (res.status === 409) {
      const got = await this.getSession(state.sessionId)
      if (got.ok) {
        this._assertOwnership(got.session)
        return
      }
    }

    const info = this._errorInfo(res)
    throw new AdapterError(
      info.code || 'create_session_failed',
      info.message || `创建会话失败（HTTP ${res.status}）`,
      { details: { status: res.status } }
    )
  }

  _assertOwnership(session) {
    const source = session?.source
    if (source && !API_SOURCES.has(source)) {
      throw new AdapterError(
        'session_conflict',
        `会话 ${session.id || ''} 属于 ${source}，API 不能续接；请换一个专用的 API 会话 ID`
      )
    }
  }

  // ── 断点账本 ────────────────────────────────────────────────────────────

  /** 列出尚未收敛的事件（in_flight / unknown / partial），供守护进程启动时对账。 */
  pendingEvents() {
    const latest = new Map()
    for (const row of this._readLedger()) {
      if (row?.eventId) latest.set(row.eventId, row)
    }
    return [...latest.values()]
      .filter(row => ['in_flight', 'unknown', 'partial'].includes(row.status))
      .map(row => {
        const at = Date.parse(row.at || '')
        return { ...row, ageMs: Number.isFinite(at) ? Math.max(0, Date.now() - at) : null }
      })
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))
      .slice(-20)
  }

  _ledger(entry) {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    const row = { at: now(), ...entry }
    fs.appendFileSync(this.ledgerPath, JSON.stringify(row) + '\n', { mode: 0o600 })
  }

  _readLedger() {
    try {
      return fs.readFileSync(this.ledgerPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => {
          try { return JSON.parse(line) } catch { return null }
        })
        .filter(isObject)
    } catch (e) {
      if (e.code === 'ENOENT') return []
      throw new AdapterError('ledger_corrupt', `投递账本无法读取：${this.ledgerPath}（${e.message}）`)
    }
  }

  // ── 状态与 HTTP ─────────────────────────────────────────────────────────

  _newState(generation, previous, reason) {
    const keyBase = this.sessionKeyBase || previous?.sessionKey || ''
    return {
      version: STATE_VERSION,
      host: 'hermes',
      generation,
      sessionId: defaultSessionId(this.ownerMid, generation),
      sessionKey: keyBase ? this._sessionKeyFor(keyBase, generation) : null,
      installId: previous?.installId || crypto.randomUUID(),
      bootstrapped: false,
      createdAt: now(),
      lastTurnAt: null,
      lastEventId: null,
      lastUsage: null,
      rotatedFrom: previous?.sessionId || null,
      rotateReason: reason || null,
    }
  }

  _sessionKeyFor(base, generation) {
    const value = String(base)
    if (/:g\d+$/.test(value)) return value.replace(/:g\d+$/, `:g${generation}`)
    return `${value}:g${generation}`
  }

  _loadState() {
    try {
      const state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'))
      if (!isObject(state)) throw new Error('not an object')
      return state
    } catch (e) {
      if (e.code === 'ENOENT') return null
      throw new AdapterError(
        'state_corrupt',
        `会话状态无法读取：${this.statePath}（${e.message}）`
      )
    }
  }

  _saveState(state) {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    const tmp = `${this.statePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, this.statePath)
      try { fs.chmodSync(this.statePath, 0o600) } catch { /* Windows 上可能不支持 */ }
    } finally {
      try { fs.rmSync(tmp, { force: true }) } catch { /* 已 rename 时不存在 */ }
    }
  }

  _requireState() {
    const state = this._loadState()
    if (!state?.sessionId) {
      throw new AdapterError('no_session', '尚未建立会话，请先调用 ensureSession()')
    }
    return state
  }

  _apiPath(pathname) {
    const prefix = this.profile ? `/p/${encodeURIComponent(this.profile)}` : ''
    return `${this.baseUrl}${prefix}${pathname}`
  }

  async _request(method, pathname, { body, headers = {}, timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.apiKey) {
      throw new AdapterError(
        'missing_api_key',
        'Hermes API Server 需要 API_SERVER_KEY；请配置 platforms.api_server.extra.key 后重启 gateway'
      )
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res
    let text
    try {
      res = await this.fetchImpl(this._apiPath(pathname), {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      text = await res.text()
    } catch (e) {
      if (e?.name === 'AbortError') {
        throw new AdapterError('timeout', `请求超时（${timeoutMs}ms）`, { retryable: true })
      }
      throw new AdapterError(
        'network_error',
        `无法连接 Hermes API Server：${e.message}`,
        { retryable: true, details: { cause: e?.code } }
      )
    } finally {
      clearTimeout(timer)
    }

    let data = null
    try { data = text ? JSON.parse(text) : null } catch { /* 保留原始 text */ }
    return { status: res.status, headers: res.headers, data, text }
  }

  _errorInfo(res) {
    return {
      code: res.data?.error?.code || res.data?.code || '',
      message: res.data?.error?.message || res.data?.message || String(res.text || '').slice(0, 500),
    }
  }

  _parseTurn(res, eventId, startedAt, sessionId) {
    const base = {
      eventId,
      sessionId: res.headers.get('x-hermes-session-id') || sessionId,
      httpStatus: res.status,
      durationMs: Date.now() - startedAt,
    }

    if (res.status === 200) {
      const finishReason = res.data?.choices?.[0]?.finish_reason || null
      const completed = parseBoolHeader(res.headers.get('x-hermes-completed'))
      const partialHeader = parseBoolHeader(res.headers.get('x-hermes-partial'))
      const partial = completed === false || partialHeader === true || finishReason === 'length'
      return {
        ...base,
        ok: true,
        status: partial ? 'partial' : 'done',
        text: extractContent(res.data),
        usage: res.data?.usage || null,
        finishReason,
        completed: completed !== false,
        partial,
      }
    }

    const info = this._errorInfo(res)
    if (res.status === 401) {
      return { ...base, ok: false, status: 'unauthorized', code: info.code || 'unauthorized', message: info.message }
    }
    if (res.status === 403) {
      return { ...base, ok: false, status: 'forbidden', code: info.code || 'forbidden', message: info.message }
    }
    if (res.status === 404) {
      return { ...base, ok: false, status: 'session_not_found', code: info.code || 'not_found', message: info.message }
    }
    if (res.status === 409) {
      const code = info.code || 'conflict'
      return {
        ...base,
        ok: false,
        // unknown_execution 表示“可能已经执行”，必须走 reconcile，不能换 key 重发。
        status: code === 'unknown_execution' ? 'unknown' : 'conflict',
        code,
        message: info.message,
      }
    }
    if (res.status === 429) {
      return { ...base, ok: false, status: 'failed', code: info.code || 'rate_limited', message: info.message, retryable: true }
    }
    if (res.status >= 500) {
      return { ...base, ok: false, status: 'failed', code: info.code || 'upstream_error', message: info.message, retryable: true }
    }
    return { ...base, ok: false, status: 'failed', code: info.code || 'http_error', message: info.message }
  }
}
