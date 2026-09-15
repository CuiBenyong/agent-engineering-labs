import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { Block } from './assemble'
import { tokenize } from './tokenize'
import { commonTerms, type Claim } from './verify'

/**
 * 生成侧。两种输出契约，共用同一份材料和同一套校验：
 *
 * - **结构化模式**（`/ask`）：模型返回 JSON，一句话一个 citations 数组。最严格，但要等全文才能解析。
 * - **内联标记模式**（`/ask/stream`）：模型返回纯文本，句末写 [1][3]。能边流边解析，代价是格式没有 JSON 硬。
 *
 * 两种模式最后都要过 `verifyAnswer`。**契约不同，校验相同**——这是今天最重要的一条设计。
 */

const MODEL = 'claude-sonnet-5'

export function buildContext(blocks: Block[]): string {
  return blocks
    .map(
      (b) =>
        `[${b.n}] ${b.chunk.chunkId}（${b.chunk.department}，更新于 ${b.chunk.updatedAt}）\n${b.text}`
    )
    .join('\n\n---\n\n')
}

const CITATION_RULES = [
  '你是云梯科技的知识库助手。只能依据下面提供的资料回答问题，不许用资料之外的知识补充。',
  '每一条结论都必须标出它来自哪一块，用发给你的块编号（形如 1、2），不要编造编号，也不要引用没发给你的编号。',
  '一条结论只能引用真正支撑它的块。宁可少引，不要为了看起来有据可查而多引。',
  '资料支撑不了这个问题时，直接说资料里没有，不要用常识补齐。',
]

export function buildJsonPrompt(
  question: string,
  blocks: Block[]
): { system: string; user: string } {
  const system = [
    ...CITATION_RULES,
    '',
    '输出格式：一个 JSON 对象，形如',
    '{"claims":[{"text":"一句完整的结论","citations":[1,3]}]}',
    '不要输出 JSON 以外的任何内容，不要用代码围栏包起来。',
  ].join('\n')
  return { system, user: `资料：\n\n${buildContext(blocks)}\n\n问题：${question}` }
}

export function buildStreamPrompt(
  question: string,
  blocks: Block[]
): { system: string; user: string } {
  const system = [
    ...CITATION_RULES,
    '',
    '输出格式：连贯的中文段落。每句话说完立刻在句号前写上出处，形如「回收站保留 30 天[2]。」',
    '一句话最多引用两个块。不要输出 JSON，不要写小标题。',
  ].join('\n')
  return { system, user: `资料：\n\n${buildContext(blocks)}\n\n问题：${question}` }
}

const DraftSchema = z.object({
  claims: z
    .array(z.object({ text: z.string().min(1), citations: z.array(z.number().int()) }))
    .min(1),
})

export interface GenerateOptions {
  /** 打回重生成时把校验反馈接在问题后面 */
  feedback?: string
  /**
   * 演示开关：让模型「编一个引用」。真实模型不需要这个开关也会编，
   * 但那不可复现，没法写进自测。开着它，第一版一定含一条编造引用，
   * 第二版（收到校验反馈之后）才规矩——正好把「校验 → 打回 → 重生成」这条链跑给你看。
   */
  fabricate?: boolean
}

export async function generateClaims(
  question: string,
  blocks: Block[],
  options: GenerateOptions = {}
): Promise<Claim[]> {
  if (process.env.MOCK === '1') {
    return mockClaims(question, blocks, options)
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('缺少 ANTHROPIC_API_KEY（或用 MOCK=1 离线运行）')

  const { system, user } = buildJsonPrompt(question, blocks)
  const client = new Anthropic({ apiKey })
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    temperature: 0, // 知识库问答要的是可复现，不是文采
    system,
    messages: [
      { role: 'user', content: options.feedback ? `${user}\n\n${options.feedback}` : user },
    ],
  })
  const raw = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
  return DraftSchema.parse(JSON.parse(stripFence(raw))).claims
}

/** 模型偶尔还是会套一层 ```json，解析前先剥掉，比再调一次便宜得多 */
function stripFence(text: string): string {
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text.trim())
  return m ? m[1] : text
}

/** 至少要和问题共享这么多词元，才算「这一块真的在回答这个问题」 */
const MOCK_MIN_HITS = 2

/**
 * 从一块材料里挑出与问题重合度最高的一句。
 * 重合度不够就返回 null——模板化生成也要有「答不了就不答」的能力，
 * 否则第三条拒答线（材料相关但答不了）在离线模式下永远触发不了。
 */
function bestSentence(text: string, wanted: Set<string>): string | null {
  const sentences = text
    .split(/[\n。！？；]/)
    .map((s) => s.replace(/^[#>\-*\s|/]+/, '').trim())
    .filter((s) => s.length >= 8)
  let best: string | null = null
  let bestHit = MOCK_MIN_HITS - 1
  for (const s of sentences) {
    const hit = new Set(tokenize(s).filter((t) => wanted.has(t))).size
    if (hit > bestHit) {
      bestHit = hit
      best = s
    }
  }
  return best
}

/**
 * MOCK 下的「生成」是模板化拼接：从每一块里摘出与问题最相关的一句，带上它自己的编号。
 *
 * 注意这里 mock 掉的只有**网络出口**。组装、压缩、引用校验、拒答判定全都真实执行——
 * 今天的重点是校验，把校验一起 mock 掉这一天就白学了。
 */
function mockClaims(question: string, blocks: Block[], options: GenerateOptions): Claim[] {
  // 「云梯」「科技」这种块块都有的词不算重合，否则随便哪一块都像在回答问题——
  // 跟 verifyAnswer 里算实质重合度时的处理是同一个道理
  const common = commonTerms(blocks)
  const wanted = new Set(tokenize(question).filter((t) => !common.has(t)))
  const grounded = blocks
    .flatMap((b) => {
      const text = bestSentence(b.text, wanted)
      return text ? [{ text, citations: [b.n] }] : []
    })
    .slice(0, 3)

  // 一块都答不上来时，输出一条没有出处的结论。它会被校验判成 uncited，
  // 最终落到第三条拒答线上——这正是我们想让读者在离线模式下看到的现象。
  if (grounded.length === 0) {
    return [{ text: '资料里没有找到能直接回答这个问题的内容。', citations: [] }]
  }

  if (!options.fabricate || options.feedback) return grounded

  // 第一版：混进两条编造引用，对应两种不同的失败方式——
  // 一条的编号根本不存在（好抓），一条的编号是真的、内容却对不上（难抓，只有算重合度才发现）。
  return [
    ...grounded.slice(0, 2),
    {
      text: '企业版用户可以联系客服申请把上限单独调高，处理时效是一个工作日。',
      citations: [blocks.length + 3],
    },
    {
      text: '管理员在后台的高级设置里可以把这个数值改成任意大小，改完立刻生效。',
      citations: [Math.min(2, blocks.length)],
    },
  ]
}

// ---------------------------------------------------------------------------
// 流式
// ---------------------------------------------------------------------------

/** 唯一的流式网络出口。逐块吐出文本增量，句号和引用标记都原样在里面 */
export async function* streamText(
  question: string,
  blocks: Block[],
  options: GenerateOptions = {}
): AsyncGenerator<string> {
  if (process.env.MOCK === '1') {
    const common = commonTerms(blocks)
    const wanted = new Set(tokenize(question).filter((t) => !common.has(t)))
    const canned = blocks
      .slice(0, 3)
      .flatMap((b) => {
        const text = bestSentence(b.text, wanted)
        return text ? [`${text}[${b.n}]。`] : []
      })
      .join('')
    const bad = options.fabricate
      ? `另外，上限可以联系客服单独调高[${blocks.length + 3}]。管理员在后台的高级设置里可以把这个数值改成任意大小[${Math.min(2, blocks.length)}]。`
      : ''
    for (const ch of canned + bad) {
      await new Promise((resolve) => setTimeout(resolve, 8))
      yield ch
    }
    return
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('缺少 ANTHROPIC_API_KEY（或用 MOCK=1 离线运行）')

  const { system, user } = buildStreamPrompt(question, blocks)
  const client = new Anthropic({ apiKey })
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 1024,
    temperature: 0,
    system,
    messages: [{ role: 'user', content: user }],
  })
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield event.delta.text
    }
  }
}

/** 把「句子 + 句末的 [n] 标记」拆成 Claim。标记从正文里剥掉，正文只留干净的句子 */
export function parseInlineSentence(raw: string): Claim {
  const citations: number[] = []
  const text = raw
    .replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_, group: string) => {
      for (const part of group.split(',')) citations.push(Number(part.trim()))
      return ''
    })
    .trim()
  return { text, citations }
}
