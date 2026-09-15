/**
 * 只读探索模式与计划的状态机。本天新增。
 *
 * **本天最重要的一句话：只读探索模式不是一套新的权限系统，它是第五天那张规则表的一个预设。**
 *
 * 具体说，它只是把规则表整体换成两条：
 *
 *   { decision: 'deny' }                          所有工具一律不许
 *   { tool: 'submit_plan', decision: 'ask' }      除了「交一份计划」这一件事
 *
 * 而只读工具（glob / grep / read_file / ask_user）根本走不到规则表——第五天的 decide()
 * 第一行就是「readOnly 为真直接放行」。于是「探索模式」这四个字在代码里只对应一次
 * 规则表替换，一个新的判定分支都没有。
 *
 * 如果反过来做——加一个 mode 字段，然后在循环里、在门里、在每个写工具里各判一次
 * 「现在是不是计划模式」——你会得到三处可能不一致的判断，而它们不一致的那天
 * 表现是「计划模式下它偷偷改了文件」。**权限的判定入口全课只能有一个。**
 *
 * 一条本天的裁定：**计划模式不给任何命令开口子**，连第五天默认放行的 node --test 也挡。
 * 在探索阶段跑测试确实无害，但「哪条命令算只读」是个无法穷举的判断
 * （跑测试会不会写快照文件？会不会碰缓存目录？），而计划模式的全部价值就在于
 * 边界简单到能一句话说清：**只读工具全过，其余全挡。** 想跑测试就先出计划。
 */
import type { PermissionState, Rule } from '../kernel/permissions.js'
import { decide } from '../kernel/permissions.js'
import type { ToolDef } from '../kernel/types.js'
import type { Plan } from './plan.js'
import { plannedFiles } from './plan.js'
import type { AskRecord } from './ask.js'

export type Mode = 'normal' | 'plan'

/** 一次成功的写入：核对计划时要用 */
export interface WriteRecord {
  tool: string
  path: string
}

export interface PlanState {
  mode: Mode
  /** 进计划模式时把原来的规则表存起来，退出时原样放回去 */
  savedRules: Rule[] | null
  /** 已批准的计划。没批准过就是 null */
  approved: Plan | null
  /** 待批准的那一份（submit_plan 收到但用户还没答） */
  pending: Plan | null
  /** 本会话里问过的问题 */
  asked: AskRecord[]
  /** 计划批准之后发生的成功写入 */
  writes: WriteRecord[]
  /** 计划批准之后成功跑过的命令：核对 verify 那一条要用 */
  commands: string[]
}

export function createPlanState(): PlanState {
  return {
    mode: 'normal',
    savedRules: null,
    approved: null,
    pending: null,
    asked: [],
    writes: [],
    commands: [],
  }
}

/** 计划模式的规则表。只有两条，理由见文件头 */
export const PLAN_RULES: Rule[] = [
  {
    decision: 'deny',
    why:
      '现在是只读探索模式：可以读文件、搜内容、问用户，但不能改文件也不能跑命令。' +
      '先探清楚，然后用 submit_plan 交一份计划等用户批准，批准之后才可以动手。',
  },
  {
    tool: 'submit_plan',
    decision: 'ask',
    why: '这是一份要用户批准的计划',
  },
]

export function enterPlanMode(state: PlanState, permissions: PermissionState): void {
  if (state.mode === 'plan') return
  state.savedRules = permissions.rules
  // TODO(1)：现在是**把两条预设追加在原规则表后面**，看着更温和——原来的规则还在，
  // 只是多了一条「一律 deny」。但第五天那条匹配规则是「更具体的赢」，而原表里
  // 那条 run_command command=node --test* allow 比无条件的 deny 具体得多。
  // 于是探索模式下 node --test 照跑，而且没有任何提示。
  // 改成**整体替换**规则表（原表已经存进 state.savedRules，退出时放回去）。
  permissions.rules = [...permissions.rules, ...PLAN_RULES]
  state.mode = 'plan'
  state.pending = null
  state.approved = null
  state.writes = []
  state.commands = []
}

/**
 * 退出计划模式，把规则表放回去，并按批准的计划**只**放行计划里那几个文件。
 *
 * 这一段是「批准的是这份计划，不是无限授权」那句话的实现。批准之后如果直接
 * 把规则表放回去、什么都不加，那么计划里每个文件在执行时还会被单独问一遍
 * ——用户刚批准了一份写明要改哪些文件的计划，再问一遍是纯粹的骚扰。
 * 反过来，批准之后就把整个写权限打开，那批准这份计划和批准「随便改」没有区别。
 *
 * 所以放行的粒度就是计划里列出的那几个文件，一个不多。
 *
 * **而且放行不能越过 deny。** 授权前先用原规则表判一次：只有判定为 ask
 * （也就是「本来要问一句」）的文件才放行；本来就 deny 的（比如测试目录）
 * 保持 deny——否则模型只要把 test/ 写进计划，就能借一次审批绕开一条硬规则。
 */
export function exitPlanMode(
  state: PlanState,
  permissions: PermissionState,
  plan: Plan,
  writeTool: ToolDef
): { granted: string[]; refused: string[] } {
  permissions.rules = state.savedRules ?? permissions.rules
  state.savedRules = null
  state.mode = 'normal'
  state.approved = plan
  state.pending = null
  state.writes = []
  state.commands = []

  const granted: string[] = []
  const refused: string[] = []
  // TODO(4)：现在是**一条整体放行**——批准一份计划就把 edit_file 全开。
  // 代码短，但它把「批准这份计划」变成了「批准随便改」，计划里写的那几个文件成了摆设。
  // 改成按 plannedFiles(plan) 逐个文件放行，并且**放行之前先用 decide() 判一次**：
  // 本来判 deny 的（比如 test/ 目录）不许放行，收进 refused 返回出去——
  // 否则模型只要把 test/ 写进计划，就能借一次审批绕开一条硬规则。
  permissions.rules.push({ tool: writeTool.name, decision: 'allow', why: '在已批准的计划里' })
  for (const file of plannedFiles(plan)) granted.push(file)
  void decide
  return { granted, refused }
}

export function describeMode(state: PlanState): string {
  if (state.mode === 'plan') return '只读探索模式（写工具与命令都被挡，先出计划）'
  if (state.approved) return `可写模式（正在执行已批准的计划：${state.approved.goal}）`
  return '可写模式（写操作按第五天那张规则表逐个判定）'
}
