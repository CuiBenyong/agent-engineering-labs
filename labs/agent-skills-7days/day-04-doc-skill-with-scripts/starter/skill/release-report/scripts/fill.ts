/**
 * 第三步：把校验通过的取值填进模板。**只有这一步会写出文件。**
 *
 * 用法：pnpm fill <模板路径> <取值 JSON> [输出路径]
 * 输出：不给输出路径就打到标准输出；给了就写文件并打一行 {"written":"<路径>"}
 * 退出码：0 成功；1 还有未填的占位符；2 用法错误或文件读不到
 *
 * 这一步刻意不做校验：校验是上一步的事。
 * 两件事混在一个脚本里，模型就没法在「计划」和「执行」之间停下来自我修正。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(?:string|number|boolean)\s*(\?)?\s*\}\}/g

export function fill(template: string, values: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER, (whole, name: string, optional?: string) => {
    if (!(name in values)) {
      // 可选字段没给就填一句占位文字；必填字段留着不动，好让下面的自检能发现它
      return optional === '?' ? '（无）' : whole
    }
    const v = values[name]
    return typeof v === 'boolean' ? (v ? '是' : '否') : String(v)
  })
}

export function main(argv: string[]): { code: number; out: string; err: string } {
  if (argv.length < 2 || argv.length > 3) {
    return { code: 2, out: '', err: '用法: fill.ts <模板路径> <取值 JSON> [输出路径]' }
  }
  let template: string
  let values: Record<string, unknown>
  try {
    template = readFileSync(argv[0], 'utf8')
    values = JSON.parse(readFileSync(argv[1], 'utf8')) as Record<string, unknown>
  } catch (e) {
    return { code: 2, out: '', err: `读取或解析失败：${(e as Error).message}` }
  }

  const filled = fill(template, values)
  // 练习 3：填完之后自检一遍，还有没填的必填占位符就以退出码 1 失败，
  // 并在错误信息里列出是哪几个。宁可报错，也不要写出一份带着两对花括号的文档 ——
  // 那种文件会被当成填好的直接发出去。
  // 现在没有自检，反面演示那一步会 ❌。

  if (argv[2]) {
    writeFileSync(argv[2], filled, 'utf8')
    return { code: 0, out: JSON.stringify({ written: argv[2] }), err: '' }
  }
  return { code: 0, out: filled, err: '' }
}
