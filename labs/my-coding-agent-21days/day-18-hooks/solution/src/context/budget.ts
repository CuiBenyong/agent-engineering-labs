/**
 * 上下文的**总预算**怎么在各路之间分配。本天新增。
 *
 * 前面几天每一路都各自报了账：第八天的 @ 引用报「注入了多少字符、约多少 token」，
 * 第九天的指令文件、第十一天的记忆同样各报一路。今天是把这些账汇总起来的地方——
 * 也是全课唯一讨论「总预算」的地方。
 *
 * 分配的思路只有一句话：**常驻的那几路给死额度，剩下的留给会长大的那几路。**
 *
 *   常驻（每一轮都在，长度基本不变）：系统指令、项目指令文件、记忆
 *   一次性（这一轮才有，长度可控）：@ 引用注入
 *   会长大（越聊越长，是压缩要对付的那一路）：对话、工具结果
 *   压缩摘要（压缩换来的那一小块，越滚越多要限量）
 *
 * 给死额度的用处不是「省钱」，是**让越界的时候能指出是谁越界了**。
 * 只有一个总数的时候，你只知道「满了」；有了各路的额度，你知道该压哪一路。
 *
 * 一条边界：**这里只算 token，不算钱。** 单价随网关与模型变，写进代码就等于把课程
 * 绑在某一家的价目表上；花费统计是第二十天的题目，它复用的仍然是这里的数。
 */
import type { Message } from '../kernel/types.js'
import { contentToText } from '../kernel/types.js'
import { estimateMessage } from './tokens.js'

/**
 * 上下文预算的基数。
 *
 * **它不是任何模型的真实上限。** 各家的窗口大小随模型与网关变化，代码里不许假设——
 * 真实上限以你所用网关的文档为准，拿到之后把这个常数换成它的八成左右即可。
 * 这里取一个整数，是为了让压缩这件事在实验里有一条可以被越过的线。
 */
export const WINDOW_TOKENS = 32_000

export type Lane = 'system' | 'instructions' | 'memory' | 'refs' | 'summary' | 'history' | 'tools'

/** 各路的额度占总预算的比例，加起来正好是 1 */
export const RESERVE: Record<Lane, number> = {
  system: 0.03,
  instructions: 0.1,
  memory: 0.05,
  refs: 0.2,
  summary: 0.07,
  history: 0.4,
  tools: 0.15,
}

export const LANE_LABELS: Record<Lane, string> = {
  system: '系统指令',
  instructions: '项目指令文件',
  memory: '记忆',
  refs: '引用注入',
  summary: '压缩摘要',
  history: '对话',
  tools: '工具结果',
}

/** 注入类消息的开头标记。分路靠它，所以这两句话是**协议**，不是文案 */
export const REFS_PREFIX = '以下是用户用 @'
export const SUMMARY_PREFIX = '以下是之前那段对话的压缩摘要'

/**
 * 一条消息属于哪一路。
 *
 * 用开头标记而不是新加一个字段，是因为消息协议在第一天就冻结了（`kernel/types.ts`）。
 * 与其为了分路去改全课的地基，不如让注入方在正文开头写一句固定的话——
 * 那句话本来也要写给模型看。**第九天的指令文件与第十一天的记忆接进来时，
 * 各自加一条前缀就自动分到自己那一路**，这里一行都不用改。
 */
export function laneOf(message: Message): Lane {
  if (message.role === 'system') return 'system'
  if (message.role === 'tool') return 'tools'
  const text = contentToText(message.content)
  if (text.startsWith(REFS_PREFIX)) return 'refs'
  if (text.startsWith(SUMMARY_PREFIX)) return 'summary'
  return 'history'
}

export interface LaneRow {
  lane: Lane
  label: string
  messages: number
  tokens: number
  /** 这一路的额度（token） */
  allowance: number
  /** 占自己额度的百分比，可以超过 100 */
  usedPercent: number
}

export interface BudgetReport {
  rows: LaneRow[]
  totalTokens: number
  windowTokens: number
  /** 占总预算的百分比 */
  usedPercent: number
  /** 超出自己额度的那几路 */
  overLanes: Lane[]
}

const ORDER: Lane[] = ['system', 'instructions', 'memory', 'refs', 'summary', 'history', 'tools']

/**
 * 本实验里根本不存在的两路：项目指令文件（第九天）与记忆（第十一天）。
 *
 * 它们照样列在表里、照样占着额度——**空位比不列出来有用**：读者一眼看到
 * 「总预算是分给七路的」，而不是以为只有眼前这五路。第九天与第十一天的机制
 * 接进来时，把这里的名字从这张表里删掉即可。
 */
const ABSENT: Set<Lane> = new Set(['instructions', 'memory'])

export function accountLanes(messages: Message[], windowTokens = WINDOW_TOKENS): BudgetReport {
  const tokens = new Map<Lane, number>()
  const counts = new Map<Lane, number>()
  for (const message of messages) {
    const lane = laneOf(message)
    tokens.set(lane, (tokens.get(lane) ?? 0) + estimateMessage(message))
    counts.set(lane, (counts.get(lane) ?? 0) + 1)
  }

  const rows: LaneRow[] = ORDER.map((lane) => {
    const used = tokens.get(lane) ?? 0
    const allowance = Math.round(windowTokens * RESERVE[lane])
    return {
      lane,
      label: LANE_LABELS[lane],
      messages: counts.get(lane) ?? 0,
      tokens: used,
      allowance,
      usedPercent: Math.round((used / Math.max(1, allowance)) * 100),
    }
  })

  const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0)
  return {
    rows,
    totalTokens,
    windowTokens,
    usedPercent: Math.round((totalTokens / windowTokens) * 100),
    overLanes: rows.filter((row) => row.tokens > row.allowance).map((row) => row.lane),
  }
}

/** 打给终端的几行。空的那几路也要列出来——它们的存在本身就是「这里还有一路」的说明 */
export function formatBudget(report: BudgetReport): string[] {
  const lines = [
    `上下文预算 ${report.windowTokens} token，当前估算占用 ${report.totalTokens}（${report.usedPercent}%）`,
  ]
  for (const row of report.rows) {
    const empty = ABSENT.has(row.lane) ? '  （本实验没有这一路，额度留给第九天与第十一天）' : ''
    lines.push(
      `  ${row.label.padEnd(6, '　')} ${String(row.tokens).padStart(6)} / 额度 ${String(row.allowance).padStart(5)}` +
        `  ${row.usedPercent}%${row.tokens > row.allowance ? ' ← 超额度' : ''}${empty}`
    )
  }
  if (report.overLanes.length > 0) {
    lines.push(
      `  超额度的是：${report.overLanes.map((lane) => LANE_LABELS[lane]).join('、')}——先压这几路`
    )
  }
  return lines
}
