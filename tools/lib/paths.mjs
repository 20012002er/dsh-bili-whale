/**
 * 统一的路径解析（数据 home 与用户主目录）。
 *
 * 为什么需要它：插件宿主半边（lib/index.js）用的是
 *   process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
 * 而工具链（tools/ 下的脚本）此前各自硬编码 path.join(HOME, '.dsh')，
 * **完全不读 DSH_HOME**。两边的 home 语义一旦不一致就会分叉：
 *
 *   · DSH_HOME 被自定义（多个 profile 根、便携安装、CI）时，
 *     宿主把配置写进 $DSH_HOME/bili-whale.config.json，
 *     工具链却去 $HOME/.dsh/ 读 → 读不到（或读到另一份），
 *     生物钟、日记、日志、配置全部错位。
 *
 * 因此所有 tools/ 脚本都应从这里取路径，别再本地拼 '.dsh'。
 *
 * 2026-10-29（通用 skill 移植）：新增 BILI_WHALE_HOME ——
 *   脱离 DSH 后没有任何环境变量可依赖，需要一个宿主无关的名字；
 *   解析顺序 BILI_WHALE_HOME → DSH_HOME → ~/.dsh（保留旧行为，
 *   现有 DSH 用户的配置/日记/状态原地可用，不需要迁移）。
 *
 * 注意保留旧行为：USERPROFILE 优先于 HOME，`BILI_WHALE_CONFIG` 仍可覆盖配置文件位置。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 用户主目录（Windows 优先 USERPROFILE，保持与原实现一致）。 */
export const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.'

const AUTO_HOME = path.join(HOME, '.bili-whale')

/**
 * 数据 home：显式 BILI_WHALE_HOME → 已存在的 ~/.bili-whale（通用安装）→ DSH_HOME → ~/.dsh。
 * 自动识别是为了让通用 skill 不需要每次导出环境变量：install.mjs 建出 ~/.bili-whale 之后，
 * 后面所有命令自然落到那里；DSH 用户没有这个目录，行为保持不变。
 */
export const BILI_WHALE_HOME = process.env.BILI_WHALE_HOME
  || (fs.existsSync(AUTO_HOME) ? AUTO_HOME : (process.env.DSH_HOME || path.join(HOME, '.dsh')))

/** 兼容旧名：DSH 插件与现有测试仍按 DSH_HOME 语义引用。 */
export const DSH_HOME = BILI_WHALE_HOME

/** 拼一个位于数据 home 下的路径。 */
export const whalePath = (...parts) => path.join(BILI_WHALE_HOME, ...parts)

/** 兼容旧名。 */
export const dshPath = whalePath

/** 拼一个位于用户主目录下的路径（.bili-ai 等凭据/状态目录用）。 */
export const homePath = (...parts) => path.join(HOME, ...parts)

/** 插件配置文件（保留 BILI_WHALE_CONFIG 覆盖）。 */
export const configPath = process.env.BILI_WHALE_CONFIG || whalePath('bili-whale.config.json')

/** Credentials are per OS user, independent of BILI_WHALE_HOME. */
export const credentialsPath = homePath('.bili-ai', 'credentials.json')
