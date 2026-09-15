// 最小任务图执行器：按依赖拓扑排序，顺序执行，记录每个节点的耗时与产物。
// D8 会把它扩成带幂等与断点续跑的正式引擎，这里先只做「按图跑」。

export type NodeResult = { artifacts: string[]; note?: string }

export type TaskNode = {
  id: string
  title: string
  deps: string[]
  run: () => Promise<NodeResult>
}

export type NodeReport = {
  id: string
  title: string
  ms: number
  artifacts: string[]
  note?: string
}

/** 拓扑排序；发现环就抛错，这正是「有向无环」四个字的意义。 */
export function topoSort(nodes: TaskNode[]): TaskNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const state = new Map<string, 'visiting' | 'done'>()
  const order: TaskNode[] = []

  const visit = (id: string, trail: string[]) => {
    const s = state.get(id)
    if (s === 'done') return
    if (s === 'visiting') throw new Error(`任务图里有环：${[...trail, id].join(' -> ')}`)
    const node = byId.get(id)
    if (!node) throw new Error(`节点 ${id} 依赖了不存在的节点`)
    state.set(id, 'visiting')
    for (const dep of node.deps) visit(dep, [...trail, id])
    state.set(id, 'done')
    order.push(node)
  }

  for (const n of nodes) visit(n.id, [])
  return order
}

export async function runGraph(nodes: TaskNode[]): Promise<NodeReport[]> {
  const reports: NodeReport[] = []
  for (const node of topoSort(nodes)) {
    const started = Date.now()
    process.stdout.write(`  ▸ ${node.id} ${node.title} ... `)
    const result = await node.run()
    const ms = Date.now() - started
    console.log(`${ms}ms，产物 ${result.artifacts.length} 个`)
    reports.push({
      id: node.id,
      title: node.title,
      ms,
      artifacts: result.artifacts,
      note: result.note,
    })
  }
  return reports
}
