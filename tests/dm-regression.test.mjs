// 私信监听的回归测试：她自己发的那条，不能把 lastSeen 推走
//   复现 2026-10-24 那个 bug（主人 02:47/02:49 两条问话被吞）
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLI = path.join(ROOT, 'tools', 'commands', 'dm-await.mjs')
const OWNER = '59413673'
const ME = '3546775719774786'

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-regress-'))
  const dsh = path.join(home, 'portable')
  fs.mkdirSync(path.join(home, '.bili-ai'), { recursive: true })
  fs.mkdirSync(dsh, { recursive: true })
  // 凭据（脚本只在真的要打网络时才用；测试走 TEST_DM_JSON 不碰网络）
  fs.writeFileSync(path.join(home, '.bili-ai', 'credentials.json'), JSON.stringify({ sessdata: 'test', bili_jct: 'a'.repeat(32), buvid3: 'x' }))
  // 配置：dm-await 会读 owner.mid / owner.name
  fs.writeFileSync(path.join(dsh, 'bili-whale.config.json'), JSON.stringify({ owner: { mid: OWNER, name: '主人' }, listen: { dm: true } }))
  return { home, dsh, state: path.join(home, '.bili-ai', 'dm-await-state.json'), fake: path.join(home, 'fake-sessions.json') }
}

function fakeSessions(file, { senderUid, ts, text }) {
  fs.writeFileSync(file, JSON.stringify({
    code: 0,
    data: {
      session_list: [{
        talker_id: Number(OWNER),
        unread_count: 0,
        last_msg: { sender_uid: Number(senderUid), receiver_type: 1, receiver_id: Number(OWNER), msg_type: 1, timestamp: ts, content: JSON.stringify({ content: text }) },
      }],
    },
  }))
}

function run(env, args = []) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, USERPROFILE: env.home, HOME: env.home, DSH_HOME: env.dsh, TEST_DM_JSON: env.fake },
    encoding: 'utf8',
    timeout: 20000,
  })
}

test('她自己发的消息不能把 lastSeen 推走，主人之前那条还要能捞回来', () => {
  const env = sandbox()
  const T = 1792781554   // 同一个时间基准
  fs.writeFileSync(env.state, JSON.stringify({ owner: OWNER, lastSeen: T - 1000 }))

  // ① 会话最后一条是【她自己】发的（notify / 日报）
  fakeSessions(env.fake, { senderUid: ME, ts: T, text: '有 1 条新的待审' })
  const r1 = run(env, ['--once', '--json'])
  const o1 = JSON.parse(String(r1.stdout).trim().split('\n').pop())
  assert.equal(o1.hit, false, '她自己发的不算命中')
  const s1 = JSON.parse(fs.readFileSync(env.state, 'utf8'))
  assert.equal(s1.lastSeen, T - 1000, 'lastSeen 必须一动不动（这正是那个 bug）')

  // ② 主人紧接着发了一条（比她那一条早 5 秒，但比 lastSeen 新）
  fakeSessions(env.fake, { senderUid: OWNER, ts: T - 5, text: '喵 检查你今晚的计划' })
  const r2 = run(env, ['--once', '--json', '--peek'])
  const o2 = JSON.parse(String(r2.stdout).trim().split('\n').pop())
  assert.equal(o2.hit, true, '主人的消息必须能命中')
  assert.match(o2.text, /检查你今晚的计划/)
  assert.ok(o2.receipt, 'peek 要给回执')
})

test('命中后（非 peek）lastSeen 才推进', () => {
  const env = sandbox()
  const T = 1792782000
  fs.writeFileSync(env.state, JSON.stringify({ owner: OWNER, lastSeen: T - 1000 }))
  fakeSessions(env.fake, { senderUid: OWNER, ts: T, text: '在吗' })
  const r = run(env, ['--once', '--json'])
  const o = JSON.parse(String(r.stdout).trim().split('\n').pop())
  assert.equal(o.hit, true)
  const s = JSON.parse(fs.readFileSync(env.state, 'utf8'))
  assert.equal(s.lastSeen, T, '命中并投递后才推进')
})
