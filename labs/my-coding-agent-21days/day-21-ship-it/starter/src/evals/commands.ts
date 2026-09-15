/**
 * 评估相关的三条斜杠命令。本天新增。
 *
 *   /eval    跑一轮基准集（--repeat=3 同一题跑三次、--task=id 只跑一题）
 *   /evals   列出磁盘上已有的评估
 *   /panel   起评估面板
 */
import type { Command } from '../commands.js'
import { runBenchmark } from './run.js'
import { TASKS, findTask } from './tasks.js'
import { formatReport, listReportIds, loadReport, saveReport, spread } from './report.js'
import { startPanel, PANEL_PORT } from './panel.js'
import type { Panel } from './panel.js'

/** 一个进程只起一个面板：再起一个会撞端口，而报错信息看不出是自己撞的 */
let panel: Panel | null = null

function parseFlags(args: string): { repeat: number; taskId: string | null } {
  const repeat = Number(/--repeat=(\d+)/.exec(args)?.[1] ?? 1)
  return { repeat: Math.max(1, repeat), taskId: /--task=([\w-]+)/.exec(args)?.[1] ?? null }
}

export const EVAL_COMMANDS: Command[] = [
  {
    name: 'eval',
    help: '跑一轮基准集（/eval --repeat=3 同一题跑三次，/eval --task=fix-divide 只跑一题）',
    run: async (args, session) => {
      const { repeat, taskId } = parseFlags(args)
      const task = taskId ? findTask(taskId) : null
      if (taskId && !task) {
        session.out(`没有这道题：${taskId}（有 ${TASKS.map((t) => t.id).join('、')}）`)
        return true
      }
      session.out(`开始评估：${task ? 1 : TASKS.length} 道题，每题跑 ${repeat} 次…`)
      const report = await runBenchmark({
        ...(task ? { tasks: [task] } : {}),
        repeat,
        onProgress: session.out,
      })
      const file = await saveReport(report)
      for (const line of formatReport(report)) session.out(line)
      if (repeat > 1) {
        // 抖动只有重复跑才谈得上。离线下它应该是 0——这本身就是一个结论
        for (const variant of report.variants) {
          const jitter = spread(variant.attempts.map((a) => a.totalTokens))
          session.out(
            `  [${variant.variantId}] token 极差占均值 ${jitter === null ? '（只跑了一次）' : `${(jitter * 100).toFixed(1)}%`}`
          )
        }
      }
      session.out(`  报告已落盘：${file}`)
      return true
    },
  },
  {
    name: 'evals',
    help: '列出磁盘上已有的评估',
    run: async (_args, session) => {
      const ids = await listReportIds()
      if (ids.length === 0) session.out('  还没跑过评估（/eval 跑一轮）')
      for (const id of ids.slice(0, 10)) {
        const report = await loadReport(id)
        const first = report?.variants[0]?.summary
        session.out(
          `  ${id}  ${report?.mode ?? '?'}  ${first ? `通过率 ${(first.passRate * 100).toFixed(1)}%` : ''}`
        )
      }
      return true
    },
  },
  {
    name: 'panel',
    help: `起评估面板（端口 ${PANEL_PORT}）`,
    run: async (_args, session) => {
      if (panel) {
        session.out(`  面板已经在跑：${panel.url}`)
        return true
      }
      panel = await startPanel()
      session.out(`  面板已启动：${panel.url}（退出 REPL 时会自动关掉）`)
      return true
    },
  },
]

/** 退出时收摊。不关的话进程不会退出，端口 3120 也一直被占着 */
export async function shutdownPanel(): Promise<void> {
  await panel?.close()
  panel = null
}
