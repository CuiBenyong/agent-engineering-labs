/**
 * 注入预算与裁剪。本天新增。
 *
 * 一条边界先划清楚：**这里只管「@ 引用这一路」的预算，不管上下文的总预算。**
 * 总预算怎么在系统提示、指令文件、记忆、历史、引用之间分配，是第十二天的题目。
 * 今天要立的纪律只有一条：**每一路注入都要自己报账**——注入了多少字符、
 * 估算多少 token、占本路预算的百分之多少。有了各路的账，第十二天才有东西可分。
 */

/** 引用这一路的字符预算。给得比较松，因为引用是用户明确点名的东西 */
export const REF_BUDGET_CHARS = 24_000
/** 单个来源不许超过预算的一半，否则一个大文件就能把别的挤光 */
export const SINGLE_SOURCE_RATIO = 0.5

/**
 * 粗糙的 token 估算：中日韩字符按 1 个字符 1 个 token 算，其余按 4 个字符 1 个 token。
 *
 * **它一定是不准的**，真正的计数要靠 tokenizer。这里要的只是一个量级，
 * 好让终端上那行「大约多少 token」有意义。第十二天会用网关回传的真实 usage
 * 把这个系数校准一遍，那时候才谈得上精确。
 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3000-\u9fff\uff00-\uffef]/g) ?? []).length
  const rest = text.length - cjk
  return Math.max(1, Math.round(cjk + rest / 4))
}

/** 来源分两级：用户逐个点名的是一级，通配符或目录展开出来的是二级 */
export type SourceTier = 'named' | 'derived'

export interface Source {
  /** 显示给用户的名字，例如 src/calc.js 或者一个网址 */
  label: string
  tier: SourceTier
  /** 注入正文；失败的来源这里是空串 */
  content: string
  /** 出了什么问题。有值就不注入，只在终端提示 */
  problem?: string
}

export interface BudgetedSource extends Source {
  chars: number
  tokens: number
  /** 因为超过单源上限而被自己截断 */
  truncated: boolean
  /** 因为总预算不够而整条被丢掉 */
  dropped: boolean
}

export interface BudgetResult {
  sources: BudgetedSource[]
  totalChars: number
  totalTokens: number
  budget: number
  droppedCount: number
}

/**
 * 分配预算。三条规则，顺序就是优先级：
 *
 *   1. **一级来源永不静默丢弃。** 用户明确点名的东西，宁可截断也要留一段，
 *      并且在终端说清截了多少。悄悄丢掉用户点名的文件是最坏的行为——
 *      他会以为模型看过了。
 *   2. **单个来源不超过预算的一半。** 超了先自己从中间截断（保留首尾，
 *      口径和第三天的工具结果截断一致，模型不用学第二种截断格式）。
 *   3. **总量还不够就丢二级来源，从最后一条开始丢。** 二级是通配符或目录
 *      带出来的，用户没有逐个点名，丢掉它的代价最小；而且丢了也要报数。
 */
export function applyBudget(sources: Source[], budget = REF_BUDGET_CHARS): BudgetResult {
  const singleCap = Math.floor(budget * SINGLE_SOURCE_RATIO)

  // 第一步：每条先各自服从单源上限
  const staged: BudgetedSource[] = sources.map((source) => {
    if (source.problem || source.content.length <= singleCap) {
      return {
        ...source,
        chars: source.content.length,
        tokens: estimateTokens(source.content),
        truncated: false,
        dropped: false,
      }
    }
    const content = truncateMiddle(source.content, singleCap)
    return {
      ...source,
      content,
      chars: content.length,
      tokens: estimateTokens(content),
      truncated: true,
      dropped: false,
    }
  })

  // 第二步：总量超了就丢来源
  // TODO(4)：这个循环有两处错。
  //   一、它从第一条开始丢，应该从**最后一条**开始（i 从 staged.length - 1 递减）。
  //   二、它不看 tier，于是会把用户明确点名的一级来源直接丢掉——
  //       悄悄丢掉用户点名的文件是最坏的行为，他会以为模型看过了。
  //       一级来源宁可截断也要留一段，只丢二级（通配符或目录带出来的那些）。
  let total = staged.reduce((sum, s) => sum + s.chars, 0)
  for (let i = 0; i < staged.length && total > budget; i += 1) {
    const source = staged[i] as BudgetedSource
    if (source.dropped || source.problem) continue
    total -= source.chars
    staged[i] = {
      ...source,
      content: '',
      chars: 0,
      tokens: 0,
      dropped: true,
      problem: `注入预算不够，这条被丢掉了（原本 ${source.chars} 字符）`,
    }
  }

  const kept = staged.filter((s) => !s.dropped && !s.problem)
  return {
    sources: staged,
    totalChars: kept.reduce((sum, s) => sum + s.chars, 0),
    totalTokens: kept.reduce((sum, s) => sum + s.tokens, 0),
    budget,
    droppedCount: staged.filter((s) => s.dropped).length,
  }
}

/**
 * 从中间截，保留首尾。头部多留一点，因为文件开头通常信息密度更高。
 *
 * 注意那句说明本身也算进 limit 里：截断之后的结果**必须不超过 limit**，
 * 否则「预算」就成了摆设——这是最容易写错的一行。
 */
export function truncateMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text
  const removed = text.length - limit
  const note = `\n…（中间已截断约 ${removed} 字符，全文共 ${text.length} 字符；需要中间部分请用 read_file 带 offset 读）…\n`
  const room = limit - note.length
  if (room <= 0) return note.slice(0, limit)
  const head = Math.floor(room * 0.6)
  return `${text.slice(0, head)}${note}${text.slice(text.length - (room - head))}`
}
