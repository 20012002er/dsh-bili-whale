// 宿主适配器工厂：agent / tick / listen 三处共用，避免各写一份路由。
// 这里只做“按配置选实现”，不碰业务；参数错误用 code='config' 抛给调用方转退出码 2。
import { HermesAdapter } from './agent-adapter.mjs'
import { OpenClawAdapter } from './openclaw-adapter.mjs'

export const configError = (message) => Object.assign(new Error(message), { code: 'config' })

export function makeAdapter(cfg, hostOverride) {
  const agent = cfg.agent ?? {}
  const host = String(hostOverride || agent.host || 'hermes')
  const stateDir = agent.sessionDir || undefined

  if (host === 'hermes') {
    return new HermesAdapter({
      ownerMid: cfg.owner?.mid,
      baseUrl: agent.baseUrl,
      model: agent.model,
      stateDir,
      turnTimeoutMs: agent.timeoutMs,
    })
  }
  if (host === 'openclaw') {
    const oc = agent.openclaw ?? {}
    return new OpenClawAdapter({
      bin: oc.bin || undefined,
      agentId: oc.agentId || '',
      mode: oc.sessionMode === 'agent' ? 'agent' : 'session-id',
      local: Boolean(oc.local),
      channel: oc.channel || '',
      deliver: Boolean(agent.deliver),
      ownerMid: cfg.owner?.mid,
      stateDir,
      turnTimeoutMs: oc.timeoutMs || agent.timeoutMs,
    })
  }
  throw configError(`agent.host = ${host} —— 只支持 hermes | openclaw`)
}

/** partial / unknown 视为“没干净完成”，交给调用方决定要不要 reconcile。 */
export function codeFor(result) {
  if (result?.ok && result.status !== 'partial') return 0
  if (result?.status === 'partial' || result?.status === 'unknown') return 1
  return 3
}

export function summarize(result) {
  return `status=${result?.status} event=${result?.eventId}` +
    (result?.generation ? ` gen=${result.generation}` : '') +
    (result?.durationMs ? ` ${result.durationMs}ms` : '') +
    (result?.code ? ` code=${result.code}` : '') +
    (result?.message ? ` message=${result.message}` : '')
}
