import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { main as analyzeMain } from '../skill/release-report/scripts/analyze.js'
import { main as validateMain } from '../skill/release-report/scripts/validate.js'
import { main as fillMain } from '../skill/release-report/scripts/fill.js'
import { writeSummary } from './summary.js'

const SKILL = 'skill/release-report'
const TEMPLATE = join(SKILL, 'assets/template.md')
const TMP = 'tmp'

/** 脚本还没写完时输出可能是空的，解析要能扛住，否则驱动自己先崩了。 */
function parseOut<T>(out: string, fallback: T): T {
  try {
    return out ? (JSON.parse(out) as T) : fallback
  } catch {
    return fallback
  }
}

function step(title: string, ok: boolean, detail: string) {
  console.log(`\n${ok ? '✅' : '❌'} ${title}`)
  console.log(detail.trimEnd())
}

async function main() {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(TMP, { recursive: true })

  // 第 1 步：分析模板，拿到字段清单。模型不该凭记忆猜字段名。
  const analyzed = analyzeMain([TEMPLATE])
  writeFileSync(join(TMP, 'fields.json'), analyzed.out || '{"fields":[]}')
  step('第 1 步 分析模板', analyzed.code === 0, analyzed.out || analyzed.err)

  // 第 2 步：唯一的网络出口 —— 让模型写摘要那一段。MOCK=1 时走离线桩。
  const summary = await writeSummary(['订单查询接口改为分页返回', '取消了已废弃的批量导出接口'])
  step('第 2 步 生成摘要（唯一的网络出口）', true, summary)

  // 第 3 步：先拿一份**故意写错的**计划去校验，看错误信息够不够模型自己改对
  const bad = { ...JSON.parse(readFileSync('fixtures/values.bad.json', 'utf8')), summary }
  writeFileSync(join(TMP, 'values.bad.json'), JSON.stringify(bad, null, 2))
  const badResult = validateMain([join(TMP, 'fields.json'), join(TMP, 'values.bad.json')])
  const badErrors = parseOut<{ errors?: string[] }>(badResult.out, {}).errors ?? []
  step(
    `第 3 步 校验（预期不通过，退出码 ${badResult.code}）`,
    badResult.code === 1 && badErrors.length >= 3,
    badErrors.map((e) => `   · ${e}`).join('\n')
  )

  // 第 4 步：按错误信息修正后重新校验。真实使用中这一步是模型自己做的。
  const good = { ...JSON.parse(readFileSync('fixtures/values.good.json', 'utf8')), summary }
  writeFileSync(join(TMP, 'values.good.json'), JSON.stringify(good, null, 2))
  const goodResult = validateMain([join(TMP, 'fields.json'), join(TMP, 'values.good.json')])
  step(
    `第 4 步 修正后重新校验（预期通过，退出码 ${goodResult.code}）`,
    goodResult.code === 0,
    goodResult.out
  )

  // 第 5 步：只有校验通过了才允许写文件
  const filled = fillMain([TEMPLATE, join(TMP, 'values.good.json')])
  step('第 5 步 填充模板', filled.code === 0, filled.out || filled.err)

  // 反面演示：跳过校验直接填那份坏计划，脚本会拒绝写出带占位符的文档
  const skipped = fillMain([TEMPLATE, join(TMP, 'values.bad.json')])
  step('反面演示 跳过校验直接填充（预期被拒绝）', skipped.code === 1, skipped.err)

  const allOk =
    analyzed.code === 0 &&
    badResult.code === 1 &&
    goodResult.code === 0 &&
    filled.code === 0 &&
    skipped.code === 1
  console.log(`\n${allOk ? '全部通过' : '有步骤未通过，检查上面的 ❌'}`)
  process.exitCode = allOk ? 0 : 1
}

await main()
