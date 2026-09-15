/**
 * 埋点层：**包在靶子外面**，不改靶子一行代码。
 *
 * ⚠️ src/agent/target.ts 与 src/core/runner.ts 都是冻结文件。这不是人为限制，
 * 而是真实处境的还原：线上那个 Agent 多半不是你写的，或者它已经在跑，
 * 你没有「回去重构一遍再埋点」这个选项。**能包就不要改**，这是可观测最实用的一条工程纪律。
 *
 * 包裹层能拿到的东西只有靶子返回的轨迹（Transcript）。于是本文件做的事情是：
 * **把一次试次的轨迹翻译成一棵链路树**。
 *
 * 三层：
 *   invoke_agent（一次试次）
 *     └── chat（这一轮模型调用）
 *           ├── execute_tool（lookup_order）
 *           └── execute_tool（issue_refund）
 *
 * 为什么把工具 span 挂在 chat 下面而不是与 chat 平级：工具是**这一轮模型调用**
 * 决定要调的，挂在它下面才能把工具耗时归因到具体某一轮。两种画法在真实
 * 埋点库里都见得到，**重点不是哪种对，而是全公司用同一种** —— 不然按层级做的
 * 聚合查询在两个服务之间就对不上。
 */

import type { EvalTarget, GradeResult, Task, Transcript, WorldState } from '../core/types'
import { GEN_AI, GEN_AI_OPERATION, SEMCONV_STABILITY, SEMCONV_VERSION } from './semconv'
import type { Span, Tracer } from './tracer'

export interface InstrumentOptions {
  /** 厂商名只写到平台一级。 */
  providerName: string
  model: string
  temperature: number
  maxTokens: number
}

/** 大字段要截断。整轮对话原样进链路是线上最常见的一次性把存储写爆的方式。 */
const MAX_PAYLOAD_CHARS = 300

function payload(value: unknown): string {
  const text = JSON.stringify(value) ?? 'null'
  return text.length <= MAX_PAYLOAD_CHARS ? text : `${text.slice(0, MAX_PAYLOAD_CHARS)}…[truncated]`
}

/** 试次的定位键。runner 是冻结文件、拿不到试次序号，只能在包裹层自己数。 */
function trialKey(taskId: string, index: number): string {
  return `${taskId}#${index}`
}

export class Instrumentation {
  private readonly roots = new Map<string, Span>()
  private readonly counters = new Map<string, number>()

  constructor(
    private readonly tracer: Tracer,
    private readonly options: InstrumentOptions
  ) {}

  /**
   * 包一个靶子，返回一个行为完全一致、但会吐 span 的新靶子。
   *
   * 注意它没有改变任何返回值：evalkit 的评分器读到的轨迹和包之前逐字相同。
   * **埋点不能改变被埋点对象的行为**，否则你测的就不是线上那个系统了。
   */
  wrap(inner: EvalTarget): EvalTarget {
    return {
      name: inner.name,
      run: async (task: Task, world: WorldState): Promise<Transcript> => {
        const index = this.counters.get(task.id) ?? 0
        this.counters.set(task.id, index + 1)
        const conversationId = trialKey(task.id, index)

        const root = this.tracer.start(
          `invoke_agent ${inner.name}`,
          GEN_AI_OPERATION.INVOKE_AGENT,
          undefined,
          {
            [GEN_AI.OPERATION_NAME]: GEN_AI_OPERATION.INVOKE_AGENT,
            [GEN_AI.PROVIDER_NAME]: this.options.providerName,
            [GEN_AI.REQUEST_MODEL]: this.options.model,
            [GEN_AI.CONVERSATION_ID]: conversationId,
            // 自己的属性一律放进自己的命名空间，不要往 gen_ai.* 里塞私货
            'eval.task.id': task.id,
            'eval.task.polarity': task.polarity,
            'eval.trial.index': index,
            'eval.semconv.version': SEMCONV_VERSION,
            'eval.semconv.stability': SEMCONV_STABILITY,
          }
        )
        this.roots.set(conversationId, root)

        let transcript: Transcript
        try {
          transcript = await inner.run(task, world)
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          this.tracer.fail(root, message)
          this.tracer.end(root, 0)
          throw e
        }

        this.emitModelTurn(root, task, transcript, conversationId)
        this.tracer.end(root, transcript.durationMs)
        return transcript
      },
    }
  }

  /** 第二层与第三层：一次模型调用，以及它决定要调的那些工具。 */
  private emitModelTurn(
    root: Span,
    task: Task,
    transcript: Transcript,
    conversationId: string
  ): void {
    // TODO 练习 2：把第二层与第三层补全。
    //
    // 现在只有一条几乎空白的 chat span：属性缺了一大半，工具调用一条都没埋。
    // 要做的事：
    //   1. 给 chat span 补上约定要求的属性 —— 模型、响应模型、温度、最大 token、
    //      finish_reasons、输入输出 token 用量、会话 id、输入输出消息（记得截断）。
    //      **属性名一律从 semconv.ts 的 GEN_AI 常量里取，不许手写字符串。**
    //   2. 遍历 transcript.toolCalls，每一次工具调用开一条 execute_tool span，
    //      **父亲是 chat 而不是 root**（工具是这一轮模型调用决定要调的）。
    //      每条要带 tool.name / tool.type / tool.call.id / arguments / result / conversation.id。
    //   3. 用 this.tracer.end(span, c.durationMs) 把靶子记的耗时写进去，
    //      不要用真实钟表 —— 否则每次跑出来的面板都不一样，没法 diff。
    //
    // 想清楚再动手：gen_ai.response.time_to_first_chunk **刻意不写**。
    // 离线靶子不是流式的，这个数拿不到，编一个比缺一列更糟。
    const chat = this.tracer.start(`chat ${this.options.model}`, GEN_AI_OPERATION.CHAT, root, {
      [GEN_AI.OPERATION_NAME]: GEN_AI_OPERATION.CHAT,
      [GEN_AI.PROVIDER_NAME]: this.options.providerName,
      [GEN_AI.REQUEST_MODEL]: this.options.model,
    })
    void task
    void conversationId
    this.tracer.end(chat, transcript.durationMs)
  }

  /**
   * 把评估结论挂回链路。**这是本天与前四天缝合的那一针。**
   *
   * 约定里已经有 gen_ai.evaluation.* 四件套，也就是说评估分数不是「另一个系统的数据」，
   * 它就是遥测本身。挂上去之后，面板上「失败率」这一列才有来源，
   * 而不是只能靠 HTTP 5xx 这种与业务正确性无关的信号去猜。
   */
  attachEvaluation(taskId: string, index: number, grades: GradeResult[]): void {
    // TODO 练习 3：把评估结论挂回根 span。
    //
    // this.roots 里存着每个试次的根 span（键是 trialKey(taskId, index)）。
    // 取出来之后写四个属性：evaluation.name / score.value / score.label / explanation，
    // 并在不通过时调 this.tracer.fail(root, 原因) 把这条链路标成 error。
    //
    // 不标 error 的失败，在面板上等于没发生过 —— 尾部采样也就留不住它。
    void taskId
    void index
    void grades
  }
}
