// Phase 3（通用 skill 移植）回归：agent 命令 + 本地 mock Hermes API。
//
// 为什么用真 CLI + 本地 http server：适配器内部用 fetch 发请求，跨进程 mock fetch 很别扭；
// 起一个真端口，既验证了参数解析和退出码，也验证了真实 HTTP 头（Session-Id / Idempotency-Key）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { composeWakePrompt } from '../tools/lib/agent-prompts.mjs'
import { writeMockCli } from './fixtures/openclaw-cli.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-agent-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 起一个只回 JSON 的 Hermes mock；handler 收到解析后的请求，返回 { status, body, headers }。 */
async function startServer(t, handler) {
  const seen = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const entry = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      }
      seen.push(entry)
      const out = handler(entry) || { status: 404, body: { error: { code: 'not_found' } } }
      res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers || {}) })
      res.end(JSON.stringify(out.body ?? {}))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return { base: `http://127.0.0.1:${server.address().port}`, seen }
}

const okSession = (id) => ({ status: 200, body: { session: { id, source: 'api_server' } } })
const okTurn = (content = 'READY') => ({
  status: 200,
  body: { choices: [{ message: { content }, finish_reason: 'stop' }], usage: { total_tokens: 5 } },
})
const created = { status: 201, body: { ok: true } }

function setup(t, base, overrides = {}) {
  const dir = tempDir(t)
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  const cfg = {
    owner: { mid: '123', name: '主人' },
    agent: { host: 'hermes', baseUrl: base, timeoutMs: 5000, sessionDir: path.join(dir, 'state') },
    ...overrides,
  }
  fs.writeFileSync(path.join(home, 'bili-whale.config.json'), JSON.stringify(cfg))
  return { dir, home, stateDir: cfg.agent.sessionDir }
}

// 必须异步 spawn：mock server 跑在本进程里，spawnSync 会锁住事件循环导致请求超时。
function runAgent({ home, dir }, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools/bili.mjs'), 'agent', ...args], {
      env: {
        ...process.env,
        HOME: dir,
        USERPROFILE: dir,
        BILI_WHALE_HOME: home,
        BILI_WHALE_CONFIG: '',
        BILI_WHALE_STATE_DIR: '',
        // 适配器只认这几个键；清掉开发机上可能存在的真实配置
        BILI_WHALE_HERMES_BASE: '',
        HERMES_API_BASE: '',
        BILI_WHALE_HERMES_KEY: '',
        HERMES_API_KEY: '',
        API_SERVER_KEY: 'test-key',
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', c => { stdout += c })
    child.stderr.on('data', c => { stderr += c })
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

const parseJson = (r) => {
  try { return JSON.parse(r.stdout) } catch { return null }
}

const hermesOk = (entry) => {
  if (entry.method === 'POST' && entry.url === '/api/sessions') return created
  if (entry.method === 'GET' && entry.url.startsWith('/api/sessions/')) {
    return okSession(decodeURIComponent(entry.url.split('/').pop()))
  }
  if (entry.method === 'POST' && entry.url === '/v1/chat/completions') return okTurn()
  return null
}

test('agent: bootstrap 建会话 → status 已报到 → wake 带固定 Session-Id 与幂等键', async (t) => {
  const { base, seen } = await startServer(t, hermesOk)
  const env = setup(t, base)

  const boot = await runAgent(env, 'bootstrap', '--json')
  assert.equal(boot.status, 0, boot.stdout + boot.stderr)
  const booted = parseJson(boot)
  assert.equal(booted.state.sessionId, 'bw-123-life-g1')
  assert.equal(booted.state.bootstrapped, true)
  const stateFile = path.join(env.stateDir, 'agent-session.json')
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessionId, 'bw-123-life-g1')

  const status = await runAgent(env, 'status', '--json')
  assert.equal(status.status, 0, status.stderr)
  assert.equal(parseJson(status).state.bootstrapped, true)

  const wake = await runAgent(env, 'wake', '--plan-id', 'p1', '--json')
  assert.equal(wake.status, 0, wake.stdout + wake.stderr)
  const turn = seen.filter(r => r.url === '/v1/chat/completions').at(-1)
  assert.equal(turn.headers['x-hermes-session-id'], 'bw-123-life-g1')
  assert.equal(turn.headers['idempotency-key'], 'wake-p1')
  // 只发最后一条：历史靠 Session-Id 由服务端从 state.db 读
  assert.equal(turn.body.messages.length, 1)

  const pending = await runAgent(env, 'pending', '--json')
  assert.equal(pending.status, 0, pending.stdout)
  assert.deepEqual(parseJson(pending).pending, [])
})

test('agent: 有 unknown 事件时拒绝唤醒，--allow-pending 才放行', async (t) => {
  const { base } = await startServer(t, hermesOk)
  const env = setup(t, base)
  assert.equal((await runAgent(env, 'bootstrap')).status, 0)

  fs.appendFileSync(
    path.join(env.stateDir, 'agent-delivery.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), eventId: 'wake-ghost', kind: 'wake', status: 'unknown' }) + '\n',
  )

  const blocked = await runAgent(env, 'wake', '--plan-id', 'p2')
  assert.equal(blocked.status, 3, blocked.stdout + blocked.stderr)
  assert.match(blocked.stderr, /未收敛|对账/)

  const list = await runAgent(env, 'pending', '--json')
  assert.equal(list.status, 1)
  assert.equal(parseJson(list).pending[0].eventId, 'wake-ghost')

  const allowed = await runAgent(env, 'wake', '--plan-id', 'p3', '--allow-pending', '--json')
  assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr)
})

test('agent: wake 撞 404 自动升代到 g2，旧会话保留只读', async (t) => {
  let gone = false
  const { base, seen } = await startServer(t, (entry) => {
    if (entry.method === 'POST' && entry.url === '/v1/chat/completions') {
      const sid = entry.headers['x-hermes-session-id'] || ''
      if (gone && sid.endsWith('-g1')) {
        return { status: 404, body: { error: { code: 'session_not_found', message: 'gone' } } }
      }
      return okTurn('READY')
    }
    return hermesOk(entry)
  })
  const env = setup(t, base)
  assert.equal((await runAgent(env, 'bootstrap')).status, 0)
  gone = true

  const wake = await runAgent(env, 'wake', '--plan-id', 'p9', '--json')
  assert.equal(wake.status, 0, wake.stdout + wake.stderr)

  const state = JSON.parse(fs.readFileSync(path.join(env.stateDir, 'agent-session.json'), 'utf8'))
  assert.equal(state.generation, 2)
  assert.equal(state.sessionId, 'bw-123-life-g2')
  assert.equal(state.rotatedFrom, 'bw-123-life-g1')

  const creates = seen.filter(r => r.method === 'POST' && r.url === '/api/sessions').map(r => r.body.id)
  assert.deepEqual(creates, ['bw-123-life-g1', 'bw-123-life-g2'])
  const retry = seen.filter(r => r.url === '/v1/chat/completions').at(-1)
  assert.equal(retry.headers['x-hermes-session-id'], 'bw-123-life-g2')
  assert.equal(retry.headers['idempotency-key'], 'wake-p9')   // 重试复用同一个键
})

test('agent: 配置/参数错误走退出码 2', async (t) => {
  const { base } = await startServer(t, hermesOk)
  const noSession = setup(t, base)
  const early = await runAgent(noSession, 'wake')
  assert.equal(early.status, 2, early.stderr)
  assert.match(early.stderr, /bootstrap/)

  const badHost = setup(t, base, { agent: { host: 'foo', baseUrl: base, sessionDir: path.join(tempDir(t), 's') } })
  const other = await runAgent(badHost, 'status')
  assert.equal(other.status, 2, other.stderr)
  assert.match(other.stderr, /只支持 hermes \| openclaw/)
})

test('agent: --host openclaw 路由到 CLI 适配器，状态文件与 Hermes 分开', async (t) => {
  const { base } = await startServer(t, hermesOk)
  const dir = tempDir(t)
  const log = path.join(dir, 'cli.log')
  process.env.MOCK_OPENCLAW_LOG = log
  t.after(() => { delete process.env.MOCK_OPENCLAW_LOG })

  const env = setup(t, base, {
    agent: {
      host: 'hermes',   // 配置里仍是 hermes，靠 --host 覆盖
      baseUrl: base,
      sessionDir: path.join(dir, 'state'),
      openclaw: { bin: writeMockCli(dir), sessionMode: 'session-id' },
    },
  })

  const boot = await runAgent(env, 'bootstrap', '--host', 'openclaw', '--json')
  assert.equal(boot.status, 0, boot.stdout + boot.stderr)
  assert.equal(parseJson(boot).state.host, 'openclaw')
  assert.ok(fs.existsSync(path.join(dir, 'state', 'agent-session-openclaw.json')))
  assert.equal(fs.existsSync(path.join(dir, 'state', 'agent-session.json')), false)

  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  assert.equal(calls[0].sessionId, 'bw-123-life-g1')
  assert.ok(calls[0].argv.includes('--json'))
})

test('prompts: wake 提示词按 share.via 二选一，命令用绝对路径', () => {
  const base = { dataHome: '/data', biliPath: '/opt/bili-whale/scripts/bili.mjs' }
  const comment = composeWakePrompt({ ...base, cfg: { share: { via: 'comment' }, night: { maxVideos: 6 } } })
  assert.match(comment, /comment --share/)
  assert.doesNotMatch(comment, /dm --msg/)
  assert.match(comment, /node "\/opt\/bili-whale\/scripts\/bili\.mjs" feed --n 6/)

  const dm = composeWakePrompt({ ...base, cfg: { share: { via: 'dm' } } })
  assert.match(dm, /dm --msg/)
  assert.doesNotMatch(dm, /comment --share/)
  // 评论区监听默认关，只有开启时才加 digest 步骤
  assert.doesNotMatch(dm, /comment-digest/)
  assert.match(composeWakePrompt({ ...base, cfg: { listen: { comment: true } } }), /comment-digest/)

  // 仓库内跑时，references 要解析成绝对路径（agent 的 cwd 不确定）
  const real = composeWakePrompt({ dataHome: '/data', biliPath: path.join(ROOT, 'tools/bili.mjs') })
  assert.match(real, new RegExp(path.join(ROOT, 'skill/references/scoring.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})
