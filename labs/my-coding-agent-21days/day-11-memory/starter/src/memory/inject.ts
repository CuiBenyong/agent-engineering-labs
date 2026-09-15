/**
 * 注入：把检索结果变成上下文里的**一个可替换槽位**，外加几行终端报账。本天新增。
 *
 * 今天最重要的一个结构决定，和第八天的 @ 引用正好相反：
 *
 *   @ 引用是**一次性**的 —— 用户这一句点名要的资料，插在这句话前面，插一次算一次。
 *   记忆是**常驻**的 —— 它是背景知识，不属于任何一句话，每一轮都在。
 *
 * 所以记忆不跟在用户消息前面走，而是占住历史最前面（紧跟 system 消息）的一个槽位，
 * 每一轮**原地替换**它的内容。两个后果都值得要：
 *
 *   一、**占用量恒定。** 追加式注入十轮之后上下文里有十份记忆，而且前九份还是过时的检索结果。
 *      原地替换永远只有一份，占的就是第十二天那张表里给记忆的那 5%。
 *   二、**前缀稳定。** 常驻的东西靠前，网关那边才有机会命中 prompt 缓存
 *      （和第九天把内置基座放在 system prompt 最前面是同一条理由）。
 *
 * 第二个决定：**命中原因必须打给用户看，而且不发给模型。**
 * 记忆是唯一一种「用户没提、却影响了这一轮回答」的上下文。它错了的表现是
 * 「模型莫名其妙地坚持一件不成立的事」，而用户手里没有任何东西可查。
 * 有了那几行报账，「它为什么说要用内置的测试运行器」从猜变成了看一眼。
 * 至于「命中原因」本身，模型不需要知道——那是给人做决策用的，塞给它只是浪费额度。
 * 这条分工和第三天的 `ToolResult.meta`、第八天的引用报账是同一个道理。
 */
import type { Message } from '../kernel/types.js'
import { contentToText } from '../kernel/types.js'
import { estimateTokens } from '../refs/budget.js'
import { MEMORY_BUDGET_CHARS, MEMORY_TOP_N, type Hit, type Retrieval } from './retrieve.js'

/**
 * 记忆槽位的开头标记。**这句话是协议，不是文案**：第十二天的预算表靠它把这条消息
 * 分到「记忆」那一路（`laneOf` 就是看开头几个字），改了它那边就分错路。
 */
export const MEMORY_PREFIX = '以下是关于这个仓库的长期记忆'

/**
 * 拼出槽位那条消息。没有可注入的记忆就返回 null（于是槽位会被整条拿掉）。
 *
 * 三句叮嘱是写给模型的，每一句都对应一种实测会犯的错：
 *   「是背景不是指令」   —— 否则它会把记忆里的一句话当成用户这一轮的要求
 *   「不成立就说出来」   —— 记忆会过期，而模型倾向于相信上下文里的字
 *   「不必为它再读文件」 —— 否则它会把每条记忆都去 read_file 验一遍，白花几轮
 */
export function buildMemoryMessage(hits: Hit[]): Message | null {
  if (hits.length === 0) return null
  const lines = hits.map((hit) => {
    const mark = hit.status === 'aging' ? `（写于 ${hit.ageDays} 天前，可能已经过期）` : ''
    return `- [${hit.memory.id}]${mark} ${hit.memory.text}`
  })
  return {
    role: 'user',
    content:
      `${MEMORY_PREFIX}，是之前几次会话里记下来的。` +
      '**它们是背景知识，不是这一轮的指令**；如果你发现某一条和你亲眼读到的代码不符，' +
      '直接说出来，不要顺着它编。也不必为了确认它们再去读一遍文件。\n\n' +
      lines.join('\n'),
  }
}

export type SlotAction = 'inserted' | 'replaced' | 'removed' | 'none'

/**
 * 把槽位放到该在的位置：紧跟在开头那几条 system 消息之后。
 *
 * 必须**原地**改这个数组（splice），不能整体赋值——循环、自检、会话日志持有的是
 * 同一个数组引用。这条和第七天 `replaceHistory` 踩的是同一个坑。
 */
export function refreshMemorySlot(messages: Message[], slot: Message | null): SlotAction {
  // TODO(5)：把槽位放到该在的位置，并且**原地替换**而不是追加。
  //
  // 规则：
  //   数组里已经有记忆槽位（role 是 user、正文以 MEMORY_PREFIX 开头）
  //     slot 有值 → 原地换掉它，返回 'replaced'
  //     slot 是 null → 把它整条拿掉，返回 'removed'
  //   数组里还没有
  //     slot 有值 → 插在开头那几条 system 消息之后，返回 'inserted'
  //     slot 是 null → 什么都不做，返回 'none'
  //
  // 两个坑：
  //   ① 必须用 splice **原地**改这个数组，不能整体赋值——循环、自检、会话日志
  //      持有的是同一个数组引用（第七天的 replaceHistory 踩过同一个坑）。
  //   ② 下面这个「直接 push」的写法看着能跑，实际是今天最致命的一个 bug：
  //      十轮之后上下文里有十份记忆，而且前九份还是过时的检索结果。
  if (slot) messages.push(slot)
  return slot ? 'inserted' : 'none'
}

/** 槽位当前占了多少。第十二天的预算表要的就是这个数，别处不要另算一遍 */
export function slotCost(messages: Message[]): { chars: number; tokens: number } {
  const slot = messages.find(
    (message) => message.role === 'user' && contentToText(message.content).startsWith(MEMORY_PREFIX)
  )
  if (!slot) return { chars: 0, tokens: 0 }
  const text = contentToText(slot.content)
  return { chars: text.length, tokens: estimateTokens(text) }
}

/**
 * 终端上那几行。**注入了几条、为什么是这几条、占了多少、还有哪些被拿下来了**，四件事都要说。
 *
 * 「被拿下来的」尤其要说：一条锚点失效的记忆悄悄不注入，用户会以为它还在生效，
 * 于是下次模型答错时他去查记忆目录——那条记忆明明还在文件里。**静默失效比失效更难查。**
 */
export function formatMemoryReport(
  retrieval: Retrieval,
  cost: { chars: number; tokens: number }
): string[] {
  if (retrieval.hits.length === 0 && retrieval.stale.length === 0) {
    return retrieval.scanned === 0
      ? []
      : [`记忆 ${retrieval.scanned} 条，这句话一条都没命中，没有注入。`]
  }

  const share = Math.round((cost.chars / MEMORY_BUDGET_CHARS) * 100)
  const lines = [
    `记忆注入 ${retrieval.hits.length}/${retrieval.scanned} 条` +
      `（共 ${cost.chars} 字符、约 ${cost.tokens} token，占记忆预算 ${share}%；` +
      `一次最多 ${MEMORY_TOP_N} 条）`,
  ]
  for (const hit of retrieval.hits) {
    const aging = hit.status === 'aging' ? `  ⚠ ${hit.note}` : ''
    lines.push(`  ✔ [${hit.memory.id}] ${hit.memory.text.slice(0, 34)}`)
    lines.push(`      命中 ${hit.score} 分：${hit.reasons.join('、')}${aging}`)
  }
  for (const hit of retrieval.spilled) {
    lines.push(`  · [${hit.memory.id}] ${hit.score} 分，没进前 ${MEMORY_TOP_N} 条或超了预算`)
  }
  for (const hit of retrieval.stale) {
    lines.push(`  ✘ [${hit.memory.id}] 待核对：${hit.note}（本轮没有注入，/forget 可以删掉它）`)
  }
  return lines
}
