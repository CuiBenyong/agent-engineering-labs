/**
 * 指令加载的对外入口，以及 /context 那几行的排版。本天新增。
 *
 * 一条纪律，和第八天的引用报账是同一条：**每一路注入都要自己报账。**
 * 引用那一路是「这一次贴了多少」，指令这一路是「每一轮都在花多少」——
 * 后者更值得报，因为它是常驻的：一段两千字符的项目指令，二十轮对话就重发了二十遍。
 * 总预算怎么在各路之间分配仍然不是今天的题目（那是第十二天），今天只要有这一路的账。
 */
import path from 'node:path'
import {
  discover,
  findRepoRoot,
  LAYER_NAMES,
  type DiscoverOptions,
  type Layer,
} from './discover.js'
import { expandImports } from './imports.js'
import {
  INSTRUCTION_BUDGET_CHARS,
  mergeInstructions,
  segmentOf,
  type ContextReport,
} from './merge.js'

export { INSTRUCTION_FILE, LAYER_NAMES } from './discover.js'
export { MAX_IMPORT_DEPTH, expandImports } from './imports.js'
export { INSTRUCTION_BUDGET_CHARS, mergeInstructions, parseDirectives } from './merge.js'
export type { ContextReport, Segment } from './merge.js'

/**
 * 两个「上下文的边界」都用环境变量给，默认值都在 work/ 里面。
 *
 * MCA_HOME  模拟用户主目录。**lab 绝不读写真实的 ~**，生产实现换成 os.homedir() 即可。
 * MCA_START 模拟「在哪个目录启动」。默认 work/repo/src，这样目录级那一层能真的被看到——
 *           如果默认在仓库根启动，目录级和项目级就是同一个文件，今天的现象就少了一半。
 */
export function instructionSources(): DiscoverOptions {
  const cwd = process.cwd()
  return {
    home: process.env.MCA_HOME ?? path.resolve(cwd, 'work/home'),
    start: process.env.MCA_START ?? path.resolve(cwd, 'work/repo/src'),
  }
}

export interface LoadResult {
  prompt: string
  report: ContextReport
}

export async function loadInstructions(
  options: DiscoverOptions & { base: string; budget?: number }
): Promise<LoadResult> {
  const found = await discover(options)
  const segments = []
  for (const entry of found) {
    // 导入允许访问的根：用户级文件只能导入主目录里的，项目级与目录级只能导入仓库里的。
    // 一个仓库的指令文件不该能把用户主目录里的东西拉进来——那是把项目当成了跳板。
    const root = entry.layer === 'user' ? options.home : await findRepoRoot(options.start)
    const expanded = await expandImports(entry.path, { root })
    segments.push(segmentOf(entry, expanded.text, expanded.files, expanded.problems))
  }
  return mergeInstructions(options.base, segments, options.budget)
}

/**
 * /context 的输出。它是今天的验收现象：**每一段来自哪个文件、有多大、谁覆盖了谁。**
 *
 * 为什么这件事值得单独做一条命令：system prompt 是唯一一段「用户看不见但每一轮都在生效」
 * 的上下文。它错了的表现是「模型莫名其妙不听话」，而用户手里没有任何东西可查。
 * 有了这条命令，「它为什么用了 npm test」这个问题从猜变成了看一眼。
 */
export function formatContext(report: ContextReport): string[] {
  // TODO(5) 这一行远远不够。/context 是今天的验收现象，它至少要打出三样东西：
  //   ① 表头：段数、整段 prompt 的字符数与估算 token，以及**三层指令自己**
  //      占了多少字符、占指令预算的百分之几（预算不含基座，理由见 merge.ts）
  //   ② 每一段一行：第几段、哪一层（LAYER_NAMES）、来自哪个文件、多少字符、
  //      约多少 token；被截断的标出来，有导入的把导入了哪几个文件列出来
  //   ③ 冲突表：每个键最终生效的值来自哪个文件，以及被覆盖的那几条各是什么
  //   最后把 report.problems 里的每条问题各打一行（前面加 ⚠）——
  //   坏掉的导入必须显式报出来，它的表现是「模型莫名其妙不听话」，用户手里没东西可查。
  //
  //   提示：估算 token 用 refs/budget.ts 里的 estimateTokens，它已经在 merge 里算过了，
  //   直接读 segment.tokens 就行。
  void LAYER_NAMES
  return [`system prompt 共 ${report.segments.length} 段`]
}
