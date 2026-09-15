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

  // TODO(5a) 现在这里只有一行开发者语言。把它换成一段人话引导，必须回答三件事：
  //   ① 缺的到底是什么 ② 敲哪条命令能补上（要能直接复制）
  //   ③ 现在不想补能不能先看看（MOCK=1 这条退路必须给）
  //   自检第 10 项会逐条检查这三件事在不在。
  lines.push('Error: LLM_API_KEY is not set')

  return { blocking: true, lines }
}
