/**
 * 第二步：拿字段清单校验取值计划。**整个流程的价值全在这一步。**
 *
 * 用法：pnpm validate <字段清单 JSON> <取值 JSON>
 * 输出：通过时 {"ok":true}；不通过时 {"ok":false,"errors":[...]}
 * 退出码：0 通过；1 有错误；2 用法错误或文件读不到
 *
 * 错误信息的写法是有讲究的：要说清「哪一项、期望什么、实际是什么、可选值有哪些」，
 * 模型才有足够信息自己改对，而不是再问一轮。
 */
import { readFileSync } from 'node:fs'
import type { Field } from './analyze.js'

export function validate(fields: Field[], values: Record<string, unknown>): string[] {
  const errors: string[] = []
  const known = new Set(fields.map((f) => f.name))

  for (const f of fields) {
    if (!(f.name in values)) {
      if (f.required) errors.push(`缺少必填字段 ${f.name}（类型 ${f.type}）`)
      continue
    }
    const v = values[f.name]
    const actual = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v
    if (actual !== f.type) {
      errors.push(
        `字段 ${f.name} 类型不符：期望 ${f.type}，实际 ${actual}（值 ${JSON.stringify(v)}）`
      )
    }
  }

  for (const name of Object.keys(values)) {
    if (!known.has(name)) {
      // 未知字段几乎总是拼写错误，所以把可用字段列出来，模型一眼就能改对
      errors.push(`模板里没有字段 ${name}。可用字段：${[...known].join('、')}`)
    }
  }
  return errors
}

export function main(argv: string[]): { code: number; out: string; err: string } {
  if (argv.length !== 2) {
    return { code: 2, out: '', err: '用法: validate.ts <字段清单 JSON> <取值 JSON>' }
  }
  let fields: Field[]
  let values: Record<string, unknown>
  try {
    fields = (JSON.parse(readFileSync(argv[0], 'utf8')) as { fields: Field[] }).fields
    values = JSON.parse(readFileSync(argv[1], 'utf8')) as Record<string, unknown>
  } catch (e) {
    return { code: 2, out: '', err: `读取或解析失败：${(e as Error).message}` }
  }
  const errors = validate(fields, values)
  return errors.length === 0
    ? { code: 0, out: JSON.stringify({ ok: true }), err: '' }
    : { code: 1, out: JSON.stringify({ ok: false, errors }), err: '' }
}
