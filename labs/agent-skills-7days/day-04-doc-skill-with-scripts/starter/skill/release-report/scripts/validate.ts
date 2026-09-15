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
  // 练习 2：写出三类错误，**错误信息的措辞就是这道练习的重点**。
  //   a. 必填字段缺失 —— 要带上它的类型
  //   b. 类型不符 —— 要写清期望什么、实际是什么、值长什么样
  //   c. 未知字段 —— 几乎总是拼写错误，所以要把可用字段列出来，模型才能一眼改对
  // 判据：把错误信息单独拿给一个没看过模板的人，他能不能照着改对？不能就再写具体一点。
  void fields
  void values
  return [] // 默认永远通过，第 3 步的「预期不通过」就会 ❌
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
