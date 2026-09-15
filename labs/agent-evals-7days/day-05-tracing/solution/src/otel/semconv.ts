/**
 * 生成式 AI 语义约定的属性名常量表 —— 本天全部埋点的唯一字符串来源。
 *
 * 为什么要有这个文件？因为这套约定是一个**移动的靶子**，而不是一个稳定的标准：
 *
 *   1. 2026-06-12 的 v1.42.0 起，所有 gen_ai.* 已经从主 semantic-conventions 仓库
 *      **移出**到独立仓库 open-telemetry/semantic-conventions-genai（Apache-2.0）。
 *      那个独立仓库到目前为止**一个 release tag 都还没有打过**。
 *   2. 于是主仓库的 registry 页面上，每一条 gen_ai.* 都带着「已弃用，已移至 GenAI 仓库」。
 *      ⚠️ **这不是属性被废弃，这是页面搬家。** 照着页面的红字把埋点删掉是最常见的误读。
 *   3. 截至 2026-07，没有任何 GenAI 的 span、属性或指标被标记为 Stable，
 *      全部处于 Development。没有 1.0，属性名还会改。
 *
 * 本课的口径是：**按它埋点，但把版本钉死。**
 * 所有属性名只在这个文件里出现一次，别处一律 import。这样约定改名时，
 * 你改的是一个文件，而不是满仓库 grep 一个字符串。
 */

/**
 * 钉死的约定版本。
 *
 * 主仓库最后一次带 gen_ai.* 的版本是 1.42.0；之后 gen_ai.* 的真源是独立仓库，
 * 而独立仓库还没有 tag，所以这里只能钉到一个日期。等它有了 tag，把
 * GENAI_REPO_REF 换成 tag —— 这一行本身就是给未来的自己留的升级坐标。
 */
export const SEMCONV_VERSION = '1.42.0'
export const GENAI_REPO_REF = 'open-telemetry/semantic-conventions-genai@2026-07'
/** 约定的成熟度。不是 stable —— 这个字段会被打进每一条链路，方便事后对账。 */
export const SEMCONV_STABILITY = 'development'

/**
 * 属性名。**逐字取自约定，不要自己造名字。**
 * 旧名 gen_ai.system 已弃用，现在叫 gen_ai.provider.name。
 */
export const GEN_AI = {
  OPERATION_NAME: 'gen_ai.operation.name',
  PROVIDER_NAME: 'gen_ai.provider.name',

  REQUEST_MODEL: 'gen_ai.request.model',
  REQUEST_TEMPERATURE: 'gen_ai.request.temperature',
  REQUEST_MAX_TOKENS: 'gen_ai.request.max_tokens',

  RESPONSE_MODEL: 'gen_ai.response.model',
  RESPONSE_ID: 'gen_ai.response.id',
  RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',
  /** 流式首块延迟，**单位是秒**，不是毫秒。 */
  RESPONSE_TIME_TO_FIRST_CHUNK: 'gen_ai.response.time_to_first_chunk',

  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  USAGE_CACHE_READ_INPUT_TOKENS: 'gen_ai.usage.cache_read.input_tokens',
  USAGE_CACHE_CREATION_INPUT_TOKENS: 'gen_ai.usage.cache_creation.input_tokens',
  USAGE_REASONING_OUTPUT_TOKENS: 'gen_ai.usage.reasoning.output_tokens',

  CONVERSATION_ID: 'gen_ai.conversation.id',

  TOOL_NAME: 'gen_ai.tool.name',
  TOOL_TYPE: 'gen_ai.tool.type',
  TOOL_CALL_ID: 'gen_ai.tool.call.id',
  TOOL_CALL_ARGUMENTS: 'gen_ai.tool.call.arguments',
  TOOL_CALL_RESULT: 'gen_ai.tool.call.result',

  INPUT_MESSAGES: 'gen_ai.input.messages',
  OUTPUT_MESSAGES: 'gen_ai.output.messages',

  /**
   * 本天的结构性转折点：**评估结果本身就是一等公民的遥测数据。**
   * 有了这四个属性，D1–D4 的离线评估分数就能挂在线上链路上，
   * 离线与在线不再是两套互不相干的系统。
   */
  EVALUATION_NAME: 'gen_ai.evaluation.name',
  EVALUATION_SCORE_VALUE: 'gen_ai.evaluation.score.value',
  EVALUATION_SCORE_LABEL: 'gen_ai.evaluation.score.label',
  EVALUATION_EXPLANATION: 'gen_ai.evaluation.explanation',
} as const

export type GenAiAttributeName = (typeof GEN_AI)[keyof typeof GEN_AI]

/**
 * gen_ai.operation.name 的**全部**合法取值，一共九个。
 * 约定里这是一个枚举，写 'agent_run' 这种自造值等于没埋 —— 后端按枚举分面，
 * 自造值会掉进 other 桶里，永远出不了图。
 */
export const GEN_AI_OPERATION = {
  CHAT: 'chat',
  CREATE_AGENT: 'create_agent',
  EMBEDDINGS: 'embeddings',
  EXECUTE_TOOL: 'execute_tool',
  GENERATE_CONTENT: 'generate_content',
  INVOKE_AGENT: 'invoke_agent',
  INVOKE_WORKFLOW: 'invoke_workflow',
  RETRIEVAL: 'retrieval',
  TEXT_COMPLETION: 'text_completion',
} as const

export type GenAiOperation = (typeof GEN_AI_OPERATION)[keyof typeof GEN_AI_OPERATION]

const OPERATION_VALUES: ReadonlySet<string> = new Set(Object.values(GEN_AI_OPERATION))
const ATTRIBUTE_VALUES: ReadonlySet<string> = new Set(Object.values(GEN_AI))

/** 这个名字是不是约定里的名字。自检的属性名护栏用它。 */
export function isKnownAttribute(name: string): boolean {
  return ATTRIBUTE_VALUES.has(name)
}

/** 这个操作名是不是九个合法取值之一。 */
export function isKnownOperation(value: string): boolean {
  return OPERATION_VALUES.has(value)
}

/** 全部已登记的属性名，供护栏枚举。 */
export function knownAttributes(): string[] {
  return [...ATTRIBUTE_VALUES].sort()
}

/**
 * 本课要求**必须**出现在一棵完整链路里的属性。
 *
 * 它的作用是防止护栏恒真：只断言「用到的名字都合法」，
 * 一个什么都没埋的实现也会全绿（零个名字，零个违规）。
 * 所以还要反过来断言「这些名字一个都不能少」。
 */
export const REQUIRED_ATTRIBUTES: readonly string[] = [
  GEN_AI.OPERATION_NAME,
  GEN_AI.PROVIDER_NAME,
  GEN_AI.REQUEST_MODEL,
  GEN_AI.RESPONSE_MODEL,
  GEN_AI.USAGE_INPUT_TOKENS,
  GEN_AI.USAGE_OUTPUT_TOKENS,
  GEN_AI.CONVERSATION_ID,
  GEN_AI.TOOL_NAME,
  GEN_AI.TOOL_CALL_ID,
  GEN_AI.EVALUATION_NAME,
  GEN_AI.EVALUATION_SCORE_VALUE,
  GEN_AI.EVALUATION_SCORE_LABEL,
]
