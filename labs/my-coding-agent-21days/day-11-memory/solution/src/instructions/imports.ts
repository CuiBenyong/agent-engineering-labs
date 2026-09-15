/**
 * 导入展开。本天新增。
 *
 * 语法只有一行：`@import ./testing.md`，独占一行，路径相对**引用它的那个文件**。
 * 为什么不复用第八天的 `@`：那是用户在对话里临时贴资料，这是作者在文件里做长期拆分，
 * 两者的失败处理完全不同——对话里的坏引用给一行提示就行，指令文件里的坏导入
 * 会让每一轮请求都少一段规矩，必须显式报出来。
 *
 * 四条安全限制，一条都不能省（这四条就是今天面试题第二问的答案）：
 *
 *   1. **深度上限。** 三层就够了；再深的层级说明作者该重构文件，而不是你该支持它。
 *   2. **循环检测。** A 导入 B、B 导入 A 是必然会有人写出来的。按「导入链」判断，
 *      不是按「导入过没有」——那两件事不一样，见下面 seen 与 chain 的区别。
 *   3. **路径必须落在允许的根里面。** `@import ../../../../etc/passwd` 一定有人试。
 *      判据只能是「解析成绝对路径之后还在不在根里面」。
 *   4. **重复导入只算一次。** A 和 B 都导入 C 不是循环，但同一段内容进 prompt 两遍
 *      纯属浪费。第二次跳过并记一条说明。
 *
 * 还有一条口径：**任何一条坏导入都不会让加载失败。** 出问题的那一行被换成一句
 * 括号说明留在原地，其余内容照常生效——指令文件坏一行就整个仓库不能用，是最糟的设计。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveInside } from '../tools/fs.js'

/** 最多套三层。第四层直接拒绝并说清楚 */
export const MAX_IMPORT_DEPTH = 3
/** 单个指令文件的字节上限：指令是每一轮都要重发的东西，比一次性的引用严得多 */
export const MAX_INSTRUCTION_BYTES = 32_000

const IMPORT_LINE = /^@import\s+(\S.*)$/

export interface ImportedFile {
  label: string
  depth: number
  chars: number
}

export interface ExpandResult {
  text: string
  /** 被导入进来的文件（不含入口文件自己） */
  files: ImportedFile[]
  /** 出了问题的导入，每条都是一句人话 */
  problems: string[]
}

export interface ImportOptions {
  /** 允许访问的根：解析出来的路径必须落在它里面 */
  root: string
  maxDepth?: number
}

/**
 * 读一个指令文件并展开它的导入。
 *
 * chain 是「当前这条导入链」，用来判循环——退出一层就要弹出来；
 * seen 是「整次展开里已经导入过的文件」，用来判重复——从不弹出。
 * 只用 seen 会把 A、B 都导入 C 误判成循环；只用 chain 会让同一个文件进 prompt 两遍。
 */
export async function expandImports(file: string, options: ImportOptions): Promise<ExpandResult> {
  const maxDepth = options.maxDepth ?? MAX_IMPORT_DEPTH
  const files: ImportedFile[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  const chain: string[] = []

  const load = async (target: string, depth: number): Promise<string> => {
    let raw: string
    try {
      const stat = await fs.stat(target)
      if (stat.size > MAX_INSTRUCTION_BYTES) {
        problems.push(
          `${short(target)} 有 ${Math.round(stat.size / 1024)} KB，超过单个指令文件上限 ` +
            `${MAX_INSTRUCTION_BYTES / 1024} KB，没有加载。指令是每一轮都要重发的东西，别当文档写。`
        )
        return ''
      }
      raw = await fs.readFile(target, 'utf8')
    } catch {
      problems.push(`读不到 ${short(target)}，这一段规矩这次没有生效`)
      return ''
    }

    chain.push(target)
    const out: string[] = []
    for (const line of raw.split('\n')) {
      const match = IMPORT_LINE.exec(line.trim())
      if (!match) {
        out.push(line)
        continue
      }
      out.push(await resolveImport(match[1] as string, target, depth))
    }
    chain.pop()
    return out.join('\n')
  }

  const resolveImport = async (spec: string, from: string, depth: number): Promise<string> => {
    let absolute: string
    try {
      // 相对引用它的那个文件解析，再确认没跑出根
      absolute = resolveInside(options.root, path.resolve(path.dirname(from), spec))
    } catch {
      problems.push(`${short(from)} 想导入 ${spec}，但它在允许的根之外，已拒绝`)
      return `（导入被拒绝：${spec} 在允许的目录之外）`
    }
    if (depth + 1 > maxDepth) {
      problems.push(
        `${short(from)} 的导入已经是第 ${depth + 1} 层，超过深度上限 ${maxDepth}，没有展开`
      )
      return `（导入未展开：${short(absolute)} 超过了深度上限 ${maxDepth}）`
    }
    if (chain.includes(absolute)) {
      problems.push(
        `发现循环导入：${chain.map(short).join(' → ')} → ${short(absolute)}，这一层已跳过`
      )
      return `（循环导入已跳过：${short(absolute)}）`
    }
    if (seen.has(absolute)) {
      problems.push(`${short(absolute)} 已经被导入过一次，这次跳过（重复导入只算一次）`)
      return `（重复导入已跳过：${short(absolute)}）`
    }
    seen.add(absolute)
    const text = await load(absolute, depth + 1)
    files.push({ label: short(absolute), depth: depth + 1, chars: text.length })
    return text
  }

  const text = await load(file, 0)
  return { text, files, problems }
}

function short(file: string): string {
  const relative = path.relative(process.cwd(), file)
  return relative.startsWith('..') ? file : relative.split(path.sep).join('/')
}
