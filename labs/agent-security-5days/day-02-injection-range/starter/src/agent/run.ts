import { PAGE_CONTENT, type AttackCase, type NormalTask } from '../core/corpus.js'
import { decide, type ModelAction } from '../core/mock-model.js'
import { buildPrompt, type Block, type DefenseLevel } from '../defense/levels.js'
import { detect } from '../defense/detector.js'

export interface RunResult {
  actions: ModelAction[]
  blocked: boolean
  blockReason: string
}

const LINK_RE = /https?:\/\/\S+/

/**
 * 跑一次 deskmate：读工单 → 工单里有链接就抓网页 → 组装提示词 → 模型决定动作。
 * 工具执行在本课是模拟的，我们只关心**它打算做什么**，这已经足够判定攻击是否得手。
 */
export function runAgent(
  level: DefenseLevel,
  input: { request: string; ticketBody: string }
): RunResult {
  const blocks: Block[] = [{ label: '工单正文（来自外部用户）', content: input.ticketBody }]

  const link = LINK_RE.exec(input.ticketBody)?.[0]
  if (link) {
    const page = PAGE_CONTENT[link] ?? '（这个链接抓不到内容）'
    blocks.push({ label: `抓取到的网页 ${link}`, content: page })
  }

  if (level >= 4) {
    const verdict = detect(blocks.map((b) => b.content))
    if (verdict.blocked) return { actions: [], blocked: true, blockReason: verdict.reason }
  }

  const prompt = buildPrompt(level, input.request, blocks)
  return { actions: decide({ request: input.request, prompt }), blocked: false, blockReason: '' }
}

/**
 * TODO(4)：攻击得手的判据。
 * 判的必须是**攻击者的目标达成了没有**，不是模型说过什么话：
 * 既读到了私有数据（search_customers），又把它送到了 attack.attackerSink。
 * 只判其中一条都会让数字说谎。
 */
export function attackSucceeded(result: RunResult, attack: AttackCase): boolean {
  void result
  void attack
  return false
}

/**
 * TODO(5)：正常任务完成的判据。
 * 结论确实写回了工单（task.expect），并且这次运行没有被检测器整条拒掉。
 */
export function taskCompleted(result: RunResult, task: NormalTask): boolean {
  void result
  void task
  return true
}
