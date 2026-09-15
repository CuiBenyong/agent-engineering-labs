import type { Chunk, Department } from './corpus'
import type { Assessment, Assessor } from './reflect'
import {
  CONTEXT_BUDGET,
  countTokens,
  packContext,
  type Candidate,
  type Retriever,
} from './retrieve'

/**
 * 把检索包成工具，接进一个最小 Agent 循环，并给循环装三道刹车。
 * 本天的教学核心在这个文件里。
 */

// ---------------------------------------------------------------------------
// 一、工具定义：描述写得好不好，直接决定模型会不会乱用
// ---------------------------------------------------------------------------

/**
 * 工具描述是**写给模型看的提示词**，不是写给同事看的注释。它要回答四个问题：
 * 这个工具查的是什么范围、什么时候该用、什么时候不该用、查询串怎么写。
 * 少写哪一条，线上就会出现对应的一类错误行为——见正文。
 */
export const SEARCH_TOOL = {
  name: 'search_knowledge_base',
  // 练习 1：把下面这句敷衍的描述改写成真正管用的工具描述。
  //   它是**写给模型看的提示词**，要回答四个问题：查的是什么范围、什么时候该用、
  //   什么时候不该用、query 该写成什么形状。少写哪一条，线上就会出现对应的一类错误行为。
  //   提示：先写「什么时候不用」，这一条最容易漏，漏了模型会连「你好」都去查一次库。
  description: '在知识库里搜索。',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: '检索关键词短语，2 到 8 个词' },
      department: {
        type: 'string',
        enum: ['product', 'hr', 'eng', 'support'],
        description: '可选。只在确定答案属于该部门时才填',
      },
    },
    required: ['query'],
  },
}

// ---------------------------------------------------------------------------
// 二、三道刹车
// ---------------------------------------------------------------------------

export const BRAKES = {
  /** 第一道：最多查几轮。多跳问题实测两跳就够，留一轮余量 */
  maxRounds: 4,
  /** 第二道：整场循环最多读进多少 token 的材料。它拦的是「每轮都不超但累计爆掉」 */
  tokenBudget: 3000,
}

/** 查询归一化：只看词的集合，「主备切换 审批」和「审批 主备切换」是同一个查询 */
export function normalizeQuery(query: string): string {
  return [...new Set(query.toLowerCase().match(/[一-鿿]|[a-z0-9]+/gu) ?? [])].sort().join('')
}

export type StopReason =
  'sufficient' | 'give-up' | 'max-rounds' | 'token-budget' | 'duplicate-query'

// ---------------------------------------------------------------------------
// 三、循环
// ---------------------------------------------------------------------------

export interface Hop {
  round: number
  query: string
  department?: Department
  /** 这一轮有没有用放宽档的准入门槛 */
  relaxed: boolean
  /** 这一轮检索到的文档，按名次 */
  docIds: string[]
  /** 这一轮**新增**的文档。连着两轮为空，说明循环在原地打转 */
  newDocIds: string[]
  tokensRead: number
  assessment: Assessment
}

export interface AgentResult {
  question: string
  hops: Hop[]
  stopReason: StopReason
  /** 最终交给生成侧的上下文，口径与固定流程完全一致（同样是 600 token） */
  context: Chunk[]
  contextDocIds: string[]
  contextTokens: number
  /** 至少有一条候选过了检索门槛 */
  admitted: boolean
  retrievalCalls: number
  assessCalls: number
  elapsedMs: number
}

/**
 * 多跳的上下文预算要**按跳轮转分配**，不能把所有轮的候选混在一起按分数排。
 *
 * 理由：第一跳的材料通常跟问题字面重合度更高，混排之后会把 600 token 全占满，
 * 第二跳辛辛苦苦查到的那一篇根本挤不进来——**跳成功了，命中却没变**。
 * 轮转分配保证每一跳的头名都有机会进上下文。
 */
export function packHops(
  hops: Array<Candidate[]>,
  budget: number = CONTEXT_BUDGET
): {
  chunks: Chunk[]
  docIds: string[]
  tokens: number
} {
  // 练习 3：现在这行把所有轮的候选一股脑拼起来按名次装，跑一次看第二段的轨迹——
  //   你会看到第二跳明明检索到了 doc-014，上下文里却没有它：第一跳的材料字面重合度更高，
  //   600 token 被它占满了。改成**按跳轮转**：先把每一跳的第 1 名都放进去，再放第 2 名，以此类推。
  return packContext(hops.flat(), budget)
}

export interface AgentOptions {
  retriever: Retriever
  assess: Assessor
  /** 第一轮查什么。默认直接用问题原文，这是最朴素也最常见的做法 */
  firstQuery?: (question: string) => string
  brakes?: typeof BRAKES
}

export async function runAgenticRetrieval(
  question: string,
  { retriever, assess, firstQuery, brakes = BRAKES }: AgentOptions
): Promise<AgentResult> {
  const started = Date.now()
  const hops: Hop[] = []
  const hopCandidates: Candidate[][] = []
  const asked: string[] = []
  const seenQueries = new Set<string>()
  let query = firstQuery?.(question) ?? question
  let tokensRead = 0
  let relaxNext = false
  let stopReason: StopReason = 'max-rounds'
  let retrievalCalls = 0
  let assessCalls = 0

  for (let round = 1; round <= brakes.maxRounds; round += 1) {
    // 第三道刹车：重复查询检测。放在检索**之前**，省下一次白花的调用
    const key = normalizeQuery(query)
    // 练习 4a：这里要做重复查询检测——查询归一化后如果查过了，就把 stopReason 设成
    //   'duplicate-query' 并跳出循环。放在检索**之前**，能省下一次白花的调用。
    seenQueries.add(key)
    asked.push(query)

    // 练习 5：上一轮自评说「方向就错了」（relaxNext 为真）时，这一轮除了换查询，
    //   还应该把 relaxGate 传给检索，降级放宽准入门槛。现在没传，所以被门槛
    //   误伤的候选永远回不来——第四段的严格门槛演示会一直是 ❌。
    const candidates = await retriever.search(query)
    void relaxNext
    retrievalCalls += 1
    const admittedNow = candidates.filter((c) => c.admitted)
    hopCandidates.push(admittedNow)

    const packed = packHops(hopCandidates)
    const before = new Set(hops.flatMap((h) => h.docIds))
    const docIds = [...new Set(admittedNow.map((c) => c.chunk.docId))]
    tokensRead += packed.tokens

    const assessment = await assess(question, packed.chunks, asked)
    assessCalls += 1
    hops.push({
      round,
      query,
      relaxed: relaxNext,
      docIds,
      newDocIds: docIds.filter((id) => !before.has(id)),
      tokensRead: packed.tokens,
      assessment,
    })

    if (assessment.sufficient) {
      stopReason = 'sufficient'
      break
    }
    if (assessment.strategy === 'give-up' || !assessment.nextQuery) {
      stopReason = 'give-up'
      break
    }
    // 练习 4b：第二道刹车——累计读进来的材料超过 brakes.tokenBudget 就停，
    //   stopReason 设成 'token-budget'。它拦的是「每轮都不超但累计爆掉」这种情况。
    void tokensRead
    // 「方向错了」才放宽；「查到半路」是多跳，放宽只会引进噪声
    relaxNext = assessment.strategy === 'broaden'
    query = assessment.nextQuery
  }

  const packed = packHops(hopCandidates)
  return {
    question,
    hops,
    stopReason,
    context: packed.chunks,
    contextDocIds: packed.docIds,
    contextTokens: packed.tokens,
    admitted: hopCandidates.some((h) => h.length > 0),
    retrievalCalls,
    assessCalls,
    elapsedMs: Date.now() - started,
  }
}

// ---------------------------------------------------------------------------
// 四、对照组：固定流程（查一次，装满 600 token，结束）
// ---------------------------------------------------------------------------

export interface FixedResult {
  contextDocIds: string[]
  contextTokens: number
  admitted: boolean
  retrievalCalls: number
  elapsedMs: number
}

export async function runFixedRetrieval(
  question: string,
  retriever: Retriever
): Promise<FixedResult> {
  const started = Date.now()
  const candidates = (await retriever.search(question)).filter((c) => c.admitted)
  const packed = packContext(candidates)
  return {
    contextDocIds: packed.docIds,
    contextTokens: packed.tokens,
    admitted: candidates.length > 0,
    retrievalCalls: 1,
    elapsedMs: Date.now() - started,
  }
}

/** 轨迹里也要能看到「这一轮读了多少 token」，所以把计数函数一并导出 */
export { countTokens }
