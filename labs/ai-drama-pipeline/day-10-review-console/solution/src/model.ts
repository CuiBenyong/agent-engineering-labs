// D10 的数据模型：一次运行 → 一集 → 一镜三层，以及「改一个字段会波及谁」的依赖图。
// 这张图是审核台的地基：没有它，点一次重生成就只能全量重跑。

import { topoSort, type TaskNode } from './dag.js'
import type { Shot } from './providers/index.js'

/** 一个镜头由三个可重生成的节点组成，加上一集共用的时间轴节点。 */
export type NodeKind = 'frame' | 'clip' | 'voice' | 'timeline'
export const TIMELINE_NODE = 'episode:timeline'

export const nodeId = (shotId: string, kind: Exclude<NodeKind, 'timeline'>) => `${shotId}:${kind}`

/** 可以被人改的字段，以及它直接作废哪个节点。 */
export type EditableField = 'dialogue' | 'visual'
const SEED: Record<EditableField, Exclude<NodeKind, 'timeline'>> = {
  dialogue: 'voice',
  visual: 'frame',
}

export type GraphNode = { id: string; deps: string[] }

/** 依赖边：首帧 → 视频；台词 → 配音；所有视频与配音 → 时间轴。 */
export function buildGraph(shotIds: string[]): GraphNode[] {
  const nodes: GraphNode[] = []
  for (const id of shotIds) {
    nodes.push({ id: nodeId(id, 'frame'), deps: [] })
    nodes.push({ id: nodeId(id, 'clip'), deps: [nodeId(id, 'frame')] })
    nodes.push({ id: nodeId(id, 'voice'), deps: [] })
  }
  nodes.push({
    id: TIMELINE_NODE,
    deps: shotIds.flatMap((id) => [nodeId(id, 'clip'), nodeId(id, 'voice')]),
  })
  return nodes
}

/** 把 GraphNode 借给 D1 的拓扑排序用，只为了拿一个合法的执行顺序。 */
function ordered(nodes: GraphNode[]): string[] {
  const asTasks: TaskNode[] = nodes.map((n) => ({
    id: n.id,
    title: n.id,
    deps: n.deps,
    run: async () => ({ artifacts: [] }),
  }))
  return topoSort(asTasks).map((t) => t.id)
}

/**
 * 爆炸半径：改了某一镜的某个字段，哪些节点作废了。
 * 做法是从种子节点出发沿着「谁依赖我」正向传播，再按拓扑序排好，
 * 这样调用方直接顺着数组跑就不会出现「先跑下游后跑上游」。
 */
export function affectedNodes(shots: Shot[], shotId: string, field: EditableField): string[] {
  const graph = buildGraph(shots.map((s) => s.id))
  const affected = new Set<string>([nodeId(shotId, SEED[field])])
  // 图很小，直接跑到不动点为止，比手写 BFS 更难写错。
  for (let changed = true; changed;) {
    changed = false
    for (const n of graph) {
      if (affected.has(n.id)) continue
      if (n.deps.some((d) => affected.has(d))) {
        affected.add(n.id)
        changed = true
      }
    }
  }
  return ordered(graph).filter((id) => affected.has(id))
}

export type ReviewNote = {
  shotId: string
  verdict: 'pass' | 'redo' | 'hold'
  tags: string[]
  comment: string
  at: string
}

export type ShotVersion = {
  version: number
  at: string
  dialogue: string
  visual: string
  /** 相对 work 目录的产物路径，按节点分列。 */
  artifacts: Record<string, string>
  /** 这一版实际重跑了哪些节点；第一版是全量。 */
  regenerated: string[]
  reason: string
}

export type ShotState = {
  shot: Shot
  status: 'ready' | 'generating'
  current: number
  versions: ShotVersion[]
}
