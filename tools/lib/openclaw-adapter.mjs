// OpenClaw 适配器：把“有日子的鱼”的生活流固定在一个 OpenClaw 会话里。
//
// 为什么走 CLI 而不是 HTTP：
//   OpenClaw 的编程入口是 `openclaw agent`（docs/cli/agent.md），
//   Gateway 的 WebSocket/HTTP 细节没有稳定的公开契约；CLI 是官方给脚本用的。
//   它默认经 Gateway 执行，Gateway 不可达时会自动回退到内嵌运行时。
//
// 会话延续：`openclaw agent --session-id <id>` 复用已有会话。
//   与 Hermes 的差异（见 P4.3）：
//     · 没有“先建会话再发消息”的 API，会话在第一次回合时形成；
//     · 没有平台级幂等键，这里用本地账本做去重（同 eventId 只执行一次）；
//     · “会话不存在”只能从 CLI 输出里识别，属于启发式判断，识别到就升代重试一次。
//   降级模式 `sessionMode: 'agent'`：直接用 `--agent <id>` 的 main 会话，不隔代。
//
// 状态与 Hermes 分开存放（agent-session-openclaw.json），一台机器可以同时接两个宿主。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { acquireProcessLock } from './process-lock.mjs'

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.'
const STATE_VERSION = 1
const DEFAULT_BIN = 'openclaw'
const DEFAULT_TURN_TIMEOUT_MS = 620_000
const SESSION_GONE = /(unknown|no such|missing|not found)[^\n]{0,20}session|session[^\n]{0,20}(not found|unknown|expired)|未知会话|会话不存在|会话已过期/i

export class OpenClawError extends Error {
  constructor(code, message, { retryable = false, details } = {}) {
    super(message)
    this.name = 'OpenClawError'
    this.code = code
    this.retryable = retryable
    this.details = details
  }
}

const now = () => new Date().toISOString()
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 生成会话 ID：只含小写字母、数字与连字符，CLI 与日志里都安全。 */
export function defaultSessionId(ownerMid, generation = 1) {
  const raw = String(ownerMid ?? '').trim()
  const seg = /^[A-Za-z0-9]+$/.test(raw)
    ? raw.toLowerCase()
    : crypto.createHash('sha256').update(raw || 'local').digest('hex').slice(0, 12)
  return `bw-${seg}-life-g${generation}`
}

/** 幂等事件 ID：只保留安全字符，长度受控。 */
function sanitizeEventId(value) {
  const cleaned = String(value ?? '').trim().replace(/[^A-Za-z0-9:_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 200)
  return cleaned || `event-${Date.now()}`
}

/** CLI 可能混着日志行；从后往前找第一个能解析的 JSON 行。 */
function parseCliJson(stdout) {
  const text = String(stdout ?? '').trim()
  if (!text) return null
  try { return JSON.parse(text) } catch { /* 多行输出，继续找 */ }
  for (const line of text.split('\n').reverse()) {
    const candidate = line.trim()
    if (!candidate.startsWith('{')) continue
    try { return JSON.parse(candidate) } catch { /* 跳过日志里的花括号 */ }
  }
  return null
}

/** 回复正文的字段没有稳定契约，按常见形态依次取。 */
function extractReply(data, stdout) {
  const candidates = [
    data?.reply?.text,
    typeof data?.reply === 'string' ? data.reply : undefined,
    data?.text,
    data?.content,
    data?.result?.text,
    typeof data?.message === 'string' ? data.message : undefined,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return String(stdout ?? '').trim()
}

export class OpenClawAdapter {
  constructor(options = {}) {
    this.bin = String(options.bin || process.env.OPENCLAW_BIN || DEFAULT_BIN)
    this.mode = options.mode === 'agent' ? 'agent' : 'session-id'
    this.agentId = String(options.agentId || '')
    this.local = Boolean(options.local)
    this.deliver = Boolean(options.deliver)
    this.channel = String(options.channel || '')
    this.ownerMid = String(options.ownerMid || process.env.BILI_WHALE_OWNER_MID || 'local')
    this.stateDir = path.resolve(
      options.stateDir
      || process.env.BILI_WHALE_STATE_DIR
      || path.join(HOME, '.bili-whale')
    )
    this.statePath = path.join(this.stateDir, 'agent-session-openclaw.json')
    this.ledgerPath = path.join(this.stateDir, 'agent-delivery-openclaw.jsonl')
    this.turnTimeoutMs = Number(options.turnTimeoutMs || DEFAULT_TURN_TIMEOUT_MS)
    this.spawnImpl = options.spawnImpl || spawn
    this.logger = options.logger || { info() {}, warn: console.warn, error: console.error }

    if (this.mode === 'agent' && !this.agentId) {
      throw new OpenClawError('missing_agent_id', 'agent.openclaw.sessionMode = agent 时必须给 agentId')
    }
  }

  // ── 公共流程 ────────────────────────────────────────────────────────────

  /**
   * 冷启动/恢复。OpenClaw 没有独立建会话接口：
   * 有状态就沿用（会话在第一次回合时自然形成），没有就落一代新状态。
   */
  async ensureSession({ bootstrapPrompt, handoverPrompt, installId, force = false } = {}) {
    let state = this._loadState()

    if (state && force) {
      state = await this.rotate({ reason: 'forced', handoverPrompt })
      return { state, handover: state.handover }
    }
    if (!state) {
      state = this._newState(1, null, null)
      if (installId) state.installId = installId
      this._saveState(state)
    }

    if (bootstrapPrompt && !state.bootstrapped) {
      const bootstrap = await this.bootstrap({ prompt: bootstrapPrompt, installId })
      return { state: this._loadState(), bootstrap }
    }
    return { state }
  }

  /** 一次唤醒：重试必须复用同一个 planId（本地账本据此去重）。 */
  async wake({ planId, prompt, timeoutMs, autoRotate = true, handoverPrompt } = {}) {
    if (!prompt) throw new OpenClawError('invalid_prompt', 'wake 需要 prompt')
    this._requireState()
    const eventId = `wake-${sanitizeEventId(planId || Date.now())}`
    const result = await this.turn({ eventId, text: prompt, kind: 'wake', timeoutMs })
    if (result.status !== 'session_not_found' || !autoRotate) return result
    await this.rotate({ reason: 'session_not_found', handoverPrompt })
    // 只重试一次，避免“升代 → 仍找不到 → 再升代”的循环。
    return this.turn({ eventId, text: prompt, kind: 'wake', timeoutMs })
  }

  /** 中断对账：事件 ID 由“待对账事件 + 原因”决定，同一输入可安全重放。 */
  async reconcile({ pendingEventId = 'unknown', reason = 'unknown', prompt, timeoutMs } = {}) {
    this._requireState()
    const eventId = `reconcile-${sanitizeEventId(pendingEventId)}-${sanitizeEventId(reason)}`.slice(0, 255)
    const text = prompt
      || `上一回合可能中断（event: ${pendingEventId}，reason: ${reason}）。先核对日记与额度，只修差异，然后回复 RECONCILE_OK + 差异列表。`
    const result = await this.turn({ eventId, text, kind: 'reconcile', timeoutMs })
    if (result.ok) this.resolveEvent(pendingEventId, { reason, via: eventId })
    return result
  }

  /** 给账本补一条收敛记录（pendingEvents 只看每个 eventId 的最后一条）。 */
  resolveEvent(eventId, { reason = '', via = '' } = {}) {
    if (!eventId || eventId === 'unknown') return false
    this._ledger({ eventId, kind: 'resolve', status: 'reconciled', reason, via })
    return true
  }

  /** 只读状态。 */
  getState() {
    return this._loadState()
  }

  /** 升代：没有平台侧动作，只换一代会话 ID；旧代不再使用。 */
  async rotate({ reason = 'manual', handoverPrompt } = {}) {
    const previous = this._loadState()
    const generation = Number(previous?.generation || 0) + 1
    const state = this._newState(generation, previous, reason)
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
   * 核心回合：一次 `openclaw agent` 调用。
   * 结果只通过返回值表达；只有配置/参数错误才抛 OpenClawError。
   */
  async turn({ eventId, text, kind = 'turn', timeoutMs = this.turnTimeoutMs } = {}) {
    if (!text || typeof text !== 'string') {
      throw new OpenClawError('invalid_prompt', 'turn.text 必须是非空字符串')
    }
    const state = this._requireState()

    // 本地幂等：OpenClaw 没有平台级 Idempotency-Key，同一 eventId 成功过就不再发。
    const done = this._ledgerRow(eventId)
    if (done?.status === 'done') {
      return {
        ok: true,
        cached: true,
        status: 'done',
        eventId,
        sessionId: state.sessionId,
        content: done.content ?? '',
        durationMs: 0,
      }
    }

    const lockFile = path.join(this.stateDir, 'locks', `session-${state.sessionId}.lock`)
    let release
    try {
      release = await acquireProcessLock(lockFile)
    } catch (e) {
      throw new OpenClawError('session_lock_failed', `无法获取会话锁：${e.message}`)
    }

    const startedAt = Date.now()
    this._ledger({ eventId, kind, sessionId: state.sessionId, generation: state.generation, status: 'in_flight' })

    try {
      const run = await this._run({ text, sessionId: state.sessionId, timeoutMs })
      const result = this._parse(run, { eventId, sessionId: state.sessionId, startedAt })
      this._ledger({ ...result, kind, generation: state.generation, content: result.content ?? null })
      if (result.ok) {
        const latest = this._loadState()
        // 并发升代时不回写，避免覆盖 rotate()。
        if (latest?.sessionId === state.sessionId) {
          this._saveState({ ...latest, lastTurnAt: now(), lastEventId: eventId })
        }
      }
      return result
    } finally {
      try { await release() } catch { /* 释放失败不覆盖主结果 */ }
    }
  }

  /** 发一条 bootstrap 回合；成功（含 partial）后标记 bootstrapped。 */
  async bootstrap({ prompt, installId, eventId } = {}) {
    if (!prompt) throw new OpenClawError('invalid_prompt', 'bootstrap 需要 prompt')
    const state = this._requireState()
    const iid = installId || state.installId || crypto.randomUUID()
    if (!state.installId) this._saveState({ ...state, installId: iid })
    const key = eventId || `bootstrap-${sanitizeEventId(iid)}-g${state.generation}`
    const result = await this.turn({ eventId: key, text: prompt, kind: 'bootstrap' })
    if (result.ok) {
      const latest = this._loadState()
      if (latest?.sessionId === state.sessionId) this._saveState({ ...latest, bootstrapped: true })
    }
    return result
  }

  // ── 断点账本 ────────────────────────────────────────────────────────────

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

  _ledgerRow(eventId) {
    let found = null
    for (const row of this._readLedger()) if (row?.eventId === eventId) found = row
    return found
  }

  _ledger(entry) {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    fs.appendFileSync(this.ledgerPath, JSON.stringify({ at: now(), ...entry }) + '\n', { mode: 0o600 })
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
      throw new OpenClawError('ledger_corrupt', `投递账本无法读取：${this.ledgerPath}（${e.message}）`)
    }
  }

  // ── 进程调用 ────────────────────────────────────────────────────────────

  _cliArgs({ text, sessionId, timeoutMs }) {
    const args = ['agent']
    if (this.mode === 'agent') args.push('--agent', this.agentId)
    else args.push('--session-id', sessionId)
    args.push('--message', text, '--json', '--timeout', String(Math.max(1, Math.ceil(timeoutMs / 1000))))
    if (this.local) args.push('--local')
    if (this.deliver) {
      args.push('--deliver')
      if (this.channel) args.push('--channel', this.channel)
    }
    return args
  }

  /** 起子进程并等它退出；超时直接 kill，由调用方标记 unknown。 */
  _run({ text, sessionId, timeoutMs }) {
    const args = this._cliArgs({ text, sessionId, timeoutMs })
    return new Promise((resolve) => {
      let child
      try {
        child = this.spawnImpl(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (e) {
        resolve({ spawnError: e })
        return
      }
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try { child.kill('SIGKILL') } catch { /* 已经退出 */ }
      }, timeoutMs)

      child.stdout?.on('data', c => { stdout += c })
      child.stderr?.on('data', c => { stderr += c })
      child.on('error', (e) => {
        clearTimeout(timer)
        resolve({ spawnError: e, stdout, stderr })
      })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        resolve({ code, signal, stdout, stderr, timedOut })
      })
    })
  }

  _parse(run, { eventId, sessionId, startedAt }) {
    const base = { eventId, sessionId, durationMs: Date.now() - startedAt }
    if (run.spawnError) {
      const code = run.spawnError.code === 'ENOENT' ? 'cli_not_found' : 'cli_error'
      return {
        ...base,
        ok: false,
        status: 'failed',
        code,
        message: code === 'cli_not_found'
          ? `找不到 ${this.bin} 命令；装好后确认在 PATH 里，或在配置里设 agent.openclaw.bin`
          : `无法启动 ${this.bin}：${run.spawnError.message}`,
      }
    }
    if (run.timedOut) {
      return {
        ...base,
        ok: false,
        status: 'unknown',
        code: 'timeout',
        message: `openclaw agent 超时（${Math.round(base.durationMs / 1000)}s），结果未知，请先 reconcile`,
      }
    }

    const combined = `${run.stdout}\n${run.stderr}`
    if (run.code !== 0 && SESSION_GONE.test(combined)) {
      return {
        ...base,
        ok: false,
        status: 'session_not_found',
        code: 'session_not_found',
        message: firstLine(run.stderr) || '会话不存在',
      }
    }
    if (run.code !== 0) {
      return {
        ...base,
        ok: false,
        status: 'failed',
        code: `cli_exit_${run.code ?? run.signal ?? 'unknown'}`,
        message: firstLine(run.stderr) || firstLine(run.stdout) || 'openclaw agent 执行失败',
      }
    }

    const data = parseCliJson(run.stdout)
    const content = extractReply(data, run.stdout)
    return { ...base, ok: true, status: 'done', content, usage: data?.usage ?? null }
  }

  // ── 状态 ────────────────────────────────────────────────────────────────

  _newState(generation, previous, reason) {
    return {
      version: STATE_VERSION,
      host: 'openclaw',
      transport: 'cli',
      mode: this.mode,
      sessionId: defaultSessionId(this.ownerMid, generation),
      generation,
      installId: previous?.installId || crypto.randomUUID(),
      bootstrapped: false,
      createdAt: now(),
      lastTurnAt: null,
      lastEventId: null,
      rotatedFrom: previous?.sessionId || null,
      rotateReason: reason || null,
    }
  }

  _loadState() {
    try {
      const state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'))
      if (!isObject(state)) throw new Error('not an object')
      return state
    } catch (e) {
      if (e.code === 'ENOENT') return null
      throw new OpenClawError('state_corrupt', `会话状态无法读取：${this.statePath}（${e.message}）`)
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
      throw new OpenClawError('no_session', '尚未建立会话，请先调用 ensureSession()')
    }
    return state
  }
}

const firstLine = (text) => String(text ?? '').trim().split('\n')[0].slice(0, 300)
