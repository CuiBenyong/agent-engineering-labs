/**
 * 把钩子挂到工具上。本天新增，也是今天**唯一碰到既有代码的地方**（一行）。
 *
 * 挂法有三种，这里选了第三种，理由值得看清楚：
 *
 *   ① 改 kernel/loop.ts，在执行工具前后各插一段 —— 否决了。循环已经管着退避、
 *      上限、打转、审批四件事，再塞一件它就不是「循环」而是「什么都干的那个文件」。
 *   ② 给 AgentEvent 加 hook_start / hook_end 两个事件 —— 否决了。这是协议层改动，
 *      而渲染层并不需要知道钩子怎么跑（第五天的审批也是按同一条口径没进协议）。
 *   ③ **装饰 ToolDef** —— 就是这里。钩子只是「工具执行前后多做一点事」，
 *      而 ToolDef.run 正好就是「工具执行」这件事本身。
 *
 * 选③还有一个白捡的好处：**远端 MCP 工具、技能附带的脚本、以后新加的任何工具，
 * 一个字都不用改就自动带上了钩子**——因为它们本来就都是 ToolDef。
 * 第十五天说过「远端工具在循环眼里和本地工具没有区别」，今天是这句话的第二次兑现。
 *
 * 注意这里返回的是一张**新的注册表**，而不是就地改那些工具对象：
 * editFileTool 之类是模块级的单例，就地改 run 会污染同一个进程里的所有会话，
 * 自检里两个会话互相看到对方的钩子——这种故障只在有第二个会话时才出现。
 */
import type { ToolContext, ToolDef, ToolResult } from '../kernel/types.js'
import { ToolRegistry } from '../kernel/tools.js'
import type { HookDef } from './types.js'
import { formatHookRun, runHooks, selectHooks } from './run.js'

export interface HookState {
  hooks: HookDef[]
  /** 报账往哪里打。REPL 传终端，自检传一个收集器 */
  out(line: string): void
  /** 关掉所有钩子（/hooks off）。留一个总开关是必须的，理由见下面 */
  enabled: boolean
}

export function createHookState(out: (line: string) => void, hooks: HookDef[]): HookState {
  return { hooks, out, enabled: true }
}

export function withHooks(registry: ToolRegistry, state: HookState): ToolRegistry {
  const wrapped = new ToolRegistry()
  for (const tool of registry.list()) wrapped.register(decorate(tool, state))
  return wrapped
}

function decorate(tool: ToolDef, state: HookState): ToolDef {
  return {
    ...tool,
    async run(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (!state.enabled) return tool.run(rawArgs, ctx)
      const args = (rawArgs ?? {}) as Record<string, unknown>

      // 工具执行之前：这是唯一能说「不」的时刻
      const pre = await runHooks(selectHooks(state.hooks, 'pre_tool', tool.name), {
        event: 'pre_tool',
        tool: tool.name,
        args,
        cwd: ctx.cwd,
      })
      for (const row of formatHookRun(pre, 'pre_tool')) state.out(row)
      if (pre.denied) {
        // 否决走的是「返回一条失败结果」这条路，不是抛异常——和第五天的审批门一模一样。
        // 这条结果会被回灌给模型，于是第六天那套自纠机制自动接手：它会换一条路，
        // 而不是对着一个没有任何解释的失败反复重试同一个调用
        return {
          ok: false,
          content:
            `这次调用被钩子拦下了，工具没有执行。原因：${pre.denied}。` +
            `这是一条确定性规则，重试同样的参数不会有不同结果，请换一条路径。`,
          meta: { blockedBy: 'hook' },
        }
      }

      const result = await tool.run(args, ctx)

      // 工具执行之后：文件已经改了，这里能做的只有检查与回灌
      const post = await runHooks(selectHooks(state.hooks, 'post_tool', tool.name), {
        event: 'post_tool',
        tool: tool.name,
        args,
        result,
        cwd: ctx.cwd,
      })
      for (const row of formatHookRun(post, 'post_tool')) state.out(row)
      if (post.feed.length === 0) return result
      return {
        ...result,
        // 阻断型钩子失败时把这次调用判成失败。**它撤销不了任何东西**，
        // 它只是让模型知道「你刚才那一手没成」，好让它自己收拾
        ok: post.denied ? false : result.ok,
        content: `${result.content}\n\n钩子结果：\n${post.feed.join('\n')}`,
      }
    },
  }
}

/**
 * 跑会话级的钩子（session_start / session_end）。
 *
 * 它和工具级钩子分开一个入口，是因为**触发它的人不同**：工具级钩子由工具调用触发，
 * 会话级钩子由 REPL 的启动与退出触发。硬要合成一个函数，调用方就得凭空造一个
 * 不存在的「工具名」传进去。
 */
export async function runLifecycle(
  state: HookState,
  event: 'session_start' | 'session_end',
  cwd: string
): Promise<void> {
  if (!state.enabled) return
  const run = await runHooks(selectHooks(state.hooks, event), { event, cwd })
  for (const row of formatHookRun(run, event)) state.out(row)
}
