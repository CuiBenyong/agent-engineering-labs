// D7 实验（solution）：一条命令跑完六个环节，打印一张按环节摊开的账单。
// 这一天故意不做重试、不做续跑、不做缓存——把痛点原样留给 D8。

import 'dotenv/config'
import { buildBill, printBill } from './billing.js'
import { runGraph, topoSort, type NodeReport, type TaskNode } from './dag.js'
import { ensureFfmpeg } from './ffmpeg.js'
import { createProviders, isMock } from './providers/index.js'
import { warnIfPaidOutputInRepo, Run, newRunId } from './run.js'
import { buildStages } from './stages.js'

const IDEA = process.argv.slice(2).join(' ') || '外卖小哥捡到一部会预知未来的手机'
const EPISODE = 1

const QUALITY_CHECKLIST = [
  '同一个角色在四镜里是不是同一张脸（跨镜一致性）',
  '每句台词说完之前，画面有没有提前切走（音画同步）',
  '字幕有没有顶到画面上下两端的安全区',
  '封面那一帧看不看得出这一集在讲什么',
  '整条片子有没有哪一镜明显比别的镜暗、糊、或者色调不对',
]

async function main() {
  warnIfPaidOutputInRepo()
  await ensureFfmpeg()
  const providers = createProviders()
  const run = new Run(newRunId())
  await run.init()

  const stages = buildStages({ idea: IDEA, episode: EPISODE, run, providers })
  console.log(`模式：${isMock() ? 'MOCK 离线占位' : `真实厂商 ${providers.video.name}`}`)
  console.log(`一句话：${IDEA}`)
  console.log(`产物目录：${run.dir}`)
  console.log(
    `环节顺序：${topoSort(stages)
      .map((n) => n.id)
      .join(' → ')}\n`
  )

  const { reports, failedAt } = await runSequential(stages)

  const bill = buildBill(reports, run.costs)
  await run.save({ idea: IDEA, episode: EPISODE, nodes: reports, bill, failedAt })
  printBill(bill)

  if (failedAt) {
    printFailureReport(failedAt, run, bill)
    process.exitCode = 1
    return
  }

  console.log(`\n成片：${run.path('output', `episode-${EPISODE}.mp4`)}`)
  console.log('\n看片检查清单（这一步没有自动化，只能你自己看）：')
  for (const item of QUALITY_CHECKLIST) console.log(`  [ ] ${item}`)
  console.log('\n三个脆弱点，以及第二周分别在哪一天解决：')
  for (const line of WEAKNESSES) console.log(`  · ${line}`)
}

/**
 * 练习 2：现在直接用 D1 的 runGraph，它一抛错就整个 reject——
 * 前面几个环节的耗时与花费全丢了，而失败时最该看的恰恰是「到这一步为止已经烧了多少」。
 * 改成用 topoSort 自己走一遍，边跑边把 NodeReport 记进数组，
 * 出错时返回已经记下的部分和失败的节点 id。
 * 提示一：失败的那一环也要推一条 report 进去，它往往已经调过一两次付费接口了，
 *         这笔钱既没换来可用的产物，也最容易在复盘时被漏掉。
 * 提示二：这一天要的仍然是最笨的做法——记完就停，不要顺手加重试或者续跑，那是 D8 的事。
 */
async function runSequential(
  stages: TaskNode[]
): Promise<{ reports: NodeReport[]; failedAt?: string }> {
  void topoSort
  const reports = await runGraph(stages)
  return { reports }
}

const WEAKNESSES = [
  '任意一步失败就要从头再跑，前面已经付过钱的产物白扔 —— D8 的工作流引擎（幂等 + 断点续跑）',
  '六个环节串成一条直线，一集跑多久就是六段耗时相加，多集只能排队 —— D9 的并发与配额',
  '成片好不好只能靠人眼看，而且看完也没有地方记 —— D10 的审核台与 D11 的质检',
]

function printFailureReport(failedAt: string, run: Run, bill: ReturnType<typeof buildBill>) {
  const spent = bill.reduce((s, l) => s + l.estimatedCny, 0)
  const artifacts = bill.reduce((s, l) => s + l.artifacts, 0)
  console.log('\n痛点报告')
  console.log(`  失败环节：${failedAt}`)
  console.log(`  已经产生的产物：${artifacts} 个，它们还好好地躺在 ${run.dir} 里`)
  console.log(`  已经花掉的折算金额：¥${spent.toFixed(4)}`)
  console.log('  现在唯一的办法：把整条命令从头再跑一遍。')
  console.log(
    '  于是上面那 ¥' + spent.toFixed(4) + ' 会被原封不动再花一次，而且是必然的，不是偶然的。'
  )
  console.log('  这一天故意不修它——记住这个数字，D8 会把它变成 0。')
}

main().catch((err: unknown) => {
  console.error(`\n失败：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
