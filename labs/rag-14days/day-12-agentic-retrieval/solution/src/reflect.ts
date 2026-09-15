import type { Chunk } from './corpus'
import { tokenize } from './retrieve'

/**
 * 检索侧的自我反思：材料到手之后，先评一次「够不够」，不够就想下一句该查什么。
 *
 * **这一层跟 D6 的拒答不是一回事，两者的位置不同：**
 * - D6 是**生成侧**：材料已经定了，判断「该不该拿它作答」，不够就闭嘴。
 * - 今天是**检索侧**：判断「要不要再查一轮」，不够就改写查询重来。
 * 先跑今天这一层，跑到不能再跑，剩下的才交给 D6 的三条拒答线。
 */

export type Strategy = 'sufficient' | 'follow-up' | 'broaden' | 'give-up'

export interface Assessment {
  /** 材料够不够回答。够了就结束循环 */
  sufficient: boolean
  /** 问题要素被材料覆盖的比例，0–1 */
  coverage: number
  /** 还没被覆盖的问题要素 */
  missing: string[]
  /** 下一跳该查什么。sufficient / give-up 时为空 */
  nextQuery: string
  strategy: Strategy
  /** 一句话说清为什么这么判，轨迹里要打出来 */
  reason: string
}

export type Assessor = (
  question: string,
  context: Chunk[],
  askedQueries: string[]
) => Promise<Assessment>

/** 覆盖率低于这条线就认为材料压根没找对，走「放宽」而不是「追问」 */
const COVERAGE_PASS = 0.6

/**
 * 答案槽位：问题在要一个什么形状的东西。
 * 覆盖率高不等于答得上——材料可能把问题里的词全命中了，却只给出一个**指代**
 * （「必须由平台组组长审批」），而问题要的是那个指代背后的东西（「组长叫什么」）。
 * 这就是多跳的入口，也是覆盖率单独用会漏掉的那一半。
 */
const SLOTS: Array<{ name: string; ask: RegExp; filled: RegExp }> = [
  {
    name: 'identity',
    ask: /谁|哪位|叫什么|名字/u,
    filled: /(?:组长|负责人|主管|总监|总裁|经理)是[一-鿿]{2,3}/u,
  },
  {
    name: 'duration',
    ask: /多久|几天|几个工作日|多长时间|提前几|有效期/u,
    filled: /\d+\s*(?:个工作日|工作日|天|小时|分钟|周|个月|年)/u,
  },
  { name: 'level', ask: /几级|哪一级/u, filled: /[一二三四1234]\s*级变更/u },
]

/** 疑问词本身不是检索线索，从要素里剔掉，否则改写出来的查询全是「什么」「怎么」 */
const INTERROGATIVE =
  /谁|哪位|哪个|哪些|什么|怎么|多久|多少|多大|多长|几个|几天|几级|名字|是不是|能不能/gu

export interface CorpusStats {
  /** 短语 → 出现过它的文档数。跨文档才叫「桥」，只在一篇里出现的短语没得跳 */
  docFreq: Map<string, number>
  /** 在超过三成块里出现的词元没有区分度，算覆盖率时不计 */
  common: Set<string>
}

/** 预统计：3–6 字的中文短语在多少篇文档里出现过，以及哪些词元太常见 */
export function buildStats(chunks: Chunk[]): CorpusStats {
  const docFreq = new Map<string, Set<string>>()
  const termDocs = new Map<string, Set<string>>()
  const byDoc = new Map<string, string[]>()
  for (const c of chunks) byDoc.set(c.docId, [...(byDoc.get(c.docId) ?? []), c.text])
  for (const [docId, texts] of byDoc) {
    const text = texts.join('\n')
    for (const phrase of chinesePhrases(text)) {
      if (!docFreq.has(phrase)) docFreq.set(phrase, new Set())
      docFreq.get(phrase)?.add(docId)
    }
    for (const term of new Set(tokenize(text))) {
      if (!termDocs.has(term)) termDocs.set(term, new Set())
      termDocs.get(term)?.add(docId)
    }
  }
  const docCount = byDoc.size
  return {
    docFreq: new Map([...docFreq].map(([p, s]) => [p, s.size])),
    common: new Set([...termDocs].filter(([, s]) => s.size / docCount > 0.3).map(([t]) => t)),
  }
}

/** 一段中文里所有 3–6 字的连续片段。窗口滑过去会产出一堆碎片，靠文档频次和长度筛 */
function chinesePhrases(text: string): string[] {
  const out: string[] = []
  for (const run of text.match(/[一-鿿]{3,}/gu) ?? []) {
    for (let len = 3; len <= 6; len += 1) {
      for (let i = 0; i + len <= run.length; i += 1) out.push(run.slice(i, i + len))
    }
  }
  return out
}

/** 把材料按句切开，挑跟问题重合度最高的那一句——桥接短语就藏在这一句里 */
function bestSentence(question: string, context: Chunk[]): string {
  const qTerms = new Set(tokenize(question))
  let best = ''
  let bestScore = -1
  for (const chunk of context) {
    for (const sentence of chunk.text.split(/[。！？\n]/u)) {
      if (sentence.trim().length < 6) continue
      const terms = new Set(tokenize(sentence))
      const hit = [...terms].filter((t) => qTerms.has(t)).length
      const score = hit / Math.sqrt(terms.size || 1)
      if (score > bestScore) {
        bestScore = score
        best = sentence
      }
    }
  }
  return best
}

/**
 * 桥接短语：最贴题的那一句里，**问题没提过、且在别的文档里也出现过**的最长具体名词。
 *
 * 两个条件缺一不可。「问题没提过」保证它是新信息；「在别的文档里也出现过」保证
 * 真的有下一跳可跳——只在这一篇里出现的短语，查了也只会把同一篇再捞回来。
 */
export function bridgePhrase(question: string, context: Chunk[], stats: CorpusStats): string {
  const sentence = bestSentence(question, context)
  const seen = new Set(context.map((c) => c.docId))
  const candidates = [...new Set(chinesePhrases(sentence))]
    .filter((p) => !question.includes(p) && (stats.docFreq.get(p) ?? 0) >= 2)
    // 长的更具体；一样长时选出现在更少文档里的那个，指向性更强
    .sort(
      (a, b) => b.length - a.length || (stats.docFreq.get(a) ?? 0) - (stats.docFreq.get(b) ?? 0)
    )
  return candidates.find((p) => (stats.docFreq.get(p) ?? 0) > seen.size - 1) ?? candidates[0] ?? ''
}

/**
 * MOCK 下的确定性自评替身：**三条规则，没有模型参与**。
 *
 * ⚠️ 它验证的是循环、刹车、多跳编排这些代码路径**跑得对不对**，
 * 不代表真实模型的判断力。规则二的正则还带着这份语料的行文习惯
 * （「平台组组长是周敏」这种写法），换一份语料要重写。
 * **不要拿 MOCK 下的多跳成功率去估计线上效果。**
 */
export function createRuleAssessor(stats: CorpusStats): Assessor {
  return async (question, context, askedQueries) => {
    const text = context.map((c) => `${c.headingPath.join(' ')} ${c.text}`).join('\n')
    const need = [...new Set(tokenize(question.replace(INTERROGATIVE, ' ')))].filter(
      (t) => !stats.common.has(t)
    )
    const inContext = new Set(tokenize(text))
    const missing = need.filter((t) => !inContext.has(t))
    const coverage = need.length === 0 ? 1 : (need.length - missing.length) / need.length

    // 规则一：要素覆盖太低，说明这一轮根本没查对方向，放宽了重查
    if (coverage < COVERAGE_PASS) {
      const widened = [...new Set([...missing, ...need.slice(0, 2)])].join(' ')
      return {
        sufficient: false,
        coverage,
        missing,
        nextQuery: widened,
        strategy: 'broaden',
        reason: `要素覆盖只有 ${(coverage * 100).toFixed(0)}%，缺 ${missing.slice(0, 4).join('、') || '（无）'}，放宽重查`,
      }
    }

    // 规则二：覆盖率够了但答案槽位没填上——材料把答案指向了别处，跳一跳
    const slot = SLOTS.find((s) => s.ask.test(question) && !s.filled.test(text))
    if (slot) {
      const bridge = bridgePhrase(question, context, stats)
      if (bridge && !askedQueries.includes(bridge)) {
        return {
          sufficient: false,
          coverage,
          missing,
          nextQuery: bridge,
          strategy: 'follow-up',
          reason: `材料命中了问题，但没给出「${slot.name}」这一项，只留下「${bridge}」这个指代，顺着它再查一跳`,
        }
      }
      return {
        sufficient: false,
        coverage,
        missing,
        nextQuery: '',
        strategy: 'give-up',
        reason: `「${slot.name}」这一项材料里没有，也找不到可以继续追的线索，停下来交给生成侧拒答`,
      }
    }

    return {
      sufficient: true,
      coverage,
      missing,
      nextQuery: '',
      strategy: 'sufficient',
      reason: `要素覆盖 ${(coverage * 100).toFixed(0)}%，答案槽位已填上，够了`,
    }
  }
}

const ASSESS_MODEL = 'claude-haiku-4-5-20251001'

/**
 * 真实自评：用**便宜的小模型**判相关性。这一步一轮要跑一次，
 * 用生成用的 `claude-sonnet-5` 去做等于给每一轮加一次贵调用，
 * 而它做的事（这堆材料够不够、下一句查什么）小模型完全够用。
 */
export function createModelAssessor(): Assessor {
  return async (question, context, askedQueries) => {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('缺少 ANTHROPIC_API_KEY（或用 MOCK=1 离线运行）')
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey })
    const materials = context
      .map((c, i) => `[${i + 1}] ${c.headingPath.join(' > ')}\n${c.text}`)
      .join('\n\n')
    const res = await client.messages.create({
      model: ASSESS_MODEL,
      max_tokens: 512,
      system:
        '你是检索质量评审。只判断材料够不够回答问题，不要回答问题本身。' +
        '只输出 JSON：{"sufficient":bool,"coverage":0-1,"missing":[string],"nextQuery":string,"strategy":"sufficient"|"follow-up"|"broaden"|"give-up","reason":string}。' +
        'nextQuery 写成检索用的关键词短语，不要写成一句问话。已经查过的查询不要重复。',
      messages: [
        {
          role: 'user',
          content: `问题：${question}\n已查过的查询：${askedQueries.join(' | ') || '（无）'}\n\n材料：\n${materials || '（这一轮什么都没检索到）'}`,
        },
      ],
    })
    const raw = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
    const json = /\{[\s\S]*\}/u.exec(raw)
    if (!json) throw new Error(`自评没有返回 JSON：${raw.slice(0, 120)}`)
    const parsed = JSON.parse(json[0]) as Partial<Assessment>
    return {
      sufficient: parsed.sufficient === true,
      coverage: typeof parsed.coverage === 'number' ? parsed.coverage : 0,
      missing: parsed.missing ?? [],
      nextQuery: parsed.nextQuery ?? '',
      strategy: parsed.strategy ?? (parsed.sufficient ? 'sufficient' : 'broaden'),
      reason: parsed.reason ?? '',
    }
  }
}
