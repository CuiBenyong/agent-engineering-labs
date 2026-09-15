/**
 * dispatch_agents：主会话派活儿用的那个工具。本天新增。
 *
 * 为什么派发要做成一个**工具**而不是一条斜杠命令：拆活儿这件事必须由模型来做。
 * 只有读过代码的那一方才知道「这两件事能不能分开干」，而斜杠命令意味着
 * 用户自己拆——用户拆得动的活儿，本来也不需要 Agent。
 *
 * 它用工厂函数拿依赖（D13 定的口径）：父注册表与 provider 都是闭包进来的，
 * **ToolContext 与 AgentEvent 一个字段都没加**。
 *
 * 审批只发生在这里，子 Agent 内部不再设门。这是本天最重要的一条权限判断：
 *   - 用户批的是「派两个 Agent 去干这两件事，它们能用这些工具」，
 *     一次决定，而且他看得懂；
 *   - 子 Agent 内部逐次审批的话，用户会被十几个「允许 edit_file 吗」轮番打断，
 *     而且他**看不到子 Agent 的上下文**，根本没有判断依据——那种审批只是走过场。
 *   - 授权的边界改由白名单承担：白名单里没有 run_command，它就永远跑不了命令。
 */
import type { ToolContext, ToolDef, ToolResult } from '../kernel/types.js'
import type { ToolRegistry } from '../kernel/tools.js'
import type { ChatProvider } from '../providers/types.js'
import { createProvider } from '../providers/index.js'
import { DISPATCH_TOOL } from './names.js'
import { runSubagent, closeWorktrees } from './run.js'
import { mergeInto, formatReport } from './merge.js'
import {
  ID_PATTERN,
  MAX_AGENTS,
  type MergePlan,
  type SubagentResult,
  type SubagentSpec,
} from './spec.js'

export interface DispatchDeps {
  /** 父注册表的取法。用函数是因为注册表正在被构造，这时候还拿不到它本身 */
  toolsOf(): ToolRegistry
  /** 不传就在第一次派发时按环境变量造一个（和 REPL 用的是同一条选择点） */
  provider?: ChatProvider
  log?(line: string): void
}

/** 最近一次派发的结果。/agents 命令读它，自检也读它 */
export interface Dispatch {
  results: SubagentResult[]
  plan: MergePlan
  written: string[]
  /** 墙上时间：从第一个子 Agent 起跑到最后一个跑完 */
  wallMs: number
}

let lastDispatch: Dispatch | null = null
export const getLastDispatch = (): Dispatch | null => lastDispatch

/**
 * 真正的派发。工具只是它的壳，自检直接调这个函数，不必绕一圈模型。
 *
 * 并行靠 Promise.all：**它们等的是网络，不是 CPU**，所以单线程的 Node 也能真并行。
 * 这一点值得说清——很多人以为要多进程才叫并行，而 Agent 这种活儿九成时间都在等模型回话。
 */
export async function dispatchAgents(specs: SubagentSpec[], deps: DispatchDeps): Promise<Dispatch> {
  const provider = deps.provider ?? createProvider()
  const startedAt = Date.now()
  const settled = await Promise.all(
    specs.map((spec) =>
      runSubagent(spec, {
        provider,
        parent: deps.toolsOf(),
        ...(deps.log ? { log: deps.log } : {}),
      })
    )
  )
  const wallMs = Date.now() - startedAt
  const results = settled.map((s) => s.result)
  // 收产物已经在 runSubagent 里做完了，所以收摊可以放心地在合并之前
  await closeWorktrees(settled.map((s) => s.tree))
  const { plan, written } = await mergeInto(results)
  lastDispatch = { results, plan, written, wallMs }
  return lastDispatch
}

/** 派单的校验。**一条都不能省**：这些参数是模型编出来的，不是人填的 */
export function validateSpecs(raw: unknown): { specs: SubagentSpec[]; error: string | null } {
  const list = Array.isArray(raw) ? raw : []
  if (list.length === 0) return { specs: [], error: 'agents 至少要有一张派单' }
  if (list.length > MAX_AGENTS) {
    return { specs: [], error: `一次最多派 ${MAX_AGENTS} 个子 Agent，这次给了 ${list.length} 个` }
  }
  const specs: SubagentSpec[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const bag = (item ?? {}) as Record<string, unknown>
    const id = String(bag.id ?? '')
    const task = String(bag.task ?? '').trim()
    if (!ID_PATTERN.test(id))
      return { specs: [], error: `工位号 ${id || '(空)'} 不合法：只允许小写字母、数字与连字符` }
    if (seen.has(id))
      return { specs: [], error: `工位号 ${id} 重复了，两个子 Agent 不能共用一间工位` }
    if (task === '') return { specs: [], error: `${id} 的 task 是空的` }
    seen.add(id)
    specs.push({ id, task, allow: (Array.isArray(bag.allow) ? bag.allow : []).map(String) })
  }
  return { specs, error: null }
}

export function createDispatchTool(deps: DispatchDeps): ToolDef {
  return {
    name: DISPATCH_TOOL,
    description:
      '把几件互不相干的事同时派给几个子 Agent。每个子 Agent 在自己的工作树里干活，' +
      '有自己的上下文与工具白名单，做完之后只把一份回执交回来。' +
      '只在这几件事**改的不是同一批文件、而且互相不依赖**时才用它；' +
      '有先后顺序的活儿请自己按顺序做，派出去只会更慢更贵。',
    parameters: {
      type: 'object',
      properties: {
        agents: {
          type: 'array',
          description: `最多 ${MAX_AGENTS} 张派单`,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '工位号，小写字母数字与连字符，例如 calc-guard' },
              task: { type: 'string', description: '一句话说清要做什么、做到什么程度算完' },
              allow: {
                type: 'array',
                items: { type: 'string' },
                description: '这个子 Agent 能用的工具名，按最小够用给',
              },
            },
            required: ['id', 'task', 'allow'],
            additionalProperties: false,
          },
        },
      },
      required: ['agents'],
      additionalProperties: false,
    },
    // 它会改文件，所以要过审批门——而且整次派发只过这一次
    readOnly: false,

    async run(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const args = (rawArgs ?? {}) as Record<string, unknown>
      const { specs, error } = validateSpecs(args.agents)
      if (error) return { ok: false, content: `没有派出任何子 Agent：${error}` }
      if (ctx.signal.aborted)
        return { ok: false, content: '用户已经取消了这一轮，没有派出子 Agent。' }

      const dispatch = await dispatchAgents(specs, deps)
      const report = formatReport(dispatch.results, dispatch.plan)
      return {
        // 有冲突就算没做成：模型必须知道它交不了差，而不是接着往下说「都改好了」
        ok: dispatch.plan.conflicts.length === 0 && dispatch.results.every((r) => r.ok),
        content: report,
        meta: {
          agents: dispatch.results.length,
          written: dispatch.written,
          conflicts: dispatch.plan.conflicts.length,
          wallMs: dispatch.wallMs,
          serialMs: dispatch.results.reduce((sum, r) => sum + r.ms, 0),
        },
      }
    },
  }
}
