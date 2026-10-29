// 轻量日志（Phase 5）：只写 stderr，stdout 留给 --json / 人读结果。
//
//   BILI_WHALE_LOG=debug|info|warn|error|silent   （默认 info）
//
// 为什么不用 console.log：tick / listen 的 --json 会被 cron / systemd 采集，
// 日志混进 stdout 会让 JSON 解析直接失败。daemon 的启动/退出横幅同理。
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 }

function currentLevel() {
  const raw = String(process.env.BILI_WHALE_LOG ?? '').trim().toLowerCase()
  return LEVELS[raw] ?? LEVELS.info
}

function formatValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const text = String(value)
  return /[\s"=]/.test(text) ? JSON.stringify(text) : text
}

function formatFields(fields) {
  if (!fields) return ''
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(' ')
}

/**
 * 建一个带 scope 的 logger。所有输出走 stderr，一行一条、key=value 便于 grep。
 * @param {string} scope 比如 'tick' / 'listen'
 */
export function createLogger(scope) {
  const threshold = currentLevel()
  const emit = (level, message, fields) => {
    if (LEVELS[level] < threshold) return
    const head = `[${new Date().toISOString()}] [${scope}] ${level}`
    const body = message ? ` ${message}` : ''
    const tail = formatFields(fields)
    process.stderr.write(`${head}${body}${tail ? ' ' + tail : ''}\n`)
  }
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  }
}
