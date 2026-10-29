import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HermesAdapter } from '../tools/lib/agent-adapter.mjs'

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function makeAdapter(handler, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-adapter-'))
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null
    const req = {
      url: String(url),
      init,
      body,
      headers: new Headers(init.headers || {}),
    }
    calls.push(req)
    return handler(req)
  }
  const adapter = new HermesAdapter({
    ownerMid: '123456',
    apiKey: 'test-key',
    baseUrl: 'http://127.0.0.1:8642',
    stateDir: dir,
    fetchImpl,
    sleep: async () => {},
    logger: { info() {}, warn() {}, error() {} },
    ...options,
  })
  return { adapter, calls, dir }
}

function successHandler(req) {
  const p = new URL(req.url).pathname
  if (p.endsWith('/api/sessions') && req.init.method === 'POST') {
    return jsonResponse({ session: { id: 'created', source: 'api_server' } }, 201)
  }
  if (p.endsWith('/v1/chat/completions')) {
    return jsonResponse({
      choices: [{ message: { content: 'READY' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })
  }
  return jsonResponse({ error: { message: `unexpected ${p}` } }, 500)
}

test('冷启动：创建 API 会话并发送 bootstrap 回合', async t => {
  const { adapter, calls, dir } = makeAdapter(successHandler)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const { state, bootstrap } = await adapter.ensureSession({
    bootstrapPrompt: 'BOOT',
    installId: 'inst-1',
  })

  assert.equal(bootstrap.status, 'done')
  assert.equal(state.bootstrapped, true)
  assert.equal(state.sessionId, 'bw-123456-life-g1')
  assert.equal(calls.length, 2)

  const create = calls[0]
  assert.equal(create.init.method, 'POST')
  assert.match(create.url, /\/api\/sessions$/)
  assert.equal(create.body.id, 'bw-123456-life-g1')

  const turn = calls[1]
  assert.match(turn.url, /\/v1\/chat\/completions$/)
  assert.equal(turn.headers.get('x-hermes-session-id'), 'bw-123456-life-g1')
  assert.equal(turn.headers.get('idempotency-key'), 'bootstrap-inst-1-g1')
  assert.deepEqual(turn.body.messages, [{ role: 'user', content: 'BOOT' }])

  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'agent-session.json'), 'utf8'))
  assert.equal(saved.bootstrapped, true)
  assert.equal(saved.installId, 'inst-1')
})

test('唤醒：复用固定 session，且只发送本轮新增内容', async t => {
  const { adapter, calls, dir } = makeAdapter(successHandler)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  await adapter.ensureSession({ bootstrapPrompt: 'BOOT', installId: 'inst-1' })
  calls.length = 0

  const result = await adapter.wake({ planId: 'plan-1', prompt: 'WAKE' })

  assert.equal(result.status, 'done')
  assert.equal(calls.length, 1)
  const req = calls[0]
  assert.equal(req.headers.get('x-hermes-session-id'), 'bw-123456-life-g1')
  assert.equal(req.headers.get('idempotency-key'), 'wake-plan-1')
  assert.deepEqual(req.body.messages, [{ role: 'user', content: 'WAKE' }])
})

test('reconcile：幂等键稳定，提示词包含待对账事件', async t => {
  const { adapter, calls, dir } = makeAdapter(successHandler)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  await adapter.ensureSession({ bootstrapPrompt: 'BOOT', installId: 'inst-1' })
  calls.length = 0

  await adapter.reconcile({ pendingEventId: 'wake-plan-1', reason: 'timeout' })

  const req = calls[0]
  assert.equal(req.headers.get('idempotency-key'), 'reconcile-wake-plan-1-timeout')
  assert.match(req.body.messages[0].content, /RECONCILE_OK/)
  assert.match(req.body.messages[0].content, /wake-plan-1/)
})

test('会话被删：wake 自动升代并重投', async t => {
  let chatCount = 0
  const handler = req => {
    const p = new URL(req.url).pathname
    if (p.endsWith('/api/sessions') && req.init.method === 'POST') {
      return jsonResponse({ session: { id: 'created', source: 'api_server' } }, 201)
    }
    if (p.endsWith('/v1/chat/completions')) {
      chatCount++
      if (chatCount === 1) {
        return jsonResponse({ choices: [{ message: { content: 'READY' }, finish_reason: 'stop' }] })
      }
      if (chatCount === 2) {
        return jsonResponse({ error: { code: 'not_found', message: 'session not found' } }, 404)
      }
      return jsonResponse({ choices: [{ message: { content: 'WAKE OK' }, finish_reason: 'stop' }] })
    }
    return jsonResponse({ error: { message: `unexpected ${p}` } }, 500)
  }
  const { adapter, calls, dir } = makeAdapter(handler)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  await adapter.ensureSession({ bootstrapPrompt: 'BOOT', installId: 'inst-1' })
  const result = await adapter.wake({ planId: 'plan-1', prompt: 'WAKE' })

  assert.equal(result.status, 'done')
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'agent-session.json'), 'utf8'))
  assert.equal(state.generation, 2)
  assert.equal(state.sessionId, 'bw-123456-life-g2')
  assert.equal(state.bootstrapped, false)

  const wakeCalls = calls.filter(c => c.headers.get('idempotency-key')?.startsWith('wake-'))
  assert.equal(wakeCalls.length, 2)
  assert.equal(wakeCalls[0].headers.get('x-hermes-session-id'), 'bw-123456-life-g1')
  assert.equal(wakeCalls[1].headers.get('x-hermes-session-id'), 'bw-123456-life-g2')
})

test('unknown_execution：标记 unknown，不换 key 重发', async t => {
  const handler = req => {
    const p = new URL(req.url).pathname
    if (p.endsWith('/api/sessions') && req.init.method === 'POST') {
      return jsonResponse({ session: { id: 'created', source: 'api_server' } }, 201)
    }
    if (p.endsWith('/v1/chat/completions')) {
      if (req.headers.get('idempotency-key')?.startsWith('bootstrap-')) {
        return jsonResponse({ choices: [{ message: { content: 'READY' }, finish_reason: 'stop' }] })
      }
      return jsonResponse({ error: { code: 'unknown_execution', message: 'turn may have executed' } }, 409)
    }
    return jsonResponse({ error: { message: `unexpected ${p}` } }, 500)
  }
  const { adapter, dir } = makeAdapter(handler)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  await adapter.ensureSession({ bootstrapPrompt: 'BOOT', installId: 'inst-1' })
  const result = await adapter.wake({ planId: 'plan-1', prompt: 'WAKE' })

  assert.equal(result.status, 'unknown')
  assert.equal(result.code, 'unknown_execution')
  assert.ok(adapter.pendingEvents().some(row => row.eventId === 'wake-plan-1'))
})

test('非法幂等键在发请求前就被拒绝', async t => {
  const { adapter, calls, dir } = makeAdapter(successHandler)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  await adapter.ensureSession({ bootstrapPrompt: 'BOOT', installId: 'inst-1' })
  calls.length = 0

  await assert.rejects(
    () => adapter.turn({ eventId: 'bad key', text: 'x' }),
    /可见 ASCII/
  )
  assert.equal(calls.length, 0)
})
