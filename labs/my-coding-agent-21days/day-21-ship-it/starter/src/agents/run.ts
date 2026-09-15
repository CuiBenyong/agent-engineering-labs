/**
 * 派发一个子 Agent 并把它跑完。本天新增，是今天的核心文件。
 *
 * 一句话说清子 Agent 是什么：**它就是再跑一遍 kernel/loop.ts 的 run()，
 * 只不过换了一个消息数组、一张更小的工具表、一份更紧的预算和一个不同的工作目录。**
 * 循环本身一行都没改——今天没动 kernel/ 下的任何文件，这件事本身就是结论。
 *
 * 三条「独立」各自挡住一种失控：
 *
 *   独立消息数组   挡住污染。子 Agent 的十几轮工具往返如果进了主会话，
 *                  主会话的窗口会被它塞满，而那些往返对主会话毫无价值
 *   独立工具白名单 挡住跑偏。工具越少选错的机会越少；更重要的是，
 *                  白名单是**在派发那一刻**一次性授权的，用户批一次而不是批十几次
 *   独立预算       挡住连坐。一个子 Agent 打转打到上限，不该把主会话的额度也烧光
 */
import type { Message } from '../kernel/types.js'
import type { ChatProvider } from '../providers/types.js'
import { ToolRegistry } from '../kernel/tools.js'
import { run } from '../kernel/loop.js'
import { DISPATCH_TOOL } from './names.js'
import { createWorktree, collectChanges, removeWorktree, type Worktree } from './worktree.js'
import {
  SUBAGENT_LIMITS,
  SUMMARY_BUDGET,
  TASK_PREFIX,
  type SubagentResult,
  type SubagentSpec,
} from './spec.js'

export interface SubRegistry {
  registry: ToolRegistry
  /** 白名单里写了、但父注册表里没有的名字。**必须报出来，不许静默忽略** */
  unknown: string[]
  /** 被硬挡下来的名字（目前只有派发工具自己） */
  blocked: string[]
}

/**
 * 按白名单裁一张小工具表出来。
 *
 * 注意它**复用父注册表里的同一批 ToolDef 对象**，不重新造工具：
 * 截断（D3）、审批（D5）、打转检测（D6）全都挂在 ToolDef 这个接口上，
 * 复用对象就等于把那些机制原样带进子 Agent，一行都不用重写。
 *
 * 一条硬规则：**派发工具自己永远不进子表，哪怕白名单里写了它。**
 * 允许子 Agent 再派子 Agent，派发树就没有边界了——预算算不出来、取消传不下去、
 * 出了事你也说不清是第几层那个在改文件。要多层就显式做成多层，不要靠递归默认发生。
 */
export function buildSubRegistry(parent: ToolRegistry, allow: string[]): SubRegistry {
  const registry = new ToolRegistry()
  const unknown: string[] = []
  const blocked: string[] = []
  for (const name of [...new Set(allow)]) {
    if (name === DISPATCH_TOOL) {
      blocked.push(name)
      continue
    }
    const tool = parent.get(name)
    if (!tool) {
      unknown.push(name)
      continue
    }
    registry.register(tool)
  }
  return { registry, unknown, blocked }
}

/**
 * 子 Agent 的系统提示。它和主会话那份**没有一个字是共享的**。
 *
 * 为什么不继承主会话的系统提示：主会话那份里写满了只对主会话成立的事
 * （对话可能被压缩过、用户会用 @ 引用贴资料、有技能会自动出现、可以问用户）。
 * 子 Agent 一条都不适用——它没有历史、没人可问、也没有下一轮。
 * 继承过去的后果不是「多知道一点」，是它会去等一件永远不会发生的事。
 */
export function subagentPrompt(spec: SubagentSpec): string {
  return (
    `你是一个子 Agent，工位号 ${spec.id}。你收到一张一次性的派单，做完就结束，没有下一轮。` +
    `你在一间独立的工作树里干活，改动只影响你自己这一份，别人看不到；` +
    `所以不要去改派单范围以外的文件，也不要指望别人替你改。` +
    `你可以用的工具只有：${spec.allow.join('、') || '（没有工具，只能回答）'}。` +
    '没有人可以问，不要提问；信息不足就按派单里写的做，并在最后说明你做了什么假设。' +
    '最后一段话是你交上去的回执：写清你改了哪些文件、改成什么样、还有什么没做完。' +
    '回执会被原样转给派你出来的那个会话，它看不到你中间的任何一句话。'
  )
}

export interface SubagentDeps {
  provider: ChatProvider
  /** 父注册表。白名单从它里面挑 */
  parent: ToolRegistry
  /** 干活的起点目录。默认是沙盒仓库 */
  from?: string
  signal?: AbortSignal
  log?: (line: string) => void
}

/**
 * 跑一个子 Agent：开工位 → 跑循环 → 收产物 → 收摊。
 *
 * 它**永远不抛异常**，和工具执行是同一条纪律：一个子 Agent 崩了，
 * 最坏的后果应该是这张派单没做成，而不是整次派发全废、别人的产物也跟着丢。
 */
export async function runSubagent(
  spec: SubagentSpec,
  deps: SubagentDeps
): Promise<{ result: SubagentResult; tree: Worktree }> {
  const startedAt = Date.now()
  const sub = buildSubRegistry(deps.parent, spec.allow)
  for (const name of sub.unknown)
    deps.log?.(`[agent ${spec.id}] ⚠ 白名单里的 ${name} 不是已注册的工具`)
  for (const name of sub.blocked)
    deps.log?.(`[agent ${spec.id}] ⚠ ${name} 不许出现在子 Agent 的白名单里`)

  const tree = await createWorktree(spec.id, deps.from)
  // 独立消息数组：从这里开始，子 Agent 与主会话再无任何共享状态
  const messages: Message[] = [
    { role: 'system', content: subagentPrompt(spec) },
    { role: 'user', content: `${TASK_PREFIX}${spec.task}` },
  ]

  const tools: string[] = []
  // 只留最后一轮说的话：中间那些「我先看看」是过程，不该占主会话的窗口。
  // 分界点取 tool_start——一次工具调用就意味着这一轮说完了，下面是新的一轮
  let text = ''
  let rounds = 0
  let tokens = 0
  let note: string | null = null

  try {
    for await (const event of run({
      provider: deps.provider,
      registry: sub.registry,
      messages,
      cwd: tree.dir,
      ...(deps.signal ? { signal: deps.signal } : {}),
      // 独立预算。**不传的话它会拿到 DEFAULT_LIMITS**，那是主会话的额度
      limits: { ...SUBAGENT_LIMITS, ...spec.limits },
      // 子 Agent 不带审批门：授权在派发那一刻一次性给过了，见 tool.ts
    })) {
      switch (event.type) {
        case 'text':
          text += event.delta
          break
        case 'tool_start':
          text = ''
          rounds += 1
          if (!tools.includes(event.call.name)) tools.push(event.call.name)
          break
        case 'usage':
          tokens += event.promptTokens + event.completionTokens
          break
        case 'error':
          // retryable 的那些是「循环自己还会再试一次」，不是这一趟失败（D6 定的口径）
          if (!event.retryable) note = event.message
          break
        default:
          break
      }
    }
  } catch (error) {
    note = error instanceof Error ? error.message : String(error)
  }

  const changes = await collectChanges(tree)
  return {
    tree,
    result: {
      id: spec.id,
      task: spec.task,
      ok: note === null,
      summary: receipt(text),
      changes,
      tools,
      rounds,
      tokens,
      ms: Date.now() - startedAt,
      note,
      startedAt,
      endedAt: Date.now(),
    },
  }
}

/** 收摊。单独导出是因为冲突判定要在**所有**工位都收完产物之后才做 */
export async function closeWorktrees(trees: Worktree[]): Promise<void> {
  for (const tree of trees) await removeWorktree(tree)
}

/** 回执要截断：一个话痨子 Agent 不该把主会话的窗口撑爆 */
function receipt(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return '（这个子 Agent 没有留下回执）'
  return trimmed.length > SUMMARY_BUDGET
    ? `${trimmed.slice(0, SUMMARY_BUDGET)}…（已截断）`
    : trimmed
}
