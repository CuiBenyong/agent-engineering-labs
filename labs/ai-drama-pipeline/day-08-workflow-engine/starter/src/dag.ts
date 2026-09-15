// 工作流引擎。D1 的版本只会「按拓扑序把节点跑一遍」，
// 今天给它加三样东西：节点状态持久化、按内容寻址的产物缓存、以及由前两样推出来的断点续跑。
//
// 一句话概括这一天：**重跑不再是「从头再来」，而是一次差集计算。**

import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CostEntry } from './providers/index.js'

export type GraphNode = { id: string; deps: string[] }

/** 拓扑排序；发现环就抛错，这正是「有向无环」四个字的意义。 */
export function topoSort<T extends GraphNode>(nodes: T[]): T[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const state = new Map<string, 'visiting' | 'done'>()
  const order: T[] = []

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

export type NodeRunContext = {
  /** 本节点的产物目录，路径里带着指纹，所以同样的输入永远写到同一个地方。 */
  outDir: string
  /** 取某个依赖节点的产物目录。节点之间只通过目录交接，不共享内存里的对象。 */
  depDir: (nodeId: string) => string
  /** 记一笔花费。注意只有真的调了接口才记，命中缓存的节点一分钱都不该出现在台账里。 */
  record: (entry: Omit<CostEntry, 'runId' | 'at'>) => void
}

export type NodeSpec = GraphNode & {
  title: string
  /**
   * 实现版本。改了这个节点的算法、提示词模板、编码参数，就把它加一，
   * 旧缓存立刻全部失效——否则你会拿着新代码读到旧产物，而且查不出来。
   */
  version: number
  /**
   * 参与幂等键的输入。**只放会影响产物的东西**：模型 id、提示词、时长、分辨率。
   * 绝对不要放 runId、时间戳、随机数——放进去等于每次都是新键，缓存永远不命中。
   */
  inputs: unknown
  /** 产物文件名，相对 outDir。引擎靠「这些文件在不在」判断这个节点做没做完。 */
  outputs: string[]
  run: (ctx: NodeRunContext) => Promise<{ note?: string }>
}

export type NodeStatus = 'done' | 'failed' | 'blocked'
export type NodeSource = 'executed' | 'cache' | 'none'

export type NodeRecord = {
  fingerprint: string
  status: NodeStatus
  source: NodeSource
  ms: number
  calls: number
  costCny: number
  outputs: string[]
  note?: string
  error?: string
  at: string
}

export type WorkflowState = {
  runId: string
  updatedAt: string
  nodes: Record<string, NodeRecord>
}

/**
 * 幂等键。四个成分缺一不可：
 * 节点 id（不同节点不能撞）、实现版本（改了算法要失效）、
 * 本节点的输入（换了提示词要失效）、以及全部依赖的指纹（上游变了要连锁失效）。
 * 最后这一条是最容易漏的：只哈希自己的输入，上游改了剧本你还在用旧的镜头。
 */
export function fingerprint(node: NodeSpec, depFingerprints: string[]): string {
  // 练习 1：把四个成分都放进哈希——节点 id、version、inputs、依赖的指纹。
  // 提示：JSON.stringify 一个对象再 sha256，取前 16 位就够用了。
  // 现在只哈希了节点 id，于是换一句话（IDEA=... RUN_ID=...）再跑，
  // 六个节点全部命中缓存，你会拿到上一集的成片而且看不出哪里错了——
  // 这是幂等做错时最阴险的一种表现：它不报错，它只是给你旧东西。
  void depFingerprints
  return createHash('sha256').update(node.id).digest('hex').slice(0, 16)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function loadState(statePath: string, runId: string): Promise<WorkflowState> {
  try {
    return JSON.parse(await readFile(statePath, 'utf8')) as WorkflowState
  } catch {
    return { runId, updatedAt: new Date().toISOString(), nodes: {} }
  }
}

async function saveState(statePath: string, state: WorkflowState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true })
  state.updatedAt = new Date().toISOString()
  await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')
}

export type EngineOptions = {
  runId: string
  /** 状态文件。每跑完一个节点就落一次盘——进程被 kill 也只丢正在跑的那一个。 */
  statePath: string
  /** 产物缓存根目录，按 `<nodeId>/<fingerprint>/` 分层。 */
  cacheDir: string
  /** 付费接口调用计数器，用来证明第二次运行真的一次都没调。 */
  callCount: () => number
  onCost: (entry: Omit<CostEntry, 'runId' | 'at'>) => void
}

export type WorkflowResult = {
  state: WorkflowState
  order: string[]
  /** 每个节点的产物目录，键就是节点 id。调用方要取成片就从这里拿。 */
  dirs: Record<string, string>
  failedAt?: string
}

export async function runWorkflow(specs: NodeSpec[], opts: EngineOptions): Promise<WorkflowResult> {
  const order = topoSort(specs)
  const state = await loadState(opts.statePath, opts.runId)
  const fingerprints = new Map<string, string>()
  const dirs = new Map<string, string>()
  let failedAt: string | undefined

  for (const node of order) {
    const fp = fingerprint(
      node,
      node.deps.map((d) => fingerprints.get(d) ?? '')
    )
    fingerprints.set(node.id, fp)
    const outDir = join(opts.cacheDir, node.id, fp)
    dirs.set(node.id, outDir)

    // 练习 3：上游失败之后，下游不应该再跑——它拿不到完整的输入，
    // 跑出来的东西要么是错的，要么是又一次白花钱。
    // 这里应该把节点记成 blocked（下面的 blocked() 已经写好了）并跳过。
    // 现在没有这段判断，注入失败之后 compose 还会硬着头皮去剪一堆缺胳膊少腿的素材。
    void blocked

    // 幂等判定只看一件事：这份指纹对应的产物是不是齐了。
    // 不看状态文件里写了什么——文件可能被手删，状态可能来自另一次运行。
    // 练习 2：幂等判定。这份指纹对应的产物如果已经齐了，就直接跳过，
    // 把节点记成 source: 'cache'、calls: 0、costCny: 0，然后 continue。
    // 提示：判据是「outputs 里每个文件都存在于 outDir」，不要去看状态文件里写了什么——
    // 文件可能被手删，状态也可能来自另一次运行，只有磁盘上的产物是真的。
    // 现在这里什么都不判，所以第二次运行的付费调用仍然是 15 次，缓存目录白写了。
    void exists

    await mkdir(outDir, { recursive: true })
    const started = Date.now()
    const callsBefore = opts.callCount()
    let costCny = 0
    process.stdout.write(`  ▸ ${node.id.padEnd(9)} ${node.title} ... `)
    try {
      const { note } = await node.run({
        outDir,
        depDir: (id) => {
          const dir = dirs.get(id)
          if (!dir) throw new Error(`节点 ${node.id} 取了未声明为依赖的 ${id} 的产物`)
          return dir
        },
        record: (entry) => {
          costCny += entry.costCny
          opts.onCost(entry)
        },
      })
      const ms = Date.now() - started
      const calls = opts.callCount() - callsBefore
      state.nodes[node.id] = {
        fingerprint: fp,
        status: 'done',
        source: 'executed',
        ms,
        calls,
        costCny: Number(costCny.toFixed(4)),
        outputs: node.outputs,
        note,
        at: new Date().toISOString(),
      }
      console.log(`${ms}ms，付费调用 ${calls} 次${note ? `（${note}）` : ''}`)
    } catch (err) {
      const ms = Date.now() - started
      const calls = opts.callCount() - callsBefore
      // 失败的节点也要落盘：它已经花掉的钱是真的，产物是残的。
      // 残产物留在 outDir 里不删——下一次跑到这里，齐不齐一看便知。
      state.nodes[node.id] = {
        fingerprint: fp,
        status: 'failed',
        source: 'executed',
        ms,
        calls,
        costCny: Number(costCny.toFixed(4)),
        outputs: node.outputs,
        error: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      }
      console.log(`${ms}ms ✗ ${state.nodes[node.id].error}`)
      failedAt = node.id
    }
    await saveState(opts.statePath, state)
  }

  await saveState(opts.statePath, state)
  return { state, order: order.map((n) => n.id), dirs: Object.fromEntries(dirs), failedAt }
}

function blocked(fingerprintValue: string): NodeRecord {
  return {
    fingerprint: fingerprintValue,
    status: 'blocked',
    source: 'none',
    ms: 0,
    calls: 0,
    costCny: 0,
    outputs: [],
    at: new Date().toISOString(),
  }
}
