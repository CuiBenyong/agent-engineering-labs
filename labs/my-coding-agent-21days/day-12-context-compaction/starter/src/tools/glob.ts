/**
 * glob：按通配符找文件。本天新增。
 *
 * 它的价值不是「列目录」，而是让模型能问出「这个仓库里有哪些测试文件」这种问题。
 * 所以描述里要给例子——模型对通配符语法的记忆不如你想象的可靠。
 *
 * 两个边界：结果要限量（默认 200 条），并且要告诉模型「还有多少条没给你」，
 * 否则它会以为自己看到了全部，然后在一个不存在的前提上继续推理。
 */
import type { ToolContext, ToolDef, ToolResult } from '../kernel/types.js'
import { globToRegExp, walkFiles } from './fs.js'

const DEFAULT_LIMIT = 200

export const globTool: ToolDef = {
  name: 'glob',
  description:
    '按通配符列出工作目录里的文件，返回相对路径。' +
    '支持 ** 跨目录、* 同层任意字符、? 单个字符，例如 **/*.js 或 test/**/*.test.js。' +
    '自动跳过 node_modules 与 .git。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '通配符，例如 **/*.js；不填等于 **/*' },
      limit: { type: 'integer', description: '最多返回多少条，默认 200' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  readOnly: true,

  async run(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    const args = (rawArgs ?? {}) as { pattern?: unknown; limit?: unknown }
    const pattern = String(args.pattern ?? '**/*') || '**/*'
    const limit = Math.max(1, Number(args.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT)

    let matcher: RegExp
    try {
      matcher = globToRegExp(pattern)
    } catch {
      return { ok: false, content: `通配符 ${pattern} 解析不了，请换一个写法，例如 **/*.js` }
    }

    const all = await walkFiles(ctx.cwd)
    const matched = all.filter((relative) => matcher.test(relative))
    if (matched.length === 0) {
      return {
        ok: true,
        // 空结果也是有效信息，但要帮模型判断「是没有，还是我写错了」
        content: `没有文件匹配 ${pattern}。工作目录里一共有 ${all.length} 个文件。`,
        meta: { pattern, matched: 0 },
      }
    }

    const shown = matched.slice(0, limit)
    const rest = matched.length - shown.length
    const tail = rest > 0 ? `\n…（还有 ${rest} 条未显示，把 pattern 写得更具体一些）` : ''
    return {
      ok: true,
      content: `匹配 ${pattern} 的文件（${matched.length} 个）：\n${shown.join('\n')}${tail}`,
      meta: { pattern, matched: matched.length, shown: shown.length },
    }
  },
}
