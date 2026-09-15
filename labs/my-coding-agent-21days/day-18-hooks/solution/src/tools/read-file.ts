/**
 * read_file：读一个文件，带行号，可以只读一段。本天新增。
 *
 * 三个设计决定，都是为了让模型少犯错：
 *   1. 带行号输出。模型要靠行号定位，第四天的编辑工具也要靠它对话
 *      （「把第 12 行改成……」比「把那个函数改成……」可执行得多）。
 *   2. 默认只读前 400 行，而不是整个文件。整文件塞进上下文是最常见的浪费，
 *      而且大多数时候模型只需要看开头就知道该往哪找。
 *   3. 读到二进制文件要明确说「这是二进制」，不要把乱码回灌给模型。
 */
import fs from 'node:fs/promises'
import type { ToolContext, ToolDef, ToolResult } from '../kernel/types.js'
import { resolveInside } from './fs.js'

const DEFAULT_LIMIT = 400
/** 单行超过这个长度就截断：压缩后的 JS 一行能有几十万字符 */
const MAX_LINE_CHARS = 500

interface ReadArgs {
  path?: unknown
  offset?: unknown
  limit?: unknown
}

export const readFileTool: ToolDef = {
  name: 'read_file',
  // 描述是给模型看的，所以写「什么时候用它、参数怎么填」，不写实现
  description:
    '读取工作目录里一个文本文件的内容，返回带行号的文本。' +
    '默认从第 1 行开始最多读 400 行；文件更长时用 offset 与 limit 分段读。' +
    '路径必须是相对工作目录的相对路径。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对工作目录的文件路径，例如 src/calc.js' },
      offset: { type: 'integer', description: '从第几行开始读，从 1 起，默认 1' },
      limit: { type: 'integer', description: '最多读多少行，默认 400' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  readOnly: true,

  async run(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    const args = (rawArgs ?? {}) as ReadArgs
    const relative = String(args.path ?? '')
    const offset = Math.max(1, Number(args.offset ?? 1) || 1)
    const limit = Math.max(1, Number(args.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT)
    const target = resolveInside(ctx.cwd, relative)

    const raw = await fs.readFile(target)
    // 出现空字节基本就是二进制，别把乱码喂给模型
    if (raw.includes(0)) {
      return {
        ok: false,
        content: `${relative} 看起来是二进制文件（${raw.length} 字节），没有读取`,
      }
    }

    const lines = raw.toString('utf8').split('\n')
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    if (slice.length === 0) {
      return { ok: false, content: `${relative} 只有 ${lines.length} 行，读不到第 ${offset} 行` }
    }

    const numbered = slice
      .map((line, i) => {
        const text =
          line.length > MAX_LINE_CHARS
            ? `${line.slice(0, MAX_LINE_CHARS)}…（本行过长已截断）`
            : line
        return `${offset + i}\t${text}`
      })
      .join('\n')
    const rest = lines.length - (offset - 1 + slice.length)
    const tail =
      rest > 0 ? `\n…（后面还有 ${rest} 行，用 offset ${offset + slice.length} 继续读）` : ''

    return {
      ok: true,
      content: `${relative}（第 ${offset}–${offset + slice.length - 1} 行，共 ${lines.length} 行）\n${numbered}${tail}`,
      meta: { path: relative, lines: lines.length, returned: slice.length },
    }
  },
}
