// 五种多 Agent 协作模式的结构图。模式之间的区别不在名字，在**图的形状**。
// 边有两种：always 是无条件边（LangGraph 的 addEdge，同一个节点上有两条就是并行扇出，
// 两个分支都会跑），choice 是条件边（addConditionalEdges，运行时只会走中其中一条）。
// 把这两种边分开数，才能看出「同时交给三个人」和「三选一交给一个人」的根本差别。

export type PatternId = 'router' | 'planner-executor' | 'critic' | 'swarm' | 'blackboard'

export interface Edge {
  from: string
  to: string
  /** always = 都走（并行）；choice = 只走一条（运行时决定） */
  kind: 'always' | 'choice'
}

export interface Pattern {
  id: PatternId
  name: string
  /** 一句话判据：什么形状的任务适合它 */
  when: string
  edges: Edge[]
}

/** 图形状的四个特征。 */
export interface Shape {
  /** 分叉：某个节点有两条以上的条件出边（运行时三选一） */
  branch: boolean
  /** 扇出：某个节点有两条以上的无条件出边（同时交给多个人） */
  fanOut: boolean
  /** 汇合：某个节点有两条以上的无条件入边（多份产出被合到一起） */
  join: boolean
  /** 回边：存在指向已访问过节点的边（可以打回重做） */
  backEdge: boolean
}

const always = (from: string, to: string): Edge => ({ from, to, kind: 'always' })
const choice = (from: string, to: string): Edge => ({ from, to, kind: 'choice' })

export const PATTERNS: Pattern[] = [
  {
    id: 'router',
    name: 'Router / Supervisor',
    when: '一次只需要一个专家，难点是判断该找谁',
    edges: [
      always('START', 'supervisor'),
      choice('supervisor', 'order_lookup'),
      choice('supervisor', 'refund_draft'),
      choice('supervisor', 'smalltalk'),
      always('order_lookup', 'END'),
      always('refund_draft', 'END'),
      always('smalltalk', 'END'),
    ],
  },
  {
    id: 'planner-executor',
    name: 'Planner-Executor',
    when: '一件事必须拆成几件、几件之间没有先后，做完还要合成一份交付',
    edges: [
      always('START', 'planner'),
      always('planner', 'executor_a'),
      always('planner', 'executor_b'),
      always('executor_a', 'reducer'),
      always('executor_b', 'reducer'),
      always('reducer', 'END'),
    ],
  },
  {
    id: 'critic',
    name: 'Critic',
    when: '产出的对错有明确判据，且错了重做比错了发出去便宜',
    edges: [
      always('START', 'executor'),
      always('executor', 'critic'),
      choice('critic', 'executor'),
      choice('critic', 'END'),
    ],
  },
  {
    id: 'swarm',
    name: 'Swarm',
    when: '下一棒交给谁由当前这位自己决定，没有中心节点，全局顺序事先说不清',
    edges: [
      always('START', 'agent_a'),
      choice('agent_a', 'agent_b'),
      choice('agent_a', 'END'),
      choice('agent_b', 'agent_a'),
      choice('agent_b', 'END'),
    ],
  },
  {
    id: 'blackboard',
    name: 'Blackboard',
    when: '参与者不知道彼此存在，只认公共状态里出现了什么就接着往下做',
    edges: [
      always('START', 'blackboard'),
      always('blackboard', 'writer_a'),
      always('blackboard', 'writer_b'),
      always('writer_a', 'blackboard'),
      always('writer_b', 'blackboard'),
      choice('blackboard', 'END'),
    ],
  },
]

/** 从边表算出图的形状。 */
export function analyzeShape(pattern: Pattern): Shape {
  // 练习 1：把 branch / fanOut / join 三个布尔值算出来。
  //   branch = 有节点的「条件出边」超过 1 条（运行时三选一）
  //   fanOut = 有节点的「无条件出边」超过 1 条（同时交给多个人）
  //   join   = 有节点的「无条件入边」超过 1 条（多份产出合到一起）
  // 提示：统计时要把 START 的出边和 END 的入边排除掉——
  //       START 天然只有一条出边、END 天然收很多条入边，算进去五种模式就都长一个样了。
  // 回边已经替你写好了，见下面的 hasBackEdge。
  return { branch: false, fanOut: false, join: false, backEdge: hasBackEdge(pattern) }
}

/** 从 START 深度优先走一遍，踩到还在递归栈里的节点就说明有回边（环）。 */
function hasBackEdge(pattern: Pattern): boolean {
  const next = new Map<string, string[]>()
  for (const edge of pattern.edges) {
    next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to])
  }
  const done = new Set<string>()
  const onStack = new Set<string>()
  const walk = (node: string): boolean => {
    if (onStack.has(node)) return true
    if (done.has(node)) return false
    onStack.add(node)
    const found = (next.get(node) ?? []).some(walk)
    onStack.delete(node)
    done.add(node)
    return found
  }
  return walk('START')
}

/** 把边表画成一张 ASCII 结构图，条件边画成虚线，一眼看出哪几条是三选一。 */
export function renderPattern(pattern: Pattern): string {
  const shape = analyzeShape(pattern)
  const marks = (
    [
      [shape.branch, '分叉'],
      [shape.fanOut, '扇出'],
      [shape.join, '汇合'],
      [shape.backEdge, '回边'],
    ] as [boolean, string][]
  )
    .filter(([on]) => on)
    .map(([, label]) => label)

  const lines = pattern.edges.map(
    (edge) => `    ${edge.from} ${edge.kind === 'always' ? '───▶' : '- - ▶'} ${edge.to}`
  )
  return [
    `  ${pattern.name}（${marks.join(' + ') || '直线'}）`,
    `    适合：${pattern.when}`,
    ...lines,
  ].join('\n')
}
