/**
 * 会话对象怎么造出来：Session 的形状、工具注册表的唯一出口、replaceHistory。
 * 来自 D15，本天改了两处：Session 上多了一个 skills（装上的技能、没装上的问题、
 * 被点名的 id），以及系统提示末尾拼上技能的阶段一摘要。
 *
 * **注意本天没有往工具注册表里加任何东西。** 技能不是工具，它不占工具清单的位置，
 * 也不会被模型「调用」——它是一段在合适的时候被放到模型面前的文字。
 * 这条分工是今天的核心判断，代码里的体现就是：createRegistry 一行都没改。
 *
 * 原 D15 说明：本天从 commands.ts 拆出来。
 *
 * 拆的理由和前几天一样，是行数：D14 的 commands.ts 已经 337 行，本课单文件上限 350，
 * 而今天还要往命令表里加一条 /mcp。**文件到了上限就拆，是这门课的纪律之一。**
 *
 * 拆的界线选在这里而不是别处：commands.ts 剩下的是**命令表**（一张数据表，
 * 每条命令一个对象），这个文件装的是**会话工厂**（一次性的构造逻辑）。
 * 两者本来就是「数据」与「装配」两件事，只是以前挤在一个文件里。
 */
import type { Message } from './kernel/types.js'
import { ToolRegistry } from './kernel/tools.js'
import { systemPromptWith } from './system-prompt.js'
import { createState, type PermissionState } from './kernel/permissions.js'
import type { SessionLog } from './session/log.js'
import { Calibrator } from './context/tokens.js'
import { CheckpointLog } from './snapshot/log.js'
import { createPlanState, type PlanState } from './plan/mode.js'
import { createAskTool, type Asker } from './plan/ask.js'
import { createSubmitPlanTool } from './plan/submit.js'
import { readFileTool } from './tools/read-file.js'
import { globTool } from './tools/glob.js'
import { grepTool } from './tools/grep.js'
import { createFileTool, editFileTool } from './tools/edit-file.js'
import { runCommandTool } from './tools/command.js'
import type { McpMount } from './mcp/mount.js'
import { emptySkillState, type SkillState } from './skills/scan.js'
import { stage1Summary } from './skills/inject.js'
import { createDispatchTool } from './agents/tool.js'

export interface Session {
  messages: Message[]
  registry: ToolRegistry
  permissions: PermissionState
  /** 当前会话的写入端。分叉之后会被换成新会话的那一个 */
  log: SessionLog
  /** token 估算器的校准样本。D12 新增：样本按会话攒，系数是进程级的 */
  calibrator: Calibrator
  /** 计划模式的状态。D13 新增 */
  plan: PlanState
  /** 文件快照那一条时间线的写入端。D14 新增，与上面那个 log 完全独立 */
  checkpoints: CheckpointLog
  /** 挂载的 MCP server。D15 新增；没挂任何 server 时是 null */
  mcp: McpMount | null
  /** 装上的技能与它们的状态。本天新增 */
  skills: SkillState
  out(line: string): void
}

/** 原地替换历史：循环与自检持有的是同一个数组引用，不能整体赋值 */
export function replaceHistory(messages: Message[], next: Message[]): void {
  messages.splice(0, messages.length, ...next)
}

export interface SessionDeps {
  /** 提问渠道。REPL 传一个从行队列读的，自检传一个按剧本答的，管道里不传 */
  ask?: Asker
  log?: (line: string) => void
  /** 快照日志的写入端。不传就从 0 开始编号（新会话）；--resume 要传 open() 出来的那个 */
  checkpoints?: CheckpointLog
  /** 已经连上的 MCP server。D15 新增 */
  mcp?: McpMount
  /** 启动时扫出来的技能。本天新增；不传就是「这台机器上一个技能都没装」 */
  skills?: SkillState
}

/**
 * 工具注册只有这一处：加一个工具不该动循环、渲染或 REPL 的任何一行。
 *
 * 本天它多了最后那几行——把远端工具也注册进来。值得注意的是这几行有多短：
 * **远端工具与本地工具在循环眼里没有任何区别**，因为它们都只是 ToolDef。
 * 截断（D3）、审批（D5）、打转检测（D6）、快照（D14）一条都不用改，
 * 它们本来就挂在 ToolDef 这个接口上，而不是挂在「我们自己写的工具」上。
 */
export function createRegistry(
  plan: PlanState,
  permissions: PermissionState,
  deps: SessionDeps = {}
): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(globTool)
  registry.register(grepTool)
  registry.register(readFileTool)
  registry.register(editFileTool)
  registry.register(createFileTool)
  registry.register(runCommandTool)
  registry.register(
    createAskTool(
      { ...(deps.ask ? { ask: deps.ask } : {}), ...(deps.log ? { log: deps.log } : {}) },
      plan.asked
    )
  )
  registry.register(
    createSubmitPlanTool({
      state: plan,
      permissions,
      writeTool: editFileTool,
      ...(deps.log ? { log: deps.log } : {}),
    })
  )
  // 本天新增：挂载的每个 MCP server 把自己的工具翻译成 ToolDef 交出来
  for (const tool of deps.mcp?.toolDefs() ?? []) registry.register(tool)
  // 本天新增：派发子 Agent 的工具。它要按白名单从这张表里挑工具给子 Agent，
  // 而这张表此刻正在被构造，所以传的是取法（() => registry）而不是表本身
  registry.register(
    createDispatchTool({ toolsOf: () => registry, ...(deps.log ? { log: deps.log } : {}) })
  )
  return registry
}

export function newSession(
  out: (line: string) => void,
  log: SessionLog,
  deps: SessionDeps = {}
): Session {
  const plan = createPlanState()
  const permissions = createState()
  const skills = deps.skills ?? emptySkillState()
  return {
    // 阶段一：技能摘要拼在系统提示末尾，从此每一次请求都带着它
    messages: [{ role: 'system', content: systemPromptWith(stage1Summary(skills.skills).text) }],
    registry: createRegistry(plan, permissions, { log: out, ...deps }),
    permissions,
    log,
    calibrator: new Calibrator(),
    plan,
    checkpoints: deps.checkpoints ?? new CheckpointLog(),
    mcp: deps.mcp ?? null,
    skills,
    out,
  }
}
