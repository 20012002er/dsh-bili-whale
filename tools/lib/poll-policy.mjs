// 2026-10-23 改：下限从 60 秒放宽到 15 秒
//   原因：私信监听想要 20 秒基础间隔 ✗（要像聊天 ✓），以前被 60 秒下限悄悄顶掉了 ✗
//   退避不变：base × 2^n（n = 连续空转次数），封顶 15 分钟 ✓
export function pollDelay(baseSeconds, idleRounds) {
  const base = Math.max(15, Number(baseSeconds) || 60)
  return Math.min(Math.max(base, 900), base * 2 ** Math.min(8, Math.max(0, idleRounds))) * 1000
}
