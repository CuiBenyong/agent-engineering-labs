/**
 * 执行阶段的一致性核对。本天新增。
 *
 * 批准一份计划之后最容易出的事不是「它不干」，而是**它干了别的**：
 * 计划里说改一个文件，实际改了三个；计划里说要跑测试验证，它改完就宣布成功。
 * 这两种偏离都不是错误——工具全部成功、循环正常结束、终端上一片对勾。
 * 所以偏离必须被**主动核对**出来，和第十二天那条压缩探针是同一个道理：
 * 静默的失败只能靠主动检查暴露。
 *
 * 采集用的是全课已经用过三次的「透明包装」形状（D7 的落盘、D12 的用量取样）：
 * 一个 async generator 把事件原样传下去，路过时顺手记一笔。
 * 好处是循环、渲染层、工具都不知道有核对这件事——**加一层观察不需要动任何一层实现**。
 *
 * 一条边界：核对只看**这一次执行**发生了什么，不看代码写得对不对。
 * 「改动是否正确」由计划里的 verify 那一条负责（跑测试），不是核对的活儿。
 */
import type { AgentEvent } from '../kernel/types.js'
import type { PlanState } from './mode.js'
import { plannedFiles, type Plan } from './plan.js'

/** 会改文件的工具。它们的 meta.path 就是实际动过的那个文件 */
const WRITE_TOOLS = new Set(['edit_file', 'create_file'])

/**
 * 透明包装：把事件原样传下去，顺手记下成功的写入与成功跑过的命令。
 *
 * 只记 ok 为真的：被门挡下来的、执行失败的都不算「实际改动」——
 * 那些是模型试过但没成的事，混进来会让核对表出现根本没被改过的文件。
 */
export async function* watchChanges(
  state: PlanState,
  events: AsyncIterable<AgentEvent>
): AsyncGenerator<AgentEvent> {
  const names = new Map<string, string>()
  for await (const event of events) {
    if (event.type === 'tool_start') names.set(event.call.id, event.call.name)
    if (event.type === 'tool_end' && event.result.ok) {
      const name = names.get(event.id) ?? ''
      const meta = event.result.meta ?? {}
      if (WRITE_TOOLS.has(name) && typeof meta.path === 'string') {
        state.writes.push({ tool: name, path: meta.path })
      }
      if (name === 'run_command' && typeof meta.command === 'string') {
        state.commands.push(meta.command)
      }
    }
    yield event
  }
}

export interface Reconciliation {
  /** 计划里列出的文件 */
  planned: string[]
  /** 实际改过的文件 */
  touched: string[]
  /** 计划里有、也真改了 */
  matched: string[]
  /** 改了但不在计划里——这是最要紧的一类偏离 */
  unplanned: string[]
  /** 计划里有但没动。可能是模型偷工，也可能是那一步本来就不需要了 */
  untouched: string[]
  /** verify 里提到的命令是否真的跑过。判据是「某条 verify 的文本里出现了跑过的命令」 */
  verified: boolean
  ok: boolean
}

export function reconcile(plan: Plan, state: PlanState): Reconciliation {
  const planned = plannedFiles(plan)
  const touched = [...new Set(state.writes.map((write) => write.path))].sort()
  const matched = touched.filter((file) => planned.includes(file))
  // TODO(5)：现在只算了「计划内的动了几个」，三样东西一个都没抓：
  //   unplanned  改了但不在计划里——这是最要紧的一类，也是审批机制存在的理由
  //   untouched  计划里有但没动——那一步是跳过了还是不需要了，得让人知道
  //   verified   计划里写的验证方式到底跑过没有。「改完了」不等于「做成了」
  // 三个都补上，ok 改成「没有计划外的、没有漏做的、而且验证跑过了」。
  // verified 的判据可以宽松：某条 verify 的文本里出现了 state.commands 里跑过的命令
  // 就算跑过——严格判据要逼模型把 verify 写成结构化命令列表，把提示词卡得太死，
  // 而这一条的用途只是提醒人「它没验证就宣布成功了」。
  const unplanned: string[] = []
  const untouched: string[] = []
  const verified = true
  return {
    planned,
    touched,
    matched,
    unplanned,
    untouched,
    verified,
    ok: touched.length > 0,
  }
}

/** 渲染核对表。偏离的每一项都要写清「所以呢」，不能只标一个叉 */
export function formatReconcile(result: Reconciliation): string[] {
  const lines = [
    `计划核对：计划改 ${result.planned.length} 个文件，实际改 ${result.touched.length} 个`,
  ]
  for (const file of result.matched) lines.push(`  ✔ ${file}（计划内）`)
  for (const file of result.unplanned) {
    lines.push(`  ⚠ ${file} 不在计划里——请让它说明为什么改了这个文件`)
  }
  for (const file of result.untouched) {
    lines.push(`  ⚠ ${file} 在计划里但没有被改动——那一步是跳过了还是不需要了`)
  }
  lines.push(
    result.verified
      ? '  ✔ 计划里的验证方式真的跑过了'
      : '  ⚠ 计划里写了验证方式，但没有跑过对应的命令——「改完了」不等于「做成了」'
  )
  return lines
}
