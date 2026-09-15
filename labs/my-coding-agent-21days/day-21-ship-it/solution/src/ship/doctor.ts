/**
 * 首次运行的引导。本天新增。
 *
 * 装完一个工具第一次敲它的名字，是这个工具**唯一一次**不需要争取就能得到的注意力。
 * 这一刻能给出的最差回应是一段堆栈。前二十天我们在 lab 里跑，缺 key 时抛个错
 * 无所谓——写这段代码的人和跑它的人是同一个。今天不是了。
 *
 * 一条人话提示要回答三个问题，缺一个用户就得去翻文档：
 *   ① 现在缺的到底是什么
 *   ② 我该敲什么命令才能补上（要能直接复制）
 *   ③ 我现在不想补，能不能先看看它长什么样（MOCK=1 这条退路必须给）
 *
 * 而且它是**返回字符串数组、不是直接抛错**：抛错的话调用方没法决定「先打印再退出」
 * 还是「打印完继续跑 MOCK」，也没法在自检里断言提示内容。
 */
import path from 'node:path'
import type { ShipConfig } from './config-layers.js'
import { userConfigDir } from './paths.js'

export interface Diagnosis {
  /** true 表示缺的东西足以让真实模式跑不起来 */
  blocking: boolean
  lines: string[]
}

export function diagnose(config: ShipConfig): Diagnosis {
  const lines: string[] = []
  if (config.mock) {
    // 离线模式下没有 key 不是问题，说一句就够了，不要摆一屏引导
    return { blocking: false, lines: ['（MOCK=1：走离线剧本，不发任何网络请求，也不需要 key）'] }
  }
  if (config.apiKey) return { blocking: false, lines: [] }

  lines.push('还没有配模型网关的密钥，mca 暂时连不上任何模型。三选一：')
  lines.push('  1. 在这个终端里临时给一次：')
  lines.push('       export LLM_API_KEY=你的key')
  lines.push('  2. 写进当前目录的 .env（记得别提交它）：')
  lines.push('       echo "LLM_API_KEY=你的key" >> .env')
  lines.push('  3. 先不配，看看它长什么样：')
  lines.push('       MOCK=1 mca')
  lines.push('')
  lines.push(
    `网关地址与模型可以写进配置文件（密钥不行）：${path.join(userConfigDir(), 'config.json')}`
  )
  lines.push(`  例如 {"baseUrl": "${config.baseUrl.value}", "model": "${config.model.value}"}`)
  lines.push('当前用的网关与模型、以及它们各自来自哪一层，敲 mca --config 看。')
  return { blocking: true, lines }
}
