/**
 * 第一步：分析模板，列出它需要哪些字段。
 *
 * 用法：pnpm analyze <模板路径>
 * 输出：一行 JSON 到标准输出，形如 {"fields":[{"name":"version","type":"string","required":true}]}
 * 退出码：0 成功；2 用法错误；1 模板读不到或一个占位符都没有
 *
 * 为什么要有这一步：模型不该凭记忆猜模板里有哪些字段。
 * 先把「真值」抽出来，后面的校验才有东西可比。
 */
import { readFileSync } from 'node:fs'

export type Field = { name: string; type: 'string' | 'number' | 'boolean'; required: boolean }

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(string|number|boolean)\s*(\?)?\s*\}\}/g

export function analyze(template: string): Field[] {
  const seen = new Map<string, Field>()
  for (const m of template.matchAll(PLACEHOLDER)) {
    const [, name, type, optional] = m
    // 同名占位符出现多次是允许的，取第一次的声明，避免同一字段两种类型
    if (!seen.has(name)) {
      seen.set(name, { name, type: type as Field['type'], required: optional !== '?' })
    }
  }
  return [...seen.values()]
}

export function main(argv: string[]): { code: number; out: string; err: string } {
  if (argv.length !== 1) {
    return { code: 2, out: '', err: '用法: analyze.ts <模板路径>\n输出字段清单 JSON 到标准输出。' }
  }
  let template: string
  try {
    template = readFileSync(argv[0], 'utf8')
  } catch {
    return { code: 1, out: '', err: `读不到模板文件：${argv[0]}` }
  }
  const fields = analyze(template)
  if (fields.length === 0) {
    return {
      code: 1,
      out: '',
      err: '模板里一个占位符都没有，形如 {{name:string}}。检查是不是路径给错了。',
    }
  }
  return { code: 0, out: JSON.stringify({ fields }), err: '' }
}
