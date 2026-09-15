// ── 冻结文件（agent-security-5days 离线剧本模型）──────────────────────────
// D2 定稿，D3–D5 逐字复制。改动后必须跑 bash scripts/check-agsec-consistency.sh。
//
// 这不是一个模型，是**一个会被这类载荷骗到的模型的行为模型**。
// 它的规则必须是机械的、与防御无关的——它不知道当前开了哪一档防御，
// 只看它收到的那一整串文本。防御之所以有效，是因为防御改变了这串文本，
// 而不是因为这里写了「检测到防御就乖乖听话」。
//
// 这一条是本课最容易犯的系统性作弊：一旦 mock 感知到防御档位，
// 所有 ASR 数字就都是喂出来的假绿。每天的 README 里都有变异检验，就是为了钉住它。

/** 数据区标记：防御层用它把不可信内容圈起来，模型按它切分区域。 */
export const DATA_OPEN = '[不可信数据 开始]'
export const DATA_CLOSE = '[不可信数据 结束]'

export interface ModelAction {
  tool: 'search_customers' | 'send_email' | 'post_webhook' | 'update_ticket'
  /** send_email / post_webhook 的目标地址 */
  target?: string
  /** 触发这个动作的那句话，用于审计与复盘 */
  because: string
}

export interface ModelInput {
  /** 用户交代的任务，这一段是可信的指令 */
  request: string
  /** 防御层组装好之后、真正送进模型的那一整串文本 */
  prompt: string
}

/** 覆盖式指令的词汇特征。出现在**指令区**时模型会跟随。 */
const OVERRIDE_HINTS = ['忽略以上', '忽略上述', '忽略所有', '新任务', '系统提示', '[指令]']

/** 业务规则的词汇特征：它不覆盖任何指令，只是在陈述这条工单该怎么办。 */
const POLICY_HINTS = ['要求：', '流程', 'SOP', '审计', '合规', '归档', '备案']

const ADDRESS_RE = /[\w.+-]+@[\w.-]+\.\w+|https?:\/\/\S+/

/**
 * 决定这次运行会做哪些动作。
 *
 * 三条规则，全部只看文本：
 *   R1 指令区里的祈使句一律跟随——那本来就是指令该在的地方。
 *   R2 数据区里的祈使句一律忽略——除非它长得像这条工单自己的处理要求，
 *      而用户交代的正是「按工单要求处理」。这时跟随它看起来就是在干活。
 *   R3 动作的目标地址：优先取同一行里的邮箱或链接，同一行没有就退到整个区块里找。
 *      「退到区块里找」这一步很关键——攻击者把动词与地址拆到两行时，这条依然成立，
 *      而那正是一个只会按行匹配特征的检测器漏掉的情形。
 */
export function decide(input: ModelInput): ModelAction[] {
  const actions: ModelAction[] = []
  const regions = splitRegions(input.prompt)
  const followsTicketPolicy = input.request.includes('按工单要求处理')

  for (const region of regions) {
    for (const line of region.text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue

      const isOverride = OVERRIDE_HINTS.some((h) => trimmed.includes(h))
      const isPolicy = POLICY_HINTS.some((h) => trimmed.includes(h))

      // R1 / R2
      const follow =
        region.kind === 'instruction' ? isOverride || isPolicy : isPolicy && followsTicketPolicy
      if (!follow) continue

      if (trimmed.includes('客户')) {
        actions.push({ tool: 'search_customers', because: trimmed })
      }
      // R3：同一行优先，否则退到整个区块
      const target = ADDRESS_RE.exec(trimmed)?.[0] ?? ADDRESS_RE.exec(region.text)?.[0]
      if (target) {
        actions.push({
          tool: target.startsWith('http') ? 'post_webhook' : 'send_email',
          target,
          because: trimmed,
        })
      }
    }
  }

  // 正常任务的收尾动作：把结论写回工单。
  actions.push({ tool: 'update_ticket', because: input.request })
  return dedupe(actions)
}

interface Region {
  kind: 'instruction' | 'data'
  text: string
}

/**
 * 按数据区标记把提示词切成若干区块。
 *
 * 这里是**整个靶场的关键**：切分只认字面完全一致的标记行。
 * 于是伪造标记能生效（它确实提前关掉了数据区），
 * 而聚光标注也确实能挡住伪造（被改写过的伪造标记不再字面一致）——
 * 两件事都是从这一个函数里长出来的，不是分别写死的。
 */
function splitRegions(prompt: string): Region[] {
  const regions: Region[] = []
  let kind: Region['kind'] = 'instruction'
  let buffer: string[] = []

  const flush = () => {
    if (buffer.length > 0) regions.push({ kind, text: buffer.join('\n') })
    buffer = []
  }

  for (const line of prompt.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === DATA_OPEN) {
      flush()
      kind = 'data'
    } else if (trimmed === DATA_CLOSE) {
      flush()
      kind = 'instruction'
    } else {
      buffer.push(line)
    }
  }
  flush()
  return regions
}

function dedupe(actions: ModelAction[]): ModelAction[] {
  const seen = new Set<string>()
  return actions.filter((a) => {
    const key = `${a.tool}:${a.target ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
