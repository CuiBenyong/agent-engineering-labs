/**
 * 五种查询侧手法：改写、假设文档嵌入、多路查询、后退提问、意图路由。
 *
 * 这个文件是本天的教学核心，请逐行读。它只做一件事：
 * **把用户原样打进来的那句话，换成一个或几个更适合拿去检索的检索式。**
 * 检索器一行都没改（见 `retrieve.ts`），所以指标的任何变化都只可能来自这里。
 *
 * ── MOCK 边界（务必先读这一段）────────────────────────────────────────────
 * 这五种手法本来都要调模型。`MOCK=1` 时模型调用换成**确定性规则替身**：
 * 规则替身只认几张写死的词表（疑问词、口语填充词、角色词、文档交叉引用），
 * 换个领域就废了。**手法本身的逻辑没有被 mock**——检索式怎么拼、几路怎么融合、
 * 路由怎么分流，MOCK 与真实模式跑的是同一份代码。
 *
 * 所以：**MOCK 下跑出来的指标只证明代码路径是通的，不代表真实模型的效果。**
 * 真实模型会重写出规则替身写不出来的检索式（也会写出规则替身不会犯的错），
 * 想知道这些手法在你的数据上到底值不值，只能连上模型自己跑一遍评估。
 * ─────────────────────────────────────────────────────────────────────────
 */

export type TransformTask = 'rewrite' | 'hyde' | 'multi-query' | 'step-back' | 'intent'

/** 一轮对话。改写要看它才能知道「这个人」指谁 */
export interface Turn {
  role: 'user' | 'assistant'
  content: string
}

/** 三条路由。分流的意义是：不需要检索的问题不该付检索的钱 */
export type Intent = 'direct' | 'single-hop' | 'multi-hop'

/** 每一步都要报账：这一步花了几次模型调用 */
export interface Step<T> {
  value: T
  calls: number
  /** 打印出来给人看的一句说明，报告和自测都靠它 */
  note: string
}

const isMock = (): boolean => process.env.MOCK === '1'
const transformModel = (): string => process.env.TRANSFORM_MODEL ?? 'claude-sonnet-5'

/** 全局调用计数器。成本账不能靠估，要靠数 */
let modelCalls = 0
export const totalModelCalls = (): number => modelCalls
export const resetModelCalls = (): void => {
  modelCalls = 0
}

// ---------------------------------------------------------------------------
// 词表：规则替身的全部「知识」就这么多，真实模式下一个都用不到
// ---------------------------------------------------------------------------

const INTERROGATIVES = [
  '分别是什么',
  '是什么',
  '为什么',
  '怎么处理',
  '怎么办',
  '怎么样',
  '怎么',
  '哪些',
  '哪个',
  '多少',
  '多久',
  '多大',
  '多长',
  '几天',
  '几次',
  '几个',
  '几级',
  '是否',
  '能不能',
  '有没有',
  '还能不能',
  '要不要',
  '谁',
  '吗',
  '呢',
  '？',
  '?',
]

const FILLERS = [
  '请问',
  '麻烦问一下',
  '麻烦',
  '一下',
  '大概',
  '到底',
  '想问问',
  '我想知道',
  '啊',
  '呀',
  '嘛',
  '那个',
]

const PRONOUNS = [
  '这个人',
  '此人',
  '该人员',
  '他们',
  '她们',
  '他',
  '她',
  '它',
  '这块',
  '那块',
  '上面这个',
]

/** 规则替身认得的「角色」。真实改写靠模型理解上下文，不靠词表——这是替身最明显的天花板 */
const ROLE_RE = /[一-鿿]{0,6}?(组组长|组长|负责人|技术副总裁|总裁|经理|主管)/g

/** 文档之间的交叉引用，形如《变更评审规范》。多跳的桥就架在它上面 */
const CROSS_REF_RE = /《([^》]+)》/g

/** 闲聊 / 元问题：这类问题检索一万次也检索不出答案 */
const CHITCHAT_RE = /^(你好|您好|在吗|谢谢|多谢|辛苦了|你是谁|你能(做|干|帮我查)|还能|再见|拜拜)/

/** 指向「另一个文档里才有的事实」的信号词。命中就走多跳 */
const HOP_MARKERS = [
  '这个人',
  '此人',
  '该人员',
  '他',
  '她',
  '按规范',
  '按流程',
  '哪个流程',
  '对应的',
]

// ---------------------------------------------------------------------------
// 小工具：从中文句子里抠出可以拿去检索的实词
// ---------------------------------------------------------------------------

/** 去掉口语填充词。「请问一下报销上限是多少」→「报销上限是多少」 */
function stripFillers(text: string): string {
  let out = text
  for (const f of FILLERS) out = out.split(f).join('')
  return out.trim()
}

/** 去掉疑问词，把问句压成陈述式的主题短语。检索式不需要问号 */
export function topicOf(text: string): string {
  let out = stripFillers(text)
  for (const w of INTERROGATIVES) out = out.split(w).join(' ')
  return out
    .replace(/[，。、：；,.:;！!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 抽出连续的中文片段与英文词，长度 ≥2 的才留——单字在 BM25 里几乎没有区分度 */
function contentTerms(text: string): string[] {
  const segs = topicOf(text).match(/[一-鿿]{2,}|[a-zA-Z0-9]{2,}/g) ?? []
  return [...new Set(segs)]
}

// ---------------------------------------------------------------------------
// 唯一的网络出口
// ---------------------------------------------------------------------------

/**
 * 所有模型调用都从这里出去，也只从这里出去。
 * MOCK=1 时**在函数最前面**就被规则替身接管，真实分支一行都不执行。
 */
async function callModel(task: TransformTask, system: string, user: string): Promise<string> {
  modelCalls += 1
  if (isMock()) throw new Error(`MOCK 模式不应该走到这里（task=${task}）`)

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('缺少 ANTHROPIC_API_KEY（或用 MOCK=1 离线运行）')
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const res = await new Anthropic({ apiKey }).messages.create({
    model: transformModel(),
    max_tokens: 512,
    temperature: 0, // 查询改写要可复现：同一句话每次必须改成同一个检索式，否则评估数字会飘
    system,
    messages: [{ role: 'user', content: user }],
  })
  return (res.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim()
}

/** MOCK 下也要记账：规则替身占的是真实模式里那一次调用的位置 */
function countMockCall(): void {
  modelCalls += 1
}

// ---------------------------------------------------------------------------
// 手法一：查询改写（补指代、去口语、拆复合）
// ---------------------------------------------------------------------------

const REWRITE_SYSTEM = [
  '你是检索系统的查询改写器。把用户这一轮的问题改写成一个可以直接拿去检索的检索式。',
  '规则：',
  '1. 用对话历史补全指代（「这个人」「他」「那个」要换成具体名称），补不出来就保持原样。',
  '2. 去掉口语填充词与礼貌用语，只留有检索价值的实词。',
  '3. 不要回答问题，不要添加历史里没有的事实。',
  '只输出改写后的一行文本，不要解释。',
].join('\n')

/**
 * 规则替身：从上一轮**回答**里找一个角色短语，替换掉当前问题里的指代词。
 *
 * 为什么找角色短语：这份语料里指代最常指向的就是「某某组组长」这类角色。
 * 这也是替身最明显的天花板——换成指向一个产品名、一个故障单号，它立刻失效。
 * 真实改写器读的是整段上下文，不是一张词表。
 */
function ruleRewrite(query: string, history: Turn[]): string {
  const cleaned = stripFillers(query)
  // 练习 1：指代消解。当前实现只去掉了口语填充词，「这个人」原样留在检索式里——
  // 跑一下就能看到第 2 轮一条候选都过不了门槛，系统只能拒答。
  //
  // 要做的事：
  //   a. 用 PRONOUNS 找出这句话里的指代词，没有就直接返回 cleaned。
  //   b. 在**上一轮回答**里用 ROLE_RE 找一个角色短语（「平台组组长」）作为先行词。
  //      提示：正则会把前面的动词一起吃进来（匹配到「必须由平台组组长」），
  //      按 /[必须由是的和与被让给在，。：、；]/ 切一刀只留最后一段。
  //   c. 找不到角色就退回上一轮**问题**的主题短语（contentTerms 的前两项）。
  //   d. 把指代词替换成先行词后返回。
  void history
  void ROLE_RE
  void PRONOUNS
  return cleaned
}

export async function rewriteQuery(query: string, history: Turn[]): Promise<Step<string>> {
  if (isMock()) {
    countMockCall()
    const rewritten = ruleRewrite(query, history)
    return { value: rewritten, calls: 1, note: `改写：${query} → ${rewritten}` }
  }
  const context = history
    .slice(-4)
    .map((t) => `${t.role === 'user' ? '用户' : '助手'}：${t.content}`)
    .join('\n')
  const rewritten = await callModel(
    'rewrite',
    REWRITE_SYSTEM,
    `对话历史：\n${context || '（无）'}\n\n本轮问题：${query}`
  )
  return { value: rewritten, calls: 1, note: `改写：${query} → ${rewritten}` }
}

// ---------------------------------------------------------------------------
// 手法二：假设文档嵌入（HyDE）
// ---------------------------------------------------------------------------

const HYDE_SYSTEM = [
  '你是一名企业知识库的文档撰写者。针对用户的问题，写一段**看起来像制度文档正文**的回答，',
  '80 到 150 字，用陈述句和文档腔（「按规定」「上限为」「须在……内」），不要用问句。',
  '你不知道真实答案也没关系——写出一段格式与用词都像目标文档的文字即可，',
  '这段文字只会被拿去做向量检索，不会展示给用户。',
].join('\n')

/**
 * 规则替身：把问句压成陈述句，再套上一层「文档腔」骨架。
 *
 * 真实的 HyDE 会**编一个具体答案**（编出「上限 300 元」这种数字），
 * 那才是它拉近查询与文档距离的关键。规则替身编不出具体内容，只能补文体词，
 * 所以 MOCK 下 HyDE 的收益会被明显低估——这是这一天最需要提防的一处 MOCK 偏差。
 */
function ruleHyde(query: string): string {
  // 练习 2：假设文档。当前实现原样返回问题，等于没做——报表里
  // 「+ 假设文档嵌入」那一行会和基线一模一样。
  //
  // 要做的事：用 topicOf 把问句压成陈述式主题，再套一层「文档腔」骨架
  // （「关于 X，按公司规定执行。……的具体数值、适用范围与例外情况以本制度正文为准」），
  // 并按问题里出现的关键词（报销 / 审批 / 保留 / 权限）补一句对应的文体词。
  // 提示：写完再想一个问题——规则替身编不出「上限 300 元」这种具体数字，
  // 而那恰恰是真实 HyDE 起作用的地方。这个差距要写进你的结论里。
  return query
}

export async function hydeQuery(query: string): Promise<Step<string>> {
  if (isMock()) {
    countMockCall()
    const doc = ruleHyde(query)
    return { value: doc, calls: 1, note: `假设文档（${doc.length} 字）：${doc.slice(0, 40)}…` }
  }
  const doc = await callModel('hyde', HYDE_SYSTEM, query)
  return { value: doc, calls: 1, note: `假设文档（${doc.length} 字）：${doc.slice(0, 40)}…` }
}

// ---------------------------------------------------------------------------
// 手法三：多路查询
// ---------------------------------------------------------------------------

const MULTI_QUERY_SYSTEM = [
  '你是检索系统的查询扩展器。针对用户的问题，生成 2 个**换个角度**的检索式：',
  '一个偏关键词（去掉所有虚词，只留名词与数字）；',
  '一个偏文档用语（用制度文档里会出现的说法重述这个问题）。',
  '每行一个，不要编号，不要解释，不要重复原问题。',
].join('\n')

/** 规则替身：一个关键词式、一个文档用语式。原问题由调用方补在第一位 */
function ruleMultiQuery(query: string): string[] {
  // 练习 3：多路查询。当前返回空数组，只有原问题一路，检索次数不会涨。
  // 要做的事：用 contentTerms 生成两个换角度的检索式——
  //   一个偏关键词（实词拼起来），一个偏文档用语（主题 + 「的规定 标准 流程 上限」）。
  // 做完之后看报表的「检索次数」那一列：20 题会变成 60 次，这就是它的账。
  void query
  return []
}

export async function multiQuery(query: string): Promise<Step<string[]>> {
  if (isMock()) {
    countMockCall()
    const variants = [query, ...ruleMultiQuery(query)]
    return { value: variants, calls: 1, note: `多路查询：${variants.length} 个检索式` }
  }
  const text = await callModel('multi-query', MULTI_QUERY_SYSTEM, query)
  const variants = [
    query,
    ...text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 2),
  ]
  return { value: variants, calls: 1, note: `多路查询：${variants.length} 个检索式` }
}

// ---------------------------------------------------------------------------
// 手法四：后退提问
// ---------------------------------------------------------------------------

const STEP_BACK_SYSTEM = [
  '你是检索系统的提问器。用户问了一个很具体的问题，请退一步，问一个**更一般**的问题，',
  '目的是先拿到这个问题所属的背景与制度全貌。',
  '例如「二级变更要提前几个工作日提单」退一步是「变更评审的分级与提单规则是什么」。',
  '只输出这个更一般的问题，一行，不要解释。',
].join('\n')

/** 规则替身：留下主题短语的前半截，配上「整体规定 适用范围 分级」这类总纲词 */
function ruleStepBack(query: string): string {
  const terms = contentTerms(query)
  const head = terms.slice(0, 2).join('') || topicOf(query)
  return `${head} 整体规定 适用范围 分级 流程`
}

export async function stepBackQuery(query: string): Promise<Step<string>> {
  if (isMock()) {
    countMockCall()
    const general = ruleStepBack(query)
    return { value: general, calls: 1, note: `后退提问：${general}` }
  }
  const general = await callModel('step-back', STEP_BACK_SYSTEM, query)
  return { value: general, calls: 1, note: `后退提问：${general}` }
}

// ---------------------------------------------------------------------------
// 手法五：意图路由
// ---------------------------------------------------------------------------

const INTENT_SYSTEM = [
  '你是检索系统的意图分类器。判断这个问题该走哪条路，只输出一个词：',
  'direct     —— 打招呼、道谢、问「你能做什么」这类问题，检索知识库没有意义；',
  'single-hop —— 一篇文档里就能找到答案；',
  'multi-hop  —— 必须先查到一个中间事实（某个角色是谁、该走哪个规范），再用它去查第二篇。',
  '只输出这三个词之一，不要解释。',
].join('\n')

/**
 * 规则替身：闲聊看开头模式，多跳看有没有「指向另一篇文档」的信号词。
 *
 * 这张信号词表是**对着本课这 20 道题调出来的**，换一份数据必然要重调——
 * 正文里那句「路由是最容易被高估的一项」说的就是它。
 */
function ruleIntent(query: string): Intent {
  // 练习 4：意图路由。当前一律判成单跳，等于没有分流——
  // 闲聊也会去检索，多跳题也拿不到更高的上下文预算。
  // 要做的事：先用 CHITCHAT_RE 认出闲聊返回 'direct'，
  // 再用 HOP_MARKERS 认出「指向另一篇文档」的信号词返回 'multi-hop'，其余返回 'single-hop'。
  void query
  void CHITCHAT_RE
  void HOP_MARKERS
  return 'single-hop'
}

export async function classifyIntent(query: string): Promise<Step<Intent>> {
  if (isMock()) {
    countMockCall()
    const intent = ruleIntent(query)
    return { value: intent, calls: 1, note: `意图：${intent}` }
  }
  const text = await callModel('intent', INTENT_SYSTEM, query)
  const intent: Intent = text.includes('direct')
    ? 'direct'
    : text.includes('multi')
      ? 'multi-hop'
      : 'single-hop'
  return { value: intent, calls: 1, note: `意图：${intent}` }
}

// ---------------------------------------------------------------------------
// 多跳用到的「桥」：从第一轮结果里抠出第二轮该查什么
// ---------------------------------------------------------------------------

/**
 * 从第一轮检索到的正文里找桥接线索：一个角色短语，或一处《文档交叉引用》。
 *
 * 这是多跳最朴素的一版，够用来演示分流；完整的多轮检索（让模型自己决定还要不要再查一轮）
 * 是第十二天的内容，这里不展开。
 */
export function bridgeQuery(question: string, contextText: string): string | null {
  // 练习 5：多跳的「桥」。当前返回 null，多跳路由会退回单跳。
  // 要做的事：从第一轮检索到的正文里找线索——CROSS_REF_RE 的《文档交叉引用》
  // 与 ROLE_RE 的角色短语，去掉原问题里已经有的，最多取两条，
  // 再拼上原问题最后两个实词组成第二轮检索式。
  void question
  void contextText
  void CROSS_REF_RE
  return null
}
