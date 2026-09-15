import 'dotenv/config'
import {
  Agent,
  run,
  tool,
  MemorySession,
  InputGuardrailTripwireTriggered,
  type InputGuardrail,
  type AgentInputItem,
} from '@openai/agents'
import { RECOMMENDED_PROMPT_PREFIX } from '@openai/agents-core/extensions'
import { z } from 'zod'

/**
 * D4 实验：双 Agent handoff 加一个 guardrail。
 *
 * 用法：
 *   MOCK=1 pnpm start "title 为空应该返回什么"   # 分诊 → validation_expert
 *   MOCK=1 pnpm start "测试之间怎么隔离状态"      # 分诊 → testing_expert
 *   MOCK=1 pnpm start "帮我写一首情诗"            # 输入护栏拦截
 *   MOCK=1 pnpm start --session                   # 两轮对话，第二轮记得第一轮
 *   去掉 MOCK=1 并配置 OPENAI_API_KEY / OPENAI_MODEL 走真模型（追踪默认开启）。
 */

const model = process.env.OPENAI_MODEL // 不写死型号，未设置时用 SDK 默认

// ---------- 函数工具：SDK 用 zod schema 替我们生成 JSON Schema ----------

const listRoutes = tool({
  name: 'list_routes',
  description: '列出 TODO API 的全部路由及其是否已有测试',
  parameters: z.object({}),
  execute: async () => [
    { route: 'POST /todos', tested: false },
    { route: 'GET /todos', tested: true },
    { route: 'DELETE /todos/:id', tested: false },
  ],
})

// ---------- 输入护栏：纯规则、零成本；真正的判断逻辑抽成函数，MOCK 下也真实执行 ----------

const ON_TOPIC = /todo|接口|校验|测试|路由|api|用例|隔离|schema|为空|返回|zod|vitest/i

export function isOffTopic(text: string): boolean {
  return !ON_TOPIC.test(text)
}

const onTopicOnly: InputGuardrail = {
  name: 'on_topic_only',
  execute: async ({ input }) => {
    const text = typeof input === 'string' ? input : JSON.stringify(input)
    const offTopic = isOffTopic(text)
    return { outputInfo: { offTopic }, tripwireTriggered: offTopic }
  },
}

// ---------- 两位专家 + 一个分诊台 ----------

const validationExpert = new Agent({
  name: 'validation_expert',
  instructions: '你负责 TODO API 的输入校验问题：schema 设计、错误响应形状。回答简短。',
  model,
  tools: [listRoutes],
})

const testingExpert = new Agent({
  name: 'testing_expert',
  instructions: '你负责 TODO API 的单元测试问题：用例设计、测试隔离。回答简短。',
  model,
  tools: [listRoutes],
})

// 练习 1：把 triage 改成真正的分诊台——用 Agent.create 加 handoffs: [validationExpert, testingExpert]，
//         instructions 以 RECOMMENDED_PROMPT_PREFIX 开头并写明「校验交给 validation_expert，测试交给 testing_expert」。
//         现在它没有 handoffs，任何问题 lastAgent 都是 triage——这就是「还没做完」的现象。
// 练习 2：把 onTopicOnly 挂到 triage 的 inputGuardrails 上（注意：输入护栏只在链条的第一个 Agent 上生效）。
void RECOMMENDED_PROMPT_PREFIX
void validationExpert
void testingExpert
void onTopicOnly
const triage = new Agent({
  name: 'triage',
  instructions: '你是 TODO API 项目的分诊台，自己简短回答。',
  model,
})

// ---------- 唯一的网络出口：MOCK 在这里打桩 ----------

interface RunOutcome {
  lastAgent: string
  finalOutput: string
}

/** MOCK 下用来模拟 SDK 的 tripwire 异常，main 里与真异常一起处理 */
class MockGuardrailTripwire extends Error {}

async function runTriage(input: string, session?: MemorySession): Promise<RunOutcome> {
  if (process.env.MOCK === '1') return mockRun(input, session)

  if (!process.env.OPENAI_API_KEY) throw new Error('缺少 OPENAI_API_KEY（或用 MOCK=1 离线运行）')
  const result = await run(triage, input, { maxTurns: 6, session })
  return {
    lastAgent: result.lastAgent?.name ?? 'unknown',
    finalOutput: String(result.finalOutput ?? ''),
  }
}

/**
 * 离线假运行：护栏与路由是真实的业务逻辑，只有「模型回答」是假的。
 * 交接规则用与真实提示同样的关键词，这样 lastAgent 的行为与真实运行一致。
 */
async function mockRun(input: string, session?: MemorySession): Promise<RunOutcome> {
  await new Promise((r) => setTimeout(r, 150))

  // 练习 2（MOCK 侧）：调用 isOffTopic(input)，为真时 throw new MockGuardrailTripwire('on_topic_only 拦截')，
  //         让离线运行也能看到护栏生效。现在跑「帮我写一首情诗」会得到一个正常回答，说明护栏还没接上。

  // 有 session 时把历史取出来当上下文（这一步和真实 SDK 一样：先取历史，再跑，再写回）
  const history = session ? await session.getItems() : []
  const remembered = history
    .filter(
      (item): item is Extract<AgentInputItem, { role: 'user' }> =>
        'role' in item && item.role === 'user'
    )
    .map((item) => (typeof item.content === 'string' ? item.content : ''))
    .filter(Boolean)

  // 练习 1（MOCK 侧）：按关键词模拟交接——含「测试 / 用例 / 隔离」交给 testing_expert，
  //         含「校验 / schema / 为空 / 400」交给 validation_expert，并换成对应专家的回答；其余留给 triage。
  const lastAgent = 'triage'
  let finalOutput = '离线模拟（triage）：这个问题我自己就能答——项目有三个路由，两个还没有测试。'
  if (remembered.length > 0) {
    finalOutput += ` 顺便说一句，你之前告诉过我：「${remembered[remembered.length - 1]}」。`
  }

  if (session) {
    await session.addItems([
      { type: 'message', role: 'user', content: input },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: finalOutput }],
      },
    ])
  }
  return { lastAgent, finalOutput }
}

// ---------- 入口 ----------

function isTripwire(err: unknown): boolean {
  return err instanceof InputGuardrailTripwireTriggered || err instanceof MockGuardrailTripwire
}

async function ask(input: string, session?: MemorySession): Promise<void> {
  console.log(`你> ${input}`)
  try {
    const outcome = await runTriage(input, session)
    console.log(`[lastAgent=${outcome.lastAgent}] ${outcome.finalOutput}`)
  } catch (err) {
    // 练习 3：用 isTripwire(err) 判断是不是护栏拦截，是就打印一句友好提示并 return，
    //         其它错误原样 throw。现在所有错误都会变成异常栈并以非 0 退出。
    void isTripwire
    throw err
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] === '--session') {
    // 同一个 session 跑两轮：第二轮应该记得第一轮给的事实
    // 练习 4：new 一个 MemorySession，把同一个 session 传给两次 ask，
    //         第二次的回答里应该出现第一次给的事实。现在两次是独立运行，第二次什么都不记得。
    void MemorySession
    await ask('我们的校验库是 zod，测试用 vitest。')
    await ask('刚才说的校验库在测试里怎么隔离？')
    return
  }
  const text = args.join(' ').trim()
  if (!text) {
    console.log('用法：pnpm start "一句话"  或  pnpm start --session')
    return
  }
  await ask(text)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
