import 'dotenv/config'

import { CHUNK_SIZE, OVERLAP, chunkText, ingest, searchMemories } from './memory'
import { EMBEDDING_DIM, embed, embeddingCostUsd } from './infra/embeddings'
import { createStore, storeKind, type SearchHit } from './infra/store'
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  memorySearchTool,
  runMemorySearch,
  type AgentContext,
  type ToolArgs,
} from './tool'

const USER_ID = 'u_1001'

// 一段虚构的电商客服档案，扮演「历次会话沉淀下来的长期记忆」。
// 生产里这段文字该是模型从对话里抽出来的陈述句，不是对话原文。
const PROFILE = `客户档案：张先生，本平台老用户，注册三年，累计下单一百多笔，客单价中等偏上，主要买生鲜零食和运动装备两类商品。这份档案由客服在每次会话结束后整理成陈述句，用来在下一次对话里唤起记忆，而不是把历次聊天记录整段塞进上下文。每条结论都尽量写成能独立看懂的一句话，不依赖前后文，这样单独被检索出来也不会读不懂。
饮食与安全：张先生对花生严重过敏，一旦误食会有急性反应，因此任何含花生、花生油或花生碎的零食礼盒都不能推荐给他，忌口这一条必须在他下单前主动提醒一次。除了花生之外他还不吃香菜，但那只是口味偏好，不属于过敏，不必特别强调。促销活动里的混合坚果礼盒尤其要留意，配料表里经常混着花生碎，遇到这类商品要直接劝阻，而不是让他自己去翻配料表。
收货与签收：常用收货地址在上海市浦东新区的一处公寓，工作日白天家里没有人，只有晚上七点以后才方便签收，所以预约配送时间要尽量安排在晚上，周末则全天都可以送。他不接受把包裹放进楼下的自提柜，之前丢过一次件，从那以后要求必须当面签收，让邻居代收也不行。如果只能白天送到，他更愿意改约日期，也不希望放在门口。
售后与尺码：上个月他退过一次货，原因是运动鞋尺码偏小，退货流程走得很顺利，没有产生纠纷。从那次之后他买鞋统一选四十二码，客服可以直接按这个尺码推荐，不必每次再问一遍，其他品类目前没有类似的尺码记录。他对售后的容忍度不低，但很在意有没有人主动跟进进度，宁愿收到一条冗余的进度通知，也不愿意自己反复来问。
支付与发票：张先生固定用同一张信用卡结算，每笔订单都要开电子普通发票，发票信息已经存在账户里，不用每次再问一遍。他不使用平台的分期付款，也不用礼品卡余额抵扣。如果订单金额超过两千元，他希望先收到一条确认消息再扣款，这条要求是他自己提出来的。
沟通与表达：张先生习惯在晚上使用客服，白天很少回复消息，所以主动通知尽量安排在晚上八点前后。他不喜欢长段落，回复越短越好，能一句话说清就不要分三段。对营销推送比较敏感，除了他自己关注的运动品类，其余活动一律不要推给他。他更信任具体的数字和时间点，例如明天下午三点前发出，比尽快发出有用得多。
物流与到付：张先生只接受顺丰，此前用过的另外几家承运商都投诉过延误，他明确说过再遇到延误就直接申请退货。另外他不接受到付，所有运费必须在下单时一起结清，货到付款这个选项不要给他推荐，他主动问起来也要说明我们默认不走到付。大件商品如果只能走别的承运商，要提前告知并征得他同意，不能默认下单。`

// --- Agent：把 memory_search 接进 D5 那套工具循环 ---
interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: ToolCall[]
}

const SYSTEM_PROMPT =
  '你是电商客服助手。回答关于用户偏好的问题之前，先用 memory_search 查一次长期记忆；' +
  '只依据检索到的内容作答，检索不到就向用户确认，不要凭印象编。'

/** 第二个网络出口：对话模型。同样在函数最前面打桩。 */
async function chat(messages: ChatMessage[]): Promise<ChatMessage> {
  if (process.env.MOCK === '1') return mockChat(messages)
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('缺少 OPENROUTER_API_KEY（或用 MOCK=1 离线运行）')

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.MODEL ?? 'openai/gpt-4o-mini',
      messages,
      tools: [{ type: 'function', function: memorySearchTool }],
    }),
  })
  if (!res.ok) throw new Error(`模型调用失败：${res.status} ${await res.text()}`)
  const json = (await res.json()) as { choices: Array<{ message: ChatMessage }> }
  return json.choices[0].message
}

/** 假模型：第一轮必定发起一次结构完整的 memory_search，拿到结果后再作答。 */
function mockChat(messages: ChatMessage[]): ChatMessage {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  const lastTool = [...messages].reverse().find((m) => m.role === 'tool')
  if (lastTool) return { role: 'assistant', content: `根据长期记忆，我查到：\n${lastTool.content}` }
  const args = JSON.stringify({ query: lastUser?.content ?? '', limit: 3 })
  const call: ToolCall = {
    id: 'call_mock_1',
    type: 'function',
    function: { name: 'memory_search', arguments: args },
  }
  return { role: 'assistant', content: '', tool_calls: [call] }
}

export async function agentTurn(ctx: AgentContext, userText: string): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userText },
  ]
  // 步数上限是 D5 立的三道闸之一：没有它，模型可以一直重试烧钱
  for (let step = 0; step < 3; step += 1) {
    const reply = await chat(messages)
    messages.push(reply)
    const call = reply.tool_calls?.[0]
    if (!call) return reply.content
    const args = JSON.parse(call.function.arguments) as ToolArgs
    const content =
      call.function.name === 'memory_search'
        ? await runMemorySearch(args, ctx)
        : `调用失败。没有名为 ${call.function.name} 的工具。`
    messages.push({ role: 'tool', tool_call_id: call.id, content })
  }
  return '（超过步数上限，本轮终止）'
}

// --- 自检：MOCK=1 SELFTEST=1 pnpm start ---
// 每项失败时打印的原因。starter 原样跑会看到其中四条，那就是练习清单。
const HINTS = [
  `目标 ${CHUNK_SIZE} 字符、重叠 ${OVERLAP} 字符：切成一整块等于没切，命中的卡片会横跨所有主题`,
  '向量必须是确定性的，否则同一个 query 每次命中不同的记忆',
  '两个 query 的 top-1 应该是不同的两条记忆；一样就说明相似度没有真的参与排序',
  '超上限要按 D5 的规矩回一条带范围和示例的错误让模型改，不能静默截断',
  '空结果返回空串，模型会当成「没有约束」然后自己编一条偏好出来',
]

let failed = 0
function report(no: number, passed: boolean, line: string): void {
  if (!passed) failed += 1
  console.log(`[${no}/5] ${line} ${passed ? '✅' : `❌ ${HINTS[no - 1]}`}`)
}

/** 围绕关键词开一个小窗，让读者一眼看到命中的是哪个主题，而不是块的开头。 */
function describe(hit: { content: string; score: number } | undefined, keyword: string): string {
  if (!hit) return '（没有命中）'
  const from = Math.max(0, hit.content.indexOf(keyword) - 14)
  const text = hit.content
    .slice(from, from + 34)
    .replace(/\s+/g, ' ')
    .trim()
  return `[相似度 ${hit.score.toFixed(2)}] …${text}…`
}

async function selfTest(ctx: AgentContext): Promise<void> {
  console.log(`=== 自检开始（仓库：${storeKind()}）===`)
  // 1. chunking：多块、每块不超过 400 字符、相邻块重叠
  const chunks = chunkText(PROFILE)
  const longest = Math.max(...chunks.map((c) => c.length))
  const lapped =
    chunks.length > 1 && chunks.every((c, i) => i === 0 || c.includes(chunks[i - 1].slice(-20)))
  const ok1 = chunks.length > 1 && longest <= CHUNK_SIZE && lapped
  const line1 = `切块：${PROFILE.length} 字符 → ${chunks.length} 块，最长 ${longest} 字符，重叠 ${lapped ? OVERLAP : 0} 字符`
  report(1, ok1, line1)
  // 2. embedding：定长 + 确定性（脚手架已实现，两个版本都该是 ✅）
  const [first] = await embed(['张先生对花生过敏'])
  const [again] = await embed(['张先生对花生过敏'])
  const stable = first.every((value, i) => value === again[i])
  const line2 = `embedding：维度 ${first.length}，同一段文字两次调用${stable ? '完全一致' : '结果不同'}`
  report(2, first.length === EMBEDDING_DIM && stable, line2)
  // 3. 写入 + 检索：换一个 query，命中的记忆要跟着变
  const { chunks: written, costUsd } = await ingest(ctx.store, ctx.userId, 'run_seed', PROFILE)
  console.log(`      已写入 ${written} 条记忆，embedding 花费 ${costUsd.toFixed(8)} 美元`)
  const [food] = await searchMemories(ctx.store, ctx.userId, '用户的食物忌口和过敏', 3)
  const [ship] = await searchMemories(ctx.store, ctx.userId, '用户的物流偏好和到付要求', 3)
  const hit = (h: SearchHit | undefined, kw: string) => h !== undefined && h.content.includes(kw)
  const varies = food?.id !== ship?.id && hit(food, '花生') && hit(ship, '顺丰')
  const line3 = `换 query 换命中：\n        「食物忌口和过敏」  → ${describe(food, '花生')}\n        「物流偏好和到付要求」→ ${describe(ship, '顺丰')}`
  report(3, varies, line3)
  // 4. memory_search 的参数校验（D5 协议）
  const rejected = await runMemorySearch({ query: '用户的食物忌口', limit: 50 }, ctx)
  const defaulted = await runMemorySearch({ query: '用户的收货地址和签收时间' }, ctx)
  const rejectOk = rejected.startsWith('调用失败') && rejected.includes(`1 到 ${MAX_LIMIT}`)
  const lines = defaulted.split('\n').length
  const ok4 = rejectOk && !defaulted.startsWith('调用失败') && lines <= DEFAULT_LIMIT
  const line4 = `参数校验：limit=50 ${rejectOk ? '被拒绝并回了可读错误' : '被放行'}；缺省 limit 返回 ${lines} 条（上限 ${DEFAULT_LIMIT}）`
  report(4, ok4, line4)
  console.log(`      回给模型的错误文案：${rejected}`)
  // 5. 空结果文案 + 一次完整的 Agent 往返。
  // 用一个没有任何记忆的用户触发空结果，顺带证明检索是按 userId 隔离的。
  const miss = await runMemorySearch({ query: '用户的食物忌口' }, { ...ctx, userId: 'u_9999' })
  const answer = await agentTurn(ctx, '我有什么忌口，下单前要注意什么')
  const missOk = miss.includes('没有找到相关的长期记忆')
  const answerOk = answer.includes('花生')
  const line5 = `换成没有记忆的 u_9999：空结果文案${missOk ? '正确' : '缺失'}；本用户走完 Agent 往返，回答${answerOk ? '带上了检索到的事实' : '没能用上记忆'}`
  report(5, missOk && answerOk, line5)
  console.log(`      空结果回给模型的是：${miss}`)
  console.log(`      Agent 回答：${answer.replace(/\s+/g, ' ').slice(0, 100)}…`)
  console.log(`=== 自检结束：${failed === 0 ? '全部通过 ✅' : `${failed} 项未通过 ❌`} ===`)
}

async function main(): Promise<void> {
  const store = createStore()
  await store.init()
  const ctx: AgentContext = { store, userId: USER_ID }

  if (process.env.SELFTEST === '1') {
    await selfTest(ctx)
    await store.close()
    process.exit(failed === 0 ? 0 : 1)
  }

  const question = process.argv.slice(2).join(' ') || '我有什么忌口'
  const { chunks, costUsd } = await ingest(store, USER_ID, 'run_seed', PROFILE)
  console.log(`[写入] ${chunks} 条记忆，花费 ${costUsd.toFixed(8)} 美元（仓库：${storeKind()}）`)
  console.log(`[提问] ${question}`)
  console.log(`[回答] ${await agentTurn(ctx, question)}`)
  const one = embeddingCostUsd([question]).toFixed(8)
  console.log(
    `[提示] 这次检索的 embedding 成本约 ${one} 美元，而把命中的 5 条塞进对话请求要 0.0003 美元——贵的从来不是 embedding。`
  )
  await store.close()
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
