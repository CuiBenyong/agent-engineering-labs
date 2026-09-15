// 三个角色的业务逻辑：Planner 怎么拆、Executor 怎么在预算内做完、Critic 按什么判。
// 图的接线在 graph.ts，这里只管「做什么」，不管「谁接谁」。

import { callModel } from '../infra/model'
import { callTool } from '../infra/orders'
import type { Task } from './state'

/** 单个子任务的工具调用上限。注意它是**子任务级**的，不是单次执行级的：
 *  被 Critic 打回重做也照样计费，否则「防超支」在有评审回路的图里等于没设。 */
export const TOOL_BUDGET = 5

/** Critic 最多打回几次（共 3 次执行）。超过就降级返回已有结果，不是抛错。 */
export const MAX_REVIEW_ROUNDS = 2

/** 同时最多跑几个 Executor。上限存在的理由是配额，不是性能。 */
export const EXECUTOR_CONCURRENCY = 2

const ORDER_ID = /SO\d{8}/

/** 一种子任务：Planner 能挑它、Executor 知道要调哪些工具、Critic 知道按什么验收。 */
export interface Skill {
  kind: string
  /** Planner 用它从请求里认出这件事该做 */
  pattern: string
  goal: string
  /** 完成它要依次调用的工具，长度就是这件事的最小成本 */
  tools: string[]
  /** Critic 的验收要求：产出里必须写明这件事 */
  requirement: string
}

export const SKILLS: Skill[] = [
  {
    kind: 'order',
    pattern: '订单状态|什么状态|订单进度',
    goal: '查订单状态并说明当前阶段',
    tools: ['查订单'],
    requirement: '当前阶段',
  },
  {
    kind: 'shipping',
    pattern: '物流|快递|到哪|发货|签收',
    goal: '查物流轨迹并给出预计送达时间',
    tools: ['查订单', '查物流'],
    requirement: '预计送达',
  },
  {
    kind: 'address',
    pattern: '地址|收货人|自提',
    goal: '确认收货地址还能不能改',
    tools: ['查配送状态'],
    requirement: '收货地址',
  },
  {
    kind: 'refund',
    pattern: '退款|退货|退钱',
    goal: '依据规则拟一份退款方案，不执行退款',
    tools: ['查订单', '查退款规则'],
    requirement: '退款结论',
  },
  {
    kind: 'invoice',
    // 七步才做得完，而预算只有五次——这条子任务注定要降级
    pattern: '发票|开票',
    goal: '整理开票信息并提交开票申请',
    tools: ['查订单', '查开票资质', '查抬头', '查税号', '查邮寄地址', '查历史开票', '生成开票申请'],
    requirement: '开票申请',
  },
  {
    kind: 'complaint',
    // 工具给不出工单号，所以 Critic 会一直判不合格——用来演示重试上限
    pattern: '投诉|升级|人工',
    goal: '把这次问题升级成人工工单并给出工单号',
    tools: ['建工单'],
    requirement: '工单号',
  },
  {
    kind: 'damage',
    // 下游理赔服务会 503，用来演示「一个子任务失败不该拖垮其他子任务」
    pattern: '破损|损坏|坏了|理赔',
    goal: '发起破损理赔并回收凭证',
    tools: ['查订单', '调用理赔服务'],
    requirement: '理赔单号',
  },
]

const GENERAL: Skill = {
  kind: 'general',
  pattern: '',
  goal: '查订单基本信息并回答用户的问题',
  tools: ['查订单'],
  requirement: '当前阶段',
}

export function skillOf(kind: string): Skill {
  return SKILLS.find((s) => s.kind === kind) ?? GENERAL
}

/** 子任务的 id 前缀就是 kind，所以从任何一条 Task 都能反查它属于哪种技能。 */
export function skillOfTask(task: Task): Skill {
  return skillOf(task.id.replace(/^t-\d+-/, ''))
}

/** 把 goal 里追加的评审意见剥掉，拿回原始目标——重做时要在原目标上做，不是在意见上做。 */
export function baseGoal(goal: string): string {
  return goal.split(' ｜ 评审意见：')[0]
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

/** 把一句请求拆成 1–3 件可以并行做的子任务。清单交给模型挑，解析不认识的 kind 一律丢弃。 */
export async function planTasks(request: string): Promise<Task[]> {
  const catalog = SKILLS.map((s) => `${s.kind} :: ${s.pattern} :: ${s.goal}`).join('\n')
  const raw = await callModel(
    'plan',
    `用户请求：${request}\n可选子任务类型（kind :: 关键词 :: 目标）：\n${catalog}`
  )
  const orderId = request.match(ORDER_ID)?.[0] ?? 'SO20260901'

  const kinds = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((kind) => SKILLS.some((s) => s.kind === kind))
    .slice(0, 3)
  // 模型一个都没挑中时不要让流程空转：兜底成一件通用子任务，比返回空计划安全得多
  const picked = kinds.length > 0 ? kinds : [GENERAL.kind]

  return picked.map((kind, i) => ({
    id: `t-${i + 1}-${kind}`,
    goal: `${skillOf(kind).goal}（订单 ${orderId}）`,
    toolCalls: 0,
    status: 'pending' as const,
  }))
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * 把一件子任务做完，工具调用次数不超过 TOOL_BUDGET。
 * 预算耗尽**不抛错**：把已经查到的部分写进 result、状态标成 failed，让上层决定怎么降级。
 * 工具本身抛的异常这里不接——它由 graph.ts 的 Executor 节点在边界上翻译成状态，
 * 因为「一个子任务失败不该炸掉整张图」是编排层的责任，不是业务函数的责任。
 */
export async function runTask(task: Task): Promise<Task> {
  const skill = skillOfTask(task)
  const orderId = task.goal.match(ORDER_ID)?.[0] ?? ''
  const observations: string[] = []
  let used = task.toolCalls

  for (const tool of skill.tools) {
    // 练习 2：在这里加预算检查。used 达到 TOOL_BUDGET 就不要再调工具了，直接
    //   return degrade(task, used, observations, `预算耗尽：...只走到「${tool}」之前`)
    // 关键是**不要抛错**：抛错等于把一次超预算升级成一次请求失败，用户什么都拿不到；
    // 降级是把已经查到的部分交出去，再由上层标 degraded。
    // 挖空默认：不管预算，想调几次调几次。跑一次自检你会看到开票子任务调满 7 次工具。
    observations.push(await callTool(tool, orderId))
    used += 1
  }

  const text = await callModel(
    'compose',
    `子任务目标：${task.goal}\n工具观测：\n${observations.map((o) => `- ${o}`).join('\n')}`
  )
  return { ...task, toolCalls: used, result: text, status: 'done' }
}

/** 降级：保留已经拿到的部分结果，状态标成 failed，绝不抛错。预算耗尽与工具失败共用这一条出口。 */
export function degrade(task: Task, used: number, observations: string[], why: string): Task {
  const partial = observations.length > 0 ? observations.join('；') : '什么都没查到'
  return {
    ...task,
    toolCalls: used,
    result: `（降级）${why}。已有结果：${partial}`,
    status: 'failed',
  }
}

// ---------------------------------------------------------------------------
// Critic
// ---------------------------------------------------------------------------

export interface Review {
  id: string
  ok: boolean
  /** 打回必须带具体理由：只说「不合格」，执行者重做一次还是同样的产出 */
  reason: string
}

/** 逐条评审做完的子任务。判据是写死的验收要求，不是「你觉得好不好」——见正文里同源偏差那一段。 */
export async function reviewTasks(tasks: Task[]): Promise<Review[]> {
  return Promise.all(
    tasks.map(async (task) => {
      const skill = skillOfTask(task)
      const verdict = await callModel(
        'review',
        `验收要求：${skill.requirement}\n子任务目标：${baseGoal(task.goal)}\n产出：${task.result ?? ''}`
      )
      const ok = verdict.trim().startsWith('PASS')
      return { id: task.id, ok, reason: ok ? '合格' : verdict.replace(/^REDO\s*/, '').trim() }
    })
  )
}
