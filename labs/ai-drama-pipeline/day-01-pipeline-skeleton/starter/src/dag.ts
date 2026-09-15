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
  // 练习 3：真的按 deps 排一次序，并在发现环时抛错。
  //   提示：深度优先遍历，给每个节点三种状态——没访问过 / 正在访问 / 访问完。
  //        再次走到「正在访问」的节点就说明有环，把走过的路径拼进错误信息里最好排查。
  //        依赖了不存在的节点也要抛错，否则会静默漏跑一整步。
  //   自测：给 script 节点加一条 deps: ['timeline'] 造一个环，实现之前程序照跑不误，
  //        实现之后应该立刻报「任务图里有环」。
  console.log('  ⚠️ topoSort 还没实现，暂时按声明顺序执行（练习 3）')
  return nodes
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
