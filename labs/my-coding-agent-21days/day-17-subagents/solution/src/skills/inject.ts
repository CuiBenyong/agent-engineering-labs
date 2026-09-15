/**
 * 渐进披露的三个阶段，以及它到底省下了多少。本天新增。
 *
 *   阶段一  摘要常驻：每个技能一行「名字 + description」，挂在系统提示末尾，永远在场
 *   阶段二  全文按需：命中触发条件的技能，把 SKILL.md 正文注入成一条消息，只在那一轮
 *   阶段三  附件再按需：正文里只列出脚本的路径与一句说明，脚本正文永远不进上下文
 *
 * 三个阶段的判据各不相同，别混：
 *   阶段一的判据是「这台机器上装了什么」——与用户说什么无关，所以它是常驻成本；
 *   阶段二的判据是「这一句话命中了什么」——所以它按轮计费，不进历史的长期占用；
 *   阶段三的判据是「模型决定要用它」——所以它根本不是注入，是一次工具调用。
 *
 * **阶段二注入的消息角色是 user 而不是 system。** 理由和第八天的 @ 引用一样：
 * 这是本轮的**资料**，不是长期规则。写成 system 的话，它会在后面每一轮都
 * 被当成同等权重的指令，而它明明只对这一句话有效。
 */
import type { Message } from '../kernel/types.js'
import { estimateTokens } from '../context/tokens.js'
import { readSkillBody, type SkillMeta } from './scan.js'
import type { Hit } from './trigger.js'

/**
 * 阶段二的字符预算。它是**上限不是配额**：没命中就一个字符都不花。
 *
 * 6000 这个数是这么定的：一份写得好的 SKILL.md 正文在 500–1000 字符量级
 * （本实验这四份分别是 708、590、487、191），预算给到能同时装下六七份，
 * 再多就该怀疑是触发词写得太宽，而不是预算给得太小。
 * 引用注入（D8）那份预算与它是**两笔独立的账**，因为它们的来源与生命周期都不同。
 */
export const SKILL_BODY_BUDGET = 6000

export const SKILL_BLOCK_HEADER = '以下是与这句话相关的团队技能（按需加载，只对本轮有效）：'

export interface Stage1 {
  text: string
  chars: number
  tokens: number
}

/** 阶段一：每个技能一行。这一行就是模型判断「要不要用它」的全部依据 */
export function stage1Summary(skills: SkillMeta[]): Stage1 {
  if (skills.length === 0) return { text: '', chars: 0, tokens: 0 }
  const text = [
    '你有以下团队技能可用。这里只给了它们的用途；',
    '判断某一条与当前任务相关时，直接说出来，系统会把它的完整内容放到你面前。',
    ...skills.map((skill) => `- ${skill.name}：${skill.description}`),
  ].join('\n')
  return { text, chars: text.length, tokens: estimateTokens(text) }
}

export interface Decision {
  hit: Hit
  loaded: boolean
  /** 没装的原因，或者装了之后占了多少 */
  why: string
}

export interface Stage2 {
  message: Message | null
  decisions: Decision[]
  chars: number
  tokens: number
}

/**
 * 阶段二：按分数从高到低装全文，两道闸。
 *
 * **第一道闸：同一个 domain 只装分最高的那一条。** 这是今天最值得想清楚的一条规则。
 * 技能冲突的本质不是「重复」而是「互相矛盾」——两份 calc 约定，一份说除零抛错、
 * 一份说返回 Infinity，同时上桌的结果不是「模型知道得更多」，而是**模型随机挑一份**，
 * 而且它挑了哪一份你还看不出来。让作者用 domain 显式声明互斥，
 * 比指望模型自己调和两份矛盾的规则靠谱得多。
 *
 * **第二道闸：总字符预算。** 装不下的不装，并且**必须把原因说出来**——
 * 静默丢弃会让人以为技能没写对，实际是预算没给够。
 */
export async function stage2Bodies(hits: Hit[], budget = SKILL_BODY_BUDGET): Promise<Stage2> {
  const decisions: Decision[] = []
  const blocks: string[] = []
  const domains = new Map<string, string>()
  let used = 0

  for (const hit of hits) {
    const winner = domains.get(hit.skill.domain)
    if (winner) {
      decisions.push({
        hit,
        loaded: false,
        why: `与 ${winner} 同属 ${hit.skill.domain} 领域，分数更低，被它挡下`,
      })
      continue
    }

    const block = await renderSkill(hit.skill)
    if (used + block.length > budget) {
      decisions.push({
        hit,
        loaded: false,
        why: `全文 ${block.length} 字符，这一轮的技能预算 ${budget} 只剩 ${budget - used}，没装`,
      })
      continue
    }

    domains.set(hit.skill.domain, hit.skill.id)
    used += block.length
    blocks.push(block)
    decisions.push({ hit, loaded: true, why: `展开全文 ${block.length} 字符` })
  }

  if (blocks.length === 0) return { message: null, decisions, chars: 0, tokens: 0 }
  const text = [SKILL_BLOCK_HEADER, ...blocks].join('\n\n')
  return {
    message: { role: 'user', content: text },
    decisions,
    chars: text.length,
    tokens: estimateTokens(text),
  }
}

/**
 * 一个技能的全文块。阶段三在这里体现：**附件只出现路径与一句说明。**
 *
 * 注意给的是一条能直接跑的命令行。给路径而不给命令，模型多半会先 read_file
 * 把脚本读一遍——那就等于把阶段三又退化回阶段二了。
 */
async function renderSkill(skill: SkillMeta): Promise<string> {
  const body = await readSkillBody(skill)
  const lines = [`### 技能 ${skill.name}`, body.trim()]
  if (skill.attachments.length > 0) {
    lines.push(
      '附带的脚本（内容没有放进这里，要用就直接跑，跑之前会请用户批准）：',
      ...skill.attachments.map((a) => `- \`node ${a.runPath}\` —— ${a.note}`)
    )
  }
  return lines.join('\n\n')
}

export interface CostTable {
  /** 全量加载：所有技能的全文一次性塞进系统提示 */
  fullChars: number
  fullTokens: number
  /** 渐进加载：阶段一常驻 + 这一轮阶段二实际注入的 */
  stage1Tokens: number
  stage2Tokens: number
}

/** 对照用的「全量加载」开销。它是这门课里那种「大家都先这么写」的做法 */
export async function fullLoadCost(
  skills: SkillMeta[]
): Promise<{ chars: number; tokens: number }> {
  const blocks: string[] = []
  for (const skill of skills) blocks.push(await renderSkill(skill))
  const text = blocks.join('\n\n')
  return { chars: text.length, tokens: estimateTokens(text) }
}

/**
 * 省下多少。**这一行要打在终端上而不是只写进 README**：
 * 一个省不下东西的机制不值得留着，而你只有把两个数并排放才看得出来。
 */
export function savingLine(cost: CostTable): string {
  const progressive = cost.stage1Tokens + cost.stage2Tokens
  const saved = cost.fullTokens - progressive
  const percent = cost.fullTokens === 0 ? 0 : Math.round((saved / cost.fullTokens) * 1000) / 10
  return (
    `（技能开销：全量加载要 ${cost.fullTokens} token，渐进加载这一轮花了 ${progressive} token` +
    `（常驻摘要 ${cost.stage1Tokens} + 本轮全文 ${cost.stage2Tokens}），省下 ${saved} token，约 ${percent}%）`
  )
}

/** 决定要打给用户看的那几行。装了什么、没装什么、为什么，一条都不能省 */
export function formatDecisions(decisions: Decision[]): string[] {
  return decisions.map((d) => `（技能 ${d.hit.skill.id}：${d.loaded ? '已' : '未'}加载，${d.why}）`)
}
