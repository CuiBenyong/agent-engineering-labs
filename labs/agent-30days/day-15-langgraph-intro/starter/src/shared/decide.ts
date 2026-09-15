// 该不该拆成多 Agent：三条判据，命中任意一条才拆，一条都不命中就别拆。
// 这一份是本章最该被记住的东西——图怎么搭是手艺，什么时候不搭是判断力。

/** 一个待评估的场景。三个字段分别对应三条判据。 */
export interface Scenario {
  name: string
  /** 判据一：同一段系统提示词里出现了互斥的行为要求（既要严谨又要热情、既要拒绝又要挽留） */
  conflictingRules: boolean
  /** 判据二：挂在同一个 Agent 上的工具数量 */
  toolCount: number
  /** 判据三：某一步需要独立的失败与重试语义（它失败了不该把整轮对话一起重来） */
  needsOwnRetry: boolean
}

/**
 * 工具数量的告警线。不是模型的硬上限，是「选错率开始明显上升」的经验线：
 * 工具描述会互相干扰，语义相近的两个工具一多，模型选错的概率就不再是可以忽略的了。
 * 超过它的第一反应应该是合并工具、收敛描述，拆 Agent 是第二反应。
 */
export const TOOL_LIMIT = 8

export interface Verdict {
  split: boolean
  reasons: string[]
}

/** 三条判据，命中任意一条就该拆；一条都不命中，多 Agent 只会带来延迟、成本和调试难度。 */
export function shouldSplit(scenario: Scenario): Verdict {
  // 练习 2：按三条判据判断该不该拆，并把命中的理由逐条写进 reasons。
  //   判据一：scenario.conflictingRules —— 提示词里有互斥的行为要求
  //   判据二：scenario.toolCount 超过 TOOL_LIMIT —— 工具多到模型选不准
  //   判据三：scenario.needsOwnRetry —— 某一步需要独立的失败与重试语义
  // 一条都没命中就必须返回 split: false，并说清「拆了只会更慢、更贵、更难查」。
  // 下面这个默认值正是本章要批判的那种判断——先拆了再说。跑一次自检你会看到它把不该拆的也拆了。
  void scenario
  return { split: true, reasons: ['多 Agent 是趋势，先拆了再说'] }
}

/** 实验里用来对照的四个场景：两个该拆、两个不该拆。 */
export const SCENARIOS: Scenario[] = [
  {
    name: '查订单 + 查物流的只读助手',
    conflictingRules: false,
    toolCount: 3,
    needsOwnRetry: false,
  },
  {
    name: '客服要同时做退款审批与挽留话术',
    conflictingRules: true,
    toolCount: 5,
    needsOwnRetry: false,
  },
  {
    name: '一个 Agent 挂了 12 个工具的全能助手',
    conflictingRules: false,
    toolCount: 12,
    needsOwnRetry: false,
  },
  {
    name: '答完还要生成一段可以重试的对外邮件',
    conflictingRules: false,
    toolCount: 4,
    needsOwnRetry: true,
  },
]
