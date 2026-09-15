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
  // 练习 1：用 PLACEHOLDER 扫出模板里的全部占位符，转成字段清单。
  // 占位符形如 {{name:string}}，末尾多一个问号表示可选。
  // 提示：同名占位符可能出现多次，取第一次的声明，别让同一个字段出现两种类型。
  void PLACEHOLDER
  void template
  return [] // 默认返回空清单，跑起来第 1 步就会 ❌
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
