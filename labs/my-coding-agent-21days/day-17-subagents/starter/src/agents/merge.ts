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
  // TODO(4) 现在的写法就是本文件开头说的那个坑：**后写的赢**，而且一声不吭。
  //   请按开头那三条规则改写：
  //     1. 只有一个人改 → 落盘
  //     2. 多个人改成了**相同**内容 → 落盘一次，不算冲突
  //     3. 多个人改成了**不同**内容 → action 写 conflict，一份都不落
  //   还要补上第四种情况：主工作区里这个文件在派发之后被别人改过
  //   （current.get(file) 与基线 edits[0].before 对不上），这时候落盘会无声覆盖掉
  //   那个人的改动，所以同样算 conflict。
  for (const [file, edits] of [...byPath].sort((a, b) => a[0].localeCompare(b[0]))) {
    const by = edits.map((e) => e.by)
    const last = edits[edits.length - 1] as { by: string; after: string }
    void current
    applied.set(file, last.after)
    entries.push({
      path: file,
      by,
      action: 'apply',
      why: `${last.by} 改的，落盘（后写的覆盖先写的）`,
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
  // TODO(5) 现在回灌给模型的只有几句白话，主会话没法据此判断任何事：
  //   哪个子 Agent 改了哪些文件、用了哪些工具、花了多少、有没有没做完、冲突在哪，一概看不到。
  //   请改成一段结构化回执：
  //     - 冲突写在**最前面**（模型读长文本时前几行权重最高，而冲突最需要人接着做决定）
  //     - 每个子 Agent 一段：完成与否、派单原文、改了哪些文件、用过的工具、
  //       用量（几次调用 / 多少 token / 多少毫秒）、没做完的原因、以及它那份回执正文
  //     - 末尾是合并裁决：几个文件落盘、几处冲突，然后逐条列出 entry.why
  //   一条硬要求：**子 Agent 的原始对话一个字都不许出现在这里**，只许出现 result.summary。
  void plan
  return results.map((result) => `${result.id}：${result.summary}`).join('\n')
}
