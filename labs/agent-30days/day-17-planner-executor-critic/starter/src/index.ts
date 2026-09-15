import 'dotenv/config'
import { runGraph, type RunResult, type ReducerMode } from './graph'
import { duplicateIds } from './shared/reducers'
import { EXECUTOR_CONCURRENCY, MAX_REVIEW_ROUNDS, TOOL_BUDGET } from './shared/roles'
import { preview, type Task } from './shared/state'

const results: boolean[] = []

// 五项自检的标题与失败提示，提示逐条对应 starter 里的练习点
const ITEMS: [string, string][] = [
  ['concat reducer 下的重复写入', '这一项不依赖练习，它演示的就是要修的现象'],
  [
    '按 id 原地更新的 reducer',
    'upsertWorkspace 还是 concat：并行写完工作区里会留下同 id 的两份（练习 1）',
  ],
  ['toolBudget 耗尽时降级', 'runTask 还没检查预算，子任务想调多少次工具就调多少次（练习 2）'],
  ['Critic 打回与重试上限', 'criticNode 从不打回：缺了验收要求的产出也照样放行（练习 3）'],
  [
    '一个子任务失败不影响其他',
    'executorNode 没接住工具异常，一件活失败会让整张图一起 reject（练习 4）',
  ],
]

function check(n: number, ok: boolean, detail: string): void {
  results.push(ok)
  const [label, hint] = ITEMS[n - 1]
  console.log(`[${n}/5] ${label}：${detail} ${ok ? '✅' : `❌ ${hint}`}`)
}

const REQUESTS = {
  clean: '订单 SO20260901 现在什么状态、物流到哪了、收货地址还能改吗',
  budget: '帮订单 SO20260901 开一张发票，顺便看看物流到哪了',
  redo: '订单 SO20260901 我要退款，另外告诉我物流到哪了',
  loop: '我要投诉，请升级人工处理',
  partial: '订单 SO20260901 商品破损了，同时帮我查物流',
}

function taskOf(run: RunResult, kind: string): Task | undefined {
  return [...run.final.workspace].reverse().find((t) => t.id.endsWith(`-${kind}`))
}

function printTrace(run: RunResult): void {
  for (const step of run.trace) {
    console.log(`    ${step.node.padEnd(9)} 写入 [${step.changed.join(', ')}] ${step.detail}`)
  }
}

/** 出错时把异常变成一条可读的失败信息，而不是让自检整个中断。 */
async function attempt(request: string, mode: ReducerMode = 'upsert'): Promise<RunResult | Error> {
  try {
    return await runGraph(request, mode)
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

async function selfTest(): Promise<number> {
  // ---- 1. 先看见问题：concat reducer 下并行写同一个字段会发生什么 ----
  console.log(`\n请求：${REQUESTS.clean}`)
  console.log('（一）workspace 通道配 concat reducer —— 也就是 D15 那一份：')
  const concat = await attempt(REQUESTS.clean, 'concat')
  if (concat instanceof Error) {
    check(1, false, `图直接抛了异常：${concat.message}`)
  } else {
    printTrace(concat)
    const stale = concat.final.workspace.find((t) => t.id.endsWith('-shipping'))
    const ok1 = concat.final.workspace.length > 3 && concat.duplicates.length > 0
    console.log(
      `    并发峰值 ${concat.peak}（上限 ${EXECUTOR_CONCURRENCY}），` +
        `第一条 ${stale?.id} 读到的状态是 ${stale?.status}`
    )
    check(
      1,
      ok1,
      `3 件子任务写出 ${concat.final.workspace.length} 条记录，重复 id ${concat.duplicates.join(' ')}；` +
        `按 id 查第一条拿到的是过期的 ${stale?.status} 版本`
    )
  }

  // ---- 2. 换成按 id 原地更新的 reducer，节点代码一行没动 ----
  console.log('\n（二）同一张图，只把 workspace 的 reducer 换成按 id 原地更新：')
  const upsert = await attempt(REQUESTS.clean, 'upsert')
  if (upsert instanceof Error) {
    check(2, false, `图直接抛了异常：${upsert.message}`)
  } else {
    printTrace(upsert)
    const fresh = upsert.final.workspace.find((t) => t.id.endsWith('-shipping'))
    const ok2 =
      upsert.final.workspace.length === 3 &&
      duplicateIds(upsert.final.workspace).length === 0 &&
      upsert.final.workspace.every((t) => t.status === 'done')
    check(
      2,
      ok2,
      `工作区 ${upsert.final.workspace.length} 条、重复 id ${duplicateIds(upsert.final.workspace).length} 个，` +
        `按 id 查拿到的是 ${fresh?.status} 版本`
    )
  }

  // ---- 3. toolBudget：需要 7 步的子任务撞上 5 次上限 ----
  console.log(`\n请求：${REQUESTS.budget}`)
  const budget = await attempt(REQUESTS.budget)
  if (budget instanceof Error) {
    check(3, false, `预算耗尽把异常抛出来了：${budget.message}`)
  } else {
    const invoice = taskOf(budget, 'invoice')
    const shipping = taskOf(budget, 'shipping')
    console.log(`    开票子任务 → ${invoice?.result}`)
    const ok3 =
      invoice?.toolCalls === TOOL_BUDGET &&
      invoice.status === 'failed' &&
      budget.final.degraded &&
      shipping?.status === 'done'
    check(
      3,
      ok3,
      `开票用了 ${invoice?.toolCalls} 次工具（预算 ${TOOL_BUDGET}）、状态 ${invoice?.status}、` +
        `degraded=${budget.final.degraded}，同一轮的物流子任务 ${shipping?.status}`
    )
  }

  // ---- 4. 评审回路：打回一次能改好；改不好的最多打回两次就停 ----
  console.log(`\n请求：${REQUESTS.redo}`)
  const redo = await attempt(REQUESTS.redo)
  console.log(`请求：${REQUESTS.loop}`)
  const loop = await attempt(REQUESTS.loop)
  if (redo instanceof Error || loop instanceof Error) {
    const err = redo instanceof Error ? redo : (loop as Error)
    check(
      4,
      false,
      `评审回路抛了异常：${err.message}` +
        (/[Rr]ecursion/.test(err.message)
          ? '（打回没有上限，图在 critic 与 executor 之间无限打转，最后撞上 LangGraph 的 recursionLimit）'
          : '')
    )
  } else {
    printTrace(loop)
    const refund = taskOf(redo, 'refund')
    const ship = taskOf(redo, 'shipping')
    const complaint = taskOf(loop, 'complaint')
    const runs = loop.trace.filter((s) => s.node === 'executor').length
    console.log(`    退款子任务 → ${refund?.result}`)
    console.log(`    投诉子任务 → ${complaint?.result}`)
    const ok4 =
      redo.final.reviewRounds === 1 &&
      refund?.status === 'done' &&
      ship?.toolCalls === 2 &&
      !redo.final.degraded &&
      loop.final.reviewRounds === MAX_REVIEW_ROUNDS &&
      runs === MAX_REVIEW_ROUNDS + 1 &&
      complaint?.status === 'failed' &&
      loop.final.degraded
    check(
      4,
      ok4,
      `退款打回 ${redo.final.reviewRounds} 次后 ${refund?.status}（物流子任务没被连坐重跑，仍是 ${ship?.toolCalls} 次工具）；` +
        `投诉打回 ${loop.final.reviewRounds} 次、共执行 ${runs} 次后停下，degraded=${loop.final.degraded}`
    )
  }

  // ---- 5. 部分失败：理赔服务 503，物流子任务照样交付 ----
  console.log(`\n请求：${REQUESTS.partial}`)
  const partial = await attempt(REQUESTS.partial)
  if (partial instanceof Error) {
    check(5, false, `一件子任务失败让整张图 reject 了：${partial.message}`)
  } else {
    const damage = taskOf(partial, 'damage')
    const alive = taskOf(partial, 'shipping')
    console.log(`    理赔子任务 → ${damage?.result}`)
    console.log(`    物流子任务 → ${alive?.result}`)
    const ok5 = damage?.status === 'failed' && alive?.status === 'done' && partial.final.degraded
    check(
      5,
      ok5,
      `理赔 ${damage?.status}、物流 ${alive?.status}、degraded=${partial.final.degraded}，图没有整体 reject`
    )
    const last = partial.final.messages.at(-1)
    console.log(`\n最终回复：\n${last && typeof last.content === 'string' ? last.content : '(空)'}`)
  }

  const passed = results.filter(Boolean).length
  console.log(`\n自检结果：${passed}/${results.length} 项通过`)
  return passed === results.length ? 0 : 1
}

async function demo(): Promise<void> {
  const question = process.argv[2] ?? REQUESTS.redo
  const run = await runGraph(question)
  console.log(`问：${question}\n`)
  printTrace(run)
  console.log(
    `\n并发峰值 ${run.peak}｜打回 ${run.final.reviewRounds} 次｜degraded=${run.final.degraded}`
  )
  console.log(`\n${run.final.messages.map(preview).join('\n')}`)
  const last = run.final.messages.at(-1)
  console.log(`\n答：\n${last && typeof last.content === 'string' ? last.content : '(空)'}`)
}

const exitCode = process.env.SELFTEST === '1' ? await selfTest() : (await demo(), 0)
process.exit(exitCode)
