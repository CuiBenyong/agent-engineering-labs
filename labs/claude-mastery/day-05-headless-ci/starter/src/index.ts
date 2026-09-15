import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

// D5 实验：把 claude -p 包成一条能进 CI 的命令。你要补三个练习点：拼参数、解析结果、让三种 MOCK 场景各得其所。

const MAX_TURNS = Number(process.env.MAX_TURNS ?? 6)
const MAX_BUDGET_USD = Number(process.env.MAX_BUDGET_USD ?? 0.5)
const BASE_REF = process.env.BASE_REF ?? 'main'

const SYSTEM =
  '你是一名安全审查员。只报告漏洞、正确性问题与明确违反需求的地方，不评论风格。每条给出文件与行号。'
const PROMPT = `下面是一个 pull request 相对于 ${BASE_REF} 的 diff。审查它，按严重程度列出问题；没有问题就只回答「未发现问题」。`

interface ClaudeResult {
  type: 'result'
  subtype: string // success / error_max_turns / error_during_execution …
  is_error: boolean
  result?: string
  session_id?: string
  num_turns?: number
  duration_ms?: number
  total_cost_usd?: number
  permission_denials?: unknown[]
}

type Verdict =
  { ok: true; summary: string } | { ok: false; lock: 'error' | 'budget' | 'turns'; reason: string }

/**
 * 练习 1：拼出带三道锁的 claude 参数（提示词与 diff 走 stdin，所以没有位置参数）。
 *   可复现：--bare、--no-session-persistence
 *   输出：  -p、--output-format json
 *   权限：  --permission-mode dontAsk、--permission-prompts none
 *   预算：  --max-turns MAX_TURNS、--max-budget-usd MAX_BUDGET_USD
 *   名片：  --append-system-prompt SYSTEM
 * 提示：每个参数和它的值是数组里相邻的两个元素；数字要 String()。
 */
export function buildArgs(): string[] {
  void MAX_TURNS
  void MAX_BUDGET_USD
  void SYSTEM
  return ['-p'] // 现在只有 -p：没有任何锁，真跑会是交互式默认权限 + 无预算
}

/**
 * 练习 2：从 JSON 判成败。顺序很重要——
 *   subtype === 'error_max_turns' → lock 'turns'
 *   is_error                      → lock 'error'（带 subtype 与 result）
 *   total_cost_usd > MAX_BUDGET_USD → lock 'budget'
 *   否则 ok，summary 取 result
 * 提示：轮数耗尽时 is_error 也是 true，所以要先判它，否则报错原因会不准。
 */
export function parseResult(raw: string): { result: ClaudeResult; verdict: Verdict } {
  const result = JSON.parse(raw) as ClaudeResult
  // 现在一律判「通过」——MOCK_SCENARIO=error / over-budget 也会显示 ✅，这就是要改的地方
  return {
    result,
    verdict: { ok: true, summary: result.result ?? '（练习未完成：parseResult 还没有判断成败）' },
  }
}

function runClaude(diff: string): string {
  if (process.env.MOCK === '1') return mockResult(process.env.MOCK_SCENARIO ?? 'success')

  if (!process.env.ANTHROPIC_API_KEY)
    throw new Error('缺少 ANTHROPIC_API_KEY（--bare 不读订阅登录；或用 MOCK=1 离线运行）')
  const args = buildArgs()
  console.log(`$ claude ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`)
  const res = spawnSync('claude', args, {
    input: `${PROMPT}\n\n<diff>\n${diff}\n</diff>`,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (res.error)
    throw new Error(`无法启动 claude：${res.error.message}（没装 Claude Code？可用 MOCK=1）`)
  if (!res.stdout.trim()) throw new Error(`claude 没有输出（exit ${res.status}）：${res.stderr}`)
  return res.stdout
}

/**
 * 练习 3：补齐 'over-budget'、'max-turns'、'error' 三个场景（success 已给出），
 *   让它们分别触发 parseResult 里的三把锁。字段参考 ClaudeResult。
 */
function mockResult(scenario: string): string {
  const base = { type: 'result', session_id: 'mock-session', duration_ms: 12345 }
  const scenarios: Record<string, ClaudeResult> = {
    success: {
      ...base,
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 3,
      total_cost_usd: 0.0421,
      result:
        '1. [高] src/routes/todos.ts:18 请求体被直接展开进对象，客户端可覆盖 id 与 done。\n2. [中] src/routes/todos.ts:17 title 没有长度上限。\n（离线模拟结果）',
    },
    // 'over-budget': { ... subtype 'success'、is_error false、total_cost_usd 1.87 ... },
    // 'max-turns':   { ... subtype 'error_max_turns'、is_error true ... },
    // 'error':       { ... subtype 'error_during_execution'、is_error true、result 'Not logged in' ... },
  }
  const r = scenarios[scenario]
  if (!r)
    throw new Error(`未知的 MOCK_SCENARIO=${scenario}，可选：${Object.keys(scenarios).join(' / ')}`)
  return JSON.stringify(r)
}

function getDiff(): string {
  if (process.env.MOCK === '1') return '（MOCK 模式下不读 git diff）'
  const res = spawnSync('git', ['diff', BASE_REF], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (res.status !== 0) throw new Error(`git diff ${BASE_REF} 失败：${res.stderr}`)
  return res.stdout
}

function main(): void {
  console.log(
    `三道锁：permission-mode=dontAsk  max-turns=${MAX_TURNS}  max-budget-usd=${MAX_BUDGET_USD}  bare=true${process.env.MOCK === '1' ? `  （MOCK 场景：${process.env.MOCK_SCENARIO ?? 'success'}）` : ''}\n`
  )
  const raw = runClaude(getDiff())
  const { result, verdict } = parseResult(raw)
  writeFileSync('review.json', raw)

  console.log(
    `subtype=${result.subtype}  is_error=${result.is_error}  turns=${result.num_turns ?? '?'}  cost=$${(result.total_cost_usd ?? 0).toFixed(4)}  session=${result.session_id ?? '-'}`
  )
  if (verdict.ok) {
    console.log('\n审查结果：\n' + verdict.summary)
    console.log('\n✅ 通过：已写入 review.json')
    return
  }
  console.error(`\n❌ 失败（触发的锁：${verdict.lock}）：${verdict.reason}`)
  process.exit(1)
}

main()
