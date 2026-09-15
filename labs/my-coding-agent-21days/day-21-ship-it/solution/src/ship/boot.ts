/**
 * 启动前要做的四件事。本天新增。
 *
 * 它是全局安装之后**每一次**启动都会走的路径，所以四件事的排序是有约束的：
 *
 *   1. 算配置（五层叠起来）      —— 后面三件事都要用它的结果
 *   2. 落回环境变量              —— 必须在任何 provider 被造出来之前
 *   3. 把配置文件的问题说出来    —— 密钥写错地方、JSON 坏了、键名拼错
 *   4. 体检与更新提示            —— 它们只是打印，放最后，谁都不挡
 *
 * 第 4 步里那两件事都**绝不能让启动失败**：体检返回文字不抛异常，
 * 更新检查自己吞掉所有异常并带超时。一个工具因为「查了一下有没有新版」
 * 而起不来，是所有分发事故里最没面子的一种。
 */
import { applyShipConfig, formatConfig, loadShipConfig, type ShipConfig } from './config-layers.js'
import { diagnose } from './doctor.js'
import { checkUpdate, fetchLatestFromRegistry } from './update.js'
import { packageInfo } from './version.js'
import type { CliOptions } from '../cli.js'

export interface BootResult {
  config: ShipConfig
  lines: string[]
  /** 真实模式下缺 key：调用方可以据此决定是不是别往下跑了 */
  blocking: boolean
}

export async function boot(options: CliOptions = {}): Promise<BootResult> {
  const config = await loadShipConfig({
    ...(options.model ? { model: options.model } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  })
  applyShipConfig(config)

  const lines: string[] = []
  // 配置文件的问题**永远要说**，哪怕这次跑得下去：密钥写进项目配置这种事
  // 悄悄忽略掉，用户会一直以为自己配好了
  for (const warning of config.warnings) lines.push(`⚠ ${warning}`)

  const diagnosis = diagnose(config)
  lines.push(...diagnosis.lines)

  const info = await packageInfo()
  const update = await checkUpdate({
    current: info.version,
    // MOCK=1 的语义是「不发任何网络请求」，这条不能有例外；
    // MCA_NO_UPDATE_CHECK 给不想被打扰的人一个开关
    disabled: config.mock || process.env.MCA_NO_UPDATE_CHECK === '1',
    fetchLatest: () => fetchLatestFromRegistry(info.name),
  })
  if (update.notice) lines.push(update.notice)

  return { config, lines, blocking: diagnosis.blocking }
}

/** `mca --config` 那条支线：算完就打印，不启动任何东西 */
export async function printConfig(options: CliOptions = {}): Promise<string[]> {
  const config = await loadShipConfig({
    ...(options.model ? { model: options.model } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  })
  return formatConfig(config)
}
