import type { Chunk } from './corpus'
import { tokenize } from './retrieve'
import type { HumanLabel, Question } from './goldenset'
import type { RetrievalTrace } from './metrics'

/**
 * 生成侧的两个指标，以及给它们打分的那个裁判。
 *
 * 忠实度（faithfulness）：回答里的每一句，有没有材料支撑。它抓的是编造。
 * 答案相关性（answer relevancy）：回答有没有答到问题上。它抓的是「说了一堆但没回答」。
 * 两个必须一起看：一句「资料中没有找到」忠实度满分，相关性为零。
 *
 * MOCK=1 时裁判换成**确定性规则裁判**——不调模型，但指标计算逻辑一行都不 mock，
 * 走的是同一套聚合与一致率代码。规则裁判只验证代码路径，不代表真实裁判的判断力，
 * 这一条 README 里也写了。
 */

export const REFUSAL = '资料中没有找到能支撑回答的内容。'
/** 判定一句话有没有被材料支撑的重合度阈值，沿用 D6，不要在这一天另定一个 */
export const MIN_OVERLAP = 0.3
/** 忠实度高于它就认为「这条回答没编」，人工抽检比对的也是这条线 */
export const FAITHFUL_PASS = 0.7

const isMock = (): boolean => process.env.MOCK === '1'
const judgeModel = (): string => process.env.JUDGE_MODEL ?? 'claude-sonnet-5'

// ---------------------------------------------------------------------------
// 先有回答，才有得评
// ---------------------------------------------------------------------------

/** 从一块里挑与问题重合度最高的一句。MOCK 模式下用它拼答案，口径与 D7 一致 */
function bestSentence(text: string, question: string): string {
  const wanted = new Set(tokenize(question))
  const sentences = text
    .split(/[\n。！？；]/)
    .map((s) => s.replace(/^[#>\-*\s|]+/, '').trim())
    .filter((s) => s.length >= 8)
  let best = sentences[0] ?? text.slice(0, 60)
  let bestHit = -1
  for (const s of sentences) {
    const hit = tokenize(s).filter((t) => wanted.has(t)).length
    if (hit > bestHit) {
      bestHit = hit
      best = s
    }
  }
  return best
}

/**
 * 第一周那套生成（D6 的拒答 + D7 的模板拼接），本天不改。
 * 检索侧一条都没过门槛就直接拒答——这是 D6 定下的，评估要量的就是它现在做得怎么样。
 */
export function answerFor(question: string, chunks: Chunk[]): string {
  if (chunks.length === 0) return REFUSAL
  return [
    '根据检索到的资料：',
    ...chunks.slice(0, 4).map((c, i) => `- ${bestSentence(c.text, question)}[${i + 1}]`),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 裁判
// ---------------------------------------------------------------------------

export interface JudgeScore {
  questionId: string
  faithfulness: number
  answerRelevancy: number
  /** 裁判认为没有材料支撑的句子，方便人工复核时直接看争议点 */
  unsupported: string[]
  judge: string
}

/**
 * 把回答拆成待判定的陈述。逐句判定是压住「偏爱长答案」的第一招，见正文。
 *
 * 末尾是冒号的行是引导语（「根据检索到的资料：」），它不主张任何事实，
 * 混进分母只会让忠实度凭空掉一截——这一条是人工抽检时发现的，不是一开始就想到的。
 */
export function claimsOf(answer: string): string[] {
  return answer
    .split(/[\n。！？；]/)
    .map((s) =>
      s
        .replace(/^[-\s]*/, '')
        .replace(/\[\d+\]/g, '')
        .trim()
    )
    .filter((s) => s.length >= 6 && !/[：:]$/.test(s))
}

/** 在多于 60% 的块里都出现的词元没有区分度，算重合时不计（口径来自 D6） */
function commonTerms(chunks: Chunk[]): Set<string> {
  const df = new Map<string, number>()
  for (const c of chunks) {
    for (const term of new Set(tokenize(c.text))) df.set(term, (df.get(term) ?? 0) + 1)
  }
  const limit = Math.max(2, Math.ceil(chunks.length * 0.6))
  return new Set([...df.entries()].filter(([, n]) => n > limit).map(([t]) => t))
}

/**
 * 一句话与上下文的实质重合度。返回 null 表示**判不了**——
 * 这句话剔掉高频词之后一个可判词元都不剩（多半是个标题片段）。
 * 判不了不等于没支撑：把它算成 0 分，忠实度会因为一行标题白掉一截。
 * 这个坑是人工抽检 q13 时撞出来的，见 README 的常见坑。
 */
function overlapRatio(sentence: string, corpusText: string, common: Set<string>): number | null {
  const terms = [...new Set(tokenize(sentence))].filter((t) => !common.has(t))
  if (terms.length === 0) return null
  const inContext = new Set(tokenize(corpusText))
  return terms.filter((t) => inContext.has(t)).length / terms.length
}

/**
 * 确定性规则裁判（MOCK=1 时用）。
 *
 * 忠实度 = 有材料支撑的句子占比；答案相关性 = 问题里的实词有多大比例出现在回答里。
 * 拒答是特例：它一个字都没编，忠实度记满分；但它也确实没回答问题，
 * 相关性只有在「这题本来就没答案」时才记满分——这两条特判把「拒答刷分」堵死了。
 */
export function ruleJudge(
  question: Question,
  answer: string,
  chunks: Chunk[]
): Omit<JudgeScore, 'questionId'> {
  if (answer.startsWith(REFUSAL)) {
    return {
      faithfulness: 1,
      answerRelevancy: question.type === 'none' ? 1 : 0,
      unsupported: [],
      judge: 'rule',
    }
  }
  const common = commonTerms(chunks)
  const contextText = chunks.map((c) => c.text).join('\n')
  // 练习 4：把忠实度真的算出来。逐条走 claimsOf(answer)：
  //   - overlapRatio 返回 null 表示这句判不了（剔掉高频词后没有可判词元），跳过，不进分母；
  //   - 低于 MIN_OVERLAP 的记进 unsupported；
  //   - 忠实度 = 1 - 没支撑的条数 / 可判条数。
  // 下面这个默认值是「无条件判满分」——它跑得通，但会让裁判探针里
  // 「与材料无关的编造应被抓出来」那一条变成 ❌，一眼就能看出还没做完。
  const unsupported: string[] = []
  const faithfulness = 1
  void contextText
  void common
  const questionTerms = [...new Set(tokenize(question.question))].filter((t) => !common.has(t))
  const answerTerms = new Set(tokenize(answer))
  const answerRelevancy =
    questionTerms.length === 0
      ? 0
      : questionTerms.filter((t) => answerTerms.has(t)).length / questionTerms.length
  return {
    faithfulness: Number(faithfulness.toFixed(3)),
    answerRelevancy: Number(answerRelevancy.toFixed(3)),
    unsupported,
    judge: 'rule',
  }
}

/**
 * 模型裁判的提示词。四条设计全部是冲着已知偏差去的，改之前先读正文那一节：
 *
 * 1. 给死评分锚点，不让它凭「感觉」给 1–5 分——锚点是压分数漂移的唯一办法。
 * 2. 要求**逐句**判定再算比例，而不是整体打印象分——这是压「偏爱长答案」的关键，
 *    长答案的分母会跟着变大，多写的每一句都要自己挣支撑。
 * 3. 只给材料和回答，不告诉它这个回答是谁生成的、是不是「我们自己的系统」——
 *    压的是自我偏好。
 * 4. 强制结构化输出，并要求把没支撑的句子原样列出来——人工抽检时才有得复核，
 *    否则你只能对着一个 0.83 干瞪眼。
 */
export function buildJudgePrompt(
  question: string,
  answer: string,
  chunks: Chunk[]
): { system: string; user: string } {
  const system = [
    '你是一名严格的评估员。你只依据「材料」判断「回答」，不许使用任何材料之外的常识。',
    '',
    '忠实度：把回答拆成一句一条的陈述，逐条判断材料里有没有直接支撑。',
    '  忠实度 = 有支撑的条数 ÷ 总条数。材料里没写但听起来合理的，一律判为没支撑。',
    '  回答如果是拒答（明确表示资料里找不到），忠实度记 1，因为它没有做出任何陈述。',
    '',
    '答案相关性：回答是否针对问题本身。锚点如下，不要给锚点之间的分数：',
    '  1.0 = 直接、完整地回答了问题；0.6 = 回答了一部分或绕了个弯；',
    '  0.3 = 相关但没答到点上；0.0 = 答非所问，或者是拒答。',
    '',
    '只输出一个 JSON 对象，不要写任何解释文字：',
    '{"faithfulness": 0.0, "answerRelevancy": 0.0, "unsupported": ["原样抄下没有支撑的那一句"]}',
  ].join('\n')

  const material = chunks.length
    ? chunks.map((c, i) => `[${i + 1}] ${c.text}`).join('\n\n---\n\n')
    : '（无）'
  const user = `材料：\n\n${material}\n\n问题：${question}\n\n回答：\n${answer}`
  return { system, user }
}

export async function judgeAnswer(
  question: Question,
  answer: string,
  chunks: Chunk[]
): Promise<JudgeScore> {
  if (isMock()) return { questionId: question.id, ...ruleJudge(question, answer, chunks) }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('缺少 ANTHROPIC_API_KEY（或用 MOCK=1 离线运行）')
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const { system, user } = buildJudgePrompt(question.question, answer, chunks)
  const res = await new Anthropic({ apiKey }).messages.create({
    model: judgeModel(),
    max_tokens: 1024,
    temperature: 0, // 评估要的是可复现：同一份输入跑两次必须给同一个分
    system,
    messages: [{ role: 'user', content: user }],
  })
  const text = (res.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
  // 裁判偶尔会在 JSON 外面裹一层说明文字，这里只取第一个大括号块
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) throw new Error(`裁判没有返回 JSON：${text.slice(0, 200)}`)
  const parsed = JSON.parse(match[0]) as {
    faithfulness: number
    answerRelevancy: number
    unsupported?: string[]
  }
  return {
    questionId: question.id,
    faithfulness: parsed.faithfulness,
    answerRelevancy: parsed.answerRelevancy,
    unsupported: parsed.unsupported ?? [],
    judge: judgeModel(),
  }
}

// ---------------------------------------------------------------------------
// 给裁判本身写测试：探针
// ---------------------------------------------------------------------------

/**
 * 裁判探针。评估系统本身也是代码，也会坏，而它坏掉的方式最阴险——
 * 分数照常输出，只是不再有意义。所以喂给它几组**已知正确答案**的输入，
 * 每次跑评估都验一遍：抓不住编造的裁判，它给出的忠实度一个字都不能信。
 */
export interface Probe {
  name: string
  faithfulness: number
  passed: boolean
  /** 已知盲区：规则裁判必然抓不住，只作提示，不参与验收 */
  blindSpot?: boolean
}

const probeChunk = (text: string): Chunk => ({
  docId: 'probe',
  chunkId: 'probe#c01',
  text,
  headingPath: [],
  page: null,
  department: 'eng',
  updatedAt: '2026-01-01',
})

export function runProbes(): Probe[] {
  const material = [
    probeChunk('生产日志保留 30 天，审计日志保留 180 天，指标数据按 1 分钟粒度保留 15 天。'),
  ]
  const fake: Question = {
    id: 'probe',
    question: '日志保留多久？',
    answerDocIds: [],
    type: 'single',
  }
  const score = (answer: string): number => ruleJudge(fake, answer, material).faithfulness

  const supported = score('生产日志保留 30 天，审计日志保留 180 天')
  const invented = score('每位员工每月可以申请最多八个工作日的远程办公，无需说明理由')
  const swapped = score('生产日志保留 90 天，审计日志保留 365 天')

  return [
    {
      name: '照抄材料的回答应判为有支撑',
      faithfulness: supported,
      passed: supported >= FAITHFUL_PASS,
    },
    {
      name: '与材料无关的编造应被抓出来',
      faithfulness: invented,
      passed: invented < FAITHFUL_PASS,
    },
    {
      name: '把数字改掉的回答应被抓出来（规则裁判的已知盲区）',
      faithfulness: swapped,
      passed: swapped < FAITHFUL_PASS,
      blindSpot: true,
    },
  ]
}

// ---------------------------------------------------------------------------
// 人工抽检一致率：裁判自己说自己准，不算数
// ---------------------------------------------------------------------------

export interface Agreement {
  checked: number
  agreed: number
  rate: number
  /** 不一致的条目，人工抽检真正的产出就是这几条 */
  disagreements: Array<{ questionId: string; judge: number; human: boolean; note: string }>
}

/**
 * 把裁判的分数二值化成「这条有没有编」，再跟人工标注比。
 * 一致率不是用来给裁判发奖状的，是用来决定「这个分数能不能拿去做决策」——
 * 低于 0.8 就别再用它拦合并了，先去改提示词。
 */
export function agreementRate(scores: JudgeScore[], labels: HumanLabel[]): Agreement {
  const byId = new Map(scores.map((s) => [s.questionId, s]))
  const disagreements: Agreement['disagreements'] = []
  let agreed = 0
  for (const label of labels) {
    const score = byId.get(label.questionId)
    if (!score) throw new Error(`人工标注里有一个 golden set 没有的题号：${label.questionId}`)
    const judgeSaysFaithful = score.faithfulness >= FAITHFUL_PASS
    if (judgeSaysFaithful === label.faithful) agreed += 1
    else
      disagreements.push({
        questionId: label.questionId,
        judge: score.faithfulness,
        human: label.faithful,
        note: label.note,
      })
  }
  return {
    checked: labels.length,
    agreed,
    rate: labels.length === 0 ? 0 : Number((agreed / labels.length).toFixed(3)),
    disagreements,
  }
}

export interface GenerationMetrics {
  faithfulness: number
  answerRelevancy: number
  /** 无答案问题上真的拒答了的比例——生成侧的最后一道闸 */
  refusalOnNone: number
}

export function aggregateGeneration(
  scores: JudgeScore[],
  answers: Map<string, string>,
  questions: Question[]
): GenerationMetrics {
  const mean = (xs: number[]): number =>
    xs.length === 0 ? 0 : Number((xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(4))
  const nones = questions.filter((q) => q.type === 'none')
  return {
    faithfulness: mean(scores.map((s) => s.faithfulness)),
    answerRelevancy: mean(scores.map((s) => s.answerRelevancy)),
    refusalOnNone: mean(nones.map((q) => ((answers.get(q.id) ?? '').startsWith(REFUSAL) ? 1 : 0))),
  }
}
