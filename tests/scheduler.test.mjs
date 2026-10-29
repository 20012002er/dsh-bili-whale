// Phase 5（通用 skill 移植）回归：tick（生物钟）与 listen（监听接线）。
//
// 用本地 mock Hermes + 临时 HOME，验证的是“判断逻辑与接线顺序”：
//   到点才投递、同一天不重复、冷却生效、启动对账、私信处理成功后才 ack。
// 真正跑满 24 小时的无重复分享，属于 Phase 6 干净机器验收。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

async function startServer(t, handler) {
  const seen = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const entry = {
        method: req.method, url: req.url, headers: req.headers,
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

const hermesOk = (entry) => {
  if (entry.method === 'POST' && entry.url === '/api/sessions') return { status: 201, body: { ok: true } }
  if (entry.method === 'GET' && entry.url.startsWith('/api/sessions/')) {
    return { status: 200, body: { session: { id: decodeURIComponent(entry.url.split('/').pop()), source: 'api_server' } } }
  }
  if (entry.method === 'POST' && entry.url === '/v1/chat/completions') {
    return { status: 200, body: { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] } }
  }
  return null
}

/** 24 小时窗口，确保 makePlan 一定能排出计划；wakes 控制一天几次。 */
function setupEnv(t, base, { wakes = 2, skipChance = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-tick-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(path.join(dir, '.bili-ai'), { recursive: true })
  fs.writeFileSync(path.join(home, 'bili-whale.config.json'), JSON.stringify({
    owner: { mid: '123', name: '主人' },
    night: { windows: [{ start: '00:00', end: '24:00', wakes }], skipChance, minGapMin: 0 },
    listen: { dm: true, comment: false, live: false },
    agent: { host: 'hermes', baseUrl: base, timeoutMs: 5000, sessionDir: path.join(dir, 'state') },
  }))
  const env = { dir, home, stateDir: path.join(dir, 'state') }
  return env
}

function runCli(env, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools/bili.mjs'), ...args], {
      env: {
        ...process.env,
        HOME: env.dir,
        USERPROFILE: env.dir,
        BILI_WHALE_HOME: env.home,
        BILI_WHALE_CONFIG: '',
        BILI_WHALE_STATE_DIR: '',
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
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000)
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
  })
}

const asJson = (r) => { try { return JSON.parse(r.stdout) } catch { return null } }
const nightState = (env) => JSON.parse(fs.readFileSync(path.join(env.home, 'whale-night.json'), 'utf8'))
const completions = (seen) => seen.filter(r => r.url === '/v1/chat/completions')

test('tick: 依次经历 到点判断 → 投递 → 冷却 → 等待下一轮', async (t) => {
  const { base, seen } = await startServer(t, hermesOk)
  const env = setupEnv(t, base, { wakes: 2 })
  assert.equal((await runCli(env, 'agent', 'bootstrap')).status, 0)
  const afterBoot = completions(seen).length   // bootstrap 那一轮

  // 计划时刻是窗口内随机抽的 → 这里用 --force 把“到点”这一条件确定下来，
  // 断言 dry 只判断不投递（真正的等待分支由末尾那次 waiting 覆盖）。
  const dry = await runCli(env, 'tick', '--once', '--dry', '--force', '--json')
  assert.equal(dry.status, 0, dry.stderr)
  const planned = asJson(dry)
  assert.equal(planned.action, 'wake')
  assert.equal(planned.wouldWake, true)
  assert.match(planned.planId, /^tick-\d{4}-\d{2}-\d{2}\|00:00–24:00-/)
  assert.equal(completions(seen).length, afterBoot)   // dry 不投递

  const fired = await runCli(env, 'tick', '--once', '--force', '--json')
  assert.equal(fired.status, 0, fired.stdout + fired.stderr)
  assert.equal(asJson(fired).status, 'done')
  assert.equal(completions(seen).length, afterBoot + 1)
  const state = nightState(env)
  assert.equal(state.fired, true)
  assert.equal(state.wakes, 1)

  // 冷却与 waiting 都依赖"计划时刻已到/未到"，而时刻是窗口内随机抽的 →
  // 直接塞一个待执行的计划，把时间条件固定下来。
  const seedPlan = (atMs) => {
    const day = new Date().toLocaleDateString('sv-SE')
    const key = `${day}|00:00–24:00`
    fs.writeFileSync(path.join(env.home, 'whale-night.json'), JSON.stringify({
      schema: 2, date: day, wakes: 1, usedCount: {}, skippedWindows: [],
      action: 'wake', fired: false, woke: false, atMs,
      atText: new Date(atMs).toLocaleString('zh-CN', { hour12: false }),
      window: '00:00–24:00', windowKey: key,
      startsAt: new Date(`${day}T00:00:00`).getTime(),
      endsAt: new Date(`${day}T00:00:00`).getTime() + 24 * 3600_000,
    }))
  }

  // 刚结束就叫醒 → 冷却拦住，且不消耗机会
  seedPlan(Date.now() - 60_000)
  const cooled = await runCli(env, 'tick', '--once', '--json')
  assert.equal(cooled.status, 0, cooled.stderr)
  assert.equal(asJson(cooled).action, 'cooldown')
  assert.equal(completions(seen).length, afterBoot + 1)
  assert.equal(nightState(env).wakes, 1)

  // 还没到点 → waiting，同样不投递
  seedPlan(Date.now() + 30 * 60_000)
  const waiting = await runCli(env, 'tick', '--once', '--json')
  assert.equal(asJson(waiting).action, 'waiting')
  assert.equal(completions(seen).length, afterBoot + 1)
})

test('tick: 一天的机会用完就 done，不再投递', async (t) => {
  const { base, seen } = await startServer(t, hermesOk)
  const env = setupEnv(t, base, { wakes: 1 })
  assert.equal((await runCli(env, 'agent', 'bootstrap')).status, 0)
  assert.equal((await runCli(env, 'tick', '--once', '--force')).status, 0)
  const count = completions(seen).length

  const done = await runCli(env, 'tick', '--once', '--json')
  assert.equal(done.status, 0, done.stderr)
  assert.equal(asJson(done).action, 'done')
  assert.equal(completions(seen).length, count)
})

test('tick: 启动时把 unknown 事件对账掉，然后才唤醒', async (t) => {
  const { base, seen } = await startServer(t, hermesOk)
  const env = setupEnv(t, base, { wakes: 2 })
  assert.equal((await runCli(env, 'agent', 'bootstrap')).status, 0)
  fs.appendFileSync(
    path.join(env.stateDir, 'agent-delivery.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), eventId: 'wake-ghost', kind: 'wake', status: 'unknown' }) + '\n',
  )

  const fired = await runCli(env, 'tick', '--once', '--force', '--json')
  assert.equal(fired.status, 0, fired.stdout + fired.stderr)

  const keys = completions(seen).map(r => r.headers['idempotency-key'])
  assert.ok(keys.includes('reconcile-wake-ghost-startup'), keys.join(','))
  const pending = await runCli(env, 'agent', 'pending', '--json')
  assert.equal(pending.status, 0, pending.stdout)
  assert.deepEqual(asJson(pending).pending, [])
})

test('tick: 没有会话时报配置错误（退出码 2）', async (t) => {
  const { base } = await startServer(t, hermesOk)
  const env = setupEnv(t, base, { wakes: 1 })
  const r = await runCli(env, 'tick', '--once', '--force', '--json')
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.equal(asJson(r).action, 'no_session')
})

test('listen: 私信先取后确认 —— 成功才 ack，失败保留待下次', async (t) => {
  const { base, seen } = await startServer(t, hermesOk)
  const env = setupEnv(t, base, { wakes: 1 })
  assert.equal((await runCli(env, 'agent', 'bootstrap')).status, 0)

  const dmStateFile = path.join(env.dir, '.bili-ai', 'dm-await-state.json')
  fs.writeFileSync(dmStateFile, JSON.stringify({
    owner: '123', lastSeen: 0, queue: [],
    pending: { hit: true, mid: '123', name: '主人', text: '在吗', ts: 1700000000, key: 'k1', receipt: 'r1' },
  }))

  const hit = await runCli(env, 'listen', '--once', '--json', '--dm', '--no-comment', '--no-live')
  assert.equal(hit.status, 0, hit.stdout + hit.stderr)
  const out = asJson(hit)
  assert.equal(out.results[0].status, 'done')

  const prompt = completions(seen).at(-1).body.messages[0].content
  assert.match(prompt, /私信/)
  assert.match(prompt, /<untrusted>/)

  const dmState = JSON.parse(fs.readFileSync(dmStateFile, 'utf8'))
  assert.equal(dmState.pending, undefined)
  assert.equal(dmState.lastSeen, 1700000000)
})

test('listen: 当天没有会话时拒绝处理（退出码 2）', async (t) => {
  const { base } = await startServer(t, hermesOk)
  const env = setupEnv(t, base)
  const r = await runCli(env, 'listen', '--once', '--json', '--dm', '--no-comment', '--no-live')
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.equal(asJson(r).results[0].status, 'no_session')
})
