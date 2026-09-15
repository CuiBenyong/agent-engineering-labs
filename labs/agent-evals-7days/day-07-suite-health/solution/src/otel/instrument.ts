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
    const chat = this.tracer.start(`chat ${this.options.model}`, GEN_AI_OPERATION.CHAT, root, {
      [GEN_AI.OPERATION_NAME]: GEN_AI_OPERATION.CHAT,
      [GEN_AI.PROVIDER_NAME]: this.options.providerName,
      [GEN_AI.REQUEST_MODEL]: this.options.model,
      [GEN_AI.REQUEST_TEMPERATURE]: this.options.temperature,
      [GEN_AI.REQUEST_MAX_TOKENS]: this.options.maxTokens,
      [GEN_AI.RESPONSE_MODEL]: this.options.model,
      [GEN_AI.RESPONSE_ID]: `resp-${conversationId}`,
      [GEN_AI.RESPONSE_FINISH_REASONS]: transcript.toolCalls.length > 0 ? 'tool_calls' : 'stop',
      [GEN_AI.USAGE_INPUT_TOKENS]: transcript.inputTokens,
      [GEN_AI.USAGE_OUTPUT_TOKENS]: transcript.outputTokens,
      [GEN_AI.CONVERSATION_ID]: conversationId,
      [GEN_AI.INPUT_MESSAGES]: payload([{ role: 'user', content: task.prompt }]),
      [GEN_AI.OUTPUT_MESSAGES]: payload(transcript.messages.filter((m) => m.role === 'assistant')),
    })

    // 首块延迟 gen_ai.response.time_to_first_chunk 刻意**不写**：
    // 离线靶子不是流式的，这个数拿不到。编一个出来比缺一列更糟 ——
    // 面板上一个假的 P95 会让人对着一个不存在的问题优化。见 aggregate.ts 的覆盖率一列。

    let toolMs = 0
    for (const [i, c] of transcript.toolCalls.entries()) {
      const span = this.tracer.start(
        `execute_tool ${c.name}`,
        GEN_AI_OPERATION.EXECUTE_TOOL,
        chat,
        {
          [GEN_AI.OPERATION_NAME]: GEN_AI_OPERATION.EXECUTE_TOOL,
          [GEN_AI.TOOL_NAME]: c.name,
          [GEN_AI.TOOL_TYPE]: 'function',
          [GEN_AI.TOOL_CALL_ID]: `${conversationId}-tool-${i}`,
          [GEN_AI.TOOL_CALL_ARGUMENTS]: payload(c.args),
          [GEN_AI.TOOL_CALL_RESULT]: payload(c.result),
          [GEN_AI.CONVERSATION_ID]: conversationId,
        }
      )
      this.tracer.end(span, c.durationMs)
      toolMs += c.durationMs
    }

    this.tracer.end(chat, Math.max(transcript.durationMs - 1, toolMs))
  }

  /**
   * 把评估结论挂回链路。**这是本天与前四天缝合的那一针。**
   *
   * 约定里已经有 gen_ai.evaluation.* 四件套，也就是说评估分数不是「另一个系统的数据」，
   * 它就是遥测本身。挂上去之后，面板上「失败率」这一列才有来源，
   * 而不是只能靠 HTTP 5xx 这种与业务正确性无关的信号去猜。
   */
  attachEvaluation(taskId: string, index: number, grades: GradeResult[]): void {
    const root = this.roots.get(trialKey(taskId, index))
    if (!root) return
    const passed = grades.length > 0 && grades.every((g) => g.passed)
    const worst = grades.find((g) => !g.passed) ?? grades[0]
    this.tracer.setAttributes(root, {
      [GEN_AI.EVALUATION_NAME]: worst?.grader ?? 'outcome',
      [GEN_AI.EVALUATION_SCORE_VALUE]: worst?.score ?? 0,
      [GEN_AI.EVALUATION_SCORE_LABEL]: passed ? 'pass' : 'fail',
      [GEN_AI.EVALUATION_EXPLANATION]: worst?.reason ?? '',
    })
    if (!passed) this.tracer.fail(root, worst?.reason ?? '评估未通过')
  }
}
