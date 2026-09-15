/**
 * 把几间工位的产物合回主工作区。本天新增。
 *
 * 这是并行里最容易被想简单的一步。直觉写法是「按顺序把每个子 Agent 的改动写回去」，
 * 那等于**后写的赢**：两个子 Agent 都改了 src/calc.js，你会得到后跑完那个的版本，
 * 而且屏幕上不会有任何提示——两份回执都写着「已完成」，主工作区里却只剩一份改动。
 * 这是并行 Agent 最典型的一种静默数据丢失。
 *
 * 所以合并要做**三方比较**：基线（派单那一刻）、这一边改成了什么、另一边改成了什么。
 * 规则只有三条，粗但诚实：
 *
 *   1. 只有一个人改了这个文件      → 落盘
 *   2. 多个人改了，改成的内容相同   → 落盘一次，不算冲突（同一件事做了两遍，无害）
 *   3. 多个人改了，内容不同         → **报冲突，一份都不落**
 *
 * 第三条为什么不选一份落下去：能自动挑的前提是你有办法判断哪份对，而你没有。
 * 行级三方合并（真 git 干的事）能在改动不重叠时自动合，但那需要基线的行信息与
 * 一套合并算法；本课把它留给真实实现，这里只保证**不静默丢东西**。
 *
 * 还有一条容易漏的：**主工作区自己也可能在这几秒里变了。** 子 Agent 干活期间
 * 用户在编辑器里存了一次盘，基线就不再等于主工作区的现状了——这时候落盘会
 * 无声覆盖掉用户刚写的东西。所以落盘前还要拿基线和主工作区现状比一次。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { REPO_DIR } from '../seed.js'
import { readTree } from './worktree.js'
import type { MergeEntry, MergePlan, SubagentResult } from './spec.js'

/**
 * 算出合并计划。**只算不写**，方便自检与 dry run 各看一遍。
 *
 * @param current 主工作区此刻的内容。传进来而不是在里面读，是为了让它成为纯函数
 */
export function planMerge(results: SubagentResult[], current: Map<string, string>): MergePlan {
  // 先按路径把所有改动归拢：谁改的、改成什么、基线是什么
  const byPath = new Map<string, Array<{ by: string; before: string | null; after: string }>>()
  for (const result of results) {
    for (const change of result.changes) {
      const bucket = byPath.get(change.path) ?? []
      bucket.push({ by: result.id, before: change.before, after: change.after })
      byPath.set(change.path, bucket)
    }
  }

  const entries: MergeEntry[] = []
  const applied = new Map<string, string>()
  for (const [file, edits] of [...byPath].sort((a, b) => a[0].localeCompare(b[0]))) {
    const by = edits.map((e) => e.by)
    const versions = new Set(edits.map((e) => e.after))
    if (versions.size > 1) {
      entries.push({
        path: file,
        by,
        action: 'conflict',
        why: `${by.join(' 与 ')} 都改了它，而且改成了 ${versions.size} 个不同的版本，一份都没落盘`,
      })
      continue
    }
    // 主工作区在这几秒里被别人动过：基线已经不作数，落盘会无声覆盖掉那个人的改动
    const baseline = edits[0]?.before ?? null
    const now = current.get(file) ?? null
    if (now !== baseline) {
      entries.push({
        path: file,
        by,
        action: 'conflict',
        why: '主工作区里的这个文件在派发之后被改过，基线已经对不上，没有落盘',
      })
      continue
    }
    applied.set(file, edits[0]?.after as string)
    entries.push({
      path: file,
      by,
      action: 'apply',
      why: by.length > 1 ? `${by.join(' 与 ')} 改成了同样的内容，落盘一次` : `${by[0]} 改的，落盘`,
    })
  }

  return { entries, applied, conflicts: entries.filter((e) => e.action === 'conflict') }
}

/** 把计划里 apply 的那几条真的写进主工作区 */
export async function applyMerge(plan: MergePlan, into = REPO_DIR): Promise<string[]> {
  const written: string[] = []
  for (const [relative, content] of plan.applied) {
    const target = path.join(into, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
    written.push(relative)
  }
  return written.sort()
}

/** 读主工作区现状，算计划，落盘。三步凑在一起是因为它们必须按这个顺序发生 */
export async function mergeInto(
  results: SubagentResult[],
  into = REPO_DIR
): Promise<{ plan: MergePlan; written: string[] }> {
  const plan = planMerge(results, await readTree(into))
  return { plan, written: await applyMerge(plan, into) }
}

/**
 * 回灌给模型的那段文字。**这是主会话唯一看得到的东西**，所以它的形状就是今天的答案：
 * 每个子 Agent 一段结构化回执（干了什么、花了多少、回执正文），然后是合并裁决。
 *
 * 一条刻意的取舍：**冲突写在最前面。** 一次派发里最需要人接着做决定的就是冲突，
 * 而模型读长文本时前面那几行的权重最高。
 */
export function formatReport(results: SubagentResult[], plan: MergePlan): string {
  const lines: string[] = []
  if (plan.conflicts.length > 0) {
    lines.push(`⚠ 有 ${plan.conflicts.length} 处冲突没有落盘，需要决定怎么办：`)
    for (const entry of plan.conflicts) lines.push(`  ${entry.path}：${entry.why}`)
    lines.push('')
  }
  lines.push(`派出了 ${results.length} 个子 Agent，回执如下：`)
  for (const result of results) {
    const files = result.changes.map((c) => c.path).join('、') || '（没改任何文件）'
    lines.push('')
    lines.push(`【${result.id}】${result.ok ? '完成' : '未完成'}　派单：${result.task}`)
    lines.push(`  改了：${files}`)
    lines.push(`  用过的工具：${result.tools.join('、') || '（一个都没用）'}`)
    lines.push(`  用量：${result.rounds} 次工具调用 / 约 ${result.tokens} token / ${result.ms}ms`)
    if (result.note) lines.push(`  没做完的原因：${result.note}`)
    lines.push(`  回执：${result.summary}`)
  }
  const ok = plan.entries.filter((e) => e.action === 'apply')
  lines.push('')
  lines.push(`合并结果：${ok.length} 个文件落盘，${plan.conflicts.length} 处冲突。`)
  for (const entry of plan.entries) lines.push(`  ${entry.path} → ${entry.why}`)
  return lines.join('\n')
}
