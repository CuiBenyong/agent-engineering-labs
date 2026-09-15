import type { UsageRow } from './infra/index'

/** 价格表是配置不是常量：厂商调价时只改这一张表。单位是「美元 / 100 万 token」。 */
export const PRICING: Record<string, { promptPerM: number; completionPerM: number }> = {
  'openai/gpt-4o-mini': { promptPerM: 0.15, completionPerM: 0.6 },
  'openai/text-embedding-3-small': { promptPerM: 0.02, completionPerM: 0 },
}

/**
 * 返回「微美元」（百万分之一美元）的整数。单价的单位正好是「美元 / 100 万 token」，
 * 所以 token 数 × 单价 就是微美元：1200 × 0.15 + 240 × 0.60 = 324 微美元 = 0.000324 美元。
 * 用整数算和存，是因为 JS 没有十进制类型，用 number 累加金额会让总额和逐条相加对不上
 * （Python 用 Decimal、Java 用 BigDecimal 解决的是同一个问题）。
 */
export function costMicroUsd(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const price = PRICING[model]
  if (!price) throw new Error(`未登记价格的模型：${model}（先把它加进 PRICING）`)
  return Math.round(promptTokens * price.promptPerM + completionTokens * price.completionPerM)
}

// 保留 6 位小数：一次调用常常不到万分之一美元，四舍五入到 2 位会全部变成 0
export function formatUsd(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(6)}`
}

export type UserSummary = {
  userId: string
  calls: number
  promptTokens: number
  completionTokens: number
  micro: number
}

/**
 * 按用户汇总某个月的成本，monthPrefix 形如 2026-09。
 * 生产里这一步会下推成 SQL 的 group by（见正文那三条查询），放在业务层是为了让
 * 内存实现和 Postgres 实现共用同一份汇总逻辑。
 */
export function summarizeByUser(rows: UsageRow[], monthPrefix: string): UserSummary[] {
  const byUser = new Map<string, UserSummary>()
  for (const row of rows) {
    if (!row.createdAt.startsWith(monthPrefix)) continue
    const acc = byUser.get(row.userId) ?? {
      userId: row.userId,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      micro: 0,
    }
    acc.calls += 1
    acc.promptTokens += row.promptTokens
    acc.completionTokens += row.completionTokens
    acc.micro += row.costMicroUsd
    byUser.set(row.userId, acc)
  }
  return [...byUser.values()].sort((a, b) => b.micro - a.micro)
}

const COLS = ['user_id', 'calls', 'prompt_tokens', 'completion_tokens', 'cost_usd']
const WIDTHS = [10, 7, 15, 19, 14]

/** admin 脚本打印的那张表：按用户一行，最后一行合计。 */
export function renderReport(rows: UsageRow[], monthPrefix: string): string {
  const users = summarizeByUser(rows, monthPrefix)
  const sum = (pick: (s: UserSummary) => number) => users.reduce((acc, s) => acc + pick(s), 0)
  const line = (cells: (string | number)[]) =>
    cells
      .map((cell, i) => String(cell).padEnd(WIDTHS[i]))
      .join('')
      .trimEnd()
  return [
    `=== usage report ${monthPrefix}（按用户）===`,
    line(COLS),
    ...users.map((s) =>
      line([s.userId, s.calls, s.promptTokens, s.completionTokens, formatUsd(s.micro)])
    ),
    '-'.repeat(60),
    line([
      'TOTAL',
      sum((s) => s.calls),
      sum((s) => s.promptTokens),
      sum((s) => s.completionTokens),
      formatUsd(sum((s) => s.micro)),
    ]),
  ].join('\n')
}
