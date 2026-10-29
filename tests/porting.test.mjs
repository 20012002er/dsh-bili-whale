// Phase 1（通用 skill 移植）回归：路径/运行时/配置/扫码登录都不再依赖 DSH。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveRuntime } from '../tools/lib/runtime.mjs'
import { generateQr, pollQrOnce, saveCredentials } from '../tools/lib/qr-auth.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const runNode = (code, env = {}) => spawnSync(process.execPath, ['--input-type=module', '-e', code], {
  encoding: 'utf8',
  env: { ...process.env, ...env },
})
const temp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-porting-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('paths: BILI_WHALE_HOME 优先，其次 DSH_HOME，配置文件名跟着走', (t) => {
  const dir = temp(t)
  const whale = path.join(dir, 'whale-home'), dsh = path.join(dir, 'dsh-home')
  const probe = (env) => runNode(
    `const p = await import(${JSON.stringify(new URL('../tools/lib/paths.mjs', import.meta.url).href)}); console.log(JSON.stringify({home: p.BILI_WHALE_HOME, cfg: p.configPath}))`,
    { ...env, USERPROFILE: dir, HOME: dir, BILI_WHALE_CONFIG: '' },
  )
  const a = JSON.parse(probe({ BILI_WHALE_HOME: whale, DSH_HOME: dsh }).stdout)
  assert.equal(a.home, whale)
  assert.equal(a.cfg, path.join(whale, 'bili-whale.config.json'))
  const b = JSON.parse(probe({ BILI_WHALE_HOME: '', DSH_HOME: dsh }).stdout)
  assert.equal(b.home, dsh)
  const c = JSON.parse(probe({ BILI_WHALE_HOME: '', DSH_HOME: '' }).stdout)
  assert.equal(c.home, path.join(dir, '.dsh'))
  // 通用安装：~/.bili-whale 一旦存在就自动接管（不需要每次导出环境变量）
  fs.mkdirSync(path.join(dir, '.bili-whale'))
  const d = JSON.parse(probe({ BILI_WHALE_HOME: '', DSH_HOME: dsh }).stdout)
  assert.equal(d.home, path.join(dir, '.bili-whale'))
})

test('runtime: BILI_WHALE_NODE 优先；PATH 为空时不猜硬编码路径', () => {
  const ok = resolveRuntime('/nonexistent', {
    env: { PATH: '', BILI_WHALE_NODE: process.execPath }, platform: 'linux', home: os.tmpdir(),
    probe: () => true, electron: false,
  })
  assert.equal(ok.file, process.execPath)
  assert.throws(() => resolveRuntime('/nonexistent', {
    env: { PATH: '' }, platform: 'linux', home: os.tmpdir(), probe: () => false, electron: false,
  }), /node/)
  // 旧宿主变量仍然可用（DSH 兼容）
  const legacy = resolveRuntime('/nonexistent', {
    env: { PATH: '', DSH_NODE: process.execPath }, platform: 'linux', home: os.tmpdir(),
    probe: () => true, electron: false,
  })
  assert.equal(legacy.file, process.execPath)
})

const json = (data, headers = {}) => new Response(JSON.stringify({ code: 0, data }), { headers })

test('qr-auth: 只接受 B 站域名的二维码，轮询状态原样映射', async () => {
  await assert.rejects(generateQr({ fetch: async () => json({ url: 'https://evil.invalid/x', qrcode_key: 'k' }) }), /二维码/)
  const qr = await generateQr({ fetch: async () => json({ url: 'https://passport.bilibili.com/scan?k=1', qrcode_key: 'fixture-key' }) })
  assert.equal(qr.key, 'fixture-key')
  assert.equal((await pollQrOnce({ key: 'k', fetch: async () => json({ code: 86101 }) })).status, 'waiting')
  assert.equal((await pollQrOnce({ key: 'k', fetch: async () => json({ code: 86090 }) })).status, 'scanned')
  assert.equal((await pollQrOnce({ key: 'k', fetch: async () => json({ code: 86038 }) })).status, 'expired')
})

test('qr-auth: 扫码成功后校验账号并写入 0600 凭据', async (t) => {
  const dir = temp(t)
  const file = path.join(dir, 'credentials.json'), pending = path.join(dir, 'pending.json')
  const headers = new Headers()
  headers.append('set-cookie', `SESSDATA=${'a'.repeat(30)}; HttpOnly`)
  headers.append('set-cookie', `bili_jct=${'b'.repeat(32)}; HttpOnly`)
  const fetchMock = async (url) => String(url).includes('/qrcode/poll')
    ? json({ code: 0 }, headers)
    : json({ isLogin: true, mid: 111, uname: '小鱼' })
  const result = await pollQrOnce({ key: 'k', fetch: fetchMock })
  const account = await saveCredentials(result.credentials, { file, pending, fetch: fetchMock })
  assert.equal(account.mid, '111')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).bili_jct, 'b'.repeat(32))
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test('login CLI: 缺 bili_jct 时在发请求前退出 2', (t) => {
  const dir = temp(t)
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/bili.mjs'), 'login', '--cookie', 'SESSDATA=only-session'], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, HOME: dir, USERPROFILE: dir, BILI_WHALE_HOME: dir, BILI_WHALE_CONFIG: '' },
  })
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /SESSDATA|bili_jct/)
})

test('install.mjs 在干净 HOME 里装出可运行目录与配置', (t) => {
  const home = temp(t)
  const r = spawnSync(process.execPath, [path.join(ROOT, 'skill/install.mjs'), '--host', 'hermes'], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, HOME: home, USERPROFILE: home, BILI_WHALE_HOME: '' },
  })
  assert.equal(r.status, 0, r.stderr)
  const dest = path.join(home, '.hermes', 'skills', 'bili-whale')
  assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')))
  assert.ok(fs.existsSync(path.join(dest, 'scripts', 'bili.mjs')))
  assert.ok(fs.existsSync(path.join(dest, 'lib', 'credentials.js')))
  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.bili-whale', 'bili-whale.config.json'), 'utf8'))
  assert.equal(cfg.agent.host, 'hermes')
  assert.equal(cfg.listen.dm, false)
})
