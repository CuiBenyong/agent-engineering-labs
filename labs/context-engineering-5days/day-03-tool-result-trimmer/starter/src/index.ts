// D3 实验（starter）：工具结果裁剪器
// 三条规则：字段白名单 → 长度上限 → 陈旧结果丢弃。
// 输出裁剪前后的 token 对比表，以及一份关键事实存活检查。
//
// 这个实验不需要网络：裁剪是纯逻辑，token 数用本地估算器算比例就够了。
// MOCK=1 只是统一入口，跑法和其它天一致。
//
// 四个练习点见下面的「练习 N」注释。现在直接跑 MOCK=1 pnpm start 是能跑通的，
// 但裁剪前后的数字一模一样、省了 0.0%——三条规则一条都还没生效。

import 'dotenv/config'
import { KEY_FACTS, loadToolResults, type ToolResult } from './fixture.js'
import { estimateTokens } from './tokens.js'

const KEEP_RECENT = Number(process.env.KEEP_RECENT ?? 3)
const MAX_CHARS = Number(process.env.MAX_CHARS ?? 900)
const HUGE = process.env.HUGE === '1'

/**
 * 规则一：字段白名单。
 * 只留下「后续步骤真的会用到」的顶层字段。
 * 判据不是「这个字段看起来重不重要」，而是「Agent 接下来要回答的问题需不需要它」——
 * 客服回答发货进度时用不到 audit_log、internal_flags、supplier_code，那它们就是纯开销。
 */
const FIELD_WHITELIST: Record<string, string[]> = {
  get_order: ['order_id', 'status', 'total_cents', 'tracking_no', 'updated_at'],
  search_products: ['keyword', 'total', 'items'],
  get_logistics: ['tracking_no', 'carrier', 'latest_status'],
  get_policy: ['clause', 'title', 'text'],
}

export function applyFieldWhitelist(result: ToolResult): string {
  const allow = FIELD_WHITELIST[result.tool]
  if (!allow) return result.content

  // 练习 1：只保留白名单里的顶层字段。
  // 提示：先 JSON.parse，解析失败就原样返回（不是 JSON 就别硬拆，交给下一条规则按长度处理）；
  // 解析成功就挑出白名单字段重新 stringify。
  // 建议再塞一个 _dropped_fields 数组记下被删掉的字段名——
  // 这样模型知道「这里本来还有东西」，需要时可以重新调工具，而不是以为它看到的就是全部。
  void allow
  return result.content
}

/**
 * 规则二：长度上限。
 * 截断的关键不是「砍掉」，而是「留下取回的路」——
 * 结尾必须写清楚被砍了多少、用什么标识可以再取一次，否则 Agent 会以为它看到的就是全部。
 */
export function applyLengthCap(content: string, ref: string, maxChars: number): string {
  // 练习 2：超过 maxChars 就截断。
  // 提示：截断的关键不是「砍掉」，是「留下取回的路」——
  // 结尾要写清楚被砍了多少字符、用什么标识可以再取一次（ref 就是这个标识）。
  void ref
  void maxChars
  return content
}

/**
 * 规则三：陈旧结果丢弃。
 * 只有最近 keepRecent 次工具结果留原文，更早的换成一行占位说明。
 * 这是最便宜的一条规则：不需要模型参与，纯按位置删，且删掉的是「模型早就读过并已经用掉」的内容。
 */
export function dropStale(
  results: ToolResult[],
  keepRecent: number
): { result: ToolResult; stale: boolean }[] {
  // 练习 3：只有最近 keepRecent 条留原文，更早的标成 stale。
  // 提示：算出第一条该保留的下标，之前的全部为 true。
  void keepRecent
  return results.map((result) => ({ result, stale: false }))
}

function staleePlaceholder(r: ToolResult): string {
  // 练习 4：占位说明要带上工具名、调用参数与 ref。
  // 少了这三样，模型只知道「这里曾经有东西」，却不知道是什么、也没法再取一次——
  // 把 KEEP_RECENT 调到 1 跑一遍，你会看到关键事实存活检查直接变红。
  void r
  return '[已清理]'
}

type Row = { ref: string; tool: string; before: number; after: number; how: string }

export function trimAll(results: ToolResult[]): { rows: Row[]; trimmed: string[] } {
  const rows: Row[] = []
  const trimmed: string[] = []

  for (const { result, stale } of dropStale(results, KEEP_RECENT)) {
    const before = estimateTokens(result.content)
    let content: string
    let how: string

    if (stale) {
      content = staleePlaceholder(result)
      how = '陈旧丢弃'
    } else {
      const afterWhitelist = applyFieldWhitelist(result)
      const capped = applyLengthCap(afterWhitelist, result.ref, MAX_CHARS)
      content = capped
      const usedWhitelist = afterWhitelist.length !== result.content.length
      const usedCap = capped.length !== afterWhitelist.length
      how =
        [usedWhitelist ? '字段白名单' : '', usedCap ? '长度上限' : '']
          .filter(Boolean)
          .join(' + ') || '原样保留'
    }

    trimmed.push(content)
    rows.push({ ref: result.ref, tool: result.tool, before, after: estimateTokens(content), how })
  }

  return { rows, trimmed }
}

export function checkRetention(trimmed: string[]): { label: string; ok: boolean }[] {
  const joined = trimmed.join('\n')
  return KEY_FACTS.map((f) => ({ label: f.label, ok: joined.includes(f.needle) }))
}

function width(s: string): number {
  return [...s].reduce((w, c) => w + (/[一-鿿　-〿＀-￯]/.test(c) ? 2 : 1), 0)
}
function pad(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - width(s)))
}

function main() {
  const results = loadToolResults(HUGE)
  const { rows, trimmed } = trimAll(results)

  console.log(
    `配置：保留最近 ${KEEP_RECENT} 次工具结果，单条上限 ${MAX_CHARS} 字符${HUGE ? '，已注入一条超长日志' : ''}`
  )
  console.log('')
  console.log(
    `${pad('ref', 8)}${pad('工具', 20)}${pad('裁剪前', 10)}${pad('裁剪后', 10)}${pad('省了', 10)}用了哪条规则`
  )
  console.log('-'.repeat(78))
  for (const r of rows) {
    const saved = r.before === 0 ? 0 : ((r.before - r.after) / r.before) * 100
    console.log(
      `${pad(r.ref, 8)}${pad(r.tool, 20)}${pad(String(r.before), 10)}${pad(String(r.after), 10)}${pad(saved.toFixed(1) + '%', 10)}${r.how}`
    )
  }
  const before = rows.reduce((s, r) => s + r.before, 0)
  const after = rows.reduce((s, r) => s + r.after, 0)
  console.log('-'.repeat(78))
  const totalSaved = before === 0 ? 0 : ((before - after) / before) * 100
  console.log(
    `${pad('合计', 28)}${pad(String(before), 10)}${pad(String(after), 10)}${pad(totalSaved.toFixed(1) + '%', 10)}`
  )

  console.log('')
  console.log('关键事实存活检查：')
  const checks = checkRetention(trimmed)
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.label}`)
  const failed = checks.filter((c) => !c.ok).length
  console.log('')
  if (failed === 0) {
    console.log(`裁掉了 ${totalSaved.toFixed(1)}% 的 token，${checks.length} 条关键事实一条没丢。`)
  } else {
    console.log(
      `裁掉了 ${totalSaved.toFixed(1)}% 的 token，但丢了 ${failed} 条关键事实——裁过头了。`
    )
    process.exitCode = 1
  }
}

main()
