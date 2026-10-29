// 监听接线（Phase 5）：私信 / 评论 / 直播，命中后叫醒同一个生活流会话。
//
// 原则：
//   · 先“取”后“确认”——私信用 dm-await --peek 取消息、agent 回合成功后才 --ack；
//     失败就留着，下一轮还会发出同一条（事件 ID 相同，适配器会去重）。
//   · 评论用收件箱汇总 + 本地已见 ID 集合，避免同一条反复唤醒。
//   · 直播只在显式开启且配置了房间时值守；一次只回一条。
//
//   node bili.mjs listen --once [--json] [--dm|--no-dm] [--comment|--no-comment] [--live|--no-live]
//   node bili.mjs listen --daemon [--interval 60]
//
// 退出码：0 没有命中或已处理；1 结果未知 / 确认失败 / 有待对账；2 配置错误；3 失败。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { config } from '../lib/config.mjs'
import { BILI_WHALE_HOME, whalePath } from '../lib/paths.mjs'
import { NODE_EXE } from '../lib/nodebin.mjs'
import { makeAdapter, codeFor } from '../lib/agent-factory.mjs'
import { trafficGuard } from '../lib/traffic.mjs'
import {
  composeBootstrapPrompt,
  composeDmPrompt,
  composeCommentPrompt,
  composeLivePrompt,
} from '../lib/agent-prompts.mjs'
import { logTurn } from '../lib/wake-log.mjs'
import { createLogger } from '../lib/logger.mjs'

const log = createLogger('listen')

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const flag = (name) => argv.includes('--' + name)
const option = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined }

const BILI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bili.mjs')
const LISTEN_STATE = whalePath('listen-state.json')
const TITLE = '有日子的鱼 · 生活流'
const MAX_SEEN = 500

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const firstLine = text => String(text ?? '').trim().split('\n')[0].slice(0, 300)

function readState() {
  try {
    const value = JSON.parse(fs.readFileSync(LISTEN_STATE, 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(LISTEN_STATE), { recursive: true })
  const tmp = `${LISTEN_STATE}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
    fs.renameSync(tmp, LISTEN_STATE)
  } finally {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 已 rename */ }
  }
}

/** 调一次自己的子命令（dm-await / comment-digest / await），拿退出码和输出。 */
function runBili(args, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const child = spawn(NODE_EXE, [BILI_PATH, ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL') } catch { /* 已退出 */ } }, timeoutMs)
    child.stdout.on('data', c => { stdout += c })
    child.stderr.on('data', c => { stderr += c })
    child.on('error', e => { clearTimeout(timer); resolve({ code: 3, stdout, stderr: e.message, timedOut }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 3, stdout, stderr, timedOut }) })
  })
}

/** 子命令的 JSON 可能在最后一行（前面混着人类可读输出）。 */
function lastJson(text) {
  for (const line of String(text ?? '').trim().split('\n').reverse()) {
    const candidate = line.trim()
    if (!candidate.startsWith('{')) continue
    try { return JSON.parse(candidate) } catch { /* 继续往前找 */ }
  }
  return null
}

const itemId = (i) => `${i?.kind ?? ''}|${i?.rpid ?? i?.id ?? i?.oid ?? ''}|${i?.mid ?? ''}|${i?.t ?? ''}`

async function wake(agent, cfg, key, prompt) {
  const state = agent.getState()
  const startedAt = Date.now()
  log.info('叫醒会话', { event: key, generation: state?.generation ?? null, sessionId: state?.sessionId ?? null })
  const result = await agent.wake({
    planId: key,
    prompt,
    handoverPrompt: composeBootstrapPrompt({
      dataHome: BILI_WHALE_HOME, biliPath: BILI_PATH, cfg,
      generation: Number(state?.generation ?? 1) + 1,
      reason: 'session_not_found', handover: true,
    }),
    title: TITLE,
  })
  logTurn({
    source: key.split('-')[0], host: state?.host ?? null,
    event: result.eventId ?? key, status: result.status, code: result.code,
    durationMs: result.durationMs, generation: result.generation, usage: result.usage,
  })
  const summary = {
    event: result.eventId ?? key, status: result.status, code: result.code ?? null,
    durationMs: result.durationMs ?? Date.now() - startedAt,
  }
  if (result.ok) log.info('会话回合完成', summary)
  else log.warn('会话回合未成功', { ...summary, message: result.message ?? null })
  return result
}

async function dmCycle(agent, cfg) {
  log.debug('检查私信')
  const peek = await runBili(['dm-await', '--peek', '--json'])
  if (peek.code === 1) {
    log.debug('没有新私信')
    return { source: 'dm', status: 'idle', code: 0 }
  }
  if (peek.code !== 0) {
    const message = firstLine(peek.stderr) || `dm-await 退出 ${peek.code}`
    log.warn('取私信失败', { code: peek.code, message })
    return { source: 'dm', status: 'failed', code: 3, message }
  }
  const message = lastJson(peek.stdout)
  if (!message?.hit) {
    log.debug('没有新私信')
    return { source: 'dm', status: 'idle', code: 0 }
  }

  // 只记元数据：正文可能包含主人家里的信息，不落到日志里。
  log.info('收到私信，准备叫醒', {
    key: message.key ?? null, receipt: message.receipt ?? null,
    from: message.mid ?? null, name: message.name ?? null, textLen: String(message.text ?? '').length,
  })
  const result = await wake(agent, cfg, `dm-${message.key ?? message.ts}`, composeDmPrompt({
    biliPath: BILI_PATH, cfg, text: message.text,
    at: message.ts ? new Date(Number(message.ts) * 1000).toISOString() : '',
  }))
  if (!result.ok) {
    // 没处理成功就不要推进已读位置；下一轮同一条会再来（事件 ID 相同，不会重复执行）。
    log.warn('私信回合未完成，保留待处理', { key: message.key ?? null, status: result.status })
    return { source: 'dm', status: result.status, code: codeFor(result) || 1, event: result.eventId, message: result.message }
  }

  const ack = await runBili(['dm-await', '--ack', message.receipt], 60_000)
  if (ack.code !== 0) {
    const message2 = firstLine(ack.stderr) || '确认失败'
    log.warn('回合成功但确认私信失败，下一轮会重复投递（事件 ID 相同会去重）', {
      receipt: message.receipt ?? null, code: ack.code, message: message2,
    })
    return { source: 'dm', status: 'ack_failed', code: 1, event: result.eventId, message: message2 }
  }
  log.info('私信已确认', { receipt: message.receipt ?? null })
  return { source: 'dm', status: 'done', code: 0, event: result.eventId }
}

async function commentCycle(agent, cfg) {
  log.debug('检查评论收件箱')
  const digest = await runBili(['comment-digest', '--hours', '24', '--json'], 180_000)
  if (digest.code !== 0) {
    const message = firstLine(digest.stderr) || `comment-digest 退出 ${digest.code}`
    log.warn('取评论收件箱失败', { code: digest.code, message })
    return { source: 'comment', status: 'failed', code: 3, message }
  }
  const data = lastJson(digest.stdout)
  const items = Array.isArray(data?.items) ? data.items : []
  const state = readState()
  const seen = new Set(state.commentSeen ?? [])
  const fresh = items.filter(item => !seen.has(itemId(item))).slice(0, 5)
  if (!fresh.length) {
    log.debug('没有新评论', { total: items.length, seen: seen.size })
    return { source: 'comment', status: 'idle', code: 0 }
  }

  log.info('发现新评论，准备叫醒', { total: items.length, fresh: fresh.length, seen: seen.size })
  const text = fresh.map(item => `${item.kind ?? 'msg'} ${item.mid ?? ''}: ${String(item.text ?? item.title ?? '').slice(0, 160)}`).join('\n')
  const eventId = `comment-${crypto.createHash('sha256').update(fresh.map(itemId).join('|')).digest('hex').slice(0, 12)}`
  const result = await wake(agent, cfg, eventId, composeCommentPrompt({
    biliPath: BILI_PATH, digest: text, count: fresh.length,
  }))
  if (!result.ok) {
    log.warn('评论回合未完成，不推进已见集合', { event: eventId, count: fresh.length, status: result.status })
    return { source: 'comment', status: result.status, code: codeFor(result) || 1, event: result.eventId, message: result.message }
  }

  const merged = [...seen, ...fresh.map(itemId)].slice(-MAX_SEEN)
  writeState({ ...state, commentSeen: merged, lastCommentAt: new Date().toISOString() })
  log.info('评论已记为处理过', { event: eventId, count: fresh.length, seen: merged.length })
  return { source: 'comment', status: 'done', code: 0, event: result.eventId, count: fresh.length }
}

async function liveCycle(agent, cfg, timeoutSec) {
  const room = String(cfg.listen?.liveRoom ?? '')
  if (!room) {
    log.debug('没有配置 listen.liveRoom，跳过直播')
    return { source: 'live', status: 'idle', code: 0, message: '未配置 listen.liveRoom' }
  }
  const wait = Math.max(30, Math.min(900, Number(timeoutSec) || 300))
  log.info('值守直播间', { room, waitSec: wait })
  const r = await runBili(['await', '--room', room, '--timeout', String(wait)], (wait + 60) * 1000)
  const hit = /AWAIT_HIT[^\n]*/.exec(r.stdout)?.[0]
  if (!hit) {
    log.debug('直播间没有需要回的弹幕', { room, code: r.code, timedOut: r.timedOut })
    return { source: 'live', status: 'idle', code: 0 }
  }

  log.info('直播间命中，准备叫醒', { room, lineLen: hit.length })
  const result = await wake(agent, cfg, `live-${crypto.createHash('sha256').update(hit).digest('hex').slice(0, 12)}`,
    composeLivePrompt({ biliPath: BILI_PATH, cfg, line: hit }))
  return {
    source: 'live',
    status: result.ok ? 'done' : result.status,
    code: result.ok ? 0 : (codeFor(result) || 1),
    event: result.eventId,
    message: result.message,
  }
}

function enabled(cfg) {
  const legacyOn = (key, fallback) => (flag('no-' + key) ? false : flag(key) ? true : fallback)
  return {
    dm: legacyOn('dm', cfg.listen?.dm !== false),
    comment: legacyOn('comment', cfg.listen?.comment === true),
    live: legacyOn('live', cfg.listen?.live === true),
  }
}

async function once(cfg, { host, liveTimeout, allowPending }) {
  // 平台暂停期里叫醒她只会让她白跑一趟（而且更容易撞风控）。
  const until = Number(trafficGuard().status()?.until ?? 0)
  if (until > Date.now()) {
    log.warn('平台保护暂停中，本轮不监听', { until: new Date(until).toISOString(), inMs: until - Date.now() })
    return [{ source: 'setup', status: 'paused', code: 0, message: `平台保护暂停到 ${new Date(until).toISOString()}` }]
  }

  const agent = makeAdapter(cfg, host)
  if (!agent.getState()) {
    log.warn('没有生活流会话，无法处理监听', { hint: '先跑 agent bootstrap' })
    return [{ source: 'setup', status: 'no_session', code: 2, message: '还没有生活流会话 —— 先跑 agent bootstrap' }]
  }
  const blocking = agent.pendingEvents().filter(e => ['unknown', 'in_flight'].includes(e.status))
  if (blocking.length && !allowPending) {
    log.warn('有未收敛事件，先对账再监听', {
      count: blocking.length, events: blocking.map(e => e.eventId).join(','),
    })
    return [{
      source: 'setup', status: 'needs_reconcile', code: 1,
      message: `有未收敛事件，先 agent reconcile：${blocking.map(e => e.eventId).join(', ')}`,
    }]
  }

  const toggle = enabled(cfg)
  log.debug('本轮监听开关', { dm: toggle.dm, comment: toggle.comment, live: toggle.live })
  const results = []
  if (toggle.dm) results.push(await dmCycle(agent, cfg))
  if (toggle.comment) results.push(await commentCycle(agent, cfg))
  if (toggle.live) results.push(await liveCycle(agent, cfg, liveTimeout))
  if (!results.length) results.push({ source: 'setup', status: 'idle', code: 0, message: '所有监听都关着' })
  return results
}

function render(results) {
  if (json) {
    console.log(JSON.stringify({ ok: results.every(r => r.code === 0), results }, null, 2))
    return
  }
  for (const r of results) {
    const tail = r.status === 'done' ? ` · event=${r.event}` : (r.message ? ` · ${r.message}` : '')
    console.log(`[${r.source}] ${r.status}${tail}`)
  }
}

async function main() {
  if (flag('help') || argv[0] === 'help') {
    console.log([
      '用法: node bili.mjs listen [--once|--daemon] [--json]',
      '  --dm / --no-dm           私信监听（默认跟配置 listen.dm）',
      '  --comment / --no-comment 评论收件箱（默认跟配置 listen.comment）',
      '  --live / --no-live       直播间（默认跟配置 listen.live，需要 listen.liveRoom）',
      '  --interval 60            daemon 轮询间隔（同时作为直播单次值守秒数）',
      '  --allow-pending          有未收敛事件也继续（默认拒绝，先 reconcile）',
      '  --host hermes|openclaw   覆盖配置里的宿主',
    ].join('\n'))
    return 0
  }

  const cfg = config()
  const host = option('host')
  const allowPending = flag('allow-pending')
  const interval = Math.max(15, Number(option('interval') ?? cfg.listen?.dmIntervalSec ?? 60))

  if (!flag('daemon')) {
    const results = await once(cfg, { host, liveTimeout: interval, allowPending })
    render(results)
    return Math.max(...results.map(r => r.code))
  }

  let stopping = false
  const stop = () => { stopping = true }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  log.info('daemon 启动', { intervalSec: interval, host: host || cfg.agent?.host || 'hermes' })
  const liveOn = enabled(cfg).live
  while (!stopping) {
    const results = await once(config(), { host, liveTimeout: interval, allowPending })
    render(results)
    if (stopping) break
    const waitMs = liveOn ? 2000 : interval * 1000
    log.debug('daemon 休眠', { waitMs, statuses: results.map(r => `${r.source}:${r.status}`).join(',') })
    // 直播那一路自己已经值守了 interval 秒；没有直播就按 interval 轮询，别把接口问穿。
    await sleep(waitMs)
  }
  log.info('daemon 退出')
  return 0
}

try {
  process.exitCode = await main()
} catch (e) {
  const code = String(e?.code ?? '')
  log.error('未捕获异常，本轮中止', { error: e?.message ?? String(e), code: code || null })
  if (json) console.log(JSON.stringify({ ok: false, error: e?.message ?? String(e) }, null, 2))
  else console.error('✗ ' + (e?.message ?? String(e)))
  process.exitCode = code === 'config' ? 2 : 3
}
