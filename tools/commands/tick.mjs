// 生物钟 tick（Phase 5）：cron / systemd 每分钟问一次“现在该不该叫她”。
//
// 只做三件事：按作息判断该不该醒、启动时把中断的回合对账掉、把提示词投给宿主。
// 不选题、不碰 B 站接口、不写日记 —— 那些是 agent 回合里的事。
//
//   node bili.mjs tick --once [--dry] [--force] [--json] [--host hermes|openclaw] [--no-reconcile]
//   node bili.mjs tick --daemon
//
// 退出码：0 不需要动作 / 已完成；1 结果未知或仍有待对账；2 配置或参数错误；3 失败。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../lib/config.mjs'
import { BILI_WHALE_HOME, whalePath } from '../lib/paths.mjs'
import { readNightConfig } from '../lib/night-config.mjs'
import { makePlan, completePlan } from '../lib/night-plan.mjs'
import { makeAdapter, codeFor } from '../lib/agent-factory.mjs'
import {
  composeBootstrapPrompt,
  composeWakePrompt,
  composeSkipPrompt,
  composeReconcilePrompt,
} from '../lib/agent-prompts.mjs'
import { logTurn } from '../lib/wake-log.mjs'
import { acquireProcessLock } from '../lib/process-lock.mjs'
import { trafficGuard } from '../lib/traffic.mjs'
import { createLogger } from '../lib/logger.mjs'

const log = createLogger('tick')

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const flag = (name) => argv.includes('--' + name)
const option = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined }

const BILI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bili.mjs')
const STATE = whalePath('whale-night.json')
const TITLE = '有日子的鱼 · 生活流'
const DEFAULT_COOLDOWN_MIN = 8      // 一轮通常 3–6 分钟，结束后至少歇 8 分钟
const MAX_RECONCILE = 3             // 每次最多补 3 条，避免一次 tick 拖太久

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function readState() {
  try {
    const value = JSON.parse(fs.readFileSync(STATE, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true })
  const tmp = `${STATE}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
    fs.renameSync(tmp, STATE)
  } finally {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 已 rename */ }
  }
}

/** 启动恢复：把 in_flight / unknown 的回合补一次对账，补不干净就不唤醒。 */
async function reconcilePending(agent, { dry, host }) {
  const pending = agent.pendingEvents()
    .filter(row => ['unknown', 'in_flight'].includes(row.status))
    .slice(0, MAX_RECONCILE)
  if (!pending.length) {
    log.debug('启动检查：没有未收敛事件')
    return { attempted: 0, left: 0 }
  }
  log.info('发现未收敛事件，准备对账', {
    count: pending.length, events: pending.map(row => row.eventId).join(','), dry,
  })
  if (dry) return { attempted: pending.length, left: pending.length, dry: true }

  for (const row of pending) {
    log.info('开始对账', { event: row.eventId, status: row.status, reason: 'startup' })
    const result = await agent.reconcile({
      pendingEventId: row.eventId,
      reason: 'startup',
      prompt: composeReconcilePrompt({
        dataHome: BILI_WHALE_HOME, biliPath: BILI_PATH,
        pendingEventId: row.eventId, reason: 'startup',
      }),
    })
    logTurn({
      source: 'reconcile', host, event: result.eventId ?? row.eventId,
      status: result.status, code: result.code, durationMs: result.durationMs, usage: result.usage,
    })
    const summary = {
      event: row.eventId, status: result.status, code: result.code,
      durationMs: result.durationMs,
    }
    if (result.ok) log.info('对账完成', summary)
    else {
      log.warn('对账未完成，本轮不再唤醒', { ...summary, message: result.message ?? null })
      break
    }
  }
  const left = agent.pendingEvents().filter(row => ['unknown', 'in_flight'].includes(row.status)).length
  return { attempted: pending.length, left }
}

async function cycle({ force, dry, host, reconcile }) {
  const cfg = config()
  const nowMs = Date.now()
  const hostLabel = host || cfg.agent?.host || 'hermes'
  log.info('开始一轮判断', { host: hostLabel, dry, force, reconcile })

  // 平台暂停优先：撞过 412/429 就老老实实等，别把唤醒排到暂停期里。
  const paused = trafficGuard().status()
  const until = Number(paused?.until ?? 0)
  if (until > nowMs) {
    log.warn('平台保护暂停中，本轮跳过', {
      until: new Date(until).toISOString(), inMs: until - nowMs,
      reason: paused?.reason ?? null, streak: paused?.streak ?? null,
    })
    return { action: 'paused', until: new Date(until).toISOString(), code: 0 }
  }

  const agent = makeAdapter(cfg, host)
  const session = agent.getState()
  if (reconcile && session) {
    const recovery = await reconcilePending(agent, { dry, host: session.host ?? host })
    if (recovery.left) {
      log.warn('仍有未收敛事件，本轮不唤醒', { left: recovery.left, attempted: recovery.attempted })
      return { action: 'needs_reconcile', left: recovery.left, attempted: recovery.attempted, code: 1 }
    }
  }

  const plan = makePlan(readNightConfig(), readState())
  writeState(plan)
  if (plan.action === 'done') {
    log.info('今天的机会都用完了', { reason: plan.reason ?? null })
    return { action: 'done', reason: plan.reason, code: 0 }
  }

  const due = force || nowMs >= Number(plan.atMs)
  if (!due) {
    const inMs = Math.max(0, Number(plan.atMs) - nowMs)
    log.info('还没到点，继续等', { at: plan.atText, inMs, window: plan.windowKey ?? plan.window ?? null })
    return { action: 'waiting', at: plan.atText, inMs, code: 0 }
  }

  if (!session) {
    log.warn('没有生活流会话，无法唤醒', { hint: '先跑 agent bootstrap' })
    return { action: 'no_session', message: '还没有生活流会话 —— 先跑 agent bootstrap', code: 2 }
  }

  // 冷却：上一轮刚结束就叫醒会把一天吵成两条时间线（也更容易撞风控）。
  const lastMs = Date.parse(session.lastTurnAt ?? '')
  const gapMin = Number(option('min-gap-min') ?? DEFAULT_COOLDOWN_MIN)
  if (!force && Number.isFinite(lastMs) && nowMs - lastMs < Math.max(1, gapMin) * 60_000) {
    const inMs = Math.max(1, gapMin) * 60_000 - (nowMs - lastMs)
    log.info('上一轮刚结束，冷却中', { inMs, lastTurnAt: session.lastTurnAt ?? null, gapMin })
    return { action: 'cooldown', inMs, code: 0 }
  }

  const planId = `tick-${plan.windowKey}-${plan.atMs}`
  log.info('到点，准备唤醒', {
    action: plan.action, planId, at: plan.atText, wakes: plan.wakes ?? null,
    generation: session.generation ?? null, sessionId: session.sessionId ?? null,
  })
  if (dry) {
    log.info('dry 模式：只判断不投递', { planId })
    return { action: plan.action, wouldWake: true, planId, at: plan.atText, code: 0 }
  }

  const prompt = plan.action === 'skip'
    ? composeSkipPrompt({
        dataHome: BILI_WHALE_HOME, biliPath: BILI_PATH, cfg,
        reason: plan.reason, atText: plan.atText,
      })
    : composeWakePrompt({
        dataHome: BILI_WHALE_HOME, biliPath: BILI_PATH, cfg,
        atText: plan.atText, planId,
      })

  const startedAt = Date.now()
  const result = await agent.wake({
    planId,
    prompt,
    handoverPrompt: composeBootstrapPrompt({
      dataHome: BILI_WHALE_HOME, biliPath: BILI_PATH, cfg,
      generation: Number(session.generation ?? 1) + 1,
      reason: 'session_not_found', handover: true,
    }),
    title: TITLE,
  })
  logTurn({
    source: 'tick', host: session.host ?? host,
    event: result.eventId ?? planId, status: result.status, code: result.code,
    durationMs: result.durationMs, generation: result.generation, usage: result.usage,
  })

  // 只有干净完成才消耗这次机会；超时/未知要留着让下一轮用同一个 planId 重试（幂等）。
  const summary = {
    planId, action: plan.action, status: result.status, code: result.code,
    durationMs: result.durationMs ?? Date.now() - startedAt,
    generation: result.generation ?? null, elapsedMs: Date.now() - startedAt,
  }
  if (result.ok) {
    const next = completePlan(plan)
    writeState(next)
    log.info('本轮完成，消耗一次机会', { ...summary, nextWakes: next.wakes ?? null })
  } else {
    log.warn('投递未确认，保留机会等下一轮重试', { ...summary, message: result.message ?? null })
  }
  return {
    action: plan.action,
    planId,
    status: result.status,
    code: codeFor(result),
    detail: result.message ?? null,
  }
}

function describe(out) {
  switch (out.action) {
    case 'paused': return `平台保护暂停中，等到 ${out.until}`
    case 'waiting': return `等她自然醒：${out.at}（还有 ${Math.round(out.inMs / 60000)} 分钟）`
    case 'done': return `今天不用再醒：${out.reason}`
    case 'cooldown': return `上一轮刚结束，${Math.ceil(out.inMs / 60000)} 分钟后再看`
    case 'needs_reconcile': return `还有 ${out.left} 条未收敛事件，先 reconcile（本次尝试 ${out.attempted} 条）`
    case 'no_session': return out.message
    case 'busy': return '另一个 tick 正在跑，跳过'
    default: return `本轮 ${out.action} · status=${out.status ?? '-'}${out.dry || out.wouldWake ? '（dry）' : ''}`
  }
}

function report(out) {
  if (json) console.log(JSON.stringify({ ok: (out.code ?? 0) === 0, ...out }, null, 2))
  else console.log(describe(out))
  return out.code ?? 0
}

/** 同一时刻只允许一个 tick；拿不到锁说明上一轮还在跑。 */
async function withLock(fn) {
  let release
  try {
    release = await acquireProcessLock(whalePath('locks', 'tick.lock'))
  } catch {
    log.warn('另一个 tick 正在跑，本轮跳过', { lock: whalePath('locks', 'tick.lock') })
    return { action: 'busy', code: 0 }
  }
  try { return await fn() } finally {
    try { await release() } catch { /* 释放失败不影响主结果 */ }
  }
}

async function main() {
  if (flag('help') || argv[0] === 'help') {
    console.log([
      '用法: node bili.mjs tick [--once|--daemon] [--dry] [--force] [--json]',
      '  --once     跑一次判断就退出（给 cron / systemd timer）',
      '  --daemon   常驻，自己按计划睡到下一轮（没有 systemd 时用）',
      '  --dry      只判断该不该醒，不投递',
      '  --force    忽略“还没到点”和冷却，立刻跑一轮（仍消耗一次机会）',
      '  --no-reconcile  启动时不自动对账',
      '  --host hermes|openclaw  覆盖配置里的宿主',
    ].join('\n'))
    return 0
  }

  const opts = {
    force: flag('force'),
    dry: flag('dry'),
    host: option('host'),
    reconcile: !flag('no-reconcile'),
  }

  if (!flag('daemon')) return report(await withLock(() => cycle(opts)))

  // daemon：每轮重新读配置，未到点就睡到计划时刻（最多 60 秒看一次）。
  let stopping = false
  const stop = () => { stopping = true }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  log.info('daemon 启动', { host: opts.host || config().agent?.host || 'hermes' })
  while (!stopping) {
    const out = await withLock(() => cycle(opts))
    report(out)
    if (stopping) break
    const waitMs = out.action === 'waiting' ? Math.min(60_000, Math.max(15_000, out.inMs)) : 60_000
    log.debug('daemon 休眠', { waitMs, after: out.action })
    await sleep(waitMs)
  }
  log.info('daemon 退出')
  return 0
}

try {
  process.exitCode = await main()
} catch (e) {
  const code = String(e?.code ?? '')
  const hint = code === 'config' ? 2 : 3
  log.error('未捕获异常，本轮中止', {
    error: e?.message ?? String(e), code: code || null, kind: code === 'config' ? 'config' : 'runtime',
  })
  if (json) console.log(JSON.stringify({ ok: false, error: e?.message ?? String(e) }, null, 2))
  else console.error('✗ ' + (e?.message ?? String(e)))
  process.exitCode = hint
}
