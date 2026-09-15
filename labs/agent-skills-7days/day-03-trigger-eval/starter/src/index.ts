import 'dotenv/config'
import { CASES, type Case } from './cases.js'
import { DESCRIPTIONS, buildCatalog } from './catalog.js'
import { triggerRate } from './judge.js'

const THRESHOLD = 0.5 // 该触发的要高于它，不该触发的要低于等于它
const RUNS = 3

type Row = { c: Case; rate: number; passed: boolean }

async function evaluate(
  version: string
): Promise<{ rows: Row[]; train: number; validation: number }> {
  const skills = buildCatalog(version)
  const rows: Row[] = []
  for (const c of CASES) {
    const rate = await triggerRate(skills, c, RUNS)
    rows.push({ c, rate, passed: c.shouldTrigger ? rate > THRESHOLD : rate <= THRESHOLD })
  }
  // 练习 4：按 split 分别统计通过率。训练集的数字指导你改描述，验证集的数字决定你选哪一版；
  // 两者混在一起算，等于把验证集也拿去优化了 —— 那就是过拟合的开始。
  const rateOf = (split: Case['split']) => {
    void split
    return 0
  }
  return { rows, train: rateOf('train'), validation: rateOf('validation') }
}

function printTable(version: string, result: Awaited<ReturnType<typeof evaluate>>) {
  console.log(`\n===== 描述版本 ${version} =====`)
  console.log('集合        期望    触发率  结果  查询')
  for (const { c, rate, passed } of result.rows) {
    const split = c.split === 'train' ? '训练' : '验证'
    const want = c.shouldTrigger ? '应触发' : '不触发'
    console.log(
      `${split}        ${want}  ${rate.toFixed(2)}    ${passed ? '✅' : '❌'}    ${c.query}` +
        (passed ? '' : `\n                              ↑ ${c.note}`)
    )
  }
  console.log(`训练集通过率 ${(result.train * 100).toFixed(0)}%（指导你改描述）`)
  console.log(`验证集通过率 ${(result.validation * 100).toFixed(0)}%（决定你选哪一版）`)
}

async function main() {
  const versions = Object.keys(DESCRIPTIONS)
  const results: Array<{ version: string; validation: number }> = []
  for (const version of versions) {
    const result = await evaluate(version)
    printTable(version, result)
    results.push({ version, validation: result.validation })
  }

  console.log('\n===== 版本对比（按验证集通过率挑，不按迭代顺序挑）=====')
  for (const r of results) console.log(`${r.version}  验证集 ${(r.validation * 100).toFixed(0)}%`)
  const best = results.reduce((a, b) => (b.validation > a.validation ? b : a))
  console.log(`最终应当选用：${best.version}`)
}

await main()
