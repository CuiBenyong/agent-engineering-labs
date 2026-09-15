import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import { assemble, compressBlocks, countTokens, type Block, type Scored } from './assemble'
import { buildIndex, search, type BM25Index } from './bm25'
import { loadChunks, type Chunk } from './corpus'
import { generateClaims, parseInlineSentence, streamText } from './generate'
import {
  feedbackForRetry,
  postCheck,
  preCheck,
  verifyAnswer,
  type Claim,
  type ClaimVerdict,
  type Refusal,
} from './verify'

export const PORT = Number(process.env.PORT ?? 3056)
const TOP_K = Number(process.env.TOP_K ?? 8)
const BUDGET = Number(process.env.CONTEXT_BUDGET ?? 1200)
const MAX_BLOCKS = Number(process.env.MAX_BLOCKS ?? 5)
/** 最多重生成一次。再多就该拒答了：连着两版都编，说明材料本来就不支持 */
const MAX_ATTEMPTS = 2

export interface Store {
  index: BM25Index
  byId: Map<string, Chunk>
}

export function buildStore(): Store {
  const chunks = loadChunks()
  const index = buildIndex(chunks.map((c) => ({ id: c.chunkId, text: c.text })))
  return { index, byId: new Map(chunks.map((c) => [c.chunkId, c])) }
}

export interface AskOptions {
  compress?: boolean
  fabricate?: boolean
}

export interface AskResult {
  status: 'answered' | 'refused'
  answer: string
  claims: { text: string; citations: number[] }[]
  refusal: Refusal | null
  blocks: { n: number; chunkId: string; score: number; updatedAt: string }[]
  citations: {
    n: number
    chunkId: string
    docId: string
    headingPath: string[]
    updatedAt: string
    text: string
  }[]
  stats: {
    attempts: number
    rawTokens: number
    contextTokens: number
    rejected: { attempt: number; issues: string[] }[]
  }
}

function retrieve(store: Store, question: string): Scored[] {
  return search(store.index, question, TOP_K).map((hit) => {
    const chunk = store.byId.get(hit.docId)
    if (!chunk) throw new Error(`索引里有一个语料里没有的块：${hit.docId}`)
    return { chunk, score: hit.score }
  })
}

function citationsOf(blocks: Block[], numbers: number[]): AskResult['citations'] {
  return numbers.flatMap((n) => {
    const block = blocks.find((b) => b.n === n)
    if (!block) return []
    return [
      {
        n,
        chunkId: block.chunk.chunkId,
        docId: block.chunk.docId,
        headingPath: block.chunk.headingPath,
        updatedAt: block.chunk.updatedAt,
        text: block.chunk.text,
      },
    ]
  })
}

function renderAnswer(verdicts: ClaimVerdict[]): string {
  return verdicts
    .map((v) => `${v.claim.text}${v.verified.map((n) => `[${n}]`).join('')}`)
    .join('\n')
}

function refusedResult(refusal: Refusal, blocks: Block[], contextTokens: number): AskResult {
  return {
    status: 'refused',
    answer: refusal.message,
    claims: [],
    refusal,
    blocks: blocks.map((b) => ({
      n: b.n,
      chunkId: b.chunk.chunkId,
      score: b.score,
      updatedAt: b.chunk.updatedAt,
    })),
    citations: [],
    stats: { attempts: 0, rawTokens: 0, contextTokens, rejected: [] },
  }
}

/** 组装 + 压缩：两条路都要走一遍的前半段 */
async function prepare(store: Store, question: string, options: AskOptions) {
  const scored = retrieve(store, question)
  const assembled = assemble(scored, { budget: BUDGET, maxBlocks: MAX_BLOCKS })
  const rawTokens = assembled.usedTokens
  const blocks =
    options.compress === false ? assembled.blocks : await compressBlocks(question, assembled.blocks)
  const contextTokens = blocks.reduce((sum, b) => sum + countTokens(b.text), 0)
  return { scored, assembled, blocks, rawTokens, contextTokens }
}

export async function ask(
  store: Store,
  question: string,
  options: AskOptions = {}
): Promise<AskResult> {
  const { scored, blocks, rawTokens, contextTokens } = await prepare(store, question, options)

  // 第一、二条拒答线在生成之前就能判：分数太低、材料自己打架。
  // 早拒答省的是一次模型调用，也省掉了一个「模型在两个数字里瞎选一个」的机会。
  const early = preCheck(scored, blocks)
  if (early) {
    const refused = refusedResult(early, blocks, contextTokens)
    return { ...refused, stats: { ...refused.stats, rawTokens } }
  }

  const rejected: { attempt: number; issues: string[] }[] = []
  let claims: Claim[] = []
  let result = verifyAnswer([], blocks)
  let attempts = 0

  while (attempts < MAX_ATTEMPTS) {
    const feedback = attempts === 0 ? undefined : feedbackForRetry(result)
    attempts += 1
    claims = await generateClaims(question, blocks, { feedback, fabricate: options.fabricate })
    result = verifyAnswer(claims, blocks)
    if (result.ok) break
    rejected.push({
      attempt: attempts,
      issues: result.verdicts.filter((v) => !v.ok).flatMap((v) => v.detail),
    })
  }

  // 第三条线只能放在生成之后：材料看着相关，但没有一句结论站得住
  const late = postCheck(result)
  const stats = { attempts, rawTokens, contextTokens, rejected }
  if (late) return { ...refusedResult(late, blocks, contextTokens), stats }

  return {
    status: 'answered',
    // 只渲染通过校验的引用：没通过的那条被剥掉标记，绝不原样吐给用户
    answer: renderAnswer(result.verdicts.filter((v) => v.verified.length > 0)),
    claims: result.verdicts
      .filter((v) => v.verified.length > 0)
      .map((v) => ({ text: v.claim.text, citations: v.verified })),
    refusal: null,
    blocks: blocks.map((b) => ({
      n: b.n,
      chunkId: b.chunk.chunkId,
      score: b.score,
      updatedAt: b.chunk.updatedAt,
    })),
    citations: citationsOf(blocks, result.verifiedCitations),
    stats,
  }
}

const AskBody = z.object({
  question: z.string().min(1),
  compress: z.boolean().optional(),
  fabricate: z.boolean().optional(),
})

/** 句子边界：中文句号问号叹号分号。标记 [1] 可能在句号前面，所以按标点切完再解析标记 */
function takeSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = []
  let rest = buffer
  for (;;) {
    const m = /[。！？；]/.exec(rest)
    if (!m) break
    sentences.push(rest.slice(0, m.index + 1))
    rest = rest.slice(m.index + 1)
  }
  return { sentences, rest }
}

export function buildServer(store: Store): FastifyInstance {
  const app = Fastify({ logger: false })

  app.post('/ask', async (request, reply) => {
    const parsed = AskBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: '请求体必须含有 question 字段' })
    return ask(store, parsed.data.question, {
      compress: parsed.data.compress,
      fabricate: parsed.data.fabricate,
    })
  })

  /**
   * 流式回答。这里是今天最后一个取舍点：
   *
   * 引用要等一句话说完才能校验，而流式的卖点是尽早出字。折中办法是**按句缓冲**：
   * 攒够一句就校验一次，通过了才把这一句连同它已核实的引用发出去。
   * 代价是首字延迟从「一个 token」变成「一句话」，换来的是**发出去的内容永远不用撤回**。
   */
  app.post('/ask/stream', async (request, reply) => {
    const parsed = AskBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: '请求体必须含有 question 字段' })
    const { question } = parsed.data

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    const { scored, blocks, contextTokens } = await prepare(store, question, {
      compress: parsed.data.compress,
    })
    send('meta', {
      blocks: blocks.map((b) => ({ n: b.n, chunkId: b.chunk.chunkId, score: b.score })),
      contextTokens,
    })

    const early = preCheck(scored, blocks)
    if (early) {
      // 拒答在流开始之前就发出去，用户不会先看到半句回答再被收回
      send('refusal', early)
      send('done', { status: 'refused' })
      return reply.raw.end()
    }

    let buffer = ''
    let emitted = 0
    let dropped = 0
    const flush = (chunk: string) => {
      buffer += chunk
      const { sentences, rest } = takeSentences(buffer)
      buffer = rest
      for (const raw of sentences) {
        const claim = parseInlineSentence(raw)
        const verdict = verifyAnswer([claim], blocks).verdicts[0]
        if (verdict.verified.length === 0 && claim.citations.length > 0) {
          // 一句都没核实住就整句不发。用户永远看不到需要撤回的内容
          dropped += 1
          send('dropped', { text: claim.text, detail: verdict.detail })
          continue
        }
        emitted += 1
        send('sentence', {
          text: claim.text,
          citations: citationsOf(blocks, verdict.verified),
        })
      }
    }

    for await (const delta of streamText(question, blocks, { fabricate: parsed.data.fabricate })) {
      flush(delta)
    }
    if (buffer.trim().length > 0) flush(`${buffer}。`)

    if (emitted === 0) {
      send('refusal', {
        kind: 'unsupported',
        message: '检索到了相关的文档，但没有一句结论通过引用校验，所以不作答。',
      })
    }
    send('done', { status: emitted > 0 ? 'answered' : 'refused', emitted, dropped })
    return reply.raw.end()
  })

  /** 引用要可验证，就必须给出回查原文的入口。前端的 [2] 点进来就是这里 */
  app.get<{ Params: { docId: string; suffix: string } }>(
    '/chunk/:docId/:suffix',
    async (request, reply) => {
      const chunkId = `${request.params.docId}#${request.params.suffix}`
      const chunk = store.byId.get(chunkId)
      if (!chunk) return reply.code(404).send({ error: `没有这个块：${chunkId}` })
      return chunk
    }
  )

  return app
}
