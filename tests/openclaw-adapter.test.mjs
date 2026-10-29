// Phase 4（通用 skill 移植）回归：OpenClaw 适配器。
//
// 本机没有 OpenClaw 实例，这里用一个假 CLI 覆盖能确定的契约：
// 参数形态（--session-id / --json / --timeout）、本地幂等、升代重试、超时标记 unknown。
// 真实的技能加载与端到端冒烟留给用户真机（P4.5 后半）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OpenClawAdapter } from '../tools/lib/openclaw-adapter.mjs'
import { writeMockCli } from './fixtures/openclaw-cli.mjs'

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-openclaw-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const log = path.join(dir, 'cli.log')
  const previous = process.env.MOCK_OPENCLAW_LOG
  process.env.MOCK_OPENCLAW_LOG = log
  t.after(() => {
    if (previous === undefined) delete process.env.MOCK_OPENCLAW_LOG
    else process.env.MOCK_OPENCLAW_LOG = previous
  })
  return {
    dir,
    log,
    stateDir: path.join(dir, 'state'),
    bin: writeMockCli(dir),
    calls() {
      if (!fs.existsSync(log)) return []
      return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    },
  }
}

const make = (box, extra = {}) => new OpenClawAdapter({
  bin: box.bin,
  ownerMid: '123',
  stateDir: box.stateDir,
  turnTimeoutMs: 10000,
  ...extra,
})

test('openclaw: bootstrap 落独立状态文件，CLI 带 --session-id 与 --json', async (t) => {
  const box = sandbox(t)
  const adapter = make(box)

  const { state, bootstrap } = await adapter.ensureSession({ bootstrapPrompt: '开始生活' })
  assert.equal(state.sessionId, 'bw-123-life-g1')
  assert.equal(state.host, 'openclaw')
  assert.equal(state.bootstrapped, true)
  assert.equal(bootstrap.status, 'done')
  assert.equal(bootstrap.content, 'OK bw-123-life-g1')

  const file = path.join(box.stateDir, 'agent-session-openclaw.json')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).generation, 1)
  // 与 Hermes 的状态文件互不覆盖
  assert.equal(fs.existsSync(path.join(box.stateDir, 'agent-session.json')), false)

  const [call] = box.calls()
  assert.deepEqual(call.argv.slice(0, 5), ['agent', '--session-id', 'bw-123-life-g1', '--message', '开始生活'])
  assert.ok(call.argv.includes('--json'))
  assert.ok(call.argv.includes('--timeout'))
})

test('openclaw: 同一 planId 只执行一次（本地账本去重）', async (t) => {
  const box = sandbox(t)
  const adapter = make(box)
  await adapter.ensureSession({ bootstrapPrompt: '开始生活' })

  const first = await adapter.wake({ planId: 'p1', prompt: '醒了' })
  const second = await adapter.wake({ planId: 'p1', prompt: '醒了' })
  assert.equal(first.status, 'done')
  assert.equal(second.cached, true)
  assert.equal(box.calls().length, 2)   // bootstrap + 一次 wake
  assert.equal(adapter.getState().lastEventId, 'wake-p1')
})

test('openclaw: 识别 session not found，升代后重试一次', async (t) => {
  const box = sandbox(t)
  const adapter = make(box)
  await adapter.ensureSession({ bootstrapPrompt: '开始生活' })

  const result = await adapter.wake({ planId: 'p2', prompt: 'GONE 这一轮会撞失效会话' })
  assert.equal(result.status, 'done')
  assert.equal(result.sessionId, 'bw-123-life-g2')

  const state = adapter.getState()
  assert.equal(state.generation, 2)
  assert.equal(state.rotatedFrom, 'bw-123-life-g1')
  const sessions = box.calls().map(c => c.sessionId)
  assert.deepEqual(sessions, ['bw-123-life-g1', 'bw-123-life-g1', 'bw-123-life-g2'])
})

test('openclaw: 超时标记 unknown 并留在待对账里；非零退出算失败', async (t) => {
  const box = sandbox(t)
  const adapter = make(box, { turnTimeoutMs: 400 })
  await adapter.ensureSession({ bootstrapPrompt: '开始生活' })

  const slow = await adapter.wake({ planId: 'slow', prompt: 'SLOW 这轮会超时' })
  assert.equal(slow.status, 'unknown')
  assert.equal(slow.code, 'timeout')
  const pending = adapter.pendingEvents().map(e => e.eventId)
  assert.ok(pending.includes('wake-slow'), pending.join(','))

  const boom = await adapter.wake({ planId: 'boom', prompt: 'BOOM 这轮会失败' })
  assert.equal(boom.status, 'failed')
  assert.match(boom.message, /model unavailable|会话/)
})

test('openclaw: sessionMode=agent 用 --agent 且强制要求 agentId', async (t) => {
  const box = sandbox(t)
  assert.throws(() => make(box, { mode: 'agent' }), /agentId/)

  const adapter = make(box, { mode: 'agent', agentId: 'ops' })
  await adapter.ensureSession({ bootstrapPrompt: '开始生活' })
  const [call] = box.calls()
  assert.equal(call.agent, 'ops')
  assert.ok(!call.argv.includes('--session-id'))
})
