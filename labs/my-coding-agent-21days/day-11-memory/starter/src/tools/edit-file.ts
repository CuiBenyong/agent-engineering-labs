/**
 * edit_file：精确替换。本天新增。
 *
 * 为什么是「精确替换」而不是「整文件重写」或「补丁」：
 *   - 整文件重写：模型要把没改的部分一字不差地重新输出一遍。长文件既贵又容易出错，
 *     它会顺手「优化」你没让它动的地方，而且这种改动在 diff 里很难被人发现。
 *   - 补丁（diff）：格式最省 token，但行号与上下文行必须完全对得上，模型算错一行整块就废，
 *     而且失败原因很难翻译成它能改的提示。
 *   - 精确替换：只发要改的那一小段与替换成什么。省 token，失败原因也具体
 *     （「这段内容找不到」「这段内容出现了 3 次」），模型一看就知道下一步该干什么。
 *
 * 「旧内容必须出现且只出现一次」这条规则同时兼任冲突检测：
 * 模型读到的那段内容如果已经不在了（被外部编辑器改了、被上一次替换动过），
 * 匹配就会失败，这次写入必须放弃——**不许猜，不许模糊匹配**。
 */
import fs from 'node:fs/promises'
import type { ToolContext, ToolDef, ToolResult } from '../kernel/types.js'
import { resolveInside } from './fs.js'

/** 故障注入：INJECT=tool_error 让第一次 edit_file 失败一次，用来演示「回灌之后自己再试」 */
const inject = process.env.INJECT ?? ''
let toolErrorFired = false

export const editFileTool: ToolDef = {
  name: 'edit_file',
  description:
    '把文件里一段完全匹配的旧内容替换成新内容。' +
    'old_string 必须与文件里的内容逐字一致（含缩进），并且在文件中只出现一次——' +
    '不唯一时请把上下文写长一点再试。' +
    '想改多处就多次调用；新建文件请用 create_file。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对工作目录的文件路径' },
      old_string: { type: 'string', description: '要被替换掉的原文，逐字一致，含缩进与换行' },
      new_string: { type: 'string', description: '替换成什么。传空字符串表示删掉这段' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  readOnly: false,

  async run(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    const args = (rawArgs ?? {}) as Record<string, unknown>
    const relative = String(args.path ?? '')
    const oldString = String(args.old_string ?? '')
    const newString = String(args.new_string ?? '')
    const target = resolveInside(ctx.cwd, relative)

    // 只在第一次生效，第二次必须成功——否则读者永远看不到「自纠成功」那一支。
    // 失败文本里明确写「文件没有任何改动，请原样重试」：模型要靠这句话决定下一步。
    if (inject === 'tool_error' && !toolErrorFired) {
      toolErrorFired = true
      return {
        ok: false,
        content: `写入 ${relative} 失败：磁盘临时不可写（注入的故障）。文件没有任何改动，请原样重试一次。`,
      }
    }

    if (oldString === '') {
      return { ok: false, content: 'old_string 不能为空。新建文件请用 create_file。' }
    }
    if (oldString === newString) {
      return { ok: false, content: 'old_string 与 new_string 相同，这次编辑没有任何效果。' }
    }

    let before: string
    try {
      before = await fs.readFile(target, 'utf8')
    } catch {
      return {
        ok: false,
        content: `${relative} 读不到（不存在或不是文本文件），没有改动任何内容。`,
      }
    }

    // 数出现次数，而不是直接 replace：0 次与多次都必须失败，且要给出可操作的原因
    const occurrences = before.split(oldString).length - 1
    if (occurrences === 0) {
      return {
        ok: false,
        content:
          `在 ${relative} 里找不到那段 old_string，没有改动任何内容。` +
          '常见原因是缩进或换行不一致，或者文件已经被改过了——请先 read_file 再重试。',
      }
    }
    if (occurrences > 1) {
      return {
        ok: false,
        content:
          `那段 old_string 在 ${relative} 里出现了 ${occurrences} 次，无法确定改哪一处，没有改动任何内容。` +
          '请把上下文写长一点，让它在文件里唯一。',
      }
    }

    const after = before.replace(oldString, newString)
    await fs.writeFile(target, after, 'utf8')

    const lineOf = before.slice(0, before.indexOf(oldString)).split('\n').length
    const delta = after.split('\n').length - before.split('\n').length
    return {
      ok: true,
      content: `已改 ${relative}：第 ${lineOf} 行起替换 1 处，行数变化 ${delta >= 0 ? '+' : ''}${delta}`,
      meta: { path: relative, line: lineOf, lineDelta: delta },
    }
  },
}

/** create_file：新建是一个特例——它没有「旧内容」可以匹配，所以单独一个工具 */
export const createFileTool: ToolDef = {
  name: 'create_file',
  description:
    '新建一个文件并写入全部内容。目标文件已存在时会失败（改已有文件请用 edit_file）。' +
    '需要的父目录会自动创建。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对工作目录的文件路径' },
      content: { type: 'string', description: '文件的全部内容' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  readOnly: false,

  async run(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    const args = (rawArgs ?? {}) as Record<string, unknown>
    const relative = String(args.path ?? '')
    const content = String(args.content ?? '')
    const target = resolveInside(ctx.cwd, relative)

    // 「已存在就失败」是故意的：覆盖一个已有文件必须走 edit_file，
    // 否则模型一次手滑就能把整个文件冲掉，而且 diff 里看不出它冲掉了什么
    try {
      await fs.access(target)
      return { ok: false, content: `${relative} 已经存在，没有覆盖。要改它请用 edit_file。` }
    } catch {
      // 不存在才继续
    }

    await fs.mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
    return {
      ok: true,
      content: `已新建 ${relative}（${content.split('\n').length} 行，${content.length} 字符）`,
      meta: { path: relative, chars: content.length },
    }
  },
}
