/**
 * 钩子协议。本天新增。
 *
 * 先说清这个协议为什么长这样：**钩子是确定性的那一半。** 前十七天加的东西全是
 * 「让模型做得更好」——更多工具、更好的上下文、更贴的经验。钩子反过来，它是
 * 「不让模型有机会做错」：一条不许改测试文件的规矩写进提示词，模型会遵守大部分时候；
 * 写成钩子，它就是百分之百。**凡是你能用一个 if 判断出来的规矩，就不该交给概率。**
 *
 * 四个触发点，覆盖一次会话里所有「有边界的时刻」：
 *
 *   session_start  会话开始：环境检查、把仓库状态记一笔
 *   pre_tool       工具执行之前：**这是唯一能否决的时刻**
 *   post_tool      工具执行之后：格式化、跑测试、把结果回灌给模型
 *   session_end    会话结束：收摊、汇总
 *
 * 为什么只有 pre_tool 能否决：否决的意思是「这件事没有发生」。工具跑完之后文件已经改了、
 * 命令已经执行了，那时候说「不行」是自欺——你能做的只有把失败告诉模型让它自己收拾。
 * 所以 post_tool 的 blocking 语义是**另一件事**：不是阻止，而是「把这次调用判成失败」，
 * 好让第六天那套自纠机制接手。两者的区别必须写进协议注释里，否则一定会有人
 * 以为 post_tool 的 blocking 能撤销一次写入。
 */
import type { ToolResult } from '../kernel/types.js'

export type HookEvent = 'session_start' | 'pre_tool' | 'post_tool' | 'session_end'

export interface HookInput {
  event: HookEvent
  /** pre_tool / post_tool 时有 */
  tool?: string
  /**
   * 已经解析好的参数。
   *
   * 刻意传解析后的对象而不是原始 JSON 文本：让每个钩子自己 JSON.parse 一遍，
   * 等于把「参数可能不是合法 JSON」这个第三天就处理过的问题复制到每一个钩子里，
   * 而且它们的处理方式必然各不相同。
   */
  args?: Record<string, unknown>
  /** post_tool 时有：工具真正的执行结果 */
  result?: ToolResult
  cwd: string
}

export interface HookOutcome {
  /**
   * 钩子这一次跑成功了没有。
   *
   * **它和「要不要放行」是两件事**，这是本协议最容易被写错的一处：
   * 一个格式化钩子没找到可格式化的文件，它 ok 为 false，但那不该拦住任何东西。
   * 拦不拦由 HookDef.blocking 决定，钩子本身只报告自己的结果。
   */
  ok: boolean
  /** 给用户看的一句话。必填——一个不说话的钩子等于一个查不出来的幽灵 */
  note: string
  /**
   * 要回灌给模型的文本。留空表示「模型不必知道这件事」。
   *
   * 判据只有一条：**模型接下来的决策会不会因为知道它而不同。** 格式化改了几个空格，
   * 模型知道了也不会做别的事，那就不回灌；测试红了，它必须知道，否则会接着往下走。
   */
  feed?: string
}

export interface HookDef {
  name: string
  event: HookEvent
  /** 只对这些工具生效；不写就是对所有工具生效 */
  tools?: string[]
  /**
   * 失败时阻断还是只警告。
   *
   * pre_tool 的阻断 = 工具不执行；post_tool 的阻断 = 这次调用被判成失败并回灌原因。
   * **默认应该是 false**：一个动不动就阻断的钩子会把 Agent 变成一个走不动路的东西，
   * 而那种故障最难查——用户看到的只是「它今天什么都不肯做」。
   */
  blocking: boolean
  /** 单个钩子的时间上限。没有超时的钩子就是一个新的挂死点 */
  timeoutMs: number
  run(input: HookInput): Promise<HookOutcome>
}
