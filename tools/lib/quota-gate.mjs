// 限额闸的统一入口（2026-10-17 加，Kimi 评审 #5：写通道只有 comment 接了闸门 ✗）
//
// 以前 quota.mjs 的头注释承诺「check 只挡发言类动作（comment / dynamic / danmaku）」，
// 但 dynamic / dynamic-image / edit-dynamic / danmaku 四条写通道里 quota 出现 0 次 —— 等于裸奔。
// 这里把「检查 + 记账」收成两个函数，四条通道各调一次。
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const QUOTA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'quota.mjs')

// 2026-10-19：DSH 的 Windows 沙箱禁止"捕获子进程输出"的 spawn（管道 → EPERM）。
//   改用 stdio:'inherit'（沙箱内实测可用），输出直接进控制台，退出码判胜负。
function run(args) {
  const r = spawnSync(process.execPath, [QUOTA, ...args], { stdio: 'inherit' })
  return { code: r.status ?? (r.error ? 1 : 0), out: '' }
}

/**
 * 发之前过闸。返回 true = 放行。
 * @param {{type:string, target?:string, auto?:boolean, share?:boolean}} o
 */
export function gate({ type, target = '', auto = true, share = false }) {
  console.log('[限额闸]')
  const r = run(['check', '--type', type, '--target', target, ...(share ? ['--share'] : auto ? ['--auto'] : [])])
  return r.code === 0
}

/** 发成功之后记账（失败也算失败，不该记账） */
export function record({ type, target = '', note = '', auto = true, share = false }) {
  console.log('[限额闸]')
  run(['record', '--type', type, '--target', target, '--note', String(note).slice(0, 40), ...(share ? ['--share'] : auto ? ['--auto'] : [])])
}
