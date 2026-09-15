// D8 实验（solution）：把 D7 那条顺序脚本换成一个有状态的工作流引擎。
// 验收看三件事：第二次运行付费调用为 0；注入失败后续跑只补下游；台账按节点分列。

import 'dotenv/config'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureFfmpeg } from './ffmpeg.js'
import { buildNodes, publishOutputs } from './nodes.js'
import { runWorkflow, type WorkflowResult } from './dag.js'
import { createProviders, isMock, type CostEntry, type Providers } from './providers/index.js'
import { warnIfPaidOutputInRepo, Run, WORK_DIR } from './run.js'

const IDEA = process.env.IDEA ?? '外卖小哥捡到一部会预知未来的手机'
const EPISODE = 1
/** 续跑就是「同一个 runId 再来一遍」。省略时用一个固定 id，方便反复演示。 */
const RUN_ID = process.env.RUN_ID ?? 'run-demo-001'

/**
 * 给四个 provider 套一层计数。
 * 「第二次运行没有重复调用付费接口」这句话必须能被证明，而不是靠日志里没打出来。
 */
function countingProviders(providers: Providers, counter: { calls: number }): Providers {
  const count =
    <A, R>(fn: (a: A) => Promise<R>) =>
    (a: A) => {
      counter.calls += 1
      return fn(a)
    }
  return {
    text: { ...providers.text, complete: count(providers.text.complete.bind(providers.text)) },
    image: { ...providers.image, generate: count(providers.image.generate.bind(providers.image)) },
    video: { ...providers.video, generate: count(providers.video.generate.bind(providers.video)) },
    tts: { ...providers.tts, synthesize: count(providers.tts.synthesize.bind(providers.tts)) },
  }
}

function printLedger(result: WorkflowResult, costs: CostEntry[]) {
  const label: Record<string, string> = {
    executed: '执行',
    cache: '缓存',
    none: '未跑',
  }
  console.log('\n台账（按节点）')
  console.log('  节点       状态  来源    耗时   付费调用   折算花费   指纹')
  let totalMs = 0
  let totalCny = 0
  let totalCalls = 0
  for (const id of result.order) {
    const r = result.state.nodes[id]
    if (!r) continue
    totalMs += r.ms
    totalCny += r.costCny
    totalCalls += r.calls
    const status = r.status === 'done' ? '✅' : r.status === 'failed' ? '❌' : '⏸'
    console.log(
      `  ${id.padEnd(9)}${status}    ${label[r.source]}` +
        `${String(r.ms).padStart(6)}ms ${String(r.calls).padStart(8)}   ¥${r.costCny.toFixed(4).padStart(8)}   ${r.fingerprint}`
    )
  }
  console.log(
    `  合计           ${' '.repeat(4)}${String(totalMs).padStart(6)}ms ${String(totalCalls).padStart(8)}   ¥${totalCny.toFixed(4).padStart(8)}`
  )
  const byKind = new Map<string, number>()
  for (const c of costs) byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + c.costCny)
  if (byKind.size > 0) {
    console.log(
      `  本次真实调用明细：${[...byKind].map(([k, v]) => `${k} ¥${v.toFixed(4)}`).join('，')}`
    )
  }
}

async function main() {
  warnIfPaidOutputInRepo()
  await ensureFfmpeg()
  const counter = { calls: 0 }
  const providers = countingProviders(createProviders(), counter)
  const run = new Run(RUN_ID)
  await run.init()

  console.log(`模式：${isMock() ? 'MOCK 离线占位' : `真实厂商 ${providers.video.name}`}`)
  console.log(`一句话：${IDEA}`)
  console.log(`运行标识：${RUN_ID}`)
  console.log(`状态文件：${run.path('state.json')}`)
  console.log(`产物缓存：${join(WORK_DIR, 'cache')}\n`)

  const nodes = buildNodes(IDEA, providers)
  const result = await runWorkflow(nodes, {
    runId: RUN_ID,
    statePath: run.path('state.json'),
    cacheDir: join(WORK_DIR, 'cache'),
    callCount: () => counter.calls,
    onCost: (entry) => run.record(entry),
  })

  printLedger(result, run.costs)
  await run.save({ idea: IDEA, episode: EPISODE, state: result.state, failedAt: result.failedAt })

  if (result.failedAt) {
    console.log(`\n❌ 停在 ${result.failedAt}。它之前的节点状态已经落盘，产物还在缓存里。`)
    console.log(`   去掉 INJECT 再跑同一条命令，引擎只会从 ${result.failedAt} 往后补：`)
    console.log(`   RUN_ID=${RUN_ID} MOCK=1 pnpm start`)
    process.exitCode = 1
    return
  }

  await mkdir(run.path('output'), { recursive: true })
  const published = await publishOutputs(result.dirs.compose, run.path('output'), EPISODE)
  console.log(`\n✅ 成片：${published[0]}`)
  console.log(`   本次付费接口调用 ${counter.calls} 次。`)
  console.log('   再跑一遍同一条命令：调用次数应当是 0，因为每个节点的指纹都没变。')
}

main().catch((err: unknown) => {
  console.error(`\n失败：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
