import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

// D5 实验：把 claude -p 包成一条能进 CI 的命令。
// 三道锁：权限（--permission-mode dontAsk + --permission-prompts none）、预算（--max-turns / --max-budget-usd）、
// 可复现（--bare + --no-session-persistence，提示词与 system prompt 都在这个文件里进版本控制）。

const MAX_TURNS = Number(process.env.MAX_TURNS ?? 6)
const MAX_BUDGET_USD = Number(process.env.MAX_BUDGET_USD ?? 0.5)
const BASE_REF = process.env.BASE_REF ?? 'main'

const SYSTEM =
  '你是一名安全审查员。只报告漏洞、正确性问题与明确违反需求的地方，不评论风格。每条给出文件与行号。'
const PROMPT = `下面是一个 pull request 相对于 ${BASE_REF} 的 diff。审查它，按严重程度列出问题；没有问题就只回答「未发现问题」。`

/** claude -p --output-format json 的结果里我们用到的字段 */
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

/** 拼出带三道锁的参数；提示词走 stdin 管道（diff 也一起喂进去），所以这里没有位置参数 */
export function buildArgs(): string[] {
  return [
    '--bare', // 可复现：不加载本机 hooks / skills / 插件 / MCP / CLAUDE.md，也防陌生仓库的 hook 在 CI 上跑
    '-p',
    '--output-format',
    'json',
    '--permission-mode',
    'dontAsk', // 权限：白名单外一律拒绝；这里连白名单都没给，它只能读 stdin 里的 diff
    '--permission-prompts',
    'none', // 本来要问人的动作直接拒掉并告诉模型别重试
    '--max-turns',
    String(MAX_TURNS), // 预算：轮数
    '--max-budget-usd',
    String(MAX_BUDGET_USD), // 预算：花费
    '--no-session-persistence', // 不落盘会话
    '--append-system-prompt',
    SYSTEM,
  ]
}

/** 从 JSON 判成败：出错 → 轮数耗尽 → 超预算 → 成功，顺序很重要（轮数耗尽也会带 is_error） */
export function parseResult(raw: string): { result: ClaudeResult; verdict: Verdict } {
  const result = JSON.parse(raw) as ClaudeResult
  const cost = result.total_cost_usd ?? 0
  let verdict: Verdict
  if (result.subtype === 'error_max_turns') {
    verdict = {
      ok: false,
      lock: 'turns',
      reason: `轮数耗尽（max-turns=${MAX_TURNS}）：任务没有在预算内结束`,
    }
  } else if (result.is_error) {
    verdict = {
      ok: false,
      lock: 'error',
      reason: `claude 返回错误（${result.subtype}）：${result.result ?? '无详情'}`,
    }
  } else if (cost > MAX_BUDGET_USD) {
    verdict = {
      ok: false,
      lock: 'budget',
      reason: `花费 $${cost.toFixed(4)} 超过预算 $${MAX_BUDGET_USD}`,
    }
  } else {
    verdict = { ok: true, summary: result.result ?? '' }
  }
  return { result, verdict }
}

/** 唯一的外部出口：真跑 claude -p，或 MOCK=1 时返回固定场景 */
function runClaude(diff: string): string {
  if (process.env.MOCK === '1') return mockResult(process.env.MOCK_SCENARIO ?? 'success')

  if (!process.env.ANTHROPIC_API_KEY)
    throw new Error('缺少 ANTHROPIC_API_KEY（--bare 不读订阅登录；或用 MOCK=1 离线运行）')
  const args = buildArgs()
  console.log(`$ claude ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`)
  const res = spawnSync('claude', args, {
    input: `${PROMPT}\n\n<diff>\n${diff}\n</diff>`, // D1 的习惯：材料用标签包起来
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (res.error)
    throw new Error(`无法启动 claude：${res.error.message}（没装 Claude Code？可用 MOCK=1）`)
  if (!res.stdout.trim()) throw new Error(`claude 没有输出（exit ${res.status}）：${res.stderr}`)
  return res.stdout
}

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
        '1. [高] src/routes/todos.ts:18 请求体被直接展开进对象，客户端可覆盖 id 与 done。\n2. [中] src/routes/todos.ts:17 title 没有长度上限。\n3. [低] test/todos.test.ts 缺少非法 dueAt 的用例。\n（离线模拟结果：去掉 MOCK=1 才会真的调用 claude -p）',
    },
    'over-budget': {
      ...base,
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 6,
      total_cost_usd: 1.87,
      result: '（模拟：任务完成了，但花费超过预算）',
    },
    'max-turns': {
      ...base,
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      num_turns: 6,
      total_cost_usd: 0.31,
      result: '（模拟：达到 max-turns 上限）',
    },
    error: {
      ...base,
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      num_turns: 1,
      total_cost_usd: 0.002,
      result: 'Not logged in（模拟：认证失败）',
    },
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
  writeFileSync('review.json', raw) // CI 的下一步用 jq 取 .result 贴回 PR

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
