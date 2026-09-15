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
  const share = Math.round((report.instructionChars / report.budget) * 100)
  const lines = [
    `system prompt 共 ${report.segments.length} 段、${report.totalChars} 字符` +
      `（约 ${report.totalTokens} token）；其中三层指令 ${report.instructionChars} 字符` +
      `（约 ${report.instructionTokens} token，占指令预算 ${share}%）`,
  ]

  report.segments.forEach((segment, i) => {
    const layer = segment.kind === 'base' ? '基座  ' : `${LAYER_NAMES[segment.kind as Layer]}`
    const marks = [
      segment.truncated ? '已截断' : '',
      segment.imports.length > 0
        ? `含导入 ${segment.imports.length} 个文件：${segment.imports.map((f) => f.label).join('、')}`
        : '',
    ]
      .filter(Boolean)
      .join('；')
    lines.push(
      `  ${i + 1}  ${layer}  ${segment.label}  ${segment.chars} 字符 · 约 ${segment.tokens} token` +
        (marks ? `（${marks}）` : '')
    )
  })

  if (report.conflicts.length > 0) {
    lines.push(`  冲突 ${report.conflicts.length} 处（越具体越靠后，后者赢）：`)
    for (const conflict of report.conflicts) {
      lines.push(
        `    ${conflict.key}  最终生效「${conflict.winner.value}」，来自 ${conflict.winner.from}`
      )
      for (const loser of conflict.losers) {
        lines.push(`      被覆盖：${loser.from} 的「${loser.value}」`)
      }
    }
  }
  for (const problem of report.problems) lines.push(`  ⚠ ${problem}`)
  return lines
}
