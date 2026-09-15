/**
 * 一张 RAG 决策地图。
 *
 * 输入四个量：**数据规模、更新频率、延迟预算、准确度要求**。
 * 输出十个旋钮的取值，每一条都带着它出自哪一天的哪个实测结论。
 *
 * 它不是一份「最佳实践清单」。清单没有前提，所以永远对、也永远没用。
 * 这张地图的每一条都长成「因为 X，所以 Y」的形状——**前提比结论重要**，
 * 前提变了结论就该变。用法有两种：
 *
 *   1. 拿到一个新需求，填四个输入，读出一份起点配置；
 *   2. 对着自己**已经在跑**的配置复核一遍，把不一致的地方逐条解释掉
 *      （`reviewConfig`）。第二种用法比第一种值钱——它会逼你说出
 *      「我当时为什么这么选」，而这正是面试里被追问的那一句。
 */

export interface Requirement {
  /** 文档篇数（不是块数）。块数按本课语料的比例估：一篇约 4.5 块 */
  docs: number
  /** 每天有多少篇文档发生内容变更 */
  updatesPerDay: number
  /** 端到端 p95 延迟预算（毫秒），从收到问题到第一个字 */
  latencyBudgetMs: number
  /** 准确度要求：能用就行 / 要高 / 要能被审计追溯 */
  accuracy: 'best-effort' | 'high' | 'audited'
}

export interface Config {
  chunking: 'heading' | 'recursive' | 'semantic'
  index: 'seqscan' | 'hnsw' | 'hnsw+partition' | 'dedicated'
  quantize: 'none' | 'halfvec' | 'binary+rescore'
  routes: 'bm25' | 'bm25+vector'
  rerank: boolean
  queryRewrite: boolean
  agentic: 'off' | 'routed' | 'always'
  sync: 'full-rebuild' | 'incremental'
  refusal: 'prompt-only' | 'code-gate' | 'code-gate+citation-verify'
  evalCadence: 'on-merge' | 'on-merge+nightly-judge'
}

export interface Decision {
  knob: keyof Config
  value: string
  /** 这一条是被哪个输入触发的 */
  driver: keyof Requirement | 'always'
  /** 依据出自哪一天，以及那天量到了什么 */
  because: string
}

/** 一篇文档大约切出多少块。本课语料实测：30 篇 → 134 块 */
const CHUNKS_PER_DOC = 134 / 30

export function decide(req: Requirement): { config: Config; decisions: Decision[] } {
  const chunks = Math.round(req.docs * CHUNKS_PER_DOC)
  const churn = req.docs === 0 ? 0 : req.updatesPerDay / req.docs
  const decisions: Decision[] = []
  const put = <K extends keyof Config>(
    knob: K,
    value: Config[K],
    driver: Decision['driver'],
    because: string
  ): Config[K] => {
    decisions.push({ knob, value: String(value), driver, because })
    return value
  }

  // 切块：D4 量到「按结构切几乎零成本、效果接近语义切分」，前提是文档有标题层级；
  // 语义切分只在没有结构的长文本上才值那一次全量 embedding。
  const chunking = put(
    'chunking',
    'heading',
    'always',
    'D4：按结构切在这份语料上与语义切分打平（都 7/8）却零成本；没有标题层级时才退到递归或语义'
  )

  // 索引：判据不是「我有多少行」，而是「索引还塞不塞得进内存」（D5）。
  const index = put(
    'index',
    chunks < 50_000
      ? 'seqscan'
      : chunks < 5_000_000
        ? req.accuracy === 'audited'
          ? 'hnsw+partition'
          : 'hnsw'
        : 'dedicated',
    'docs',
    `D5：约 ${chunks.toLocaleString('en-US')} 块。五万块以内顺序扫比 HNSW 还快还准；` +
      '千万块且索引塞不进内存，或过滤条件是十几个属性的任意组合时才该换专用库'
  )

  // 量化：D5 实测半精度的召回损失落在重跑噪声里，索引却小四成——它几乎是白捡的。
  const quantize = put(
    'quantize',
    chunks < 50_000 ? 'none' : 'halfvec',
    'docs',
    'D5：半精度索引从 38.8 MB 降到 22.2 MB，同样 ef_search 下召回 90.5% 对 92.0%，差别在噪声里；' +
      '二值量化必须配原始向量精排，且损失取决于你自己的向量分布，别抄别人的数字'
  )

  // 检索路数：延迟预算极紧时向量那一路先砍——它要一次 embedding 往返（建模 120 ms）。
  const routes = put(
    'routes',
    req.latencyBudgetMs < 300 ? 'bm25' : 'bm25+vector',
    'latencyBudgetMs',
    'D9：向量一路要多一次 embedding 往返（建模 120 ms）。它换来的是「换个说法也能捞到」——' +
      'D9 有一道题关键词前 10 名一条没有、向量排第 3'
  )

  // 重排：D9 的三笔账。它买的是排序质量（nDCG），不买召回率，而且是一次同步往返。
  const rerank = put(
    'rerank',
    req.accuracy !== 'best-effort' && req.latencyBudgetMs >= 800,
    'latencyBudgetMs',
    'D9：重排建模 180 ms、按检索次数计价，买到的是 nDCG（D11 实测 0.6438 → 0.7218），' +
      '买不到召回率也救不了拒答——准入卡在每一路原始分上，重排只改顺序'
  )

  // 查询改写：D10 实测单轮几乎不涨指标，多轮是「有没有」的分界线。
  const queryRewrite = put(
    'queryRewrite',
    true,
    'always',
    'D10：单轮开不开指标一模一样；多轮里不消解指代，第二轮「这个人叫什么名字」一条候选都过不了门槛，' +
      '系统只能拒答——那不是答错，是明明有答案却说找不到'
  )

  // Agentic：D12 的结构——收益集中在多跳，代价摊给全部问题。所以只在能分流时开。
  const agentic = put(
    'agentic',
    req.accuracy === 'audited' && req.latencyBudgetMs >= 3000 ? 'routed' : 'off',
    'accuracy',
    'D12：多跳档召回率 75% → 100%，single 一个点没涨，代价是每问平均多 0.75 次检索加 0.75 次模型调用。' +
      '你为 100% 的问题付钱、只有一小部分拿到好处，所以先分流再进循环，不要当默认值'
  )

  // 同步：全量重建等于每天把知识库重买一遍（D13）。
  const sync = put(
    'sync',
    req.updatesPerDay > 0 && req.docs > 200 ? 'incremental' : 'full-rebuild',
    'updatesPerDay',
    `D13：日变更率约 ${(churn * 100).toFixed(1)}%。实验里对账只向量化 6 块、全量要 151 块，账单差二十多倍；` +
      '篇数少且每天都要重跑一遍才划算的时候，全量重建反而更省心'
  )

  // 拒答：D6 的结论是「可信度只能来自代码回查」；要审计就必须连引用校验一起上。
  const refusal = put(
    'refusal',
    req.accuracy === 'audited'
      ? 'code-gate+citation-verify'
      : req.accuracy === 'high'
        ? 'code-gate'
        : 'prompt-only',
    'accuracy',
    'D6：提示词里写十遍「请确保引用准确」增益接近零；编号是闭集，一行代码就能判它存不存在，' +
      '再加一道实质重合度才拦得住「编号是真的、内容是假的」那一类'
  )

  // 评估节奏：D8 的两档——检索侧指标纯本地几秒钟零成本，模型裁判留给合并前与每晚。
  const evalCadence = put(
    'evalCadence',
    req.accuracy === 'best-effort' ? 'on-merge' : 'on-merge+nightly-judge',
    'accuracy',
    'D8：检索侧三个指标是纯本地计算、几秒钟、零成本，每次提交都能跑；' +
      '模型裁判要花钱，留给合并前和每晚各一次，而且换了裁判必须重做一次人工抽检'
  )

  return {
    config: {
      chunking,
      index,
      quantize,
      routes,
      rerank,
      queryRewrite,
      agentic,
      sync,
      refusal,
      evalCadence,
    },
    decisions,
  }
}

export interface Divergence {
  knob: keyof Config
  actual: string
  recommended: string
  because: string
}

/**
 * 对着地图复核一份**已经在跑**的配置。
 *
 * 返回的每一条都不是「你错了」，而是「这一条你得给个理由」。
 * 本天实验的最后一步就是把这几条逐条解释掉——解释不掉的，才是真该改的。
 */
export function reviewConfig(actual: Config, req: Requirement): Divergence[] {
  const { config, decisions } = decide(req)
  const reasonOf = new Map(decisions.map((d) => [d.knob, d.because]))
  const knobs = Object.keys(config) as Array<keyof Config>
  return knobs
    .filter((knob) => String(actual[knob]) !== String(config[knob]))
    .map((knob) => ({
      knob,
      actual: String(actual[knob]),
      recommended: String(config[knob]),
      because: reasonOf.get(knob) ?? '',
    }))
}

/** 本天这个综合项目实际在跑的配置。它是被复核的对象，不是标准答案 */
export const CAPSTONE_CONFIG: Config = {
  chunking: 'heading',
  index: 'seqscan',
  quantize: 'none',
  routes: 'bm25+vector',
  rerank: true,
  queryRewrite: false,
  agentic: 'off',
  sync: 'full-rebuild',
  refusal: 'code-gate+citation-verify',
  evalCadence: 'on-merge',
}

/** 本项目的需求侧前提，写出来才能被复核 */
export const CAPSTONE_REQUIREMENT: Requirement = {
  docs: 30,
  updatesPerDay: 1,
  latencyBudgetMs: 1500,
  accuracy: 'audited',
}
