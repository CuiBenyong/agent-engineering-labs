import Anthropic from '@anthropic-ai/sdk'
import type { Doc } from './corpus'
import { tokenize } from './tokenize'

const MODEL = 'claude-sonnet-5'

export interface Passage {
  doc: Doc
  score: number
}

export const REFUSAL = '资料中没有找到能支撑回答的内容。'

/**
 * 组装上下文这一步决定了模型「看到什么」，是整个链路里最容易被忽略的一环。
 * 三件事必须做：给每段材料一个可引用的编号、把编号规则写进指令、明确允许拒答。
 * 少了第三条，模型在材料不足时几乎一定会编。
 */
export function buildPrompt(
  question: string,
  passages: Passage[]
): { system: string; user: string } {
  const system = [
    '你是云梯科技的知识库助手。只能依据下面提供的资料回答问题。',
    `资料里找不到答案时，只回复这一句：${REFUSAL}`,
    '每一句结论后面都要用方括号标出它来自哪一篇，格式如 [doc-006]。不要引用没有提供给你的编号。',
    '如果两段资料互相矛盾，把两种说法都列出来并指出各自的更新日期，不要自己挑一个。',
  ].join('\n')

  const context = passages
    .map(
      (p) =>
        `[${p.doc.id}]（${p.doc.department}，更新于 ${p.doc.updated}）${p.doc.title}\n${p.doc.body}`
    )
    .join('\n\n---\n\n')

  const user = `资料：\n\n${context || '（无）'}\n\n问题：${question}`
  return { system, user }
}

/** 从一篇文档里挑出与问题重合度最高的一句，MOCK 模式下用它拼答案 */
function bestSentence(doc: Doc, question: string): string {
  const wanted = new Set(tokenize(question))
  const sentences = doc.body
    .split(/[\n。！？；]/)
    .map((s) => s.replace(/^[#>\-*\s|]+/, '').trim())
    .filter((s) => s.length >= 8)

  let best = sentences[0] ?? doc.title
  let bestScore = -1
  for (const s of sentences) {
    const hit = tokenize(s).filter((t) => wanted.has(t)).length
    if (hit > bestScore) {
      bestScore = hit
      best = s
    }
  }
  return best
}

/**
 * 唯一的网络出口。MOCK 判断放在函数最前面，真实分支一行都不执行。
 *
 * D1 的 mock 不是「假装调用成功」，而是把「生成」这一步换成**模板化拼接**：
 * 从每篇命中文档里挑一句最相关的，带着编号列出来。
 * 这样离线也能看到真实的现象——检索对了就有依据，检索错了就拼出一堆不相干的句子，
 * 一眼能看出锅在检索还是在生成。
 */
export async function answer(question: string, passages: Passage[]): Promise<string> {
  if (passages.length === 0) return REFUSAL

  if (process.env.MOCK === '1') {
    const lines = passages.map((p) => `- ${bestSentence(p.doc, question)}[${p.doc.id}]`)
    return [
      '根据检索到的资料：',
      ...lines,
      '',
      '（离线模板拼接：MOCK=1 时不调用模型，只把命中段落里最相关的一句摘出来带上出处。',
      '去掉 MOCK=1 并配置 ANTHROPIC_API_KEY 就会换成真实生成。）',
    ].join('\n')
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('缺少 ANTHROPIC_API_KEY（或用 MOCK=1 离线运行）')

  const { system, user } = buildPrompt(question, passages)
  const client = new Anthropic({ apiKey })
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    temperature: 0, // 知识库问答要的是可复现，不是文采
    system,
    messages: [{ role: 'user', content: user }],
  })
  return res.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}
