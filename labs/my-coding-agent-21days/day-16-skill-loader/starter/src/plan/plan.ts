/**
 * 计划的数据结构、校验与渲染。本天新增，纯函数。
 *
 * 一份计划要能被审批，就必须**可核对**。所以四个字段一个都不能省，而且每个字段
 * 都要能在事后拿实际发生的事去对：
 *
 *   goal    一句话说清要达成什么。用来判断「这份计划答的是不是我问的问题」
 *   steps   每步改哪几个文件、做什么。**files 是核对的抓手**，也是批准的授权范围
 *   verify  怎么证明做成了。没有这一条，Agent 会在改完之后宣布成功
 *   risks   有什么可能出错。它的真正用处是给人一个「不批」的理由
 *
 * 最容易被省掉的是 verify，而它省不得：一份没有验证方式的计划，执行完只能靠人看。
 * 反过来，写清了「跑 node --test，四个用例全绿」，执行阶段就有一条硬判据。
 *
 * 为什么不让模型写一段自然语言计划：自然语言读起来更顺，但它不可核对。
 * 「优化一下除法的边界处理」这句话，改一个文件和改五个文件都算符合。
 */

export interface PlanStep {
  /** 这一步要动的文件，相对沙盒仓库的路径。只读的探索步骤写空数组 */
  files: string[]
  /** 做什么。一句话，动词开头 */
  action: string
}

export interface Plan {
  goal: string
  steps: PlanStep[]
  /** 怎么验证做成了。至少一条 */
  verify: string[]
  risks: string[]
}

export interface PlanParse {
  plan: Plan | null
  /** 不合格的原因，直接回灌给模型让它重发一次 */
  problems: string[]
}

/**
 * 校验模型给的计划。
 *
 * 判据只有「能不能核对」这一条，所以缺 steps、steps 里没有一个 files、缺 verify
 * 都算不合格；而 risks 允许为空（真的没有风险的改动是存在的）。
 *
 * **不合格就整份退回，不要就地补全。** 补全出来的 verify 是我们编的，
 * 而审批的意义在于用户批的是模型自己的计划——我们替它补一条验证方式，
 * 等于让用户批准了一份没人负责的计划。
 */
export function parsePlan(raw: unknown): PlanParse {
  const bag = (raw ?? {}) as Record<string, unknown>
  const problems: string[] = []

  const goal = String(bag.goal ?? '').trim()
  if (!goal) problems.push('缺 goal：用一句话说清这次要达成什么')

  const steps: PlanStep[] = []
  if (!Array.isArray(bag.steps) || bag.steps.length === 0) {
    problems.push('缺 steps：至少写一步，每步有 files 与 action')
  } else {
    for (const item of bag.steps) {
      const entry = (item ?? {}) as Record<string, unknown>
      const action = String(entry.action ?? '').trim()
      const files = Array.isArray(entry.files)
        ? entry.files.map((file) => String(file).trim()).filter(Boolean)
        : []
      if (!action) {
        problems.push('steps 里有一步没写 action')
        continue
      }
      steps.push({ files, action })
    }
  }

  const verify = Array.isArray(bag.verify)
    ? bag.verify.map((row) => String(row).trim()).filter(Boolean)
    : []
  if (verify.length === 0) {
    problems.push('缺 verify：写清怎么证明做成了，例如「跑 node --test，四个用例全绿」')
  }

  const risks = Array.isArray(bag.risks)
    ? bag.risks.map((row) => String(row).trim()).filter(Boolean)
    : []

  // 一步都没写要改的文件，说明这份计划没有可核对的抓手
  if (steps.length > 0 && steps.every((step) => step.files.length === 0)) {
    problems.push('steps 里一个 files 都没有：要改哪些文件必须写出来，它是批准的授权范围')
  }

  if (problems.length > 0) return { plan: null, problems }
  return { plan: { goal, steps, verify, risks }, problems: [] }
}

/** 计划里提到的全部文件，去重后按字典序。它同时是「批准的授权范围」 */
export function plannedFiles(plan: Plan): string[] {
  return [...new Set(plan.steps.flatMap((step) => step.files))].sort()
}

/** 渲染成终端上的几行。审批提示直接用它，所以每一行都要能独立看懂 */
export function formatPlan(plan: Plan): string[] {
  const lines = [`计划：${plan.goal}`]
  plan.steps.forEach((step, index) => {
    const where = step.files.length > 0 ? step.files.join('、') : '（只读，不改文件）'
    lines.push(`  ${index + 1}. ${step.action}  →  ${where}`)
  })
  lines.push(`  验证：${plan.verify.join('；')}`)
  lines.push(
    plan.risks.length > 0 ? `  风险：${plan.risks.join('；')}` : '  风险：模型没有列出风险'
  )
  return lines
}
