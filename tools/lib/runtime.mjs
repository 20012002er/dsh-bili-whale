import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// Verify execution using a file: an Electron process can exit zero without running JS.
export function probeRuntime(file, env) {
  let dir
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-node-'))
    const proof = path.join(dir, 'proof')
    const r = spawnSync(file, ['-e', 'require("fs").writeFileSync(process.argv[1],process.versions.node)', proof],
      { env, stdio: 'ignore', windowsHide: true, timeout: 10000 })
    return !r.error && r.status === 0 && /^\d+\./.test(fs.readFileSync(proof, 'utf8'))
  } catch { return false }
  finally { if (dir) fs.rmSync(dir, { recursive: true, force: true }) }
}
export function resolveRuntime(dshHome, options = {}) {
  const env = options.env ?? process.env, platform = options.platform ?? process.platform
  const home = options.home ?? (env.USERPROFILE || env.HOME || os.homedir())
  const electron = options.electron ?? Boolean(process.versions.electron)
  const current = options.execPath ?? process.execPath
  const probe = options.probe ?? probeRuntime
  const bin = platform === 'win32' ? 'node.exe' : 'node'
  // 解析顺序：BILI_WHALE_NODE（通用模式）→ DSH_NODE / DSH_DESKTOP_NODE_EXECUTABLE（旧宿主）
  // → DSH 自带运行时（兼容）→ PATH → 平台常见安装位置
  const cands = [env.BILI_WHALE_NODE, env.DSH_NODE, env.DSH_DESKTOP_NODE_EXECUTABLE]
  for (const root of new Set([path.join(dshHome, 'dsh-runtimes'), path.join(home, '.dsh', 'dsh-runtimes')])) {
    try { for (const d of fs.readdirSync(root)) cands.push(path.join(root, d, 'dependencies', 'node', 'bin', bin)) } catch {}
  }
  const sep = platform === 'win32' ? ';' : ':'
  for (const dir of String(env.PATH ?? '').split(sep)) if (dir) cands.push(path.join(dir.replace(/^"|"$/g, ''), bin))
  // PATH 为空 = 调用方明确没给运行时（装机器 / 测试模拟"没有 node"）→ 不再猜硬编码路径，
  // 只认上面显式声明的 BILI_WHALE_NODE / DSH_NODE。PATH 正常时才做桌面端的兜底猜测 ✓
  const searchHost = String(env.PATH ?? '').trim().length > 0
  if (platform === 'darwin' && searchHost) cands.push('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node', '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node')
  if (platform === 'win32' && env.ProgramFiles) cands.push(path.join(env.ProgramFiles, 'nodejs', bin))
  if (options.allowCurrent && !electron) cands.push(current)
  for (const file of new Set(cands.filter(Boolean))) {
    try { if (fs.statSync(file).isFile() && probe(file, env)) return { file, env: { ...env } } } catch {}
  }
  if (electron) {
    const nodeEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' }
    if (probe(current, nodeEnv)) return { file: current, env: nodeEnv }
  }
  throw Error('[bili-whale] 找不到可执行脚本的 node 运行时：请安装 Node 18+ 并放进 PATH，或把 BILI_WHALE_NODE 设为真实 node 的绝对路径')
}
