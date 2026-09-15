/**
 * grep：在文件内容里搜正则。本天新增。
 *
 * 三个只读工具里它最容易把上下文撑爆，所以限量做在三个维度上：
 *   1. 命中条数（默认 50 条）
 *   2. 单行长度（120 字符，超了截断）——压缩后的代码一行能有几十万字符
 *   3. 文件范围（可选的 glob 参数）——先缩范围再搜，比搜完再筛便宜得多
 *
 * 输出格式固定为 路径:行号:内容，因为这是模型见过最多的形状（各家 grep 都这么打），
 * 它能直接照着这个格式去调 read_file 看上下文。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ToolContext, ToolDef, ToolResult } from '../kernel/types.js'
import { globToRegExp, walkFiles } from './fs.js'

const DEFAULT_LIMIT = 50
const MAX_LINE_CHARS = 120

export const grepTool: ToolDef = {
  name: 'grep',
  description:
    '在工作目录的文件内容里搜索正则，返回 路径:行号:内容 形式的命中行。' +
    '可以用 glob 参数先把搜索范围缩小到某些文件，例如 src/**/*.js。' +
    '默认最多返回 50 条命中。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript 正则，例如 function\\s+divide' },
      glob: { type: 'string', description: '只搜匹配这个通配符的文件，例如 src/**/*.js' },
      limit: { type: 'integer', description: '最多返回多少条命中，默认 50' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  readOnly: true,

  async run(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    const args = (rawArgs ?? {}) as { pattern?: unknown; glob?: unknown; limit?: unknown }
    const source = String(args.pattern ?? '')
    const limit = Math.max(1, Number(args.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT)

    let matcher: RegExp
    try {
      matcher = new RegExp(source)
    } catch (error) {
      // 正则写错是模型的高频失误，把引擎的原话回灌回去，它一看就知道怎么改
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, content: `正则 ${source} 编译不过：${detail}` }
    }

    const fileFilter = args.glob ? globToRegExp(String(args.glob)) : null
    const files = (await walkFiles(ctx.cwd)).filter((rel) => !fileFilter || fileFilter.test(rel))

    const hits: string[] = []
    let scanned = 0
    let total = 0
    for (const relative of files) {
      if (ctx.signal.aborted) break // 大仓库上搜正则可能很久，取消要立刻生效
      let text: string
      try {
        text = await fs.readFile(path.join(ctx.cwd, relative), 'utf8')
      } catch {
        continue
      }
      if (text.includes('\u0000')) continue // 二进制跳过
      scanned += 1
      text.split('\n').forEach((line, i) => {
        if (!matcher.test(line)) return
        total += 1
        if (hits.length >= limit) return
        const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line
        hits.push(`${relative}:${i + 1}:${shown.trim()}`)
      })
    }

    if (total === 0) {
      return {
        ok: true,
        content: `没有命中 ${source}（搜了 ${scanned} 个文件）。`,
        meta: { pattern: source, scanned, total: 0 },
      }
    }
    const rest = total - hits.length
    const tail = rest > 0 ? `\n…（还有 ${rest} 条命中未显示，把正则或 glob 写得更窄一些）` : ''
    return {
      ok: true,
      content: `命中 ${total} 条（搜了 ${scanned} 个文件）：\n${hits.join('\n')}${tail}`,
      meta: { pattern: source, scanned, total, shown: hits.length },
    }
  },
}
