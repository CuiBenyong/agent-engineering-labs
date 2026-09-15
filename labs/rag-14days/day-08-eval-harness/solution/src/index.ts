import 'dotenv/config'
import { FAITHFUL_PASS } from './judge'
import { gate, loadBaseline, runEvaluation, writeReport, type Report } from './report'

/**
 * 一条命令跑完整套评估，输出一份可对比的报告文件。
 *
 *   MOCK=1 pnpm start     离线：哈希向量 + 确定性规则裁判，不需要任何 key
 *   pnpm start            真实：OpenAI 向量 + 模型裁判（要 OPENAI_API_KEY / ANTHROPIC_API_KEY）
 *   MOCK=1 GATE=1 pnpm start   跑完再跟 eval/baseline-report.json 比一遍，退步就以非 0 退出
 *
 * 最后一行的验收清单是 starter 的进度条：原样跑有几项是 ❌，做完练习全部变 ✅。
 */

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`

function printTable(rows: string[][]): void {
  const widths = rows[0].map((_, i) =>
    Math.max(
      ...rows.map((r) => [...r[i]].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 2 : 1), 0))
    )
  )
  for (const row of rows) {
    console.log(
      row
        .map((cell, i) => {
          const w = [...cell].reduce((acc, ch) => acc + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)
          return cell + ' '.repeat(Math.max(0, widths[i] - w))
        })
        .join('  ')
    )
  }
}

/** 造一份「召回率掉了 15 个点」的假报告，用来现场演示闸门会不会真的拦住 */
function degraded(report: Report): Report {
  return {
    ...report,
    retrieval: { ...report.retrieval, recall: report.retrieval.recall - 0.15 },
  }
}

async function main(): Promise<void> {
  const report = await runEvaluation()
  const { json, md } = writeReport(report)

  console.log(`\n语料 ${report.config.corpusDocs} 篇 / ${report.config.chunks} 块`)
  console.log(
    `题集 ${report.goldenSet.total} 题：single ${report.goldenSet.coverage.single}、multi ${report.goldenSet.coverage.multi}、none ${report.goldenSet.coverage.none}`
  )
  console.log(
    `检索 两路各取 ${report.config.retrieval.perRouteTopK}，上下文预算 ${report.config.contextBudget} token｜向量后端 ${report.config.embedBackend}｜裁判 ${report.config.judge}`
  )

  console.log('\n一、检索侧')
  printTable([
    ['指标', '值', '它对什么故障敏感'],
    ['召回率（可答题）', pct(report.retrieval.recall), '答案压根没进上下文'],
    ['召回率（single）', pct(report.retrieval.recallSingle), '单篇可答题的基本盘'],
    ['召回率（multi）', pct(report.retrieval.recallMulti), '多跳只捞到一半'],
    ['平均倒数排名', report.retrieval.mrr.toFixed(4), '答案还在但被挤到后面'],
    [`nDCG@${report.config.ndcgK}`, report.retrieval.ndcg.toFixed(4), '前几名整体质量下滑'],
    ['无答案题拒答率', pct(report.retrieval.abstainRate), '没有答案时硬塞材料'],
    ['平均上下文 token', String(report.retrieval.avgContextTokens), '每一问的上下文成本'],
  ])

  console.log('\n二、生成侧')
  printTable([
    ['指标', '值', '它对什么故障敏感'],
    ['忠实度', report.generation.faithfulness.toFixed(4), '回答超出材料乱说'],
    ['答案相关性', report.generation.answerRelevancy.toFixed(4), '说了一堆但没答到问题上'],
    ['无答案题真的拒答', pct(report.generation.refusalOnNone), '没有材料还硬编一段'],
  ])

  console.log('\n三、逐题（none 类看的是有没有正确闭嘴）')
  printTable([
    ['题号', '类型', '结果', '倒数排名', 'nDCG', 'token', '忠实度', '相关性'],
    ...report.perQuestion.map((q) => [
      q.id,
      q.type,
      q.type === 'none' ? (q.admitted ? '误答' : '正确拒答') : q.hit ? '命中' : '未命中',
      q.reciprocalRank.toFixed(3),
      q.ndcg.toFixed(3),
      String(q.contextTokens),
      q.faithfulness.toFixed(2),
      q.answerRelevancy.toFixed(2),
    ]),
  ])

  console.log('\n四、裁判探针（给裁判本身做的体检，喂已知答案的输入验它有没有坏）')
  for (const p of report.probes) {
    const mark = p.passed ? '✅' : p.blindSpot ? '⚠️ ' : '❌'
    console.log(
      `   ${mark} ${p.name}：忠实度 ${p.faithfulness.toFixed(2)}${p.blindSpot && !p.passed ? '（规则裁判抓不住换数字，真模型裁判才能，这是 MOCK 的边界）' : ''}`
    )
  }

  console.log(
    `\n五、人工抽检 ${report.agreement.checked} 条，一致 ${report.agreement.agreed} 条，一致率 ${pct(report.agreement.rate)}（判定线：忠实度 ≥ ${FAITHFUL_PASS} 视为没编）`
  )
  if (report.agreement.disagreements.length === 0) console.log('   没有分歧。')
  for (const d of report.agreement.disagreements) {
    console.log(
      `   ✗ ${d.questionId}：裁判 ${d.judge.toFixed(2)}，人工判「${d.human ? '没编' : '编了'}」——${d.note}`
    )
  }

  const baseline = loadBaseline()
  const real = gate(report, baseline)
  const demo = gate(degraded(report), baseline ?? report)
  console.log('\n六、回归闸门')
  if (!baseline) {
    console.log('   还没有基线文件，本次结果可以直接存成 eval/baseline-report.json 当第一版基线。')
  } else if (real.passed) {
    console.log('   ✅ 对比 eval/baseline-report.json：没有指标退步。')
  } else {
    for (const r of real.regressions) {
      console.log(
        `   ❌ ${r.metric}：${r.baseline.toFixed(4)} → ${r.current.toFixed(4)}（${r.delta}）`
      )
    }
  }
  console.log(
    `   演示：把召回率人为调低 15 个点再比一次 → ${demo.passed ? '闸门放行了（说明闸门没生效）' : `闸门拦住了（${demo.regressions.map((r) => r.metric).join('、')}）`}`
  )

  console.log(`\n报告已写入：\n   ${json}\n   ${md}`)

  const checks: Array<[string, boolean]> = [
    [
      'golden set 20 题且覆盖度达标（multi ≥ 3、none ≥ 3）',
      report.goldenSet.total === 20 &&
        report.goldenSet.coverage.multi >= 3 &&
        report.goldenSet.coverage.none >= 3,
    ],
    [
      '召回率算出来了，且 single 与 multi 两档不同（multi 用的是「全部命中」口径）',
      report.retrieval.recall > 0 && report.retrieval.recallSingle !== report.retrieval.recallMulti,
    ],
    ['平均倒数排名算出来了（不是占位的 0）', report.retrieval.mrr > 0],
    [
      `nDCG@${report.config.ndcgK} 算出来了，且不等于召回率（说明是两套逻辑而不是抄的）`,
      report.retrieval.ndcg > 0 && report.retrieval.ndcg !== report.retrieval.recall,
    ],
    [
      '裁判探针：照抄材料判有支撑、无关编造被抓出来（换数字那条是已知盲区，不计入）',
      report.probes.filter((p) => !p.blindSpot).every((p) => p.passed),
    ],
    ['人工抽检一致率不低于 0.8', report.agreement.rate >= 0.8],
    ['把召回率人为调低 15 个点，闸门会拦住', !demo.passed],
  ]
  console.log('\n七、验收')
  for (const [name, ok] of checks) console.log(`   ${ok ? '✅' : '❌'} ${name}`)

  if (process.env.GATE === '1' && !real.passed) {
    console.log('\nGATE=1 且检测到退步，以非 0 退出码结束——这就是「指标退步就拦住合并」。')
    process.exitCode = 1
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
