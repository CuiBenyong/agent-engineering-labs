/**
 * 三个脚本的统一命令行入口。
 *
 * 用法：pnpm analyze <模板> | pnpm validate <字段清单> <取值> | pnpm fill <模板> <取值> [输出]
 *
 * 为什么统一入口：Agent 读到的是一串它要照着敲的命令，命令越少越不容易敲错。
 * 数据走标准输出、诊断走标准错误，这样调用方可以直接把标准输出喂给 jq。
 */
import { main as analyze } from './analyze.js'
import { main as validate } from './validate.js'
import { main as fill } from './fill.js'

const HELP = `用法: cli.ts <analyze|validate|fill> [参数...]

  analyze  <模板路径>                        输出字段清单 JSON
  validate <字段清单 JSON> <取值 JSON>        校验计划，退出码 1 表示有错误
  fill     <模板路径> <取值 JSON> [输出路径]   填充模板

退出码：0 成功，1 业务失败（有错误 / 有未填占位符），2 用法或文件问题。`

const [sub, ...rest] = process.argv.slice(2)
const runners: Record<string, (a: string[]) => { code: number; out: string; err: string }> = {
  analyze,
  validate,
  fill,
}

if (!sub || sub === '--help' || sub === '-h' || !(sub in runners)) {
  console.log(HELP)
  process.exit(sub && sub !== '--help' && sub !== '-h' ? 2 : 0)
}

const result = runners[sub](rest)
if (result.out) console.log(result.out)
if (result.err) console.error(result.err)
process.exit(result.code)
