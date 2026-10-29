// 宿主 agent 命令（Phase 3 · Hermes L1）。
//
//   node bili.mjs agent bootstrap [--handover] [--json]
//   node bili.mjs agent wake [--plan-id <id>] [--prompt <文本>] [--allow-pending] [--json]
//   node bili.mjs agent reconcile [--event <id>] [--reason <原因>] [--json]
//   node bili.mjs agent status | pending | rotate
//
// 为什么单独一个命令：调度（cron/systemd/tick）不该关心宿主 API 细节，
// 它只需要问"现在该不该叫醒她"和"叫醒是否成功"。这里把会话、幂等、对账收在一处。
//
// 退出码：0 成功；1 部分完成 / 结果未知 / 有待对账事件；2 参数或配置错误；3 失败。
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../lib/config.mjs'
import { BILI_WHALE_HOME } from '../lib/paths.mjs'
import { makeAdapter, codeFor, summarize } from '../lib/agent-factory.mjs'
import {
  composeBootstrapPrompt,
  composeWakePrompt,
  composeReconcilePrompt,
} from '../lib/agent-prompts.mjs'

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const flag = (name) => argv.includes('--' + name)
const option = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined }
const BILI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bili.mjs')
const TITLE = '有日子的鱼 · 生活流'

function out(text) { if (!json) console.log(text) }
function finish(code, payload) {
  if (json) console.log(JSON.stringify(payload, null, 2))
  process.exit(code)
}
function fail(code, message) {
  if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2))
  else console.error('✗ ' + message)
  process.exit(code)
}

async function main() {
  const cmd = argv[0]
  const cfg = config()
  const dataHome = BILI_WHALE_HOME

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log([
      '用法: node bili.mjs agent <子命令> [参数] [--host hermes|openclaw]',
      '',
      '  bootstrap   建会话/恢复固定会话，读日记报到              [--handover] [--json]',
      '  wake        叫醒她跑一轮                                 [--plan-id id] [--prompt 文本] [--allow-pending] [--timeout-ms N]',
      '  reconcile   中断对账                                 [--event id] [--reason 原因]',
      '  status      看会话状态与待对账数量',
      '  pending     列出未收敛事件（有则退出码 1）',
      '  rotate      手动升代（旧会话保留只读）                [--reason 原因]',
    ].join('\n'))
    return 0
  }

  let agent
  try { agent = makeAdapter(cfg, option('host')) } catch (e) {
    if (e?.code === 'config') fail(2, e.message)
    throw e
  }

  if (cmd === 'status') {
    const state = agent.getState()
    const pending = agent.pendingEvents()
    if (json) {
      finish(0, { ok: true, state, pending })
      return 0
    }
    if (!state) { console.log('还没有生活流会话 —— 先跑 `agent bootstrap`'); return 0 }
    console.log(`宿主      : ${state.host ?? 'hermes'}${state.transport ? ` · ${state.transport}` : ''}`)
    console.log(`会话      : ${state.sessionId}`)
    console.log(`代次      : g${state.generation ?? 1}`)
    console.log(`已报到    : ${state.bootstrapped ? '是' : '否'}`)
    console.log(`上一轮    : ${state.lastTurnAt ?? '还没跑过'}`)
    console.log(`待对账    : ${pending.length} 条${pending.length ? '（' + pending.map(p => p.eventId).join(', ') + '）' : ''}`)
    return 0
  }

  if (cmd === 'pending') {
    const pending = agent.pendingEvents()
    if (json) { finish(pending.length ? 1 : 0, { ok: pending.length === 0, pending }); return 0 }
    if (!pending.length) { console.log('没有待对账事件'); return 0 }
    for (const row of pending) console.log(`${row.eventId}  ${row.status}  ${row.kind ?? ''}  ${row.at ?? ''}`)
    return 1
  }

  if (cmd === 'bootstrap') {
    const state = agent.getState()
    const handover = flag('handover')
    const installId = state?.installId || crypto.randomUUID()
    const generation = handover ? Number(state?.generation ?? 0) + 1 : Number(state?.generation ?? 1)
    const handoverPrompt = composeBootstrapPrompt({
      dataHome, biliPath: BILI_PATH, cfg, generation,
      reason: handover ? 'manual_handover' : 'resume', handover: true,
    })
    const result = await agent.ensureSession({
      ...(handover ? {} : {
        bootstrapPrompt: composeBootstrapPrompt({
          dataHome, biliPath: BILI_PATH, cfg, generation,
          reason: state ? 'resume' : 'cold_start',
        }),
      }),
      ...(handover ? { handoverPrompt } : {}),
      installId,
      force: handover,
      title: TITLE,
    })
    const latest = result.state ?? agent.getState()
    const code = result.bootstrap ? codeFor(result.bootstrap) : 0
    if (json) {
      finish(code, {
        ok: code === 0,
        state: latest,
        bootstrap: result.bootstrap ?? null,
        handover: latest?.handover ?? null,
      })
    }
    out(`会话 ${latest.sessionId}（g${latest.generation ?? 1}）${latest.bootstrapped ? ' · 已报到' : ''}`)
    if (result.bootstrap) out(summarize(result.bootstrap))
    if (latest.handover) out(summarize(latest.handover))
    return code
  }

  if (cmd === 'wake') {
    const state = agent.getState()
    if (!state) fail(2, '还没有生活流会话 —— 先跑 `agent bootstrap`')
    if (!flag('allow-pending')) {
      const blocking = agent.pendingEvents().filter(e => ['unknown', 'in_flight'].includes(e.status))
      if (blocking.length) {
        fail(3, `有未收敛事件，先对账再唤醒：${blocking.map(e => e.eventId).join(', ')}（或加 --allow-pending）`)
      }
    }
    const planId = option('plan-id') || `wake-${Date.now()}`
    const prompt = option('prompt') || composeWakePrompt({ dataHome, biliPath: BILI_PATH, cfg, planId })
    const timeoutMs = Number(option('timeout-ms')) || agent.turnTimeoutMs || undefined
    const result = await agent.wake({
      planId,
      prompt,
      timeoutMs,
      handoverPrompt: composeBootstrapPrompt({
        dataHome, biliPath: BILI_PATH, cfg,
        generation: Number(state.generation ?? 1) + 1, reason: 'session_not_found', handover: true,
      }),
      title: TITLE,
    })
    if (json) finish(codeFor(result), { ok: result.ok, planId, result })
    out(`plan ${planId} · ${summarize(result)}`)
    const reply = result.content ?? result.text
    if (reply) out('\n' + String(reply).trim())
    return codeFor(result)
  }

  if (cmd === 'reconcile') {
    const pending = agent.pendingEvents()
    const eventId = option('event') || pending.at(-1)?.eventId
    const reason = option('reason') || pending.at(-1)?.status || 'unknown'
    const prompt = option('prompt') || composeReconcilePrompt({
      dataHome, biliPath: BILI_PATH, pendingEventId: eventId || 'unknown', reason,
    })
    const result = await agent.reconcile({ pendingEventId: eventId || 'unknown', reason, prompt })
    if (json) finish(codeFor(result), { ok: result.ok, eventId: eventId || 'unknown', reason, result })
    out(summarize(result))
    const reply = result.content ?? result.text
    if (reply) out('\n' + String(reply).trim())
    return codeFor(result)
  }

  if (cmd === 'rotate') {
    const state = await agent.rotate({
      reason: option('reason') || 'manual',
      handoverPrompt: composeBootstrapPrompt({
        dataHome, biliPath: BILI_PATH, cfg,
        generation: Number(agent.getState()?.generation ?? 1) + 1,
        reason: option('reason') || 'manual', handover: true,
      }),
      title: TITLE,
    })
    if (json) finish(0, { ok: true, state: { ...state, handover: undefined }, handover: state.handover ?? null })
    out(`已升代到 g${state.generation}（${state.sessionId}）`)
    if (state.handover) out(summarize(state.handover))
    return 0
  }

  fail(2, `未知子命令：${cmd}（试 agent help）`)
}

try {
  process.exitCode = await main()
} catch (e) {
  const code = String(e?.code ?? '')
  fail((code === 'config' || code.startsWith('invalid')) ? 2 : 3, e?.message ?? String(e))
}
